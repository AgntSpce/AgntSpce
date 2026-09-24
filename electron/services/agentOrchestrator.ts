import { PrioritySemaphore } from './prioritySemaphore'
import { ResourceTracker } from './resourceTracker'
import type { StateManager } from './orchestration/stateManager'
import { WorktreeLifecycle } from './orchestration/worktreeLifecycle'
import { AGENT_TYPES } from './types'

interface SessionRecord {
  id: string
  ptyPid: number
  worktreeId: string
  agentId: string
  taskGroupId: string | null
  startedAt: number
  restartCount: number
  lastHealthCheck: number
  healthy: boolean
}

export class AgentOrchestrator {
  private concurrencyLimiter: PrioritySemaphore
  private resourceTracker = new ResourceTracker()
  private sessions = new Map<string, SessionRecord>()
  private healthInterval: NodeJS.Timeout | null = null
  private readonly MAX_RESTARTS = 3
  private readonly RESTART_WINDOW_MS = 60000
  private readonly HEALTH_TIMEOUT_MS = 15000
  private readonly HEALTH_CHECK_INTERVAL_MS = 15000
  private readonly maxConcurrentSessions: number
  private io: any
  private stateManager: StateManager | null = null

  constructor(io: any, maxConcurrentSessions = 8) {
    this.io = io
    this.maxConcurrentSessions = maxConcurrentSessions
    this.concurrencyLimiter = new PrioritySemaphore(maxConcurrentSessions)
    // Health/resource timers are started lazily on first session registration
    // and stopped when the last session closes (see registerSession/
    // unregisterSession) so idle apps consume zero polling overhead.
  }

  setStateManager(sm: StateManager | null): void {
    this.stateManager = sm
  }

  getStateManager(): StateManager | null {
    return this.stateManager
  }

  getOrchestrationStats() {
    try {
      return this.stateManager?.getOrchestratorStats() ?? null
    } catch (err: any) {
      console.error('[orchestrator] getOrchestrationStats failed:', err?.message || err)
      return null
    }
  }

  async acquireSlot(priority = 1, signal?: AbortSignal): Promise<() => void> {
    return this.concurrencyLimiter.acquire(priority, signal)
  }

  /** Reserve a whole block of slots for one Task's subtasks (fail-fast,
   *  partial reservations released) — see PrioritySemaphore.tryAcquire. */
  async tryAcquireSlots(count: number, timeoutMs = 30000): Promise<(() => void)[]> {
    return this.concurrencyLimiter.tryAcquire(count, timeoutMs)
  }

  /** Aggregate live resource usage by task group (Orca WorktreeMemory-style
   *  bucketing). Sessions without a task link are grouped under 'adhoc'. */
  getTaskResourceUsage(): { taskGroupId: string; cpuPercent: number; memoryMB: number; sessionCount: number }[] {
    const usage = this.resourceTracker.getAllUsage()
    const byTask = new Map<string, { cpuPercent: number; memoryMB: number; sessionCount: number }>()
    for (const u of usage) {
      const rec = this.sessions.get(u.sessionId)
      const key = rec?.taskGroupId ?? 'adhoc'
      const bucket = byTask.get(key) ?? { cpuPercent: 0, memoryMB: 0, sessionCount: 0 }
      bucket.cpuPercent += u.cpuPercent || 0
      bucket.memoryMB += u.subtreeMemoryMB ?? u.memoryMB ?? 0
      bucket.sessionCount += 1
      byTask.set(key, bucket)
    }
    return [...byTask.entries()].map(([taskGroupId, b]) => ({
      taskGroupId,
      cpuPercent: Math.round(b.cpuPercent * 10) / 10,
      memoryMB: Math.round(b.memoryMB * 10) / 10,
      sessionCount: b.sessionCount,
    }))
  }

  registerSession(sessionId: string, ptyPid: number, worktreeId: string, agentId: string, taskGroupId?: string | null, subtaskId?: string | null): void {
    this.resourceTracker.registerSession(sessionId, ptyPid)
    this.sessions.set(sessionId, {
      id: sessionId,
      ptyPid,
      worktreeId,
      agentId,
      taskGroupId: taskGroupId ?? null,
      startedAt: Date.now(),
      restartCount: 0,
      lastHealthCheck: Date.now(),
      healthy: true,
    })
    // Restart polling timers now that a session exists.
    this.startHealthChecks()
    this.resourceTracker.startMonitoring()
    try {
      // Preserve the existing task link across restarts: upsertSession without
      // taskId would null it out, then ensureSessionTask re-creates a NEW task
      // on every register — the duplicate "Ad-hoc … session" entries.
      const existing = this.stateManager?.getSession(sessionId)
      const existingTaskId = existing?.taskId ?? null
      this.stateManager?.upsertSession({
        id: sessionId,
        sessionType: agentId,
        agentId,
        taskId: existingTaskId,
        taskGroupId: taskGroupId ?? existing?.taskGroupId ?? null,
        subtaskId: subtaskId ?? existing?.subtaskId ?? null,
        worktreeId: worktreeId || null,
        status: 'idle',
      })
      if ((AGENT_TYPES as readonly string[]).includes(agentId as any)) {
        const task = this.stateManager?.ensureSessionTask(sessionId, agentId, `Ad-hoc ${agentId} session ${sessionId.slice(-8)}`)
        // Re-link if ensureSessionTask replaced the old task (e.g. terminal task)
        if (task && task.id !== existingTaskId) {
          this.stateManager?.linkSessionToTask(sessionId, task.id)
        }
      }
    } catch (err: any) {
      console.error('[orchestrator] registerSession persistence failed:', sessionId, err?.message || err)
    }
  }

