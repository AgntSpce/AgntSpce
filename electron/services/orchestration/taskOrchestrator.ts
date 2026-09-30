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
  buildTaskAssignments,
  writeTaskMetaFile,
  type PlanAgentInput,
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
      slotTimeoutMs?: number
    }
  ) {}


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
   *  Only 'planning' (or 'paused' after a failed launch) groups launch. A merged
   *  task stays 'active' with its worktree and agents intact, so it is never
   *  relaunched - work simply continues. */
  async launchTask(taskGroupId: string): Promise<LaunchResult> {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    if (group.status !== 'planning' && group.status !== 'paused') {
      throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} is ${group.status}, expected planning/paused`)
    }
    const shells = this.sm.listSubTasks(taskGroupId)
    if (shells.length === 0) throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} has no agents`)

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

    // Every agent gets the whole goal. There is no split to record, so the
    // meta file is just who is taking part.
    const assignments = buildTaskAssignments(
      this.planContext({ ...group, branchName, worktreePath }, shells),
      shells.map(s => ({ agentId: s.agentId, model: s.model, reasoning: s.reasoning, verbosity: s.verbosity })),
    )
    writeTaskMetaFile(cwd, {
      taskGroupId: group.id,
      branchName,
      baseSha,
      worktreeMode: group.worktreeMode,
      agents: shells.map(s => s.agentId),
    })
    for (const a of assignments) {
      const shell = shells.find(x => x.agentId === a.agentId)
      if (shell) this.sm.updateSubTaskAssignment(shell.id, a.assignmentPrompt)
    }
    new CollabShim(this.sm, group.repoPath).seed(group.id)

    // Reserve every slot before spawning the first agent.
    let releases: (() => void)[]
    try {
      releases = await this.slots.tryAcquire(shells.length, this.opts?.slotTimeoutMs ?? 30000)
    } catch (err: any) {
      this.sm.updateTaskGroup(group.id, { status: 'paused' })
      throw new CoordinatorError('NO_CAPACITY', err?.message || 'Not enough agent slots right now — reduce agents or wait for another task to finish')
    }

    const sessionIds: string[] = []
    try {
      const fresh = this.sm.listSubTasks(group.id)
      for (const s of fresh) {
        if (s.status === 'done') continue
        const sid = await this.spawner.spawnTaskSubtask({
          taskGroupId: group.id,
          subtaskId: s.id,
          agentId: s.agentId,
          model: s.model ?? undefined,
          reasoning: s.reasoning ?? undefined,
          verbosity: s.verbosity ?? undefined,
          prompt: s.assignmentPrompt,
          cwd,
          worktreeId: group.id,
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
    return { taskGroupId: group.id, sessionIds }
  }

  /** Follow-up: stop running agents, hand them the goal plus the new message,
   *  re-seed, and respawn only the non-done ones. There is nothing to re-plan —
   *  every agent already has the whole goal, so a follow-up is just more of it. */
  async followUpTask(taskGroupId: string, followUp: string): Promise<LaunchResult> {
    const groupIdLabel = (g: TaskGroupOverview) => `"${g.title}"`
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const message = followUp.trim()
    if (!message) throw new CoordinatorError('INVALID', 'Follow-up message is empty')
    // A finished task's worktree is gone. Following up used to relaunch its
    // agents into that deleted directory, which fails silently and leaves a bare
    // shell — and, before the merge started closing sessions, one that looked
    // to the agent like its environment had been swapped.
    if (group.status === 'done' || group.status === 'abandoned') {
      throw new CoordinatorError('INVALID_STATE', `Task ${groupIdLabel(group)} has already been merged and its worktree is gone. Start a new task instead.`)
    }
    if (group.worktreePath && !fs.existsSync(group.worktreePath)) {
      throw new CoordinatorError('INVALID_STATE', 'This task\'s worktree no longer exists, so its agents cannot be restarted. Create the task again.')
    }

    const subs = this.sm.listSubTasks(taskGroupId)
    const runningIds = subs.filter(s => s.status === 'running' && s.sessionId).map(s => s.sessionId as string)
    try { this.spawner.closeTaskSessions(runningIds) } catch {}
    for (const s of subs) {
      if (s.status === 'running') this.sm.updateSubTaskStatus(s.id, 'pending', null)
    }

    const agents: PlanAgentInput[] = subs
      .filter(s => s.status !== 'done')
      .map(s => ({ agentId: s.agentId, model: s.model, reasoning: s.reasoning, verbosity: s.verbosity }))
    if (agents.length === 0) throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} is fully done — no unfinished agents to follow up`)

    const assignments = buildTaskAssignments(
      this.planContext(group, agents, message),
      agents,
    )
    for (const a of assignments) {
      const shell = subs.find(s => s.agentId === a.agentId && s.status !== 'done')
      if (shell) this.sm.updateSubTaskAssignment(shell.id, a.assignmentPrompt)
    }
    const cwd = group.worktreePath ?? group.repoPath
    const current = this.sm.listSubTasks(taskGroupId)
    writeTaskMetaFile(cwd, {
      taskGroupId: group.id,
      branchName: group.branchName ?? '',
      baseSha: group.baseSha,
      worktreeMode: group.worktreeMode,
      agents: agents.map(a => a.agentId),
    })
    new CollabShim(this.sm, group.repoPath).refresh(group.id)
    this.sm.updateTaskGroup(group.id, { status: 'active' })

    let releases: (() => void)[]
    try {
      releases = await this.slots.tryAcquire(agents.length, this.opts?.slotTimeoutMs ?? 30000)
    } catch (err: any) {
      this.sm.updateTaskGroup(group.id, { status: 'paused' })
      throw new CoordinatorError('NO_CAPACITY', err?.message || 'Not enough agent slots right now')
    }
    const sessionIds: string[] = []
    try {
      for (const s of current) {
        if (s.status === 'done') continue
        const sid = await this.spawner.spawnTaskSubtask({
          taskGroupId: group.id,
          subtaskId: s.id,
          agentId: s.agentId,
          model: s.model ?? undefined,
          reasoning: s.reasoning ?? undefined,
          verbosity: s.verbosity ?? undefined,
          prompt: s.assignmentPrompt,
          cwd,
          worktreeId: group.id,
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
    return { taskGroupId: group.id, sessionIds }
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

  /** The assignment context every agent in this task shares.
   *
   *  There is no planning step: this resolves the worktree/branch and states how
   *  many agents share the task, and `buildTaskAssignments` hands each one the
   *  whole goal. Splitting the goal was the old LLM planner's job, and it had
   *  strictly less information than the agents do. */
  private planContext(group: TaskGroupOverview, shells: { agentId: string }[], followUp?: string): PlanContext {
    const wtl = new WorktreeLifecycle(group.repoPath)
    const slug = WorktreeLifecycle.sanitizeTaskSlug(group.title)
    const branchName = group.branchName ?? wtl.buildTaskBranchName(group.id, slug)
    // 'none' has no worktree at all — the agent's cwd is the workspace folder.
    const worktreePath = group.worktreePath
      ?? (group.worktreeMode === 'in-repo' || group.worktreeMode === 'none' ? group.repoPath : wtl.getTaskWorktreePath(group.id))
    return {
      taskTitle: group.title,
      userGoal: group.userGoal,
      branchName,
      worktreePath,
      worktreeMode: group.worktreeMode,
      integrationBranch: this.integrationBranchOrUndefined(),
      agentCount: shells.length,
      followUp,
    }
  }

  private safeRevParse(repoPath: string, ref: string): string | null {
    try {
      return execFileSync('git', ['rev-parse', ref], { cwd: repoPath, encoding: 'utf-8', timeout: 15000 }).trim() || null
    } catch {
      return null
    }
  }
}
