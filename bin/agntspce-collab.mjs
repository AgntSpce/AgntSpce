#!/usr/bin/env node
// agntspce-collab — collaboration CLI for agents sharing one task worktree.
// Agents invoke this as an ordinary shell command (bin/ is on their PATH);
// every write is an atomic SQLite row, and COLLAB.md is regenerated from the
// DB after each write (agents only ever READ that file).
//
// Uses node:sqlite (built into Node >= 22.5) instead of better-sqlite3 on
// purpose: the repo's better-sqlite3 binary targets Electron's Node ABI and
// cannot load under the system node agents run with.
//
// Env (injected at session spawn):
//   AGNTSPCE_TASK_ID     task group id
//   AGNTSPCE_SUBTASK_ID  this agent's subtask id
//
// Usage:
//   agntspce-collab claim <file> [ttlMs]
//   agntspce-collab release <file>
//   agntspce-collab post "<message>"
//   agntspce-collab request "<message>"
//   agntspce-collab done "<summary>"

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  console.error('agntspce-collab: node:sqlite is unavailable (need Node >= 22.5)')
  process.exit(1)
}

const CLAIM_TTL_MS = 90_000

function findDbPath(startDir) {
  let dir = path.resolve(startDir)
  while (true) {
    const candidate = path.join(dir, '.agntspce', 'coordinator.db')
    if (fs.existsSync(candidate)) return candidate
    // Inside a task worktree (<repo>/.agntspce/tasks/<id>) the coordinator.db
    // lives two levels up; the generic walk-up covers that too.
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
  } catch {
    return String(ts)
  }
}

// Compact mirror of renderCollabMd() in
// electron/services/orchestration/collabShim.ts — keep section structure in
// sync. The DB is the source of truth; this file is only a view.
function render(group, subtasks, events, openClaims) {
  const lines = []
  lines.push(`# Task: ${group.title}`)
  lines.push(`- branch: ${group.branch_name || '(not created yet)'} | base: ${group.base_sha || '-'} | mode: ${group.worktree_mode}`)
  lines.push(`- status: ${group.status}`)
  if (group.user_goal) lines.push(`- goal: ${group.user_goal}`)
  lines.push('')
  lines.push('## Subtasks')
  for (const s of subtasks) {
    const scope = s.scope_files && s.scope_files !== '[]' ? ` \`${JSON.parse(s.scope_files).join('`, `')}\`` : ''
    const model = s.model ? ` (${s.model})` : ''
    lines.push(`- ${s.agent_id}${model} → ${s.title || s.status}${scope} [${s.status}]`)
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
    lines.push(`## [${e.agent_id}] ${fmtTime(e.created_at)} — ${e.kind}`)
    let p = {}
    try { p = JSON.parse(e.payload || '{}') } catch {}
    if (typeof p.message === 'string' && p.message) lines.push(p.message)
    if (typeof p.file === 'string' && p.file && (e.kind === 'claim' || e.kind === 'release')) {
      lines.push(`- file: \`${p.file}\``)
    }
    if (Array.isArray(p.touched) && p.touched.length > 0) lines.push(`- touched: ${p.touched.join(', ')}`)
    if (Array.isArray(p.exports) && p.exports.length > 0) lines.push(`- exports: ${p.exports.join(', ')}`)
    if (typeof p.next === 'string' && p.next) lines.push(`- next: ${p.next}`)
  }
  lines.push('')
  return lines.join('\n')
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const taskGroupId = process.env.AGNTSPCE_TASK_ID
  const subtaskId = process.env.AGNTSPCE_SUBTASK_ID
  if (!taskGroupId || !subtaskId) {
    console.error('agntspce-collab: AGNTSPCE_TASK_ID / AGNTSPCE_SUBTASK_ID are not set')
    process.exit(2)
  }
  const dbPath = findDbPath(process.cwd())
  if (!dbPath) {
    console.error('agntspce-collab: no .agntspce/coordinator.db found above ' + process.cwd())
    process.exit(2)
  }
  const db = new DatabaseSync(dbPath)
  try {
    run(db, taskGroupId, subtaskId, cmd, rest, dbPath)
  } finally {
    db.close()
  }
}

