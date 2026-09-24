import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { StateManager } from '../orchestration/stateManager'
import { TaskOrchestrator, type Spawner, type SubtaskSpawnInput } from '../orchestration/taskOrchestrator'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-taskorch-'))
  tmpDirs.push(dir)
  return dir
}
function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

class FakeSpawner implements Spawner {
  spawns: SubtaskSpawnInput[] = []
  closed: string[] = []
  failSpawn = false
  async spawnTaskSubtask(input: SubtaskSpawnInput): Promise<string> {
    if (this.failSpawn) throw new Error('spawn boom')
    this.spawns.push(input)
    return `sess-${input.subtaskId.slice(0, 6)}`
  }
  closeTaskSessions(ids: string[]): number {
    this.closed.push(...ids)
    return ids.length
  }
}

class FakeSlots {
  constructor(private fail = false) {}
  async tryAcquire(count: number): Promise<(() => void)[]> {
    if (this.fail) throw new Error('Could not reserve 2 slots within 1ms (0 acquired)')
    return Array.from({ length: count }, () => () => {})
  }
}

const CLEAN_PLAN = JSON.stringify({
  todoList: ['db', 'ui'],
  subtasks: [
    { agentId: 'claude', title: 'DB', scopeFiles: ['src/db.ts'] },
    { agentId: 'opencode', title: 'UI', scopeFiles: ['src/ui.tsx'] },
  ],
})

function setup(mode: 'worktree' | 'in-repo' = 'worktree'): { repo: string; sm: StateManager; gid: string } {
  const repo = tmpDir()
  initRepo(repo)
  const sm = new StateManager(path.join(repo, 'c.db'), repo)
  const g = sm.createTaskGroup({ repoPath: repo, title: 'Login Page', userGoal: 'build it', worktreeMode: mode })
  sm.addSubTask({ taskGroupId: g.id, agentId: 'claude', model: 'opus' })
  sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })
  return { repo, sm, gid: g.id }
}

