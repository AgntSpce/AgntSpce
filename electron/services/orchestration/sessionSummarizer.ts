import type Database from 'better-sqlite3'

export interface TaskSummary {
  taskId: string
  summary: string
  keyFiles: string[]
  statusLine: string
  updatedAt: number
}

export interface AgentSummary {
  agentId: string
  name: string
  status: string
  activeTasks: { taskId: string; description: string; statusLine: string }[]
  recentSummaries: string[]
}

interface TaskRow {
  id: string
  description: string
  status: string
  declared_files: string
  actual_files: string | null
  branch_name: string | null
  worktree_path: string | null
  agent_id: string | null
  created_at: number
  completed_at: number | null
  branch_point: string | null
}

const MAX_SUMMARY_LENGTH = 500

export class SessionSummarizer {
  private db: Database.Database
  private repoPath: string

  constructor(db: Database.Database, repoPath: string) {
    this.db = db
    this.repoPath = repoPath
  }

  summarizeTask(taskId: string): TaskSummary {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!task) throw new Error(`Task ${taskId} not found`)

    const parts: string[] = []
    const agent = task.agent_id ? this.getAgentName(task.agent_id) : 'unassigned'

    parts.push(`[${task.status}] ${task.description}`)
    parts.push(`agent: ${agent}`)

    if (task.branch_name) parts.push(`branch: ${task.branch_name}`)

    const declaredFiles: string[] = JSON.parse(task.declared_files || '[]')
    const actualFiles: string[] = task.actual_files ? JSON.parse(task.actual_files) : []

    const keyFiles = actualFiles.length > 0 ? actualFiles : declaredFiles
    const keyFilesList = keyFiles.length > 0 ? keyFiles.slice(0, 5) : []
    if (keyFilesList.length > 0) {
      parts.push(`files: ${keyFilesList.join(', ')}${keyFiles.length > 5 ? '...' : ''}`)
    }

    const updates = this.db.prepare(
      'SELECT text, created_at FROM status_updates WHERE task_id = ? ORDER BY created_at DESC LIMIT 2'
    ).all(taskId) as { text: string; created_at: number }[]
    if (updates.length > 0) {
      const latest = updates[0]
      parts.push(`last update: ${latest.text.slice(0, 100)}`)
    }

    if (task.status === 'done' && task.completed_at) {
      parts.push(`completed: ${new Date(task.completed_at).toISOString().slice(0, 10)}`)
    }
    if (task.status === 'escalated') {
      const esc = this.db.prepare(
        "SELECT reason FROM escalations WHERE instr(details, ?) > 0 AND status = 'open'"
      ).get(taskId) as { reason: string } | undefined
      if (esc) parts.push(`escalated: ${esc.reason.slice(0, 80)}`)
    }

    const summary = parts.slice(0, 4).join(' | ').slice(0, MAX_SUMMARY_LENGTH)

    const statusLine = this.buildStatusLine(task)
    const now = Date.now()

