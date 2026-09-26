import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { createSchema, migrateSchema } from './schema'

export interface AgentRow {
  id: string
  name: string
  agent_type: string
  status: 'active' | 'idle' | 'paused'
  capabilities: string
  registered_at: number
  last_seen: number
  session_summary: string
}

export interface TaskRow {
  id: string
  description: string
  status: 'open' | 'claimed' | 'in_progress' | 'merging' | 'done' | 'escalated' | 'abandoned' | 'setup_failed'
  declared_files: string
  actual_files: string | null
  branch_name: string | null
  worktree_path: string | null
  agent_id: string | null
  created_at: number
  completed_at: number | null
  branch_point: string | null
  failure_count: number
}

export interface SessionRow {
  id: string
  workspace_id: string | null
  session_type: string
  agent_id: string | null
  task_id: string | null
  task_group_id: string | null
  subtask_id: string | null
  status: string
  branch: string | null
  worktree_id: string | null
  created_at: number
  last_activity: number
  closed_at: number | null
}

export interface MessageRow {
  id: string
  from_agent_id: string
  to_agent_id: string | null
  broadcast: number
  content: string
  created_at: number
  read_by: string
  deliver_only_when_idle: number
}

export interface EscalationRow {
  id: string
  reason: string
  details: string
  involved_agent_ids: string
  status: 'open' | 'resolved'
  decision: string | null
  created_at: number
  resolved_at: number | null
}

export interface StatusUpdateRow {
  id: string
  task_id: string
  agent_id: string
  text: string
  created_at: number
}

export interface GateRow {
  id: string
  task_id: string
  status: 'blocked' | 'approved' | 'rejected'
  reason: string
  decision: string | null
  created_at: number
  resolved_at: number | null
}

export interface GateInfo {
  id: string
  taskId: string
  status: 'blocked' | 'approved' | 'rejected'
  reason: string
  decision: string | null
  createdAt: number
  resolvedAt: number | null
}

export interface WorkspaceContextResult {
  agents: { id: string; name: string; type: string; status: string }[]
  tasks: { id: string; description: string; status: string; agentId: string | null }[]
  openEscalations: number
}

export interface TaskOverview {
  id: string
  description: string
  status: string
  declaredFiles: string[]
  actualFiles: string[] | null
  branchName: string | null
  worktreePath: string | null
  branchPoint: string | null
  agentId: string | null
  createdAt: number
  completedAt: number | null
  failureCount: number
}

export interface TaskGroupRow {
  id: string
  workspace_id: string | null
  repo_path: string
  title: string
  user_goal: string
  status: 'planning' | 'active' | 'paused' | 'merging' | 'done' | 'abandoned'
  worktree_mode: 'worktree' | 'in-repo' | 'none'
  branch_name: string | null
  worktree_path: string | null
  base_sha: string | null
  created_at: number
  completed_at: number | null
  pinned_at: number | null
  merge_candidate_ref: string | null
  merge_candidate_base: string | null
}

export interface TaskGroupOverview {
  id: string
  workspaceId: string | null
  repoPath: string
  title: string
  userGoal: string
  status: string
  worktreeMode: 'worktree' | 'in-repo' | 'none'
  branchName: string | null
  worktreePath: string | null
  baseSha: string | null
  createdAt: number
  completedAt: number | null
  pinnedAt: number | null
  /** Branch holding a prepared-but-unconfirmed merge commit, if any. */
  mergeCandidateRef: string | null
  /** Integration tip the prepared candidate was built on. */
  mergeCandidateBase: string | null
}

export interface SubTaskRow {
  id: string
  task_group_id: string
  agent_id: string
  model: string | null
  reasoning: string | null
  verbosity: string | null
  title: string
  assignment_prompt: string
  scope_files: string
  status: 'pending' | 'running' | 'done' | 'failed'
  session_id: string | null
  last_event_at: number | null
  created_at: number
  completed_at: number | null
}

export interface SubTaskOverview {
  id: string
  taskGroupId: string
  agentId: string
  model: string | null
  reasoning: string | null
  verbosity: string | null
  title: string
  assignmentPrompt: string
  scopeFiles: string[]
  status: string
  sessionId: string | null
  lastEventAt: number | null
  createdAt: number
  completedAt: number | null
}

export type CollabEventKind = 'progress' | 'claim' | 'release' | 'request' | 'done'

export interface CollabEventRow {
  id: string
  task_group_id: string
  subtask_id: string
  agent_id: string
  kind: CollabEventKind
  payload: string
  file: string | null
  created_at: number
  expires_at: number | null
}

export interface CollabEvent {
  id: string
  taskGroupId: string
  subtaskId: string
  agentId: string
  kind: CollabEventKind
  payload: Record<string, unknown>
  file: string | null
  createdAt: number
  expiresAt: number | null
}

export interface SessionOverview {
  id: string
  workspaceId: string | null
  sessionType: string
  agentId: string | null
  taskId: string | null
  taskGroupId: string | null
  subtaskId: string | null
  status: string
  branch: string | null
  worktreeId: string | null
  createdAt: number
  lastActivity: number
  closedAt: number | null
}

export interface WorktreeRow {
  id: string
  repo_path: string
  branch_name: string | null
  worktree_path: string | null
  source_ref: string | null
  task_id: string | null
  session_id: string | null
  created_at: number
  removed_at: number | null
}

export interface WorktreeOverview {
  id: string
  repoPath: string
  branchName: string | null
  worktreePath: string | null
  sourceRef: string | null
  taskId: string | null
  sessionId: string | null
  createdAt: number
  removedAt: number | null
}

export interface AgentInfo {
  id: string
  name: string
  agentType: string
  status: string
  capabilities: string[]
  registeredAt: number
  lastSeen: number
  sessionSummary: string
}

export interface MessageInfo {
  id: string
  fromAgentId: string
  toAgentId: string | null
  broadcast: boolean
  content: string
  createdAt: number
  deliverOnlyWhenIdle: boolean
}

export interface EscalationInfo {
  id: string
  reason: string
  details: string
  involvedAgentIds: string[]
  status: string
  decision: string | null
  createdAt: number
  resolvedAt: number | null
}

export interface StatusUpdateInfo {
  id: string
  taskId: string
  agentId: string
  text: string
  createdAt: number
}

const STALE_AGENT_TIMEOUT_MS = 5 * 60 * 1000

export class CoordinatorError extends Error {
  code: string
  data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'CoordinatorError'
    this.code = code
    this.data = data
  }
}

export class StateManager {
  private db: Database.Database
  private workspaceRepoPath: string
  private lastTouchAt = new Map<string, number>()

  constructor(dbPath: string, workspaceRepoPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.workspaceRepoPath = workspaceRepoPath
    createSchema(this.db)
    migrateSchema(this.db)
    this.initSystemAgent()
    this.initIntegrationBranch()
  }

