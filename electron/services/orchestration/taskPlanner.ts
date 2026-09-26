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
  worktreeMode: 'worktree' | 'in-repo' | 'none'
  /** Branch that peers' committed work lands on. Agents need the name so they
   *  can pull it in instead of reporting a peer's file as missing. */
  integrationBranch?: string
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
  // In 'none' mode there is no worktree and no branch: agents share the
  // workspace folder itself, so the isolation wording would be a lie.
  const shared = ctx.worktreeMode === 'worktree' ? 'Shared worktree' : ctx.worktreeMode === 'in-repo' ? 'Shared checkout' : 'Shared workspace (no isolation)'
  const place = ctx.worktreeMode === 'none'
    ? `${shared}: ${ctx.worktreePath}. Other agents are editing these same files right now — claim every file before you touch it, and expect conflicting edits.`
    : `${shared}: ${ctx.worktreePath} (branch ${ctx.branchName}). Do NOT cd outside it. Do NOT \`git checkout\` any other branch.`
  // Verified failure: agents wrote their output and stopped, never committing,
  // so the merge had nothing to land and the files stayed invisible in the
  // worktree. State the requirement explicitly, in the mode the agent is in.
  const gitRules = ctx.worktreeMode === 'none'
    ? [
        `  This is a shared folder with no branch of your own. \`git commit\` your work anyway so each agent's`,
        `  changes stay attributable and reversible. Never \`git checkout\`, \`git reset --hard\`, or revert a peer's work.`,
      ]
    : [
        `  You MUST \`git add -A && git commit\` your work before you finish. Uncommitted work cannot be merged and`,
        `  will not appear in the user's folder. Commit in logical steps, not one giant commit at the end.`,
        `  Do NOT merge, rebase, or \`git checkout\` any other branch — AgntSpce does that.`,
      ]
  // Verified failure: an agent looked for a file a peer had created, did not
  // find it, and told the user it did not exist. The peer HAD committed it — it
  // was sitting on the integration branch, which this worktree does not have
  // until it syncs. Give the agent the exact command instead of letting it
  // report a phantom missing file.
  const peerSync = ctx.worktreeMode === 'worktree' && ctx.integrationBranch
    ? [
        ``,
        `PEER WORK:`,
        `  Other tasks in this workspace land their committed work on the \`${ctx.integrationBranch}\` branch.`,
        `  Your worktree does not have it. If you need a file or API a peer created:`,
        `      git merge ${ctx.integrationBranch} --no-edit`,
        `  then continue. Never rebase, never cherry-pick, never \`git checkout\` another branch.`,
        `  If the merge conflicts, resolve it, \`git add\` the resolved files, and commit.`,
      ]
    : []
  return [
    `You are ${agent.agentId}${agent.model ? ` (${agent.model})` : ''} working on subtask "${subtaskTitle}" of task "${ctx.taskTitle}".`,
    `Goal: ${ctx.userGoal}`,
    `Your scope: ${scope}. Others: ${peerSummary}.`,
    place,
    ``,
    `VERSION CONTROL (mandatory):`,
    ...gitRules,
    ...peerSync,
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
