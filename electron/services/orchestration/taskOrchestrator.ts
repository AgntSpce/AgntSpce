import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  StateManager,
  CoordinatorError,
  type TaskGroupOverview,
  type SubTaskOverview,
} from './stateManager'
import { WorktreeLifecycle } from './worktreeLifecycle'
import { CollabShim } from './collabShim'
import {
  planTask,
  writeTaskMetaFile,
  type PlanAgentInput,
  type TaskPlan,
} from './taskPlanner'
import { SessionSummarizer, type TaskSummary } from './sessionSummarizer'

export interface SubtaskSpawnInput {
  taskGroupId: string
  subtaskId: string
  agentId: string
  model?: string
  reasoning?: string
  verbosity?: string
  prompt: string
  cwd: string
  worktreeId: string
  scopeFiles: string[]
  siblingSessionIds: string[]
}

/** Narrow seam for spawning PTYs — SessionManager satisfies this structurally,
 *  tests inject fakes so no PTY is ever needed. */
export interface Spawner {
  spawnTaskSubtask(input: SubtaskSpawnInput): Promise<string>
  closeTaskSessions(sessionIds: string[]): number
}

/** Narrow seam for slot reservation — AgentOrchestrator satisfies this. */
export interface SlotPool {
  tryAcquire(count: number, timeoutMs?: number): Promise<(() => void)[]>
}

export interface TaskWarning {
  type: 'conflict' | 'stale'
  taskGroupId: string
  message: string
  at: number
}

export interface LaunchResult {
  taskGroupId: string
  sessionIds: string[]
  usedFallback: boolean
  warnings: string[]
}

export interface TaskDetail {
  group: TaskGroupOverview
  subtasks: SubTaskOverview[]
  summary: TaskSummary
  warnings: TaskWarning[]
}

const CONFLICT_WINDOW_MS = 60_000
const STALE_AFTER_MS = 10 * 60_000

export class TaskOrchestrator {
  constructor(
    private sm: StateManager,
    private spawner: Spawner,
    private slots: SlotPool,
    private opts?: {
      llm?: (prompt: string) => Promise<string | null>
      repoTree?: (repoPath: string) => string[]
      slotTimeoutMs?: number
    }
  ) {}

  private repoTreeFor(repoPath: string): string[] {
    try {
      if (this.opts?.repoTree) return this.opts.repoTree(repoPath)
      return fs.readdirSync(repoPath)
    } catch {
      return []
    }
  }

  private sourceRef(): string {
    try {
      return this.sm.getIntegrationBranchSha()
    } catch {
      return 'HEAD'
    }
  }

  /** Integration branch name for the agent prompt, or undefined when this
   *  workspace has no usable git repo — the prompt only mentions peer work when
   *  there is a branch to merge from. */
  private integrationBranchOrUndefined(): string | undefined {
    try {
      return this.sm.getIntegrationBranch() || undefined
    } catch {
      return undefined
    }
  }

  /** Full launch: plan → worktree/branch → meta+seed → reserve → spawn.
   *  Only 'planning' (or 'paused' after a failed launch) groups launch. */
  async launchTask(taskGroupId: string): Promise<LaunchResult> {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    if (group.status !== 'planning' && group.status !== 'paused') {
      throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} is ${group.status}, expected planning/paused`)
    }
    const shells = this.sm.listSubTasks(taskGroupId)
    if (shells.length === 0) throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} has no agents`)

    const plan = await this.buildPlan(group, shells)
    const wtl = new WorktreeLifecycle(group.repoPath)
    const slug = WorktreeLifecycle.sanitizeTaskSlug(group.title)

