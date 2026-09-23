# Assignment Agent Logic — archived implementation

Status: PARKED (not active). The task popup no longer auto-assigns or auto-runs
agents. This file preserves the complete assignment system so it can be
reimplemented in the future. Everything below is copied from the working tree
as of commit `4ebf462` (plus uncommitted wizard work): restore the files in
§6 in order and the system works again.

Related live code that was NOT parked (do not duplicate): `taskMerger.ts`
(multi-task merge), `CreateTaskModal.tsx` wizard shell, `TaskChat.tsx`.

## How the assignment system works

Pipeline (one LLM call, everything else deterministic):

1. User picks agents in the wizard → `create-task-group` socket event
   (`electron/server/handlers/tasks.ts`) writes one `TaskGroup` row
   (`status='planning'`) plus one `SubTask` shell row per agent (agentId +
   model, no prompt yet). Nothing is spawned.
2. User hits Launch → `launch-task` → `TaskOrchestrator.launchTask`:
   a. `planTask()` (taskPlanner.ts): builds a planner prompt (goal + per-agent
      expertise notes + repo top-level listing), calls the injected LLM once
      (first configured chat provider: anthropic → openai → google →
      deepseek → grot/mistral/groq/openrouter; none configured → skip LLM),
      parses the returned JSON (`todoList` + per-agent `subtasks` with
      `scopeFiles`), runs a deterministic pairwise overlap check, re-prompts
      ONCE on overlap, else falls back to a round-robin directory split that
      cannot overlap by construction. Hardest slice goes to the strongest
      model; identical models split by file area.
   b. Creates the isolated git worktree + `task/<slug>-<shortid>` branch
      (`WorktreeLifecycle.createTaskWorktree`), records branch/baseSha/path.
   c. Writes `.task.json` (plan metadata) and seeds `COLLAB.md` (header +
      subtask list) in the worktree.
   d. `tryAcquire(N)` reserves ALL subtask slots or fails fast (no trickling).
   e. Spawns one PTY per non-done subtask via `spawnTaskSubtask` with the
      generated `assignmentPrompt`; each PTY inherits `AGNTSPCE_TASK_ID` /
      `AGNTSPCE_SUBTASK_ID` in its environment. Partial spawn failure rolls
      back (closes what started, group → `paused`).
3. Agents collaborate inside the shared worktree through `agntspce-collab`
   (shell CLI, `bin/` is on their PATH): `claim`/`release` a file before/after
   editing shared files (real DB rows, 90s TTL, crash-safe), `post` progress,
   `request` help, `done` with a summary. Every write regenerates the
   read-only `COLLAB.md` view. Claims are enforced mechanically
   (`CLAIMED` / `NOT_HOLDER` errors) — never by prompt convention alone.
4. Follow-up message → `replanTask`: closes running sessions, re-plans with
   the message appended to the goal, updates non-done subtasks, re-seeds,
   respawns only the non-done ones.
5. `closeTask` kills every subtask PTY (pause → `paused`, abandon → retired).

## Part 1 — `electron/services/orchestration/taskPlanner.ts` (full)

```ts
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface PlanAgentInput {
  agentId: string
  model?: string | null
  reasoning?: string | null
  verbosity?: string | null
}

export interface PlannedSubtask {
  agentId: string
  model?: string | null
  title: string
  scopeFiles: string[]
  assignmentPrompt: string
}

export interface ScopeConflict {
  file: string
  agentIds: string[]
}

export interface TaskPlan {
  todoList: string[]
  subtasks: PlannedSubtask[]
  /** Non-empty when the deterministic fallback (not the LLM) produced the plan. */
  warnings: string[]
  /** True when overlap survived the re-prompt and the prefix fallback was used. */
  usedFallback: boolean
}

export interface PlanContext {
  taskTitle: string
  userGoal: string
  branchName: string
  worktreePath: string
  worktreeMode: 'worktree' | 'in-repo'
}

// Static capability notes layered on top of agentManager configs. The planner
// assigns the hardest reasoning/architecture slice to the strongest model and
// splits by file area when models are identical.
const AGENT_EXPERTISE: Record<string, { strengths: string; bestFor: string }> = {
  claude: { strengths: 'deep reasoning, architecture, large refactors', bestFor: 'hardest slice: data model, core logic, architecture' },
  codex: { strengths: 'fast code generation, tests', bestFor: 'implementation slices: components, endpoints, tests' },
  opencode: { strengths: 'generalist coding, full-stack edits', bestFor: 'feature slices end-to-end within a file area' },
  gemini: { strengths: 'large context, review, docs', bestFor: 'review slices: docs, consistency checks, broad refactors' },
  pi: { strengths: 'security review, correctness, docs', bestFor: 'security + docs slices: auth, validation, documentation' },
  droid: { strengths: 'generalist coding', bestFor: 'general implementation slices' },
  amp: { strengths: 'generalist coding', bestFor: 'general implementation slices' },
  copilot: { strengths: 'code completion, small edits', bestFor: 'small well-scoped slices' },
}

export function expertiseFor(agentId: string): { strengths: string; bestFor: string } {
  return AGENT_EXPERTISE[agentId] ?? { strengths: 'generalist coding', bestFor: 'general implementation slices' }
}

export function buildAssignmentPrompt(
  ctx: PlanContext,
  agent: PlanAgentInput,
  subtaskTitle: string,
  scopeFiles: string[],
  peerSummary: string,
  doneCriteria: string
): string {
  const scope = scopeFiles.length > 0 ? scopeFiles.join(', ') : '(no fixed scope — coordinate via COLLAB.md)'
  const shared = ctx.worktreeMode === 'worktree' ? 'Shared worktree' : 'Shared checkout'
  return [
    `You are ${agent.agentId}${agent.model ? ` (${agent.model})` : ''} working on subtask "${subtaskTitle}" of task "${ctx.taskTitle}".`,
    `Goal: ${ctx.userGoal}`,
    `Your scope: ${scope}. Others: ${peerSummary}.`,
    `${shared}: ${ctx.worktreePath} (branch ${ctx.branchName}). Do NOT cd outside it. Do NOT \`git checkout\` any other branch.`,
    ``,
    `COLLABORATION (mandatory):`,
    `- Read COLLAB.md in the task root before editing any file another agent also owns, to see current conventions and progress.`,
    `- Before editing a file listed in another agent's scope, run:`,
    `    agntspce-collab claim <file>`,
    `  If it reports the file is claimed by someone else, wait and retry rather than editing anyway.`,
    `  When done editing that file, run:`,
    `    agntspce-collab release <file>`,
    `- After each meaningful step, run:`,
    `    agntspce-collab post "<what you touched, what you exported, what you need from peers>"`,
    `- If you need a name/API another agent owns, run \`agntspce-collab request "<message>"\` instead of renaming or guessing.`,
    ``,
    `Done criteria: ${doneCriteria}. When finished, run:`,
    `    agntspce-collab done "<summary>"`,
    `and stop.`,
  ].join('\n')
}