    this.db.prepare(
      `INSERT OR REPLACE INTO task_summaries (task_id, summary, key_files, status_line, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(taskId, summary, JSON.stringify(keyFilesList), statusLine, now)

    return { taskId, summary, keyFiles: keyFilesList, statusLine, updatedAt: now }
  }

  summarizeAgent(agentId: string): AgentSummary {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
      | { id: string; name: string; status: string }
      | undefined
    if (!agent) throw new Error(`Agent ${agentId} not found`)

    const tasks = this.db.prepare(
      "SELECT id, description, status FROM tasks WHERE agent_id = ? AND status IN ('claimed', 'in_progress', 'merging', 'setup_failed')"
    ).all(agentId) as { id: string; description: string; status: string }[]

    const activeTasks = tasks.map(t => {
      const stmt = this.db.prepare('SELECT status_line FROM task_summaries WHERE task_id = ?')
      const row = stmt.get(t.id) as { status_line: string } | undefined
      return { taskId: t.id, description: t.description, statusLine: row?.status_line || t.status }
    })

    const summaries = this.db.prepare(
      `SELECT ts.summary FROM task_summaries ts
       JOIN tasks t ON t.id = ts.task_id
       WHERE t.agent_id = ? AND t.status IN ('done', 'escalated', 'abandoned')
       ORDER BY ts.updated_at DESC LIMIT 3`
    ).all(agentId) as { summary: string }[]

    return {
      agentId,
      name: agent.name,
      status: agent.status,
      activeTasks,
      recentSummaries: summaries.map(s => s.summary),
    }
  }

  compressStatusUpdates(taskId: string, maxLen = 3): void {
    const all = this.db.prepare(
      'SELECT id, created_at FROM status_updates WHERE task_id = ? ORDER BY created_at ASC'
    ).all(taskId) as { id: string; created_at: number }[]
    const toRemove = all.slice(0, Math.max(0, all.length - maxLen))
    const stmt = this.db.prepare('DELETE FROM status_updates WHERE id = ?')
    for (const r of toRemove) {
      stmt.run(r.id)
    }
  }

  private getAgentName(agentId: string): string {
    const row = this.db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined
    return row?.name || agentId.slice(0, 8)
  }

  private buildStatusLine(task: TaskRow): string {
    switch (task.status) {
      case 'open': return `Open - awaiting claim`
      case 'claimed': return `Claimed - setting up worktree`
      case 'in_progress': return `In progress${task.branch_name ? ` on ${task.branch_name}` : ''}`
      case 'merging': return `Merging - running merge gate`
      case 'done': return `Done${task.completed_at ? ` (${new Date(task.completed_at).toISOString().slice(0, 10)})` : ''}`
      case 'escalated': return `Escalated - needs human review`
      case 'abandoned': return `Abandoned`
      case 'setup_failed': return `Setup failed - dependency install error`
      default: return task.status
    }
  }

  // ── v2 TaskGroup summaries (TaskChat + merge previews) ──

  summarizeTaskGroup(taskGroupId: string): TaskSummary {
    const group = this.db.prepare('SELECT * FROM task_groups WHERE id = ?').get(taskGroupId) as
      | { id: string; title: string; status: string; branch_name: string | null; completed_at: number | null }
      | undefined
    if (!group) throw new Error(`TaskGroup ${taskGroupId} not found`)

    const subs = this.db.prepare(
      'SELECT agent_id, status, scope_files FROM subtasks WHERE task_group_id = ? ORDER BY created_at ASC'
    ).all(taskGroupId) as { agent_id: string; status: string; scope_files: string }[]

    const parts: string[] = []
    parts.push(`[${group.status}] ${group.title}`)
    if (subs.length > 0) {
      parts.push(`agents: ${subs.map(s => `${s.agent_id}(${s.status})`).join(', ')}`)
    }
    const keyFiles: string[] = []
    for (const s of subs) {
      try {
        for (const f of JSON.parse(s.scope_files || '[]')) {
          if (typeof f === 'string' && !keyFiles.includes(f)) keyFiles.push(f)
        }
      } catch {}
    }
    if (keyFiles.length > 0) {
      parts.push(`files: ${keyFiles.slice(0, 5).join(', ')}${keyFiles.length > 5 ? '...' : ''}`)
    }

    const dones = this.db.prepare(
      `SELECT agent_id, payload FROM collab_events
       WHERE task_group_id = ? AND kind = 'done' ORDER BY created_at DESC LIMIT 5`
    ).all(taskGroupId) as { agent_id: string; payload: string }[]
    for (const d of dones.slice(0, 2)) {
      try {
        const msg = (JSON.parse(d.payload || '{}') as { message?: string }).message
        if (msg) parts.push(`${d.agent_id} done: ${msg.slice(0, 100)}`)
      } catch {}
    }

    if (group.status === 'done' && group.completed_at) {
      parts.push(`completed: ${new Date(group.completed_at).toISOString().slice(0, 10)}`)
    }

    return {
      taskId: taskGroupId,
      summary: parts.slice(0, 5).join(' | ').slice(0, MAX_SUMMARY_LENGTH),
      keyFiles: keyFiles.slice(0, 5),
      statusLine: `Task ${group.status}${group.branch_name ? ` on ${group.branch_name}` : ''}`,
      updatedAt: Date.now(),
    }
  }
}