    // Worktree/branch (idempotent-ish: reuse recorded values on relaunch).
    let branchName = group.branchName
    let worktreePath: string | null = group.worktreePath
    let baseSha = group.baseSha
    if (!branchName) {
      if (group.worktreeMode === 'none') {
        // Explicitly accepted "no git" mode: agents run directly in the
        // workspace folder. No branch, no worktree, nothing to merge — and
        // crucially no empty directory pretending to be isolation.
        branchName = null
        worktreePath = null
        baseSha = null
      } else if (group.worktreeMode === 'in-repo') {
        branchName = wtl.deduplicateBranchName(wtl.buildTaskBranchName(group.id, slug))
        const ref = this.sourceRef()
        wtl.createTaskBranchInRepo(branchName, ref)
        baseSha = baseSha ?? this.safeRevParse(group.repoPath, ref)
        worktreePath = null
      } else {
        const res = wtl.createTaskWorktree(group.id, slug, this.sourceRef())
        branchName = res.branchName
        worktreePath = res.worktreePath
        baseSha = res.branchPoint
      }
    }
    const cwd = worktreePath ?? group.repoPath
    this.sm.updateTaskGroup(group.id, { branchName, worktreePath, baseSha, status: 'active' })

    writeTaskMetaFile(cwd, {
      taskGroupId: group.id,
      branchName,
      baseSha,
      worktreeMode: group.worktreeMode,
      todoList: plan.todoList,
      subtasks: plan.subtasks.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: s.scopeFiles })),
    })
    for (const s of plan.subtasks) {
      const shell = shells.find(x => x.agentId === s.agentId)
      if (shell) this.sm.updateSubTaskPlan(shell.id, { title: s.title, scopeFiles: s.scopeFiles, assignmentPrompt: s.assignmentPrompt })
    }
    new CollabShim(this.sm, group.repoPath).seed(group.id)

    // Reserve every slot before spawning the first agent.
    let releases: (() => void)[]
    try {
      releases = await this.slots.tryAcquire(plan.subtasks.length, this.opts?.slotTimeoutMs ?? 30000)
    } catch (err: any) {
      this.sm.updateTaskGroup(group.id, { status: 'paused' })
      throw new CoordinatorError('NO_CAPACITY', err?.message || 'Not enough agent slots right now — reduce agents or wait for another task to finish')
    }

    const sessionIds: string[] = []
    try {
      const fresh = this.sm.listSubTasks(group.id)
      for (const s of fresh) {
        if (s.status === 'done') continue
        const planned = plan.subtasks.find(p => p.agentId === s.agentId)
        const sid = await this.spawner.spawnTaskSubtask({
          taskGroupId: group.id,
          subtaskId: s.id,
          agentId: s.agentId,
          model: s.model ?? undefined,
          reasoning: s.reasoning ?? undefined,
          verbosity: s.verbosity ?? undefined,
          prompt: planned?.assignmentPrompt || s.assignmentPrompt,
          cwd,
          worktreeId: group.id,
          scopeFiles: s.scopeFiles,
          siblingSessionIds: [...sessionIds],
        })
        this.sm.updateSubTaskStatus(s.id, 'running', sid)
        sessionIds.push(sid)
      }
    } catch (err) {
      // Partial spawn: stop what started so the next launch is clean.
      try { this.spawner.closeTaskSessions(sessionIds) } catch {}
      this.sm.updateTaskGroup(group.id, { status: 'paused' })
      throw err
    } finally {
      for (const release of releases) {
        try { release() } catch {}
      }
    }
    return { taskGroupId: group.id, sessionIds, usedFallback: plan.usedFallback, warnings: plan.warnings }
  }

  /** Follow-up: stop running agents, re-plan with the new message appended,
   *  update non-done subtasks, re-seed, respawn only the non-done ones. */
  async replanTask(taskGroupId: string, followUp: string): Promise<LaunchResult> {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const message = followUp.trim()
    if (!message) throw new CoordinatorError('INVALID', 'Follow-up message is empty')

    const subs = this.sm.listSubTasks(taskGroupId)
    const runningIds = subs.filter(s => s.status === 'running' && s.sessionId).map(s => s.sessionId as string)
    try { this.spawner.closeTaskSessions(runningIds) } catch {}
    for (const s of subs) {
      if (s.status === 'running') this.sm.updateSubTaskStatus(s.id, 'pending', null)
    }

    const goal = group.userGoal ? `${group.userGoal}\nFollow-up: ${message}` : message
    const agents: PlanAgentInput[] = subs
      .filter(s => s.status !== 'done')
      .map(s => ({ agentId: s.agentId, model: s.model, reasoning: s.reasoning, verbosity: s.verbosity }))
    if (agents.length === 0) throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} is fully done — nothing to replan`)

    const plan = await planTask(
      {
        taskTitle: group.title,
        userGoal: goal,
        branchName: group.branchName ?? '',
        worktreePath: group.worktreePath ?? group.repoPath,
        worktreeMode: group.worktreeMode,
        integrationBranch: this.integrationBranchOrUndefined(),
      },
      agents,
      this.repoTreeFor(group.worktreePath ?? group.repoPath),
      this.opts?.llm
    )
    for (const p of plan.subtasks) {
      const shell = subs.find(s => s.agentId === p.agentId && s.status !== 'done')
      if (shell) this.sm.updateSubTaskPlan(shell.id, { title: p.title, scopeFiles: p.scopeFiles, assignmentPrompt: p.assignmentPrompt })
    }
    const cwd = group.worktreePath ?? group.repoPath
    const current = this.sm.listSubTasks(taskGroupId)
    writeTaskMetaFile(cwd, {
      taskGroupId: group.id,
      branchName: group.branchName ?? '',
      baseSha: group.baseSha,
      worktreeMode: group.worktreeMode,
      todoList: plan.todoList,
      subtasks: current.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: s.scopeFiles })),
    })
    new CollabShim(this.sm, group.repoPath).refresh(group.id)
    this.sm.updateTaskGroup(group.id, { status: 'active' })

    let releases: (() => void)[]
    try {
      releases = await this.slots.tryAcquire(plan.subtasks.length, this.opts?.slotTimeoutMs ?? 30000)
    } catch (err: any) {
      this.sm.updateTaskGroup(group.id, { status: 'paused' })
      throw new CoordinatorError('NO_CAPACITY', err?.message || 'Not enough agent slots right now')
    }
    const sessionIds: string[] = []
    try {
      for (const s of current) {
        if (s.status === 'done') continue
        const planned = plan.subtasks.find(p => p.agentId === s.agentId)
        const sid = await this.spawner.spawnTaskSubtask({
          taskGroupId: group.id,
          subtaskId: s.id,
          agentId: s.agentId,
          model: s.model ?? undefined,
          reasoning: s.reasoning ?? undefined,
          verbosity: s.verbosity ?? undefined,
          prompt: planned?.assignmentPrompt || s.assignmentPrompt,
          cwd,
          worktreeId: group.id,
          scopeFiles: s.scopeFiles,
          siblingSessionIds: [...sessionIds],
        })
        this.sm.updateSubTaskStatus(s.id, 'running', sid)
        sessionIds.push(sid)
      }
    } catch (err) {
      try { this.spawner.closeTaskSessions(sessionIds) } catch {}
      this.sm.updateTaskGroup(group.id, { status: 'paused' })
      throw err
    } finally {
      for (const release of releases) {
        try { release() } catch {}
      }
    }
    return { taskGroupId: group.id, sessionIds, usedFallback: plan.usedFallback, warnings: plan.warnings }
  }

  /** Kill graph: closes every subtask PTY. Abandon also retires the group;
   *  plain close parks it (running subtasks return to pending). */
  closeTask(taskGroupId: string, abandon = false): { closed: number } {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const subs = this.sm.listSubTasks(taskGroupId)
    const ids = subs.filter(s => s.sessionId).map(s => s.sessionId as string)
    let closed = 0
    try { closed = this.spawner.closeTaskSessions(ids) } catch {}
    for (const s of subs) {
      if (s.status === 'running') this.sm.updateSubTaskStatus(s.id, abandon ? 'failed' : 'pending', null)
    }
    this.sm.updateTaskGroup(taskGroupId, abandon ? { status: 'abandoned', completedAt: Date.now() } : { status: 'paused' })
    return { closed }
  }

  /** Full delete: closes member PTYs, removes the worktree (merged-only
   *  branches survive per the never-delete-unmerged rule), drops DB rows. */
  deleteTask(taskGroupId: string): { closed: number; sessionIds: string[] } {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const subs = this.sm.listSubTasks(taskGroupId)
    const ids = subs.filter(s => s.sessionId).map(s => s.sessionId as string)
    let closed = 0
    try { closed = this.spawner.closeTaskSessions(ids) } catch {}
    try {
      new WorktreeLifecycle(group.repoPath).removeTaskWorktree(taskGroupId, this.sm.getIntegrationBranch())
    } catch {}
    this.sm.deleteTaskGroup(taskGroupId)
    return { closed, sessionIds: ids }
  }

  getDetail(taskGroupId: string, now = Date.now()): TaskDetail {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const subtasks = this.sm.listSubTasks(taskGroupId)
    const summarizer = new SessionSummarizer(this.sm.getDb(), group.repoPath)
    return {
      group,
      subtasks,
      summary: summarizer.summarizeTaskGroup(taskGroupId),
      warnings: this.getWarnings(taskGroupId, now),
    }
  }

  /** Advisory-only warnings (FileWatcher latency is 1–3s, so these never gate
   *  execution — they surface in TaskChat for humans and agents to see). */
  getWarnings(taskGroupId: string, now = Date.now()): TaskWarning[] {
    const out: TaskWarning[] = []
    const events = this.sm.getCollabEvents(taskGroupId, now - CONFLICT_WINDOW_MS)
    const byFile = new Map<string, Set<string>>()
    for (const e of events) {
      if (e.kind !== 'claim' && e.kind !== 'release') continue
      const file = e.file ?? (typeof e.payload?.file === 'string' ? (e.payload.file as string) : null)
      if (!file) continue
      if (!byFile.has(file)) byFile.set(file, new Set())
      byFile.get(file)!.add(e.subtaskId)
    }
    for (const [file, subs] of byFile) {
      if (subs.size > 1) {
        out.push({ type: 'conflict', taskGroupId, message: `Concurrent edits on ${file} by ${subs.size} agents in the last minute`, at: now })
      }
    }
    for (const s of this.sm.listSubTasks(taskGroupId)) {
      if (s.status !== 'running') continue
      const last = s.lastEventAt ?? s.createdAt
      if (now - last > STALE_AFTER_MS) {
        const mins = Math.round((now - last) / 60000)
        out.push({ type: 'stale', taskGroupId, message: `${s.agentId} has posted no update in ${mins}m`, at: now })
      }
    }
    return out
  }

  private async buildPlan(group: TaskGroupOverview, shells: { agentId: string; model: string | null; reasoning: string | null; verbosity: string | null }[]): Promise<TaskPlan> {
    const wtl = new WorktreeLifecycle(group.repoPath)
    const slug = WorktreeLifecycle.sanitizeTaskSlug(group.title)
    const branchName = group.branchName ?? wtl.buildTaskBranchName(group.id, slug)
    // 'none' has no worktree at all — the agent's cwd is the workspace folder.
    const worktreePath = group.worktreePath
      ?? (group.worktreeMode === 'in-repo' || group.worktreeMode === 'none' ? group.repoPath : wtl.getTaskWorktreePath(group.id))
    return planTask(
      {
        taskTitle: group.title,
        userGoal: group.userGoal,
        branchName,
        worktreePath,
        worktreeMode: group.worktreeMode,
        integrationBranch: this.integrationBranchOrUndefined(),
      },
      shells.map(s => ({ agentId: s.agentId, model: s.model, reasoning: s.reasoning, verbosity: s.verbosity })),
      this.repoTreeFor(group.repoPath),
      this.opts?.llm
    )
  }

  private safeRevParse(repoPath: string, ref: string): string | null {
    try {
      return execFileSync('git', ['rev-parse', ref], { cwd: repoPath, encoding: 'utf-8', timeout: 15000 }).trim() || null
    } catch {
      return null
    }
  }
}