export function buildPlannerPrompt(
  ctx: PlanContext,
  agents: PlanAgentInput[],
  repoTree: string[]
): string {
  const agentLines = agents.map(a => {
    const e = expertiseFor(a.agentId)
    return `- ${a.agentId}${a.model ? ` (${a.model})` : ''}: ${e.strengths}; best for ${e.bestFor}`
  })
  return [
    `Break this software task into per-agent subtasks. Reply with a single JSON object, no other text.`,
    `Task: ${ctx.taskTitle}`,
    `Goal: ${ctx.userGoal}`,
    `Agents:`,
    ...agentLines,
    `Repository top-level entries: ${repoTree.slice(0, 60).join(', ') || '(unknown)'}`,
    `Rules:`,
    `- Produce "todoList": 3-8 steps in build order.`,
    `- Produce "subtasks": one per agent, each with "agentId" (must match an agent above), "title", and "scopeFiles" (repo-relative write targets).`,
    `- No file may appear in more than one subtask's scopeFiles. Prefer splitting by directory prefix.`,
    `- Give the hardest slice to the strongest model; identical models split by file area.`,
    `- Keep each scope to files the agent will actually WRITE.`,
    `JSON shape: {"todoList": ["..."], "subtasks": [{"agentId": "...", "title": "...", "scopeFiles": ["..."]}]}`,
  ].join('\n')
}

export function parsePlanJson(text: string): { todoList: string[]; subtasks: { agentId: string; title: string; scopeFiles: string[] }[] } | null {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    const raw = (fenced ? fenced[1] : text).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const obj = JSON.parse(raw.slice(start, end + 1)) as any
    if (!Array.isArray(obj?.todoList) || !Array.isArray(obj?.subtasks)) return null
    const subtasks = obj.subtasks
      .filter((s: any) => typeof s?.agentId === 'string')
      .map((s: any) => ({
        agentId: s.agentId,
        title: typeof s.title === 'string' ? s.title : s.agentId,
        scopeFiles: Array.isArray(s.scopeFiles) ? s.scopeFiles.filter((f: any) => typeof f === 'string') : [],
      }))
    return { todoList: obj.todoList.filter((t: any) => typeof t === 'string'), subtasks }
  } catch {
    return null
  }
}