  private initSystemAgent(): void {
    const existing = this.db.prepare("SELECT id FROM agents WHERE name = 'coordinator'").get() as { id: string } | undefined
    if (!existing) {
      const id = 'agntspce-coordinator'
      const now = Date.now()
      this.db.prepare(
        'INSERT INTO agents (id, name, agent_type, status, capabilities, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'coordinator', 'system', 'active', JSON.stringify(['coordinator']), now, now)
    }
  }

  getRepoPath(): string {
    return this.workspaceRepoPath
  }

  getDb(): Database.Database {
    return this.db
  }

  getIntegrationBranch(): string {
    const row = this.db.prepare("SELECT value FROM workspace_config WHERE key = 'integration_branch'").get() as { value: string } | undefined
    if (row?.value) return row.value
    return this.initIntegrationBranch()
  }

  /** Run git with piped stdio. These are best-effort capability probes (a
   *  workspace folder may not be a repo at all), so they must never print
   *  `fatal: not a git repository` into the host terminal — the message is
   *  folded into the thrown error instead. */
  private gitOut(args: string[], timeout = 5000): string {
    return execFileSync('git', args, {
      cwd: this.workspaceRepoPath, encoding: 'utf-8', timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim()
  }

  getSourceBranch(): string {
    const row = this.db.prepare("SELECT value FROM workspace_config WHERE key = 'source_branch'").get() as { value: string } | undefined
    if (row?.value) return row.value
    return this.detectSourceBranch()
  }

  private detectSourceBranch(): string {
    try {
      const head = this.gitOut(['symbolic-ref', '--short', 'HEAD'])
      this.db.prepare("UPDATE workspace_config SET value = ? WHERE key = 'source_branch'").run(head)
      return head
    } catch {
      return 'main'
    }
  }

  /** The branch every task in this workspace merges into.
   *
   *  Named after the workspace folder so the user can see it in `git branch`
   *  and merge it into their own branch themselves — an internal fixed name
   *  gave them no way to know it existed. Sanitized to a valid git ref: no
   *  spaces, no `..`, no leading/trailing punctuation. Unicode-only names
   *  collapse to the `workspace` fallback rather than producing a ref that is
   *  awkward in a terminal. */
  defaultIntegrationBranchName(): string {
    const base = path.basename(this.workspaceRepoPath.replace(/[\\/]+$/, '')).replace(/\.git$/i, '')
    const sanitized = base
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+/, '')
      .replace(/[.-]+$/, '')
      .slice(0, 48)
    return `${sanitized || 'workspace'}_agntspce`
  }

  initIntegrationBranch(): string {
    const integrationBranch = this.defaultIntegrationBranchName()
    let exists = false
    try {
      this.gitOut(['rev-parse', '--verify', integrationBranch])
      exists = true
    } catch {
      const sourceBranch = this.getSourceBranch()
      try {
        const sourceSha = this.gitOut(['rev-parse', sourceBranch])
        this.gitOut(['branch', integrationBranch, sourceSha])
        exists = true
      } catch {}
    }
    // Only remember the branch once git actually has it. Caching a branch that
    // was never created leaves a stale config row that keeps failing — even
    // after the folder is `git init`-ed later.
    if (exists) {
      this.db.prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run(integrationBranch)
    }
    return integrationBranch
  }

  getIntegrationBranchSha(): string {
    const branch = this.getIntegrationBranch()
    try {
      return this.gitOut(['rev-parse', branch])
    } catch {
      return ''
    }
  }

  configureIntegrationBranch(branch: string): string {
    const sha = this.gitOut(['rev-parse', branch])
    this.db.prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run(branch)

    const existing = this.gitOut(['rev-parse', '--verify', branch])
    if (!existing) {
      this.gitOut(['branch', branch, sha])
    }
    return sha
  }

  validateRef(ref: string): string | null {
    try {
      return this.gitOut(['rev-parse', '--verify', ref])
    } catch {
      return null
    }
  }

  isRefCheckedOut(ref: string): boolean {
    try {
      const branches = execFileSync('git', ['branch', '--list', ref], { cwd: this.workspaceRepoPath, encoding: 'utf-8', timeout: 5000 })
      return branches.includes('*')
    } catch {
      return false
    }
  }

  getActiveBranch(): string | null {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.workspaceRepoPath, encoding: 'utf-8', timeout: 5000 }).trim()
    } catch {
      return null
    }
  }

  getActiveBranchHead(): string {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.workspaceRepoPath, encoding: 'utf-8', timeout: 5000 }).trim()
    } catch {
      return ''
    }
  }

  close(): void {
    this.db.close()
  }

  // ── Agent CRUD ──

  registerAgent(name: string, agentType: string, capabilities: string[]): AgentInfo {
    const id = uuid()
    const now = Date.now()
    const stmt = this.db.prepare(
      'INSERT INTO agents (id, name, agent_type, status, capabilities, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    stmt.run(id, name, agentType, 'active', JSON.stringify(capabilities), now, now)
    return this.getAgent(id)!
  }

  getAgent(id: string): AgentInfo | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    if (!row) return null
    return this.rowToAgent(row)
  }

  updateAgentStatus(id: string, status: 'active' | 'idle' | 'paused'): void {
    this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id)
  }

  updateLastSeen(id: string): void {
    this.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now(), id)
  }

  updateSessionSummary(id: string, summary: string): void {
    this.db.prepare('UPDATE agents SET session_summary = ? WHERE id = ?').run(summary, id)
  }

  listAgents(): AgentInfo[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY registered_at ASC').all() as AgentRow[]
    return rows.map(r => this.rowToAgent(r))
  }

  getActiveAgents(): AgentInfo[] {
    const rows = this.db.prepare("SELECT * FROM agents WHERE status IN ('active', 'idle') ORDER BY registered_at ASC").all() as AgentRow[]
    return rows.map(r => this.rowToAgent(r))
  }

  private rowToAgent(row: AgentRow): AgentInfo {
    return {
      id: row.id,
      name: row.name,
      agentType: row.agent_type,
      status: row.status,
      capabilities: JSON.parse(row.capabilities),
      registeredAt: row.registered_at,
      lastSeen: row.last_seen,
      sessionSummary: row.session_summary,
    }
  }

  // ── Task CRUD ──

  createTask(description: string, declaredFiles: string[]): TaskOverview {
    const id = uuid()
    const now = Date.now()
    const stmt = this.db.prepare(
      'INSERT INTO tasks (id, description, status, declared_files, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    stmt.run(id, description, 'open', JSON.stringify(declaredFiles), now)
    return this.getTask(id)!
  }

  ensureSessionTask(sessionId: string, sessionType: string, description: string): TaskOverview {
    const session = this.getSession(sessionId)
    if (session?.taskId) {
      const existing = this.getTask(session.taskId)
      if (existing) return existing
    }
    const task = this.createTask(description, [])
    this.linkSessionToTask(sessionId, task.id)
    // Clean up duplicate "Ad-hoc … session" bookkeeping rows that accumulated
    // when registerSession used to wipe session.task_id and create a fresh task
    // on every registration/restart.
    this.closeDuplicateSessionTasks(task.id, description)
    return task
  }

  // Abandon other active tasks that share the same session-bookkeeping
  // description (same session suffix). Keeps the DB and preamble clean.
  closeDuplicateSessionTasks(keepTaskId: string, description: string): void {
    try {
      this.db.prepare(
        "UPDATE tasks SET status = 'abandoned', completed_at = ? WHERE description = ? AND id != ? AND status IN ('open', 'claimed', 'in_progress', 'merging', 'setup_failed')"
      ).run(Date.now(), description, keepTaskId)
    } catch (err: any) {
      console.error('[stateManager] closeDuplicateSessionTasks failed:', err?.message || err)
    }
  }

  getTask(id: string): TaskOverview | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!row) return null
    return this.rowToTask(row)
  }

  listTasks(): TaskOverview[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as TaskRow[]
    return rows.map(r => this.rowToTask(r))
  }

  getActiveTasks(): TaskOverview[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status IN ('claimed', 'in_progress', 'merging', 'setup_failed') ORDER BY created_at ASC").all() as TaskRow[]
    return rows.map(r => this.rowToTask(r))
  }

  claimTask(taskId: string, agentId: string, branchName: string, worktreePath: string, branchPoint: string): TaskOverview {
    const task = this.getTask(taskId)
    if (!task) throw new CoordinatorError('NOT_FOUND', `Task ${taskId} not found`)
    if (task.status !== 'open') throw new CoordinatorError('INVALID_STATE', `Task ${taskId} is not open (status: ${task.status})`)

    const overlap = this.checkFileOverlap(task.declaredFiles, taskId)
    if (overlap.overlaps) {
      throw new CoordinatorError('OVERLAP', `File overlap: ${overlap.conflictingFiles.join(', ')} is claimed by another active task`, {
        conflictingFiles: overlap.conflictingFiles,
        conflictingTaskIds: overlap.conflictingTaskIds,
      })
    }

    this.db.prepare(
      'UPDATE tasks SET status = ?, agent_id = ?, branch_name = ?, worktree_path = ?, branch_point = ? WHERE id = ?'
    ).run('claimed', agentId, branchName, worktreePath, branchPoint, taskId)

    return this.getTask(taskId)!
  }

  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    'open': ['in_progress', 'setup_failed', 'abandoned'],
    'claimed': ['in_progress', 'setup_failed', 'abandoned'],
    'setup_failed': ['in_progress', 'abandoned'],
    'in_progress': ['merging', 'abandoned'],
    'merging': ['done', 'escalated', 'abandoned'],
    'done': [],
    'escalated': ['abandoned'],
    'abandoned': [],
  }

  transitionTaskStatus(taskId: string, newStatus: TaskRow['status']): void {
    const task = this.getTask(taskId)
    if (!task) throw new CoordinatorError('NOT_FOUND', `Task ${taskId} not found`)

    const allowed = StateManager.VALID_TRANSITIONS[task.status]
    if (!allowed || !allowed.includes(newStatus)) {
      throw new CoordinatorError('INVALID_STATE',
        `Cannot transition task ${taskId} from '${task.status}' to '${newStatus}'`)
    }

    if (newStatus === 'done') {
      this.db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?').run(newStatus, Date.now(), taskId)
    } else {
      this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(newStatus, taskId)
    }
  }

  updateTaskActualFiles(taskId: string, files: string[]): void {
    this.db.prepare('UPDATE tasks SET actual_files = ? WHERE id = ?').run(JSON.stringify(files), taskId)
  }

  // Claim enforcement for the session-start path (1.5). Every session that
  // launches an agent must declare its scope before the agent starts. If the
  // declared files overlap another active task, claim is rejected (thrown).
  // Sessions in the same parallel group run in isolated worktrees, so their
  // tasks are excluded from the overlap check against one another.
  claimSessionTask(sessionId: string, agentId: string, declaredFiles: string[], excludeSessionIds: string[] = []): TaskOverview {
    const session = this.getSession(sessionId)
    if (!session) throw new CoordinatorError('NOT_FOUND', `Session ${sessionId} not found`)

    let task = session.taskId ? this.getTask(session.taskId) : null

    // A terminal task (already done/abandoned/escalated) must not block a
    // fresh session start — unlink it and open a new task for this session.
    if (task && (task.status === 'done' || task.status === 'abandoned' || task.status === 'escalated')) {
      this.db.prepare('UPDATE sessions SET task_id = NULL WHERE id = ?').run(sessionId)
      task = null
    }

    if (!task) {
      task = this.ensureSessionTask(sessionId, agentId, `Session ${sessionId.slice(-8)}`)
    }

    const excludeTaskIds = new Set<string>()
    for (const sid of excludeSessionIds) {
      const s = this.getSession(sid)
      if (s?.taskId) excludeTaskIds.add(s.taskId)
    }
    excludeTaskIds.add(task.id)

    const overlap = this.checkFileOverlap(declaredFiles, task.id, excludeSessionIds.length > 0 ? [...excludeTaskIds] : undefined)
    if (overlap.overlaps) {
      throw new CoordinatorError('OVERLAP', `File overlap: ${overlap.conflictingFiles.join(', ')} is claimed by another active task`, {
        conflictingFiles: overlap.conflictingFiles,
        conflictingTaskIds: overlap.conflictingTaskIds,
      })
    }

    this.db.prepare('UPDATE tasks SET declared_files = ?, agent_id = ? WHERE id = ?')
      .run(JSON.stringify(declaredFiles), this.resolveAgentRef(agentId), task.id)

    if (task.status === 'open') {
      this.transitionTaskStatus(task.id, 'in_progress')
    }

    return this.getTask(task.id)!
  }

  releaseTask(taskId: string): void {
    this.db.prepare(
      "UPDATE tasks SET agent_id = NULL WHERE id = ? AND status IN ('claimed', 'in_progress', 'setup_failed')"
    ).run(taskId)
  }

  private rowToTask(row: TaskRow): TaskOverview {
    return {
      id: row.id,
      description: row.description,
      status: row.status,
      declaredFiles: JSON.parse(row.declared_files),
      actualFiles: row.actual_files ? JSON.parse(row.actual_files) : null,
      branchName: row.branch_name,
      worktreePath: row.worktree_path,
      branchPoint: row.branch_point,
      agentId: row.agent_id,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }
  }

  // ── Failure Tracking (circuit breaker) ──

  getTaskFailureCount(taskId: string): number {
    const row = this.db.prepare('SELECT failure_count FROM tasks WHERE id = ?').get(taskId) as { failure_count: number } | undefined
    return row?.failure_count ?? 0
  }

  recordTaskFailure(taskId: string): number {
    this.db.prepare('UPDATE tasks SET failure_count = failure_count + 1 WHERE id = ?').run(taskId)
    return this.getTaskFailureCount(taskId)
  }

  resetTaskFailures(taskId: string): void {
    this.db.prepare('UPDATE tasks SET failure_count = 0 WHERE id = ?').run(taskId)
  }

  // 3.3 circuit breaker: a task that keeps failing is released back to `open`
  // (agent/branch/worktree cleared) so another agent can claim it fresh.
  // Returns the released task, or null if it couldn't be released.
  redispatchTask(taskId: string): TaskOverview | null {
    const task = this.getTask(taskId)
    if (!task) return null
    if (task.status === 'done' || task.status === 'abandoned') return null
    this.db.prepare(
      "UPDATE tasks SET status = 'open', agent_id = NULL, branch_name = NULL, worktree_path = NULL, branch_point = NULL WHERE id = ?"
    ).run(taskId)
    return this.getTask(taskId)
  }

  // ── TaskGroup / SubTask / Collab (v2 Tasks system) ──
  // The legacy flat `tasks` table above stays untouched; all new Task
  // orchestration goes through these tables. agent_id columns here are raw
  // CLI agent strings (no agents-FK) so UI-launched sessions never violate FKs.

  createTaskGroup(input: {
    workspaceId?: string | null
    repoPath: string
    title: string
    userGoal?: string
    worktreeMode?: 'worktree' | 'in-repo' | 'none'
  }): TaskGroupOverview {
    const id = uuid()
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO task_groups (id, workspace_id, repo_path, title, user_goal, status, worktree_mode, created_at)
       VALUES (?, ?, ?, ?, ?, 'planning', ?, ?)`
    ).run(
      id,
      input.workspaceId ?? null,
      input.repoPath,
      input.title,
      input.userGoal ?? '',
      input.worktreeMode ?? 'worktree',
      now
    )
    return this.getTaskGroup(id)!
  }

  getTaskGroup(id: string): TaskGroupOverview | null {
    const row = this.db.prepare('SELECT * FROM task_groups WHERE id = ?').get(id) as TaskGroupRow | undefined
    if (!row) return null
    return this.rowToTaskGroup(row)
  }

  // Pinned tasks first (most recently pinned first), then the rest in creation
  // order. `(pinned_at IS NULL)` is 0 for pinned rows, so ASC floats them up.
  listTaskGroups(workspaceId?: string): TaskGroupOverview[] {
    const order = 'ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, created_at ASC'
    const rows = workspaceId
      ? (this.db.prepare(`SELECT * FROM task_groups WHERE workspace_id = ? ${order}`).all(workspaceId) as TaskGroupRow[])
      : (this.db.prepare(`SELECT * FROM task_groups ${order}`).all() as TaskGroupRow[])
    return rows.map(r => this.rowToTaskGroup(r))
  }

  updateTaskGroup(id: string, updates: {
    status?: TaskGroupRow['status']
    branchName?: string | null
    worktreePath?: string | null
    baseSha?: string | null
    completedAt?: number | null
    title?: string
    userGoal?: string
    pinnedAt?: number | null
    mergeCandidateRef?: string | null
    mergeCandidateBase?: string | null
  }): TaskGroupOverview | null {
    const group = this.getTaskGroup(id)
    if (!group) return null
    const next = {
      status: updates.status ?? group.status,
      branch_name: updates.branchName !== undefined ? updates.branchName : group.branchName,
      worktree_path: updates.worktreePath !== undefined ? updates.worktreePath : group.worktreePath,
      base_sha: updates.baseSha !== undefined ? updates.baseSha : group.baseSha,
      completed_at: updates.completedAt !== undefined ? updates.completedAt : group.completedAt,
      title: updates.title ?? group.title,
      user_goal: updates.userGoal ?? group.userGoal,
      pinned_at: updates.pinnedAt !== undefined ? updates.pinnedAt : group.pinnedAt,
      merge_candidate_ref: updates.mergeCandidateRef !== undefined ? updates.mergeCandidateRef : group.mergeCandidateRef,
      merge_candidate_base: updates.mergeCandidateBase !== undefined ? updates.mergeCandidateBase : group.mergeCandidateBase,
    }
    if (next.status === 'done' && next.completed_at == null) next.completed_at = Date.now()
    this.db.prepare(
      'UPDATE task_groups SET status = ?, branch_name = ?, worktree_path = ?, base_sha = ?, completed_at = ?, title = ?, user_goal = ?, pinned_at = ?, merge_candidate_ref = ?, merge_candidate_base = ? WHERE id = ?'
    ).run(next.status, next.branch_name, next.worktree_path, next.base_sha, next.completed_at, next.title, next.user_goal, next.pinned_at, next.merge_candidate_ref, next.merge_candidate_base, id)
    return this.getTaskGroup(id)
  }

  /** Hard-delete a task group and everything under it (subtasks, events).
   *  Worktree/branch on disk are left to the caller (TaskOrchestrator). */
  deleteTaskGroup(id: string): boolean {
    const existing = this.db.prepare('SELECT id FROM task_groups WHERE id = ?').get(id) as { id: string } | undefined
    if (!existing) return false
    this.db.prepare('DELETE FROM collab_events WHERE task_group_id = ?').run(id)
    this.db.prepare('DELETE FROM subtasks WHERE task_group_id = ?').run(id)
    this.db.prepare('DELETE FROM task_groups WHERE id = ?').run(id)
    return true
  }

  private rowToTaskGroup(row: TaskGroupRow): TaskGroupOverview {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      repoPath: row.repo_path,
      title: row.title,
      userGoal: row.user_goal,
      status: row.status,
      worktreeMode: row.worktree_mode,
      branchName: row.branch_name,
      worktreePath: row.worktree_path,
      baseSha: row.base_sha,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      pinnedAt: row.pinned_at ?? null,
      mergeCandidateRef: row.merge_candidate_ref ?? null,
      mergeCandidateBase: row.merge_candidate_base ?? null,
    }
  }

  addSubTask(input: {
    taskGroupId: string
    agentId: string
    model?: string | null
    reasoning?: string | null
    verbosity?: string | null
    title?: string
    assignmentPrompt?: string
    scopeFiles?: string[]
  }): SubTaskOverview {
    const group = this.getTaskGroup(input.taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `TaskGroup ${input.taskGroupId} not found`)
    const id = uuid()
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO subtasks (id, task_group_id, agent_id, model, reasoning, verbosity, title, assignment_prompt, scope_files, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      id,
      input.taskGroupId,
      input.agentId,
      input.model ?? null,
      input.reasoning ?? null,
      input.verbosity ?? null,
      input.title ?? '',
      input.assignmentPrompt ?? '',
      JSON.stringify(input.scopeFiles ?? []),
      now
    )
    return this.getSubTask(id)!
  }

  getSubTask(id: string): SubTaskOverview | null {
    const row = this.db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id) as SubTaskRow | undefined
    if (!row) return null
    return this.rowToSubTask(row)
  }

  listSubTasks(taskGroupId: string): SubTaskOverview[] {
    const rows = this.db.prepare('SELECT * FROM subtasks WHERE task_group_id = ? ORDER BY created_at ASC').all(taskGroupId) as SubTaskRow[]
    return rows.map(r => this.rowToSubTask(r))
  }

  updateSubTaskStatus(id: string, status: SubTaskRow['status'], sessionId?: string | null): SubTaskOverview | null {
    const sub = this.getSubTask(id)
    if (!sub) return null
    const completedAt = status === 'done' || status === 'failed' ? Date.now() : null
    if (sessionId !== undefined) {
      this.db.prepare('UPDATE subtasks SET status = ?, session_id = ?, completed_at = ? WHERE id = ?').run(status, sessionId, completedAt, id)
    } else {
      this.db.prepare('UPDATE subtasks SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id)
    }
    return this.getSubTask(id)
  }

  /** Replan update: replaces a subtask's assignment (title/scope/prompt)
   *  without touching its status/session linkage. */
  updateSubTaskPlan(id: string, plan: { title?: string; scopeFiles?: string[]; assignmentPrompt?: string }): SubTaskOverview | null {
    const sub = this.getSubTask(id)
    if (!sub) return null
    this.db.prepare('UPDATE subtasks SET title = ?, scope_files = ?, assignment_prompt = ? WHERE id = ?').run(
      plan.title ?? sub.title,
      JSON.stringify(plan.scopeFiles ?? sub.scopeFiles),
      plan.assignmentPrompt ?? sub.assignmentPrompt,
      id
    )
    return this.getSubTask(id)
  }

  private rowToSubTask(row: SubTaskRow): SubTaskOverview {
    return {
      id: row.id,
      taskGroupId: row.task_group_id,
      agentId: row.agent_id,
      model: row.model,
      reasoning: row.reasoning,
      verbosity: row.verbosity,
      title: row.title,
      assignmentPrompt: row.assignment_prompt,
      scopeFiles: JSON.parse(row.scope_files || '[]'),
      status: row.status,
      sessionId: row.session_id,
      lastEventAt: row.last_event_at,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }
  }

  // ── Collab events (CLI-shim write path; COLLAB.md is rendered from these) ──

  appendCollabEvent(input: {
    taskGroupId: string
    subtaskId: string
    agentId: string
    kind: CollabEventKind
    payload?: Record<string, unknown>
    ttlMs?: number | null
  }): CollabEvent {
    const id = uuid()
    const now = Date.now()
    const expiresAt = input.ttlMs ? now + input.ttlMs : null
    const payload = input.payload ?? {}
    // Claim/release rows carry their file as a first-class column so holder
    // lookups filter in SQL (no client-side row window to fall out of).
    const file = (input.kind === 'claim' || input.kind === 'release')
      && typeof payload.file === 'string' ? payload.file : null
    this.db.prepare(
      'INSERT INTO collab_events (id, task_group_id, subtask_id, agent_id, kind, payload, file, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.taskGroupId, input.subtaskId, input.agentId, input.kind, JSON.stringify(payload), file, now, expiresAt)
    this.db.prepare('UPDATE subtasks SET last_event_at = ? WHERE id = ?').run(now, input.subtaskId)
    return this.getCollabEvent(id)!
  }

  getCollabEvent(id: string): CollabEvent | null {
    const row = this.db.prepare('SELECT * FROM collab_events WHERE id = ?').get(id) as CollabEventRow | undefined
    if (!row) return null
    return this.rowToCollabEvent(row)
  }

  getCollabEvents(taskGroupId: string, since = 0): CollabEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM collab_events WHERE task_group_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC'
    ).all(taskGroupId, since) as CollabEventRow[]
    return rows.map(r => this.rowToCollabEvent(r))
  }

  private rowToCollabEvent(row: CollabEventRow): CollabEvent {
    let payload: Record<string, unknown> = {}
    try { payload = JSON.parse(row.payload || '{}') } catch {}
    return {
      id: row.id,
      taskGroupId: row.task_group_id,
      subtaskId: row.subtask_id,
      agentId: row.agent_id,
      kind: row.kind,
      payload,
      file: row.file ?? (typeof payload.file === 'string' ? payload.file : null),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  // ── File claims (real DB rows with TTL, not a text convention) ──
  // A claim is active when its row has no matching later release AND has not
  // expired. Expired claims are treated as released (crash-safe).

  claimFile(taskGroupId: string, file: string, subtaskId: string, agentId: string, ttlMs = 90000): CollabEvent {
    const holder = this.getFileClaimHolder(taskGroupId, file)
    if (holder && holder.subtaskId !== subtaskId) {
      throw new CoordinatorError('CLAIMED', `File ${file} is claimed by ${holder.agentId}`, {
        file,
        holderSubtaskId: holder.subtaskId,
        holderAgentId: holder.agentId,
        expiresAt: holder.expiresAt,
      })
    }
    this.pruneExpiredClaims(taskGroupId)
    return this.appendCollabEvent({ taskGroupId, subtaskId, agentId, kind: 'claim', payload: { file }, ttlMs })
  }

  releaseFile(taskGroupId: string, file: string, subtaskId: string, agentId: string): CollabEvent {
    // Only the current holder may release. Releasing an unheld file is an
    // idempotent no-op (still logged for audit); releasing someone else's
    // claim is rejected instead of trusting the caller to behave.
    const holder = this.getFileClaimHolder(taskGroupId, file)
    if (holder && holder.subtaskId !== subtaskId) {
      throw new CoordinatorError('NOT_HOLDER', `File ${file} is claimed by ${holder.agentId}`, {
        file,
        holderSubtaskId: holder.subtaskId,
        holderAgentId: holder.agentId,
      })
    }
    return this.appendCollabEvent({ taskGroupId, subtaskId, agentId, kind: 'release', payload: { file } })
  }

  getFileClaimHolder(taskGroupId: string, file: string): { subtaskId: string; agentId: string; expiresAt: number | null } | null {
    const now = Date.now()
    // Filter by file in SQL (indexed column) and take the single latest
    // event: a release means unheld, an unexpired claim means held. No row
    // window — the answer is exact no matter how long the task has run.
    const row = this.db.prepare(
      `SELECT subtask_id, agent_id, kind, expires_at FROM collab_events
       WHERE task_group_id = ? AND file = ? AND kind IN ('claim', 'release')
       ORDER BY rowid DESC LIMIT 1`
    ).get(taskGroupId, file) as { subtask_id: string; agent_id: string; kind: string; expires_at: number | null } | undefined
    if (!row || row.kind === 'release') return null
    if (row.expires_at != null && row.expires_at <= now) return null
    return { subtaskId: row.subtask_id, agentId: row.agent_id, expiresAt: row.expires_at }
  }

  private pruneExpiredClaims(taskGroupId: string): void {
    try {
      this.db.prepare(
        "DELETE FROM collab_events WHERE task_group_id = ? AND kind = 'claim' AND expires_at IS NOT NULL AND expires_at <= ?"
      ).run(taskGroupId, Date.now())
    } catch {}
  }

  // ── Session CRUD (unified store, Phase 0.2) ──

  // agent_id FKs reference registered orchestrator agents only. UI-launched
  // sessions carry a CLI type ('claude'/'codex'/'shell') as their agentId,
  // which is NOT a registered agent — resolve it to NULL so the FK holds.
  private resolveAgentRef(agentId: string | null | undefined): string | null {
    if (!agentId) return null
    const row = this.db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId) as { id: string } | undefined
    return row ? agentId : null
  }

  upsertSession(session: {
    id: string
    workspaceId?: string | null
    sessionType: string
    agentId?: string | null
    taskId?: string | null
    taskGroupId?: string | null
    subtaskId?: string | null
    status?: string
    branch?: string | null
    worktreeId?: string | null
    lastActivity?: number
  }): void {
    const now = session.lastActivity ?? Date.now()
    const agentRef = this.resolveAgentRef(session.agentId)
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id) as { id: string } | undefined
    if (existing) {
      this.db.prepare(
        'UPDATE sessions SET workspace_id = ?, session_type = ?, agent_id = ?, task_id = ?, task_group_id = ?, subtask_id = ?, status = ?, branch = ?, worktree_id = ?, last_activity = ? WHERE id = ?'
      ).run(
        session.workspaceId ?? null,
        session.sessionType,
        agentRef,
        session.taskId ?? null,
        session.taskGroupId ?? null,
        session.subtaskId ?? null,
        session.status ?? 'idle',
        session.branch ?? null,
        session.worktreeId ?? null,
        now,
        session.id
      )
    } else {
      this.db.prepare(
        'INSERT INTO sessions (id, workspace_id, session_type, agent_id, task_id, task_group_id, subtask_id, status, branch, worktree_id, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        session.id,
        session.workspaceId ?? null,
        session.sessionType,
        agentRef,
        session.taskId ?? null,
        session.taskGroupId ?? null,
        session.subtaskId ?? null,
        session.status ?? 'idle',
        session.branch ?? null,
        session.worktreeId ?? null,
        now,
        now
      )
    }
  }

  getSession(id: string): SessionOverview | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) return null
    return this.rowToSession(row)
  }

  listSessions(): SessionOverview[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all() as SessionRow[]
    return rows.map(r => this.rowToSession(r))
  }

  closeSessionRecord(id: string): void {
    this.db.prepare("UPDATE sessions SET status = 'exited', closed_at = ? WHERE id = ?").run(Date.now(), id)
  }

  touchSession(id: string, lastActivity: number = Date.now()): void {
    // Called on every output chunk; throttle the sync DB write to once/sec per session.
    const last = this.lastTouchAt.get(id) || 0
    if (lastActivity - last < 1000) return
    this.lastTouchAt.set(id, lastActivity)
    this.db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(lastActivity, id)
  }

  linkSessionToTask(sessionId: string, taskId: string): void {
    this.db.prepare('UPDATE sessions SET task_id = ? WHERE id = ?').run(taskId, sessionId)
  }

  private rowToSession(row: SessionRow): SessionOverview {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      sessionType: row.session_type,
      agentId: row.agent_id,
      taskId: row.task_id,
      taskGroupId: row.task_group_id ?? null,
      subtaskId: row.subtask_id ?? null,
      status: row.status,
      branch: row.branch,
      worktreeId: row.worktree_id,
      createdAt: row.created_at,
      lastActivity: row.last_activity,
      closedAt: row.closed_at,
    }
  }

  // ── Worktree CRUD (unified store, Phase 1.2) ──

  recordWorktree(worktree: {
    id: string
    branchName?: string | null
    worktreePath?: string | null
    sourceRef?: string | null
    taskId?: string | null
    sessionId?: string | null
  }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO worktrees (id, repo_path, branch_name, worktree_path, source_ref, task_id, session_id, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      worktree.id,
      this.workspaceRepoPath,
      worktree.branchName ?? null,
      worktree.worktreePath ?? null,
      worktree.sourceRef ?? null,
      worktree.taskId ?? null,
      worktree.sessionId ?? null,
      Date.now(),
      null
    )
  }

  markWorktreeRemoved(id: string): void {
    this.db.prepare('UPDATE worktrees SET removed_at = ? WHERE id = ?').run(Date.now(), id)
  }

  getWorktree(id: string): WorktreeOverview | null {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as WorktreeRow | undefined
    if (!row) return null
    return this.rowToWorktree(row)
  }

  listActiveWorktrees(): WorktreeOverview[] {
    const rows = this.db.prepare('SELECT * FROM worktrees WHERE removed_at IS NULL ORDER BY created_at ASC').all() as WorktreeRow[]
    return rows.map(r => this.rowToWorktree(r))
  }

  private rowToWorktree(row: WorktreeRow): WorktreeOverview {
    return {
      id: row.id,
      repoPath: row.repo_path,
      branchName: row.branch_name,
      worktreePath: row.worktree_path,
      sourceRef: row.source_ref,
      taskId: row.task_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      removedAt: row.removed_at,
    }
  }

  // ── File Overlap Checking ──

  checkFileOverlap(declaredFiles: string[], excludeTaskId?: string, excludeTaskIds?: string[]): {
    overlaps: boolean
    conflictingFiles: string[]
    conflictingTaskIds: string[]
  } {
    const activeTasks = this.getActiveTasks()
    const declaredSet = new Set(declaredFiles)
    const excluded = new Set<string>(excludeTaskIds || [])
    if (excludeTaskId) excluded.add(excludeTaskId)
    const conflicts: string[] = []
    const conflictTaskIds = new Set<string>()

    for (const t of activeTasks) {
      if (excluded.has(t.id)) continue
      for (const f of [...t.declaredFiles, ...(t.actualFiles || [])]) {
        if (declaredSet.has(f)) {
          conflicts.push(f)
          conflictTaskIds.add(t.id)
        }
      }
    }

    return {
      overlaps: conflicts.length > 0,
      conflictingFiles: [...new Set(conflicts)],
      conflictingTaskIds: [...conflictTaskIds],
    }
  }

  getActiveTaskFiles(excludeTaskId?: string): string[] {
    const activeTasks = this.getActiveTasks()
    const files = new Set<string>()
    for (const t of activeTasks) {
      if (excludeTaskId && t.id === excludeTaskId) continue
      for (const f of t.declaredFiles) files.add(f)
      if (t.actualFiles) {
        for (const f of t.actualFiles) files.add(f)
      }
    }
    return [...files]
  }

  // ── Message CRUD ──

  // 3.1 idle-delivered messaging: a message sent to a specific agent is queued
  // (deliverOnlyWhenIdle=true) and only surfaces via getPendingMessages once
  // the receiver is IDLE — busy agents are never interrupted mid-task.
  // Broadcasts and explicit deliverOnlyWhenIdle=false deliver immediately.
  sendMessage(fromAgentId: string, toAgentId: string | null, broadcast: boolean, content: string, deliverOnlyWhenIdle = true): MessageInfo {
    const id = uuid()
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO messages (id, from_agent_id, to_agent_id, broadcast, content, created_at, deliver_only_when_idle) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, fromAgentId, toAgentId, broadcast ? 1 : 0, content, now, broadcast ? 0 : (deliverOnlyWhenIdle ? 1 : 0))
    return {
      id,
      fromAgentId,
      toAgentId,
      broadcast,
      content,
      createdAt: now,
      deliverOnlyWhenIdle: broadcast ? false : deliverOnlyWhenIdle,
    }
  }

  // Delivery gate (3.1): idle-delivered messages are held back while the
  // receiver is actively working a task. Broadcasts and immediate messages
  // always pass. A registered-but-taskless agent is considered idle, so
  // piggybacking still works right after registration.
  getPendingMessages(agentId: string): MessageInfo[] {
    const receiverBusy = this.isReceiverBusy(agentId)
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE (to_agent_id = ? OR broadcast = 1)
         AND json_extract(read_by, '$."' || ? || '"') IS NULL
         AND (deliver_only_when_idle = 0 OR broadcast = 1 OR ? = 0)
       ORDER BY created_at ASC`
    ).all(agentId, agentId, receiverBusy ? 1 : 0) as MessageRow[]
    return rows.map(r => ({
      id: r.id,
      fromAgentId: r.from_agent_id,
      toAgentId: r.to_agent_id,
      broadcast: r.broadcast === 1,
      content: r.content,
      createdAt: r.created_at,
      deliverOnlyWhenIdle: r.deliver_only_when_idle === 1,
    }))
  }

  // True while the agent is mid-task (claimed or actively working). An agent
  // whose task is `merging` is awaiting the merge pipeline — treated as idle.
  private isReceiverBusy(agentId: string): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('claimed', 'in_progress')`
    ).get(agentId) as { n: number }
    return (row?.n ?? 0) > 0
  }

  markMessagesRead(agentId: string): void {
    const now = Date.now().toString()
    const receiverBusy = this.isReceiverBusy(agentId)
    const messages = this.db.prepare(
      `SELECT id, read_by FROM messages
       WHERE (to_agent_id = ? OR broadcast = 1)
         AND json_extract(read_by, '$."' || ? || '"') IS NULL
         AND (deliver_only_when_idle = 0 OR broadcast = 1 OR ? = 0)`
    ).all(agentId, agentId, receiverBusy ? 1 : 0) as { id: string; read_by: string }[]
    const updateStmt = this.db.prepare('UPDATE messages SET read_by = ? WHERE id = ?')
    for (const msg of messages) {
      const readBy: Record<string, string> = JSON.parse(msg.read_by)
      readBy[agentId] = now
      updateStmt.run(JSON.stringify(readBy), msg.id)
    }
  }

  // ── Escalations ──

  createEscalation(reason: string, details: string, involvedAgentIds: string[]): EscalationInfo {
    const id = uuid()
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO escalations (id, reason, details, involved_agent_ids, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, reason, details, JSON.stringify(involvedAgentIds), 'open', now)

    for (const agentId of involvedAgentIds) {
      this.updateAgentStatus(agentId, 'paused')
    }

    return this.getEscalation(id)!
  }

  getEscalation(id: string): EscalationInfo | null {
    const row = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as EscalationRow | undefined
    if (!row) return null
    return this.rowToEscalation(row)
  }

  resolveEscalation(id: string, decision: string): void {
    const escalation = this.getEscalation(id)
    if (!escalation) throw new CoordinatorError('NOT_FOUND', `Escalation ${id} not found`)
    this.db.prepare('UPDATE escalations SET status = ?, decision = ?, resolved_at = ? WHERE id = ?')
      .run('resolved', decision, Date.now(), id)

    for (const agentId of escalation.involvedAgentIds) {
      this.updateAgentStatus(agentId, 'active')
    }
  }

  listEscalations(): EscalationInfo[] {
    const rows = this.db.prepare('SELECT * FROM escalations ORDER BY created_at DESC').all() as EscalationRow[]
    return rows.map(r => this.rowToEscalation(r))
  }

  getOpenEscalations(): EscalationInfo[] {
    const rows = this.db.prepare("SELECT * FROM escalations WHERE status = 'open' ORDER BY created_at ASC").all() as EscalationRow[]
    return rows.map(r => this.rowToEscalation(r))
  }

  // ── Decision Gates (3.4) ──

  // 3.4: a gate blocks a risky merge until a human approves. `blocked` →
  // `approved` lets the merge proceed; `rejected` releases the task so another
  // agent can pick it up. Uses the `gates` table (Phase 0).
  createGate(taskId: string, reason: string): GateInfo {
    const id = uuid()
    const now = Date.now()
    this.db.prepare(
      "INSERT INTO gates (id, task_id, status, reason, created_at) VALUES (?, ?, 'blocked', ?, ?)"
    ).run(id, taskId, reason, now)
    return this.getGate(id)!
  }

  getGate(id: string): GateInfo | null {
    const row = this.db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as GateRow | undefined
    if (!row) return null
    return this.rowToGate(row)
  }

  resolveGate(id: string, decision: string): GateInfo {
    const gate = this.getGate(id)
    if (!gate) throw new CoordinatorError('NOT_FOUND', `Gate ${id} not found`)
    if (gate.status !== 'blocked') throw new CoordinatorError('INVALID_STATE', `Gate ${id} is already ${gate.status}`)
    const status = decision.toLowerCase() === 'approve' || decision.toLowerCase() === 'approved' ? 'approved' : 'rejected'
    this.db.prepare('UPDATE gates SET status = ?, decision = ?, resolved_at = ? WHERE id = ?')
      .run(status, decision, Date.now(), id)
    return this.getGate(id)!
  }

  listGates(): GateInfo[] {
    const rows = this.db.prepare('SELECT * FROM gates ORDER BY created_at DESC').all() as GateRow[]
    return rows.map(r => this.rowToGate(r))
  }

  getOpenGatesForTask(taskId: string): GateInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM gates WHERE task_id = ? AND status = 'blocked' ORDER BY created_at ASC"
    ).all(taskId) as GateRow[]
    return rows.map(r => this.rowToGate(r))
  }

  hasOpenGate(taskId: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM gates WHERE task_id = ? AND status = 'blocked'"
    ).get(taskId) as { n: number }
    return (row?.n ?? 0) > 0
  }

  private rowToGate(row: GateRow): GateInfo {
    return {
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      reason: row.reason,
      decision: row.decision,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }
  }

  private rowToEscalation(row: EscalationRow): EscalationInfo {
    return {
      id: row.id,
      reason: row.reason,
      details: row.details,
      involvedAgentIds: JSON.parse(row.involved_agent_ids),
      status: row.status,
      decision: row.decision,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }
  }

  // ── Status Updates ──

  postStatusUpdate(taskId: string, agentId: string, text: string): StatusUpdateInfo {
    const id = uuid()
    const now = Date.now()
    this.db.prepare(
      'INSERT INTO status_updates (id, task_id, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, taskId, agentId, text, now)
    return { id, taskId, agentId, text, createdAt: now }
  }

  getTaskStatusUpdates(taskId: string): StatusUpdateInfo[] {
    const rows = this.db.prepare(
      'SELECT * FROM status_updates WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as StatusUpdateRow[]
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      agentId: r.agent_id,
      text: r.text,
      createdAt: r.created_at,
    }))
  }

  // ── Workspace Context ──

  getWorkspaceContext(forAgentId?: string): WorkspaceContextResult & { pendingMessages: MessageInfo[] } {
    const agents = this.getActiveAgents().map(a => ({
      id: a.id,
      name: a.name,
      type: a.agentType,
      status: a.status,
    }))
    const tasks = this.listTasks().map(t => ({
      id: t.id,
      description: t.description.length > 80 ? t.description.slice(0, 80) + '...' : t.description,
      status: t.status,
      agentId: t.agentId,
    }))
    const openEscalations = this.getOpenEscalations().length
    const pendingMessages = forAgentId ? this.getPendingMessages(forAgentId) : []

    return { agents, tasks, openEscalations, pendingMessages }
  }

  // Dispatch preamble (2.1): a compact header injected as the first message a
  // freshly-launched agent receives, naming who's active, what they claim, and
  // on which branches — so every agent starts knowing the orchestration state.
  // Capped at ~2KB to keep agent context small (trap: never exceed a few KB).
  buildDispatchPreamble(forAgentId?: string, excludeTaskIds: string[] = []): string {
    const exclude = new Set(excludeTaskIds)
    const agents = this.getActiveAgents().filter(a => a.agentType !== 'system')
    // Only advertise REAL orchestrated work. Internal bookkeeping tasks created
    // for UI-launched agent sessions ("Ad-hoc <agent> session …" / "Session …")
    // are not shareable work and only clutter every agent's dispatch header.
    const tasks = this.getActiveTasks().filter(t =>
      !exclude.has(t.id) &&
      !/^Ad-hoc\s+\w+\s+session\s+/i.test(t.description || '') &&
      !/^Session\s+[\w-]{1,10}$/i.test(t.description || '')
    )
    const completions = this.getRecentCompletions(2)
    // Only inject when there is genuinely shareable state. "Registered agents"
    // or historical completions alone shouldn't spam a freshly-opened agent's
    // chat — if there's no active work to coordinate, there's nothing to say.
    if (tasks.length === 0) return ''

    const lines: string[] = []
    lines.push('AgntSpce dispatch — shared workspace state')

    if (tasks.length > 0) {
      lines.push('', 'Active tasks:')
      for (const t of tasks) {
        const files = t.declaredFiles.length > 0 ? `  files: ${t.declaredFiles.join(', ')}` : ''
        const branch = t.branchName ? `  branch: ${t.branchName}` : ''
        const actual = this.getBranchDiffFiles(t)
        const actualStr = actual.length > 0 ? `  touching: ${actual.join(', ')}` : ''
        const desc = t.description.length > 100 ? t.description.slice(0, 100) + '…' : t.description
        lines.push(`- ${t.status} ${t.agentId ?? 'unassigned'}${branch}${files}${actualStr}  — ${desc}`)
      }
    }

    if (completions.length > 0) {
      lines.push('', 'Recently completed:')
      for (const c of completions) {
        const sum = c.summary.length > 120 ? c.summary.slice(0, 120) + '…' : c.summary
        lines.push(`- ${c.agentName}: ${sum}`)
      }
    }

    if (agents.length > 0) {
      lines.push('', 'Registered agents:')
      for (const a of agents) {
        if (forAgentId && a.id === forAgentId) continue
        lines.push(`- ${a.name} (${a.agentType}) [${a.status}]`)
      }
    }

    const preamble = lines.join('\n')
    const max = 2000
    return preamble.length > max ? preamble.slice(0, max) + '\n…[truncated]' : preamble
  }

  // Actual files another agent's branch has changed (2.5). Mirrors the diff
  // computation in mergeGate.ts:83-85 (`git diff --name-only branchPoint..branch`).
  // Capped + best-effort: a transient git failure (branch already merged/deleted)
  // must never break preamble construction.
  private getBranchDiffFiles(task: TaskOverview, maxFiles = 8): string[] {
    if (!task.branchPoint || !task.branchName) return []
    try {
      const out = execFileSync(
        'git',
        ['diff', '--name-only', `${task.branchPoint}..${task.branchName}`],
        { cwd: this.workspaceRepoPath, encoding: 'utf-8', timeout: 5000 }
      )
      const files = out.split('\n').map(l => l.trim()).filter(Boolean)
      return files.length > maxFiles ? files.slice(0, maxFiles) : files
    } catch {
      return []
    }
  }

  // Recent completed task summaries across all agents (2.3 broadcast): feeds
  // the dispatch preamble so a newly-launched agent sees what others just
  // finished. Capped to a small number to keep the preamble lean.
  getRecentCompletions(limit = 3): { agentName: string; summary: string; completedAt: number }[] {
    const rows = this.db.prepare(
      `SELECT ts.summary, ts.updated_at, t.agent_id, t.completed_at
       FROM task_summaries ts
       JOIN tasks t ON t.id = ts.task_id
       WHERE t.status = 'done'
       ORDER BY ts.updated_at DESC LIMIT ?`
    ).all(limit) as { summary: string; updated_at: number; agent_id: string | null; completed_at: number | null }[]

    return rows.map(r => ({
      agentName: r.agent_id ? this.getAgentDisplayName(r.agent_id) : 'unassigned',
      summary: r.summary,
      completedAt: r.completed_at || r.updated_at,
    }))
  }

  private getAgentDisplayName(agentId: string): string {
    const row = this.db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined
    return row?.name || agentId.slice(0, 8)
  }

  // 5.3 orchestrator gauges: aggregate counts used by the stats panel. Cheap
  // queries against existing indexes — safe to call on every stats request.
  getOrchestratorStats(): {
    agents: { total: number; active: number; idle: number; paused: number }
    tasks: Record<string, number>
    worktrees: number
    sessions: number
    messages: { pending: number; total: number }
    escalations: number
    gates: { blocked: number; approved: number; rejected: number }
    completions: number
  } {
    const agentRows = this.db.prepare('SELECT status FROM agents').all() as { status: string }[]
    const agents = { total: agentRows.length, active: 0, idle: 0, paused: 0 }
    for (const a of agentRows) {
      if (a.status === 'active') agents.active++
      else if (a.status === 'idle') agents.idle++
      else if (a.status === 'paused') agents.paused++
    }

    const taskRows = this.db.prepare('SELECT status FROM tasks').all() as { status: string }[]
    const tasks: Record<string, number> = {}
    for (const t of taskRows) tasks[t.status] = (tasks[t.status] || 0) + 1

    const worktrees = (this.db.prepare('SELECT COUNT(*) AS c FROM worktrees WHERE removed_at IS NULL').get() as { c: number }).c
    const sessions = (this.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE status != \'closed\'').get() as { c: number }).c

    const msg = this.db.prepare('SELECT read_by FROM messages').all() as { read_by: string }[]
    const messages = {
      pending: msg.filter(m => m.read_by === '[]').length,
      total: msg.length,
    }

    const escalations = (this.db.prepare("SELECT COUNT(*) AS c FROM escalations WHERE status = 'open'").get() as { c: number }).c

    const gateRows = this.db.prepare('SELECT status FROM gates').all() as { status: string }[]
    const gates = { blocked: 0, approved: 0, rejected: 0 }
    for (const g of gateRows) {
      if (g.status === 'blocked') gates.blocked++
      else if (g.status === 'approved') gates.approved++
      else if (g.status === 'rejected') gates.rejected++
    }

    const completions = (this.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'done'").get() as { c: number }).c

    return { agents, tasks, worktrees, sessions, messages, escalations, gates, completions }
  }

  // ── Stale Agent Sweep ──

  sweepStaleAgents(timeoutMs: number = STALE_AGENT_TIMEOUT_MS): string[] {
    const cutoff = Date.now() - timeoutMs
    const staleRows = this.db.prepare(
      "SELECT id FROM agents WHERE status IN ('active', 'idle') AND last_seen < ?"
    ).all(cutoff) as { id: string }[]

    const staleIds = staleRows.map(r => r.id)
    if (staleIds.length === 0) return []

    const markIdle = this.db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?")

    const transaction = this.db.transaction(() => {
      for (const id of staleIds) {
        markIdle.run(id)
        const tasks = this.db.prepare(
          "SELECT id FROM tasks WHERE agent_id = ? AND status IN ('claimed', 'in_progress', 'setup_failed')"
        ).all(id) as { id: string }[]
        for (const t of tasks) {
          this.transitionTaskStatus(t.id, 'abandoned')
          this.db.prepare('UPDATE tasks SET agent_id = NULL WHERE id = ?').run(t.id)
        }
      }
    })
    transaction()

    return staleIds
  }
}
