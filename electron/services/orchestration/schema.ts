import type Database from 'better-sqlite3'

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      capabilities TEXT NOT NULL DEFAULT '[]',
      registered_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      session_summary TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      declared_files TEXT NOT NULL DEFAULT '[]',
      actual_files TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      agent_id TEXT REFERENCES agents(id),
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      branch_point TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      session_type TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id),
      task_id TEXT REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'idle',
      branch TEXT,
      worktree_id TEXT,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);

    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      source_ref TEXT,
      task_id TEXT REFERENCES tasks(id),
      session_id TEXT,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_worktrees_task ON worktrees(task_id);
    CREATE INDEX IF NOT EXISTS idx_worktrees_branch ON worktrees(branch_name);

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      file_path TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_claims_task ON claims(task_id);
    CREATE INDEX IF NOT EXISTS idx_claims_agent ON claims(agent_id);
    CREATE INDEX IF NOT EXISTS idx_claims_file ON claims(file_path);

    CREATE TABLE IF NOT EXISTS agent_contexts (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      context_md TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_contexts_updated ON agent_contexts(updated_at);

    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'blocked',
      reason TEXT NOT NULL,
      decision TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gates_task ON gates(task_id);
    CREATE INDEX IF NOT EXISTS idx_gates_status ON gates(status);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL REFERENCES agents(id),
      to_agent_id TEXT REFERENCES agents(id),
      broadcast INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_by TEXT NOT NULL DEFAULT '[]',
      deliver_only_when_idle INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      involved_agent_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      decision TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS status_updates (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent_id);
    CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
    CREATE INDEX IF NOT EXISTS idx_status_updates_task ON status_updates(task_id);

    CREATE TABLE IF NOT EXISTS workspace_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO workspace_config (key, value) VALUES ('integration_branch', 'agntspce-integration');
    INSERT OR IGNORE INTO workspace_config (key, value) VALUES ('source_branch', '');

    CREATE TABLE IF NOT EXISTS task_summaries (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      summary TEXT NOT NULL,
      key_files TEXT NOT NULL DEFAULT '[]',
      status_line TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    -- v2 Tasks system: user-facing Task (1 Task = 1 worktree + 1 branch + N agents).
    -- The legacy flat 'tasks' table stays untouched for one release (read-only).
    CREATE TABLE IF NOT EXISTS task_groups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      repo_path TEXT NOT NULL,
      title TEXT NOT NULL,
      user_goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planning',
      worktree_mode TEXT NOT NULL DEFAULT 'worktree',
      branch_name TEXT,
      worktree_path TEXT,
      base_sha TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      pinned_at INTEGER,
      merge_candidate_ref TEXT,
      merge_candidate_base TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_groups_workspace ON task_groups(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_task_groups_status ON task_groups(status);

    CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      task_group_id TEXT NOT NULL REFERENCES task_groups(id),
      agent_id TEXT NOT NULL,
      model TEXT,
      reasoning TEXT,
      verbosity TEXT,
      title TEXT NOT NULL DEFAULT '',
      assignment_prompt TEXT NOT NULL DEFAULT '',
      scope_files TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT,
      last_event_at INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_subtasks_group ON subtasks(task_group_id);
    CREATE INDEX IF NOT EXISTS idx_subtasks_status ON subtasks(status);

    -- Collaboration write path: agents write via the agntspce-collab CLI shim,
    -- COLLAB.md is regenerated from these rows (read-only view for agents).
    -- 'file' is a first-class column (not just JSON) so claim lookups filter
    -- in SQL instead of scanning a row window client-side.
    CREATE TABLE IF NOT EXISTS collab_events (
      id TEXT PRIMARY KEY,
      task_group_id TEXT NOT NULL REFERENCES task_groups(id),
      subtask_id TEXT NOT NULL REFERENCES subtasks(id),
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      file TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_collab_events_group ON collab_events(task_group_id);
    CREATE INDEX IF NOT EXISTS idx_collab_events_kind ON collab_events(kind);
    CREATE INDEX IF NOT EXISTS idx_collab_events_created ON collab_events(created_at);
    -- NOTE: idx_collab_events_file lives in ensureCollabFileColumn (called by
    -- migrateSchema), NOT here. db.exec runs this whole batch as one script:
    -- on a pre-migration DB the CREATE TABLE is a no-op but the index build
    -- references the missing file column and aborts schema creation with
    -- "no such column: file" before migrations ever run.
  `)
}

// Migrations for databases created by an earlier schema version. Safe to run
// after createSchema on every boot — each migration checks before altering.
export function migrateSchema(db: Database.Database): void {
  const taskColumns = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]
  if (!taskColumns.some(c => c.name === 'failure_count')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`)
  }

  const msgColumns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
  if (!msgColumns.some(c => c.name === 'deliver_only_when_idle')) {
    db.exec(`ALTER TABLE messages ADD COLUMN deliver_only_when_idle INTEGER NOT NULL DEFAULT 0`)
  }

  // v2 Tasks system: sessions can link to a task group + subtask (in addition
  // to the legacy task_id FK, which stays for compat).
  const sessionColumns = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  if (!sessionColumns.some(c => c.name === 'task_group_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN task_group_id TEXT`)
  }
  if (!sessionColumns.some(c => c.name === 'subtask_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN subtask_id TEXT`)
  }

  // task_groups.pinned_at — NULL = unpinned; the timestamp orders pinned tasks
  // (most recently pinned first) and survives a restart.
  const taskGroupColumns = db.prepare(`PRAGMA table_info(task_groups)`).all() as { name: string }[]
  if (taskGroupColumns.length > 0 && !taskGroupColumns.some(c => c.name === 'pinned_at')) {
    db.exec(`ALTER TABLE task_groups ADD COLUMN pinned_at INTEGER`)
  }

  // Pending merge candidate for an AI-resolved conflict. The candidate commit is
  // parked on merge_candidate_ref (a scratch branch) and was built on
  // merge_candidate_base (the integration tip at the time), so the confirm step
  // can survive a process restart instead of living in memory.
  if (taskGroupColumns.length > 0 && !taskGroupColumns.some(c => c.name === 'merge_candidate_ref')) {
    db.exec(`ALTER TABLE task_groups ADD COLUMN merge_candidate_ref TEXT`)
    db.exec(`ALTER TABLE task_groups ADD COLUMN merge_candidate_base TEXT`)
  }

  // v2 collab_events.file column (added after step 1 shipped): backfill from
  // the JSON payload so claim lookups can filter in SQL.
  ensureCollabFileColumn(db)
}

/** Ensure the first-class `file` column exists (repairs pre-migration DBs).
 *  Returns true when the column is present afterwards. Loud on failure —
 *  a silent skip here surfaces later as "no such column: file". */
export function ensureCollabFileColumn(db: Database.Database): boolean {
  try {
    const collabColumns = db.prepare(`PRAGMA table_info(collab_events)`).all() as { name: string }[]
    if (collabColumns.length > 0 && !collabColumns.some(c => c.name === 'file')) {
      db.exec(`ALTER TABLE collab_events ADD COLUMN file TEXT`)
      db.exec(`UPDATE collab_events SET file = json_extract(payload, '$.file')
               WHERE kind IN ('claim', 'release') AND file IS NULL`)
      console.log('[schema] backfilled collab_events.file')
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_collab_events_file ON collab_events(task_group_id, file, kind)`)
    const after = db.prepare(`PRAGMA table_info(collab_events)`).all() as { name: string }[]
    return after.length === 0 || after.some(c => c.name === 'file')
  } catch (e: any) {
    console.error('[schema] collab_events.file repair failed:', e?.message || e)
    return false
  }
}
