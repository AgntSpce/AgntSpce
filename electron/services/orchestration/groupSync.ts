import * as fs from 'node:fs'
import * as path from 'node:path'
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

/** Shared-context briefing, written to a file — never into a live PTY.
 *  Writing text into an interactive agent TUI corrupts its visible transcript
 *  (garbled repeats), so agents discover everything by reading files:
 *  COLLAB.md (members, scopes, progress), .task.json (ids), and the CLI
 *  usage block below. Scopes are advisory: grouped agents share everything
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

export const GROUP_BRIEFING_FILENAME = 'AGENTS-TASK.md'

/** Link one live session into a group: subtask row (running + linked),
 *  group flipped active, files re-rendered. Idempotent — returns
 *  joined:false when already linked. Shared by join-group and spawn. */
export function linkSessionToGroup(
  sm: StateManager,
  sessionStates: Record<string, any>,
  taskGroupId: string,
  sessionId: string,
  repoPath: string
): { subtask: SubTaskOverview; joined: boolean } {
  const group = sm.getTaskGroup(taskGroupId)
  if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
  const state = sessionStates[sessionId]
  if (!state) throw new CoordinatorError('NOT_FOUND', 'That session no longer exists')
  const already = sm.listSubTasks(taskGroupId).find(s => s.sessionId === sessionId)
  if (already) return { subtask: already, joined: false }
  const agentId = String(state.type || 'shell')
  const created = sm.addSubTask({ taskGroupId, agentId, title: agentId })
  const subtask = sm.updateSubTaskStatus(created.id, 'running', sessionId)!
  if (group.status !== 'active') sm.updateTaskGroup(taskGroupId, { status: 'active' })
  syncGroupFiles(sm, taskGroupId, repoPath)
  return { subtask, joined: true }
}

/** Re-renders COLLAB.md and writes the shared briefing file next to it.
 *  Returns the paths written. Pure file I/O — nothing is ever written into
 *  a live terminal, so agent transcripts stay clean. */
export function syncGroupFiles(
  sm: StateManager,
  taskGroupId: string,
  repoPath: string
): { mdPath: string; briefingPath: string | null } {
  const group = sm.getTaskGroup(taskGroupId)
  if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
  const members = sm.listSubTasks(taskGroupId)
  const shim = new CollabShim(sm, repoPath)
  const mdPath = shim.refresh(taskGroupId)
  let conventions = ''
  try {
    conventions = fs.readFileSync(mdPath, 'utf-8')
  } catch {}
  const dir = group.worktreePath && fs.existsSync(group.worktreePath)
    ? group.worktreePath
    : repoPath
  let briefingPath: string | null = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    briefingPath = path.join(dir, GROUP_BRIEFING_FILENAME)
    fs.writeFileSync(briefingPath, buildGroupPreamble(group, members, conventions), 'utf-8')
  } catch {}
  return { mdPath, briefingPath }
}

/** @deprecated PTY injection garbles live TUI transcripts. Use syncGroupFiles. */
export function injectGroupContext(
  _sm: StateManager,
  _writer: PtyWriter,
  _taskGroupId: string,
  _repoPath: string
): { injected: number } {
  return { injected: 0 }
}
