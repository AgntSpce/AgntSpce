import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { AgentOrchestrator } from '../agentOrchestrator'
import { WorktreeLifecycle } from '../orchestration/worktreeLifecycle'
import { registerTaskHandlers } from '../../server/handlers/tasks'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-taskcreate-'))
  tmpDirs.push(dir)
  return dir
}
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function setupHandler(repo: string) {
  const handlers: Record<string, (...a: any[]) => void> = {}
  const socket: any = {
    on: (event: string, fn: (...a: any[]) => void) => { handlers[event] = fn },
    emit: () => {},
  }
  const ws = { id: 'ws1', name: 'demo', repository: { path: repo, type: 'git' } }
  const ctx: any = {
    io: { emit: () => {} },
    workspaceManager: {
      getActiveWorkspace: () => ws,
      getWorkspace: () => ws,
    },
    // No StateManager set: reproduces blank-start windows where the boot
    // coordinator never ran. Handlers must lazily ensure the task DB.
    agentOrchestrator: new AgentOrchestrator({ emit: () => {} } as any, 4),
    sessionManager: { getSessionStates: () => ({}) },
    chatManager: { getProvider: () => { throw new Error('no providers') } },
  }
  registerTaskHandlers(ctx, socket)
  return { handlers, ctx, ws }
}

function call(handlers: Record<string, (...a: any[]) => void>, event: string, data: any): Promise<any> {
  return new Promise(resolve => handlers[event](data, (res: any) => resolve(res)))
}

// Worktree setup now runs after the ack (fast create); poll until it lands.
async function waitForWorktree(handlers: Record<string, (...a: any[]) => void>, id: string): Promise<any> {
  const deadline = Date.now() + 15000
  for (;;) {
    const listed = await call(handlers, 'list-task-groups', { workspaceId: 'ws1' })
    const group = (listed.taskGroups || []).find((g: any) => g.id === id)
    if (group?.worktreePath && fs.existsSync(group.worktreePath)) return group
    if (Date.now() > deadline) throw new Error('timed out waiting for task worktree')
    await new Promise(r => setTimeout(r, 100))
  }
}

