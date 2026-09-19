import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { StateManager } from '../orchestration/stateManager'
import { WorktreeLifecycle } from '../orchestration/worktreeLifecycle'

const tmpDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-tasks-'))
  tmpDirs.push(dir)
  return dir
}

function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Repo\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir })
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim()
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe('v2 task groups', () => {
  it('creates, lists, and updates task groups pinned to one repo', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ workspaceId: 'ws1', repoPath: '/repo/a', title: 'Login Page!', userGoal: 'build it' })
    expect(g.id).toBeTruthy()
    expect(g.status).toBe('planning')
    expect(g.worktreeMode).toBe('worktree')
    expect(g.repoPath).toBe('/repo/a')

    expect(sm.listTaskGroups('ws1')).toHaveLength(1)
    expect(sm.listTaskGroups('ws-other')).toHaveLength(0)

    const updated = sm.updateTaskGroup(g.id, { status: 'active', branchName: 'task/login-x', baseSha: 'abc' })!
    expect(updated.status).toBe('active')
    expect(updated.branchName).toBe('task/login-x')
    expect(updated.baseSha).toBe('abc')
  })

  it('manages subtasks with scope files and session links', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: '/repo/a', title: 'T' })
    const s1 = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude', model: 'opus', title: 'DB', scopeFiles: ['src/db/a.ts'] })
    const s2 = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode', title: 'UI', scopeFiles: ['src/ui/b.tsx'] })
    expect(sm.listSubTasks(g.id)).toHaveLength(2)
    expect(s1.scopeFiles).toEqual(['src/db/a.ts'])

    sm.updateSubTaskStatus(s1.id, 'running', 'sess-1')
    expect(sm.getSubTask(s1.id)?.status).toBe('running')
    expect(sm.getSubTask(s1.id)?.sessionId).toBe('sess-1')

    sm.upsertSession({ id: 'sess-1', sessionType: 'claude', agentId: 'claude', taskGroupId: g.id, subtaskId: s1.id })
    const sess = sm.getSession('sess-1')!
    expect(sess.taskGroupId).toBe(g.id)
    expect(sess.subtaskId).toBe(s1.id)
    void s2
  })

  it('enforces TTL file claims between subtasks', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: '/repo/a', title: 'T' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })

    sm.claimFile(g.id, 'src/x.ts', a.id, 'claude')
    expect(() => sm.claimFile(g.id, 'src/x.ts', b.id, 'opencode')).toThrowError(/claimed/i)
    // Same subtask can re-claim (renew).
    sm.claimFile(g.id, 'src/x.ts', a.id, 'claude')
    sm.releaseFile(g.id, 'src/x.ts', a.id, 'claude')
    // After release, the other subtask can claim.
    sm.claimFile(g.id, 'src/x.ts', b.id, 'opencode')

    // Expired claims do not block (ttlMs negative => already past TTL).
    sm.appendCollabEvent({ taskGroupId: g.id, subtaskId: a.id, agentId: 'claude', kind: 'claim', payload: { file: 'src/y.ts' }, ttlMs: -1 })
    sm.claimFile(g.id, 'src/y.ts', b.id, 'opencode')

    const events = sm.getCollabEvents(g.id)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]!.createdAt).toBeLessThanOrEqual(events[events.length - 1]!.createdAt)
    expect(sm.getSubTask(b.id)?.lastEventAt).toBeTruthy()
  })

  it('rejects release by non-holder and finds claims past any row window', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: '/repo/a', title: 'T' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })

    sm.claimFile(g.id, 'src/keep.ts', a.id, 'claude')
    // Bury the claim under hundreds of unrelated events: the holder lookup
    // filters by file in SQL, so history length must not matter.
    for (let i = 0; i < 250; i++) {
      sm.appendCollabEvent({ taskGroupId: g.id, subtaskId: b.id, agentId: 'opencode', kind: 'progress', payload: { i } })
    }
    expect(() => sm.claimFile(g.id, 'src/keep.ts', b.id, 'opencode')).toThrowError(/claimed by/i)
    expect(() => sm.releaseFile(g.id, 'src/keep.ts', b.id, 'opencode')).toThrowError(/claimed by/i)
    // The actual holder can still release, then the file is free.
    sm.releaseFile(g.id, 'src/keep.ts', a.id, 'claude')
    sm.claimFile(g.id, 'src/keep.ts', b.id, 'opencode')
    expect(sm.getFileClaimHolder(g.id, 'src/keep.ts')?.subtaskId).toBe(b.id)
  })
})

describe('v2 task worktrees', () => {
  it('creates and removes a task worktree, keeping unmerged branches', () => {
    const repo = tmpDir()
    const defaultBranch = initRepo(repo)
    fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
    const sm = new StateManager(path.join(repo, '.agntspce', 'c.db'), repo)
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Login Page' })
    const wtl = new WorktreeLifecycle(repo)

    const slug = WorktreeLifecycle.sanitizeTaskSlug(g.title)
    expect(slug).toBe('login-page')
    const res = wtl.createTaskWorktree(g.id, slug, defaultBranch)
    expect(res.branchName.startsWith('task/login-page-')).toBe(true)
    expect(fs.existsSync(res.worktreePath)).toBe(true)
    expect(res.branchPoint).toBeTruthy()
    expect(wtl.taskWorktreeExists(g.id)).toBe(true)

    // Make the task branch genuinely unmerged, then removal must keep it.
    fs.writeFileSync(path.join(res.worktreePath, 'feature.txt'), 'work\n')
    execFileSync('git', ['add', '.'], { cwd: res.worktreePath })
    execFileSync('git', ['commit', '-m', 'task work'], { cwd: res.worktreePath })

    // Unmerged removal: worktree goes away, branch survives.
    wtl.removeTaskWorktree(g.id, defaultBranch)
    expect(wtl.taskWorktreeExists(g.id)).toBe(false)
    const branches = execFileSync('git', ['branch', '--list', res.branchName], { cwd: repo, encoding: 'utf-8' }).trim()
    expect(branches).toContain(res.branchName)
    execFileSync('git', ['branch', '-D', res.branchName], { cwd: repo })
  })

  it('deduplicates branch names', () => {
    const repo = tmpDir()
    const defaultBranch = initRepo(repo)
    const wtl = new WorktreeLifecycle(repo)
    const base = 'task/demo-12345678'
    execFileSync('git', ['branch', base, defaultBranch], { cwd: repo })
    expect(wtl.deduplicateBranchName(base)).toBe(`${base}-2`)
    expect(wtl.deduplicateBranchName('task/free-12345678')).toBe('task/free-12345678')
  })

  it('ignores .agntspce/ idempotently without touching existing rules', () => {
    const repo = tmpDir()
    initRepo(repo)
    const wtl = new WorktreeLifecycle(repo)
    const gi = path.join(repo, '.gitignore')

    wtl.ensureTasksIgnored()
    expect(fs.readFileSync(gi, 'utf-8')).toContain('.agntspce/')

    fs.writeFileSync(gi, 'node_modules/\n.agntspce/\n')
    wtl.ensureTasksIgnored()
    expect(fs.readFileSync(gi, 'utf-8')).toBe('node_modules/\n.agntspce/\n')

    fs.writeFileSync(gi, 'node_modules/')
    wtl.ensureTasksIgnored()
    expect(fs.readFileSync(gi, 'utf-8')).toBe('node_modules/\n.agntspce/\n')
  })
})
