import * as fs from 'node:fs'
import * as path from 'node:path'

/** One agent taking part in a task. */
export interface PlanAgentInput {
  agentId: string
  model?: string | null
  reasoning?: string | null
  verbosity?: string | null
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
  /** How many agents share this task. Each one gets the same goal, so this is
   *  what tells an agent it is not working alone. */
  agentCount: number
  /** Appended after the first round — a follow-up message from the user. */
  followUp?: string
}

/** The briefing handed to every agent in a task.
 *
 *  This used to be produced by an LLM "planner" that read the repo's top-level
 *  directory names, split the goal into per-agent `scopeFiles`, re-prompted once
 *  when two agents claimed the same path, and finally fell back to a
 *  round-robin directory split. That machinery is gone: the planner had less
 *  information than the agents themselves (top-level names only, no file
 *  contents, no dependency graph), so its scope split was a guess dressed up as
 *  a plan, and a wrong guess was worse than no guess — two agents told to own
 *  "the same directory" would clobber each other.
 *
 *  A task is now just an isolated git worktree plus the agents you picked. Every
 *  agent gets the same goal and coordinates dynamically through
 *  `agntspce-collab` file claims and COLLAB.md, which is measured at the moment
 *  of editing rather than guessed up front. */
export function buildAssignmentPrompt(
  ctx: PlanContext,
  agent: PlanAgentInput
): string {
  const shared = ctx.worktreeMode === 'worktree' ? 'Shared worktree' : ctx.worktreeMode === 'in-repo' ? 'Shared checkout' : 'Shared workspace (no isolation)'
  const place = ctx.worktreeMode === 'none'
    ? `${shared}: ${ctx.worktreePath}. Other agents are editing these same files right now — claim every file before you touch it, and expect conflicting edits.`
    : `${shared}: ${ctx.worktreePath} (branch ${ctx.branchName}). Do NOT cd outside it. Do NOT \`git checkout\` any other branch.`
  const peers = ctx.agentCount > 1
    ? `You are 1 of ${ctx.agentCount} agents working this same goal in this same ${ctx.worktreeMode === 'worktree' ? 'worktree' : 'folder'}. Nobody was assigned a slice, so you must pick your own and keep off your peers' files.`
    : `You are the only agent on this task.`
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
    `You are ${agent.agentId}${agent.model ? ` (${agent.model})` : ''}, working on task "${ctx.taskTitle}".`,
    `Goal: ${ctx.userGoal}`,
    ``,
    peers,
    place,
    ``,
    `PLAN YOUR OWN WORK:`,
    `- You have the whole goal, not a slice of it. Decide what you will actually change, then do that part well.`,
    ctx.agentCount > 1
      ? `- Before you start, read COLLAB.md to see what your peers have already claimed or finished, and pick work they have not taken.`
      : `- You have the whole goal to yourself.`,
    `- Prefer new files over editing files a peer may be in the middle of. If you must touch a peer's file, claim it first and wait if they hold it.`,
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
    `Done criteria: the goal is met and your work is committed. When finished, run:`,
    `    agntspce-collab done "<summary>"`,
    `and stop.`,
    ctx.followUp ? `\nFOLLOW-UP FROM THE USER:\n${ctx.followUp}\n` : '',
  ].filter(Boolean).join('\n')
}

/** One row per agent taking part in a task. There is no split to compute. */
export function buildTaskAssignments(
  ctx: PlanContext,
  agents: PlanAgentInput[]
): { agentId: string; assignmentPrompt: string }[] {
  return agents.map(a => ({ agentId: a.agentId, assignmentPrompt: buildAssignmentPrompt(ctx, a) }))
}

/** Persist the task next to the worktree so agents and the UI can read it. */
export function writeTaskMetaFile(dir: string, meta: {
  taskGroupId: string
  branchName: string
  baseSha: string | null
  worktreeMode: string
  agents: string[]
}): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, '.task.json')
  fs.writeFileSync(filePath, JSON.stringify({ ...meta, writtenAt: Date.now() }, null, 2), 'utf-8')
  return filePath
}
