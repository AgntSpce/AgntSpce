import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { StateManager } from '../orchestration/stateManager'
import { WorktreeLifecycle } from '../orchestration/worktreeLifecycle'
import { TaskOrchestrator, type SubtaskSpawnInput } from '../orchestration/taskOrchestrator'
import { TaskMerger } from '../orchestration/taskMerger'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-e2e-'))
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

const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'agntspce-collab.mjs')

function collab(cwd: string, taskId: string, subtaskId: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, AGNTSPCE_TASK_ID: taskId, AGNTSPCE_SUBTASK_ID: subtaskId },
      encoding: 'utf-8',
      timeout: 30000,
    })
    return { code: 0, out: String(out) }
  } catch (e: any) {
    return { code: e?.status ?? 1, out: String(e?.stdout || '') + String(e?.stderr || '') }
  }
}

// E2E: plan → worktree → seed → (simulated agents via the real CLI binary +
// real file edits) → merge → landed on integration. The spawner is fake (no
// PTY in unit tests); everything else is production code.
describe('task pipeline e2e', () => {
  it('login-page flow lands on the integration branch', async () => {
    const repo = tmpDir()
    git(['init', '-b', 'main'], repo)
    git(['config', 'user.email', 'test@test.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    fs.writeFileSync(path.join(repo, 'README.md'), '# App\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'init'], repo)
    git(['branch', 'agntspce-integration', 'main'], repo)

    const sm = (() => {
      fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
      const m = new StateManager(path.join(repo, '.agntspce', 'coordinator.db'), repo)
      // Pin the integration branch name for this test's assertions; the derived
      // per-workspace name is covered in taskGroups.test.ts.
      m.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
      return m
    })()
    const created = sm.createTaskGroup({ workspaceId: 'ws1', repoPath: repo, title: 'Login Page', userGoal: 'login with db' })
    const dbSub = sm.addSubTask({ taskGroupId: created.id, agentId: 'claude', model: 'opus' })
    const uiSub = sm.addSubTask({ taskGroupId: created.id, agentId: 'opencode' })

    const spawns: SubtaskSpawnInput[] = []
    const slots = { tryAcquire: async (n: number) => Array.from({ length: n }, () => () => {}) }
    const spawner = {
      spawnTaskSubtask: async (input: SubtaskSpawnInput) => {
        spawns.push(input)
        return `sess-${input.subtaskId.slice(0, 6)}`
      },
      closeTaskSessions: (ids: string[]) => ids.length,
    }
    const planJson = JSON.stringify({
      todoList: ['schema', 'form'],
      subtasks: [
        { agentId: 'claude', title: 'Database', scopeFiles: ['src/db.ts'] },
        { agentId: 'opencode', title: 'Form', scopeFiles: ['src/form.tsx'] },
      ],
    })
    const orch = new TaskOrchestrator(sm, spawner, slots, { llm: async () => planJson })
    const launched = await orch.launchTask(created.id)
    expect(launched.sessionIds).toHaveLength(2)

    const group = sm.getTaskGroup(created.id)!
    expect(group.status).toBe('active')
    const wt = group.worktreePath!
    expect(fs.existsSync(path.join(wt, 'COLLAB.md'))).toBe(true)

    // The task worktree itself must not pollute the main repo's git status.
    const status = git(['status', '--porcelain'], repo)
    expect(status.split('\n').filter(l => l.includes('.agntspce'))).toEqual([])

    // Agent 1 (claude): claim, edit, post, release, done — via the real CLI.
    expect(collab(wt, created.id, dbSub.id, ['claim', 'src/db.ts']).code).toBe(0)
    expect(collab(wt, created.id, uiSub.id, ['claim', 'src/db.ts']).code).toBe(1)
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'db.ts'), 'export const users = "users";\n')
    expect(collab(wt, created.id, dbSub.id, ['post', 'schema done']).code).toBe(0)
    expect(collab(wt, created.id, dbSub.id, ['release', 'src/db.ts']).code).toBe(0)

    // Agent 2 (opencode): sees agent 1's conventions, writes matching code.
    expect(collab(wt, created.id, uiSub.id, ['claim', 'src/form.tsx']).code).toBe(0)
    fs.writeFileSync(path.join(wt, 'src', 'form.tsx'), 'import { users } from "./db";\n')
    expect(collab(wt, created.id, uiSub.id, ['done', 'form uses shared users export']).code).toBe(0)
    expect(collab(wt, created.id, dbSub.id, ['done', 'schema done']).code).toBe(0)

    const md = fs.readFileSync(path.join(wt, 'COLLAB.md'), 'utf-8')
    expect(md).toContain('schema done')
    expect(md).toContain('shared users export')

    git(['add', '.'], wt)
    git(['commit', '-m', 'login work'], wt)

    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const merged = await merger.executeMerge(created.id, false)
    expect(merged.error).toBeUndefined()
    expect(merged.ok).toBe(true)
    expect(sm.getTaskGroup(created.id)!.status).toBe('done')
    expect(git(['show', 'agntspce-integration:src/db.ts'], repo)).toContain('users')
    expect(git(['show', 'agntspce-integration:src/form.tsx'], repo)).toContain('./db')
    expect(fs.existsSync(wt)).toBe(false)
  })
})