describe('TaskOrchestrator', () => {
  it('launches: plans, creates worktree, seeds, reserves, spawns', async () => {
    const { repo, sm, gid } = setup()
    const spawner = new FakeSpawner()
    const orch = new TaskOrchestrator(sm, spawner, new FakeSlots(), { llm: async () => CLEAN_PLAN })
    const res = await orch.launchTask(gid)

    expect(res.sessionIds).toHaveLength(2)
    expect(res.usedFallback).toBe(false)
    const group = sm.getTaskGroup(gid)!
    expect(group.status).toBe('active')
    expect(group.branchName).toMatch(/^task\/login-page-/)
    expect(group.worktreePath).toBeTruthy()
    expect(fs.existsSync(group.worktreePath!)).toBe(true)
    expect(fs.existsSync(path.join(group.worktreePath!, '.task.json'))).toBe(true)
    expect(fs.existsSync(path.join(group.worktreePath!, 'COLLAB.md'))).toBe(true)
    const subs = sm.listSubTasks(gid)
    expect(subs.every(s => s.status === 'running' && s.sessionId)).toBe(true)
    // Spawns share the worktree cwd and carry the assignment prompt.
    expect(new Set(spawner.spawns.map(s => s.cwd))).toEqual(new Set([group.worktreePath]))
    expect(spawner.spawns[0]!.prompt).toContain('agntspce-collab')
    expect(spawner.spawns[0]!.siblingSessionIds).toEqual([])
    expect(spawner.spawns[1]!.siblingSessionIds).toHaveLength(1)
    void repo
  })

  it('launches in-repo mode without a worktree dir', async () => {
    const { sm, gid } = setup('in-repo')
    const orch = new TaskOrchestrator(sm, new FakeSpawner(), new FakeSlots(), { llm: async () => CLEAN_PLAN })
    const res = await orch.launchTask(gid)
    expect(res.sessionIds).toHaveLength(2)
    const group = sm.getTaskGroup(gid)!
    expect(group.worktreePath).toBeNull()
    expect(group.branchName).toMatch(/^task\//)
  })

  it('pauses without spawning when slots are unavailable', async () => {
    const { sm, gid } = setup()
    const spawner = new FakeSpawner()
    const orch = new TaskOrchestrator(sm, spawner, new FakeSlots(true), { llm: async () => CLEAN_PLAN })
    await expect(orch.launchTask(gid)).rejects.toThrow(/NO_CAPACITY|slots/)
    expect(spawner.spawns).toHaveLength(0)
    expect(sm.getTaskGroup(gid)!.status).toBe('paused')
  })

  it('rolls back partial spawns and pauses', async () => {
    const { sm, gid } = setup()
    const spawner = new FakeSpawner()
    spawner.failSpawn = true
    const orch = new TaskOrchestrator(sm, spawner, new FakeSlots(), { llm: async () => CLEAN_PLAN })
    await expect(orch.launchTask(gid)).rejects.toThrow(/spawn boom/)
    expect(sm.getTaskGroup(gid)!.status).toBe('paused')
  })

  it('replans follow-ups: closes old sessions, respawns non-done', async () => {
    const { sm, gid } = setup()
    const spawner = new FakeSpawner()
    const orch = new TaskOrchestrator(sm, spawner, new FakeSlots(), { llm: async () => CLEAN_PLAN })
    const first = await orch.launchTask(gid)
    const subs = sm.listSubTasks(gid)
    sm.updateSubTaskStatus(subs[0]!.id, 'done')

    const res = await orch.replanTask(gid, 'also add logout')
    // Only the non-done subtask respawns; the done session stays closed-or-absent.
    expect(res.sessionIds).toHaveLength(1)
    expect(spawner.closed).toEqual(expect.arrayContaining(first.sessionIds.slice(1)))
    expect(sm.getSubTask(subs[0]!.id)?.status).toBe('done')
    expect(sm.getTaskGroup(gid)!.status).toBe('active')
  })

  it('closes tasks: kills sessions, parks or abandons', async () => {
    const { sm, gid } = setup()
    const spawner = new FakeSpawner()
    const orch = new TaskOrchestrator(sm, spawner, new FakeSlots(), { llm: async () => CLEAN_PLAN })
    const launched = await orch.launchTask(gid)
    const out = orch.closeTask(gid)
    expect(out.closed).toBe(2)
    expect(spawner.closed).toEqual(expect.arrayContaining(launched.sessionIds))
    expect(sm.getTaskGroup(gid)!.status).toBe('paused')
    expect(sm.listSubTasks(gid).every(s => s.status === 'pending' && !s.sessionId)).toBe(true)

    await orch.launchTask(gid)
    orch.closeTask(gid, true)
    expect(sm.getTaskGroup(gid)!.status).toBe('abandoned')
  })

  it('surfaces conflict and staleness warnings', async () => {
    const { sm, gid } = setup()
    const orch = new TaskOrchestrator(sm, new FakeSpawner(), new FakeSlots())
    const subs = sm.listSubTasks(gid)
    sm.updateSubTaskStatus(subs[0]!.id, 'running', 'sess-1')
    // Two subtasks touching the same file within the window.
    sm.appendCollabEvent({ taskGroupId: gid, subtaskId: subs[0]!.id, agentId: 'claude', kind: 'claim', payload: { file: 'src/x.ts' } })
    sm.appendCollabEvent({ taskGroupId: gid, subtaskId: subs[1]!.id, agentId: 'opencode', kind: 'claim', payload: { file: 'src/x.ts' } })
    const warnings = orch.getWarnings(gid)
    expect(warnings.some(w => w.type === 'conflict')).toBe(true)
    // Staleness with a future clock (no event in 20 fake minutes).
    const stale = orch.getWarnings(gid, Date.now() + 20 * 60_000)
    expect(stale.some(w => w.type === 'stale')).toBe(true)
  })

  it('deleteTask closes sessions, retires worktree, drops rows', async () => {
    const { sm, gid } = setup()
    const spawner = new FakeSpawner()
    const orch = new TaskOrchestrator(sm, spawner, new FakeSlots(), { llm: async () => CLEAN_PLAN })
    const launched = await orch.launchTask(gid)
    const wt = sm.getTaskGroup(gid)!.worktreePath!
    expect(fs.existsSync(wt)).toBe(true)

    const out = orch.deleteTask(gid)
    expect(out.closed).toBe(2)
    expect(spawner.closed).toEqual(expect.arrayContaining(launched.sessionIds))
    expect(sm.getTaskGroup(gid)).toBeNull()
    expect(fs.existsSync(wt)).toBe(false)
  })

  it('getDetail bundles group, subtasks, summary, warnings', async () => {
    const { sm, gid } = setup()
    const orch = new TaskOrchestrator(sm, new FakeSpawner(), new FakeSlots(), { llm: async () => CLEAN_PLAN })
    await orch.launchTask(gid)
    const detail = orch.getDetail(gid)
    expect(detail.group.id).toBe(gid)
    expect(detail.subtasks).toHaveLength(2)
    expect(detail.summary.taskId).toBe(gid)
    expect(Array.isArray(detail.warnings)).toBe(true)
  })
})