  unregisterSession(sessionId: string): void {
    this.resourceTracker.unregisterSession(sessionId)
    this.sessions.delete(sessionId)
    // Stop polling timers when the last session goes away — nothing to monitor.
    if (this.sessions.size === 0) {
      this.stopHealthChecks()
      this.resourceTracker.stopMonitoring()
    }
    try {
      this.stateManager?.closeSessionRecord(sessionId)
      this.teardownMergedWorktree(sessionId)
    } catch (err: any) {
      console.error('[orchestrator] unregisterSession persistence failed:', sessionId, err?.message || err)
    }
  }

  private teardownMergedWorktree(sessionId: string): void {
    const sm = this.stateManager
    if (!sm) return
    const session = sm.getSession(sessionId)
    if (!session?.taskId) return
    const task = sm.getTask(session.taskId)
    if (!task || task.status !== 'done' || !task.worktreePath) return
    try {
      const integrationBranch = sm.getIntegrationBranch()
      new WorktreeLifecycle(sm.getRepoPath()).removeWorktree(session.taskId, integrationBranch)
    } catch (err: any) {
      console.error('[orchestrator] worktree teardown failed:', sessionId, err?.message || err)
    }
  }

  touchSession(sessionId: string): void {
    try {
      this.stateManager?.touchSession(sessionId)
    } catch {}
  }

  enforceSessionClaims(sessionId: string, agentId: string, declaredFiles: string[], excludeSessionIds: string[] = []): boolean {
    if (!this.stateManager) return true
    try {
      this.stateManager.claimSessionTask(sessionId, agentId, declaredFiles, excludeSessionIds)
      return true
    } catch (err: any) {
      console.error('[orchestrator] session claim enforcement blocked:', sessionId, err?.message || err)
      return false
    }
  }

  canRestart(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record) return true
    const windowStart = Date.now() - this.RESTART_WINDOW_MS
    return record.restartCount < this.MAX_RESTARTS || record.startedAt < windowStart
  }

  recordRestart(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record) return false
    const windowStart = Date.now() - this.RESTART_WINDOW_MS
    if (record.startedAt < windowStart) {
      record.restartCount = 1
    } else {
      record.restartCount++
    }
    record.startedAt = Date.now()
    return record.restartCount <= this.MAX_RESTARTS
  }

  getConcurrencyLoad(): { active: number, queued: number, max: number } {
    return {
      active: this.concurrencyLimiter.currentLoad,
      queued: this.concurrencyLimiter.queuedCount,
      max: this.maxConcurrentSessions,
    }
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  getResourceUsage(sessionId: string) {
    return this.resourceTracker.getUsage(sessionId)
  }

  getAllResourceUsage() {
    return this.resourceTracker.getAllUsage()
  }

  getTotalMemoryMB(): number {
    return this.resourceTracker.getTotalMemoryMB()
  }

  getTotalCpuPercent(): number {
    return this.resourceTracker.getTotalCpuPercent()
  }

  getTotalProcessCount(): number {
    return this.resourceTracker.getTotalProcessCount()
  }

  private startHealthChecks(): void {
    if (this.healthInterval) return
    this.healthInterval = setInterval(() => this.runHealthCheck(), this.HEALTH_CHECK_INTERVAL_MS)
  }

  private stopHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval)
      this.healthInterval = null
    }
  }

  private runHealthCheck(): void {
    const now = Date.now()
    for (const [sessionId, record] of this.sessions) {
      if (now - record.lastHealthCheck > this.HEALTH_TIMEOUT_MS * 2) {
        record.healthy = false
        try {
          this.io.emit('session-unhealthy', { sessionId, reason: 'health-check-timeout' })
        } catch {}
      }

      if (this.resourceTracker.isOverMemoryThreshold(sessionId)) {
        record.healthy = false
        try {
          this.io.emit('session-unhealthy', {
            sessionId,
            reason: 'memory-threshold-exceeded',
            usage: this.resourceTracker.getUsage(sessionId),
          })
        } catch {}
      }

      record.lastHealthCheck = now
    }
  }

  markHealthCheck(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    if (record) {
      record.lastHealthCheck = Date.now()
      record.healthy = true
    }
    try {
      this.stateManager?.touchSession(sessionId)
    } catch {}
  }

  isHealthy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.healthy ?? true
  }

  async shutdownAll(): Promise<void> {
    this.stopHealthChecks()
    this.resourceTracker.stopMonitoring()
    this.concurrencyLimiter.reset()
    this.sessions.clear()
    this.resourceTracker.clear()
  }

  async shutdownWorkspace(workspaceId: string, sessionManager: any): Promise<void> {
    const toClose: string[] = []
    for (const [sessionId, record] of this.sessions) {
      const state = sessionManager.getSessionStates()
      if (state[sessionId]?.worktreeId === record.worktreeId) {
        toClose.push(sessionId)
      }
    }
    for (const id of toClose) {
      sessionManager.closeSession(id)
      this.unregisterSession(id)
    }
  }

  reset(): void {
    this.shutdownAll()
    this.resourceTracker.clear()
  }
}