function run(db, taskGroupId, subtaskId, cmd, rest, dbPath) {
  const group = db.prepare('SELECT * FROM task_groups WHERE id = ?').get(taskGroupId)
  if (!group) fail(`unknown task ${taskGroupId}`)
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ? AND task_group_id = ?').get(subtaskId, taskGroupId)
  if (!sub) fail(`unknown subtask ${subtaskId} in task ${taskGroupId}`)
  const agentId = sub.agent_id
  const now = Date.now()

  const insert = (kind, payload, ttlMs) => {
    const file = (kind === 'claim' || kind === 'release') && typeof payload.file === 'string' ? payload.file : null
    db.prepare(
      'INSERT INTO collab_events (id, task_group_id, subtask_id, agent_id, kind, payload, file, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), taskGroupId, subtaskId, agentId, kind, JSON.stringify(payload), file, now, ttlMs ? now + ttlMs : null)
    db.prepare('UPDATE subtasks SET last_event_at = ? WHERE id = ?').run(now, subtaskId)
  }

  const holderOf = (file) => {
    const row = db.prepare(
      `SELECT subtask_id, agent_id, kind, expires_at FROM collab_events
       WHERE task_group_id = ? AND file = ? AND kind IN ('claim', 'release')
       ORDER BY rowid DESC LIMIT 1`
    ).get(taskGroupId, file)
    if (!row || row.kind === 'release') return null
    if (row.expires_at != null && row.expires_at <= Date.now()) return null
    return row
  }

  switch (cmd) {
    case 'claim': {
      const file = rest[0]
      if (!file) fail('usage: agntspce-collab claim <file> [ttlMs]')
      const holder = holderOf(file)
      if (holder && holder.subtask_id !== subtaskId) {
        fail(`File ${file} is claimed by ${holder.agent_id}`)
      }
      insert('claim', { file }, Number(rest[1]) > 0 ? Number(rest[1]) : CLAIM_TTL_MS)
      console.log(`Claimed ${file}`)
      break
    }
    case 'release': {
      const file = rest[0]
      if (!file) fail('usage: agntspce-collab release <file>')
      const holder = holderOf(file)
      if (holder && holder.subtask_id !== subtaskId) {
        fail(`File ${file} is claimed by ${holder.agent_id}`)
      }
      insert('release', { file }, null)
      console.log(`Released ${file}`)
      break
    }
    case 'post':
    case 'request': {
      const message = rest.join(' ').trim()
      if (!message) fail(`usage: agntspce-collab ${cmd} "<message>"`)
      insert(cmd === 'post' ? 'progress' : 'request', { message }, null)
      console.log('Recorded')
      break
    }
    case 'done': {
      const summary = rest.join(' ').trim()
      if (!summary) fail('usage: agntspce-collab done "<summary>"')
      insert('done', { message: summary }, null)
      db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(now, subtaskId)
      console.log('Subtask marked done')
      break
    }
    default:
      fail('usage: agntspce-collab <claim|release|post|request|done> …')
  }

  // Regenerate the read-only view next to the task worktree (fall back to cwd).
  const dir = group.worktree_path && fs.existsSync(group.worktree_path) ? group.worktree_path : process.cwd()
  const subtasks = db.prepare('SELECT * FROM subtasks WHERE task_group_id = ? ORDER BY created_at ASC, rowid ASC').all(taskGroupId)
  const events = db.prepare('SELECT * FROM collab_events WHERE task_group_id = ? ORDER BY created_at ASC, rowid ASC').all(taskGroupId)
  const openClaims = []
  const seen = new Set()
  for (const e of events) {
    let file = e.file
    if (!file) {
      try { file = JSON.parse(e.payload || '{}').file || null } catch {}
    }
    if (!file || seen.has(file) || (e.kind !== 'claim' && e.kind !== 'release')) continue
    seen.add(file)
    const h = holderOf(file)
    if (h) {
      const holderSub = db.prepare('SELECT agent_id FROM subtasks WHERE id = ?').get(h.subtask_id)
      openClaims.push({ file, agentId: holderSub ? holderSub.agent_id : h.agent_id })
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'COLLAB.md'), render(group, subtasks, events, openClaims), 'utf-8')
}

function fail(msg) {
  console.error('agntspce-collab: ' + msg)
  process.exit(1)
}

main()
