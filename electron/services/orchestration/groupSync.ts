import * as fs from 'node:fs'
import {
  StateManager,
  CoordinatorError,
  type TaskGroupOverview,
  type SubTaskOverview,
} from './stateManager'
import { CollabShim } from './collabShim'

/** Minimal PTY surface group sync needs — SessionManager satisfies this. */
export interface PtyWriter {
  writeToSession(sessionId: string, data: string): boolean
}

/** Shared-context preamble injected into each grouped session's live PTY.
 *  No trailing newline on purpose: the text lands in the agent's input box
 *  for it (or the user) to submit — auto-submitting into a live TUI can
 *  misfire mid-turn. Scopes are advisory: grouped agents share everything
 *  and coordinate through claims, not exclusivity. */
export function buildGroupPreamble(
  group: TaskGroupOverview,
  members: SubTaskOverview[],
  conventions: string
): string {
  const lines = [
    `You are now grouped on task "${group.title}" with ${members.length - 1} other agent(s).`,
    `Goal: ${group.userGoal || group.title}`,
    group.worktreePath
      ? `Shared worktree: ${group.worktreePath} (branch ${group.branchName ?? ''}). Do your task work here so everyone sees the same files.`
      : `Shared repo: ${group.repoPath}. Do your task work here so everyone sees the same files.`,
    `Members: ${members.map(m => `${m.agentId}${m.title ? ` (${m.title})` : ''}`).join(', ')}`,
  ]
  if (conventions.trim()) {
    lines.push(`Shared conventions (from COLLAB.md):`, conventions.trim().slice(0, 1500))
  }
  lines.push(
    `Coordinate through the collab CLI (bin/ is on your PATH). Your ids:`
  )
  for (const m of members) {
    lines.push(`- ${m.agentId}: agntspce-collab --task ${group.id} --subtask ${m.id} <claim|release|post|request|done> …`)
  }
  lines.push(
    `Rules: re-read COLLAB.md before editing shared files; claim a file before editing it and release after; post progress after each step; never rename another agent's names/APIs — request instead.`
  )
  return lines.join('\n')
}

/** Re-renders COLLAB.md and injects the shared preamble into every running
 *  member session. Returns how many PTYs accepted the write. */
export function injectGroupContext(
  sm: StateManager,
  writer: PtyWriter,
  taskGroupId: string,
  repoPath: string
): { injected: number } {
  const group = sm.getTaskGroup(taskGroupId)
  if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
  const members = sm.listSubTasks(taskGroupId)
  const shim = new CollabShim(sm, repoPath)
  const mdPath = shim.refresh(taskGroupId)
  let conventions = ''
  try {
    conventions = fs.readFileSync(mdPath, 'utf-8')
  } catch {}
  const running = members.filter(m => m.status === 'running' && m.sessionId)
  let injected = 0
  for (const m of running) {
    const text = buildGroupPreamble(group, members, conventions)
    try {
      if (writer.writeToSession(m.sessionId as string, text)) injected++
    } catch {}
  }
  return { injected }
}
