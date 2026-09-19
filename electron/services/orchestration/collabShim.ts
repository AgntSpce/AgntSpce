import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  StateManager,
  CoordinatorError,
  type TaskGroupOverview,
  type SubTaskOverview,
  type CollabEvent,
  type CollabEventKind,
} from './stateManager'

export const COLLAB_MD_FILENAME = 'COLLAB.md'
export const COLLAB_CLAIM_TTL_MS = 90_000

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
  } catch {
    return String(ts)
  }
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

/** Render the read-only COLLAB.md view from DB state. Agents read this file;
 *  all writes go through claim/release/post/request/done (CLI or this class).
 *  NOTE: bin/agntspce-collab.mjs carries a compact copy of this renderer so
 *  the CLI can regenerate the file immediately after each write. Keep the
 *  section structure in sync when changing this function. */
export function renderCollabMd(
  group: TaskGroupOverview,
  subtasks: SubTaskOverview[],
  events: CollabEvent[],
  openClaims: { file: string; agentId: string }[]
): string {
  const lines: string[] = []
  lines.push(`# Task: ${group.title}`)
  lines.push(`- branch: ${group.branchName ?? '(not created yet)'} | base: ${group.baseSha ?? '-'} | mode: ${group.worktreeMode}`)
  lines.push(`- status: ${group.status}`)
  if (group.userGoal) lines.push(`- goal: ${group.userGoal}`)
  lines.push('')
  lines.push('## Subtasks')
  for (const s of subtasks) {
    const scope = s.scopeFiles.length > 0 ? ` \`${s.scopeFiles.join('`, `')}\`` : ''
    const model = s.model ? ` (${s.model})` : ''
    lines.push(`- ${s.agentId}${model} → ${s.title || s.status}${scope} [${s.status}]`)
  }
  lines.push('')
  if (openClaims.length > 0) {
    lines.push('## Open claims')
    for (const c of openClaims) lines.push(`- \`${c.file}\` claimed by ${c.agentId}`)
    lines.push('')
  }
  lines.push('## Progress')
  const shown = events.slice(-200)
  if (shown.length === 0) lines.push('_No updates yet._')
  for (const e of shown) {
    lines.push(`## [${e.agentId}] ${fmtTime(e.createdAt)} — ${e.kind}`)
    const p = e.payload as Record<string, unknown>
    if (typeof p.message === 'string' && p.message) lines.push(p.message)
    if (typeof p.file === 'string' && p.file && (e.kind === 'claim' || e.kind === 'release')) {
      lines.push(`- file: \`${p.file}\``)
    }
    if (Array.isArray(p.touched) && p.touched.length > 0) lines.push(`- touched: ${(p.touched as string[]).join(', ')}`)
    if (Array.isArray(p.exports) && p.exports.length > 0) lines.push(`- exports: ${(p.exports as string[]).join(', ')}`)
    if (typeof p.next === 'string' && p.next) lines.push(`- next: ${p.next}`)
  }
  lines.push('')
  return lines.join('\n')
}

export interface ShimResult {
  ok: boolean
  message: string
}

export class CollabShim {
  constructor(private sm: StateManager, private repoPath: string) {}

  private subtaskOf(taskGroupId: string, subtaskId: string): SubTaskOverview {
    const sub = this.sm.getSubTask(subtaskId)
    if (!sub || sub.taskGroupId !== taskGroupId) {
      throw new CoordinatorError('NOT_FOUND', `Subtask ${subtaskId} not found in task ${taskGroupId}`)
    }
    return sub
  }

  claim(taskGroupId: string, subtaskId: string, file: string): ShimResult {
    const sub = this.subtaskOf(taskGroupId, subtaskId)
    try {
      this.sm.claimFile(taskGroupId, file, subtaskId, sub.agentId, COLLAB_CLAIM_TTL_MS)
      this.refresh(taskGroupId)
      return { ok: true, message: `Claimed ${file}` }
    } catch (err: any) {
      return { ok: false, message: err?.message || `File ${file} is claimed` }
    }
  }

  release(taskGroupId: string, subtaskId: string, file: string): ShimResult {
    const sub = this.subtaskOf(taskGroupId, subtaskId)
    try {
      this.sm.releaseFile(taskGroupId, file, subtaskId, sub.agentId)
      this.refresh(taskGroupId)
      return { ok: true, message: `Released ${file}` }
    } catch (err: any) {
      return { ok: false, message: err?.message || `Cannot release ${file}` }
    }
  }

  post(taskGroupId: string, subtaskId: string, payload: Record<string, unknown>): ShimResult {
    const sub = this.subtaskOf(taskGroupId, subtaskId)
    this.sm.appendCollabEvent({ taskGroupId, subtaskId, agentId: sub.agentId, kind: 'progress', payload })
    this.refresh(taskGroupId)
    return { ok: true, message: 'Progress recorded' }
  }

  request(taskGroupId: string, subtaskId: string, message: string): ShimResult {
    const sub = this.subtaskOf(taskGroupId, subtaskId)
    this.sm.appendCollabEvent({ taskGroupId, subtaskId, agentId: sub.agentId, kind: 'request', payload: { message } })
    this.refresh(taskGroupId)
    return { ok: true, message: 'Request posted' }
  }

  done(taskGroupId: string, subtaskId: string, summary: string): ShimResult {
    const sub = this.subtaskOf(taskGroupId, subtaskId)
    this.sm.appendCollabEvent({ taskGroupId, subtaskId, agentId: sub.agentId, kind: 'done', payload: { message: summary } })
    this.sm.updateSubTaskStatus(subtaskId, 'done')
    this.refresh(taskGroupId)
    return { ok: true, message: 'Subtask marked done' }
  }

  /** Seed COLLAB.md for a freshly planned task (header + subtask list). */
  seed(taskGroupId: string): string {
    return this.refresh(taskGroupId)
  }

  /** Re-render COLLAB.md from current DB state. Returns the file path. */
  refresh(taskGroupId: string): string {
    const group = this.sm.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const dir = group.worktreePath ?? this.repoPath
    const content = renderCollabMd(group, this.sm.listSubTasks(taskGroupId), this.sm.getCollabEvents(taskGroupId), this.collectOpenClaims(taskGroupId))
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, COLLAB_MD_FILENAME)
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  private collectOpenClaims(taskGroupId: string): { file: string; agentId: string }[] {
    const out: { file: string; agentId: string }[] = []
    const seen = new Set<string>()
    for (const e of this.sm.getCollabEvents(taskGroupId)) {
      const file = typeof e.payload?.file === 'string' ? (e.payload.file as string) : e.file
      if (!file || seen.has(file)) continue
      if (e.kind !== 'claim' && e.kind !== 'release') continue
      seen.add(file)
      const holder = this.sm.getFileClaimHolder(taskGroupId, file)
      if (holder) out.push({ file, agentId: holder.agentId })
    }
    return out
  }
}

export { shortId }