/** Pairwise write-scope overlap across subtasks. Empty = safe to spawn. */
export function checkScopeOverlap(subtasks: { agentId: string; scopeFiles: string[] }[]): ScopeConflict[] {
  const byFile = new Map<string, Set<string>>()
  for (const s of subtasks) {
    for (const f of s.scopeFiles) {
      const key = f.replace(/^\.\//, '').replace(/\/+$/, '')
      if (!byFile.has(key)) byFile.set(key, new Set())
      byFile.get(key)!.add(s.agentId)
    }
  }
  const out: ScopeConflict[] = []
  for (const [file, agents] of byFile) {
    if (agents.size > 1) out.push({ file, agentIds: [...agents] })
  }
  return out
}

/** Deterministic fallback: split top-level directories round-robin. Never
 *  overlaps by construction; used when the LLM is unavailable or still
 *  overlapping after one re-prompt. */
export function fallbackSplit(
  ctx: PlanContext,
  agents: PlanAgentInput[],
  repoTree: string[]
): TaskPlan {
  const dirs = repoTree.filter(d => d && !d.startsWith('.')).slice(0, 24)
  const buckets: string[][] = agents.map(() => [])
  if (dirs.length === 0) {
    agents.forEach((_, i) => buckets[i]!.push(`area-${i + 1}/**`))
  } else {
    dirs.forEach((d, i) => buckets[i % agents.length]!.push(`${d.replace(/\/+$/, '')}/**`))
  }
  const peer = (idx: number) =>
    agents.map((a, i) => (i === idx ? null : `${a.agentId} owns ${(buckets[i] || []).join(', ')}`)).filter(Boolean).join('; ') || 'none'
  const subtasks: PlannedSubtask[] = agents.map((a, i) => ({
    agentId: a.agentId,
    model: a.model ?? null,
    title: `${a.agentId}: ${(buckets[i] || []).join(', ')}`,
    scopeFiles: buckets[i] || [],
    assignmentPrompt: buildAssignmentPrompt(ctx, a, `${a.agentId} slice`, buckets[i] || [], peer(i), 'your scope files are implemented and committed in the task branch'),
  }))
  return {
    todoList: agents.map((a, i) => `${a.agentId} implements ${(buckets[i] || []).join(', ')}`),
    subtasks,
    warnings: ['Planner LLM unavailable or overlapping — used deterministic directory split. Review scopes before launch.'],
    usedFallback: true,
  }
}

export function buildPlanFromParsed(
  ctx: PlanContext,
  agents: PlanAgentInput[],
  parsed: { todoList: string[]; subtasks: { agentId: string; title: string; scopeFiles: string[] }[] }
): TaskPlan {
  const byAgent = new Map(agents.map(a => [a.agentId, a]))
  const peer = (agentId: string, scope: string[]) =>
    parsed.subtasks.filter(s => s.agentId !== agentId)
      .map(s => `${s.agentId} owns ${s.scopeFiles.join(', ') || 'nothing specific'}`).join('; ') || 'none'
  const subtasks: PlannedSubtask[] = parsed.subtasks
    .filter(s => byAgent.has(s.agentId))
    .map(s => {
      const agent = byAgent.get(s.agentId)!
      return {
        agentId: s.agentId,
        model: agent.model ?? null,
        title: s.title,
        scopeFiles: s.scopeFiles,
        assignmentPrompt: buildAssignmentPrompt(ctx, agent, s.title, s.scopeFiles, peer(s.agentId, s.scopeFiles), 'your scope files are implemented and committed in the task branch'),
      }
    })
  return { todoList: parsed.todoList, subtasks, warnings: [], usedFallback: false }
}

/** Full planning flow: LLM split → overlap check → one re-prompt → fallback.
 *  `llm` is injected (stub in tests); null/parse-failure goes deterministic. */
export async function planTask(
  ctx: PlanContext,
  agents: PlanAgentInput[],
  repoTree: string[],
  llm?: (prompt: string) => Promise<string | null>
): Promise<TaskPlan> {
  if (agents.length === 0) throw new Error('planTask needs at least one agent')
  if (!llm) return fallbackSplit(ctx, agents, repoTree)

  const first = await llm(buildPlannerPrompt(ctx, agents, repoTree)).catch(() => null)
  const parsed = first ? parsePlanJson(first) : null
  if (parsed && parsed.subtasks.length > 0) {
    if (checkScopeOverlap(parsed.subtasks).length === 0) {
      return buildPlanFromParsed(ctx, agents, parsed)
    }
    const conflicts = checkScopeOverlap(parsed.subtasks)
      .map(c => `${c.file} (${c.agentIds.join(', ')})`).join('; ')
    const retry = await llm(
      `Your previous split overlaps on: ${conflicts}. Reply with corrected JSON only, same shape, zero overlapping scopeFiles.`
    ).catch(() => null)
    const reparsed = retry ? parsePlanJson(retry) : null
    if (reparsed && reparsed.subtasks.length > 0 && checkScopeOverlap(reparsed.subtasks).length === 0) {
      return buildPlanFromParsed(ctx, agents, reparsed)
    }
  }
  const fallback = fallbackSplit(ctx, agents, repoTree)
  fallback.warnings.unshift('LLM plan overlapped or failed — fell back to deterministic split.')
  return fallback
}

/** Persist the plan next to the worktree for agents + UI to read. */
export function writeTaskMetaFile(dir: string, meta: {
  taskGroupId: string
  branchName: string
  baseSha: string | null
  worktreeMode: string
  todoList: string[]
  subtasks: { agentId: string; model?: string | null; title: string; scopeFiles: string[] }[]
}): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, '.task.json')
  fs.writeFileSync(filePath, JSON.stringify({ ...meta, writtenAt: Date.now() }, null, 2), 'utf-8')
  return filePath
}
```

## Part 2 — `electron/services/orchestration/taskOrchestrator.ts` (full)

```ts
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
      if (group.worktreeMode === 'in-repo') {
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
        

...[truncated 20887 chars]