describe('create-task-group against a pre-migration DB file', () => {
  it('self-heals a legacy coordinator.db missing the file column', async () => {
    const repo = tmpDir()
    git(['init', '-b', 'main'], repo)
    git(['config', 'user.email', 'test@test.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'init'], repo)
    // Legacy DB: full v1 schema shape but collab_events WITHOUT the file column.
    fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
    const legacy = new Database(path.join(repo, '.agntspce', 'coordinator.db'))
    legacy.exec(`CREATE TABLE task_groups (id TEXT PRIMARY KEY, workspace_id TEXT, repo_path TEXT NOT NULL, title TEXT NOT NULL, user_goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planning', worktree_mode TEXT NOT NULL DEFAULT 'worktree', branch_name TEXT, worktree_path TEXT, base_sha TEXT, created_at INTEGER NOT NULL, completed_at INTEGER)`)
    legacy.exec(`CREATE TABLE subtasks (id TEXT PRIMARY KEY, task_group_id TEXT NOT NULL REFERENCES task_groups(id), agent_id TEXT NOT NULL, model TEXT, reasoning TEXT, verbosity TEXT, title TEXT NOT NULL DEFAULT '', assignment_prompt TEXT NOT NULL DEFAULT '', scope_files TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, last_event_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER)`)
    legacy.exec(`CREATE TABLE collab_events (id TEXT PRIMARY KEY, task_group_id TEXT NOT NULL REFERENCES task_groups(id), subtask_id TEXT NOT NULL REFERENCES subtasks(id), agent_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, expires_at INTEGER)`)
    legacy.close()

    const { handlers } = setupHandler(repo)
    const res = await call(handlers, 'create-task-group', {
      title: 'Legacy repair',
      userGoal: 'heal me',
      worktreeMode: 'worktree',
      agents: [],
      workspaceId: 'ws1',
    })
    expect(res.ok).toBe(true)
    const group = await waitForWorktree(handlers, res.taskGroup.id)
    expect(group.branchName).toMatch(/^task\//)
    expect(group.status).toBe('active')
  })
})

describe('create-task-group in a folder that is not a git repository', () => {
  it('creates a plain-dir task quietly, with no branch and no base sha', async () => {
    const dir = tmpDir()
    // Deliberately NOT git init — this is a plain folder workspace.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n')

    const { handlers } = setupHandler(dir)
    const res = await call(handlers, 'create-task-group', {
      title: 'No git here',
      userGoal: 'work without a repo',
      worktreeMode: 'worktree',
      agents: [],
      workspaceId: 'ws1',
    })
    expect(res.ok).toBe(true)

    // The slow setup runs after the ack; poll for the deferred write.
    const group = await (async () => {
      const deadline = Date.now() + 10000
      for (;;) {
        const listed = await call(handlers, 'list-task-groups', { workspaceId: 'ws1' })
        const g = (listed.taskGroups || []).find((x: any) => x.id === res.taskGroup.id)
        if (g?.worktreePath) return g
        if (Date.now() > deadline) throw new Error('timed out waiting for task setup')
        await new Promise(r => setTimeout(r, 50))
      }
    })()

    // Plain-dir fallback: a directory exists, but there is nothing to merge.
    expect(group.worktreePath).toBeTruthy()
    expect(fs.existsSync(group.worktreePath)).toBe(true)
    expect(group.baseSha).toBeNull()
    // No bogus integration branch is remembered for a folder git never saw.
    expect(WorktreeLifecycle.isGitRepository(dir)).toBe(false)
  })
})

describe('create-task-group in worktreeMode "none" (accepted no-git mode)', () => {
  it('runs the task in the workspace folder with no branch, no worktree, no merge', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n')

    const { handlers } = setupHandler(dir)
    const res = await call(handlers, 'create-task-group', {
      title: 'No isolation',
      userGoal: 'just work here',
      worktreeMode: 'none',
      agents: [],
      workspaceId: 'ws1',
    })
    expect(res.ok).toBe(true)
    expect(res.taskGroup.worktreeMode).toBe('none')

    const group = await (async () => {
      const deadline = Date.now() + 10000
      for (;;) {
        const listed = await call(handlers, 'list-task-groups', { workspaceId: 'ws1' })
        const g = (listed.taskGroups || []).find((x: any) => x.id === res.taskGroup.id)
        if (g && g.status === 'active') return g
        if (Date.now() > deadline) throw new Error('timed out waiting for task setup')
        await new Promise(r => setTimeout(r, 50))
      }
    })()

    // No isolation means no branch, no worktree path and no base to merge
    // against — and crucially no empty directory pretending to be a worktree.
    expect(group.branchName).toBeNull()
    expect(group.worktreePath).toBeNull()
    expect(group.baseSha).toBeNull()
    expect(fs.existsSync(path.join(dir, '.agntspce', 'tasks', res.taskGroup.id, '.task.json'))).toBe(false)
    // The agent's cwd is the workspace folder, so its briefing lives there.
    expect(fs.existsSync(path.join(dir, 'COLLAB.md'))).toBe(true)
  })
})

describe('create-task-group (no boot coordinator)', () => {
  it('creates the group, isolated worktree, seed files — no StateManager preset', async () => {
    const repo = tmpDir()
    git(['init', '-b', 'main'], repo)
    git(['config', 'user.email', 'test@test.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'init'], repo)

    const { handlers } = setupHandler(repo)
    const res = await call(handlers, 'create-task-group', {
      title: 'Demo task',
      userGoal: 'try it out',
      worktreeMode: 'worktree',
      agents: [],
      workspaceId: 'ws1',
    })
    expect(res.ok).toBe(true)
    expect(res.taskGroup.id).toBeTruthy()
    const group = await waitForWorktree(handlers, res.taskGroup.id)
    expect(group.status).toBe('active')
    expect(group.branchName).toMatch(/^task\//)

    const wt = group.worktreePath
    expect(wt && fs.existsSync(wt)).toBe(true)
    expect(fs.existsSync(path.join(wt, 'COLLAB.md'))).toBe(true)
    expect(fs.existsSync(path.join(wt, '.task.json'))).toBe(true)

    // Second call sees the same DB (lazily created once, then reused).
    const listed = await call(handlers, 'list-task-groups', { workspaceId: 'ws1' })
    expect(listed.ok).toBe(true)
    expect(listed.taskGroups.map((g: any) => g.id)).toContain(res.taskGroup.id)
  })
})
