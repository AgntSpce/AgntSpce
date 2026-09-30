import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StateManager } from '../orchestration/stateManager'
import { buildGroupPreamble, syncGroupFiles, linkSessionToGroup, GROUP_BRIEFING_FILENAME } from '../orchestration/groupSync'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-group-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe('groupSync', () => {
  it('builds a preamble naming members, scopes, and flag-form CLI usage', () => {
    const preamble = buildGroupPreamble(
      { id: 'g1', title: 'Shared task', userGoal: 'ship it', worktreePath: '/r/.agntspce/tasks/g1', branchName: 'task/x', worktreeMode: 'worktree', status: 'active' } as any,
      [
        { id: 's1', agentId: 'claude', title: 'claude', scopeFiles: [] },
        { id: 's2', agentId: 'opencode', title: 'opencode', scopeFiles: [] },
      ] as any,
      'naming: snake_case'
    )
    expect(preamble).toContain('Shared task')
    expect(preamble).toContain('claude')
    expect(preamble).toContain('opencode')
    expect(preamble).toContain('--task g1 --subtask s1')
    expect(preamble).toContain('snake_case')
    expect(preamble).toContain('/r/.agntspce/tasks/g1')
  })

  it('syncs COLLAB.md and the briefing file without touching any PTY', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: dir, title: 'G' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })
    sm.updateSubTaskStatus(a.id, 'running', 'sess-a')
    sm.updateSubTaskStatus(b.id, 'running', 'sess-b')

    // No worktree here, so the files go under .agntspce/ instead of the user's
    // project root — writing them at the root left three untracked files that
    // then blocked "Apply to main".
    const shared = path.join(dir, '.agntspce', 'shared')
    const { mdPath, briefingPath } = syncGroupFiles(sm, g.id, dir)
    expect(mdPath).toBe(path.join(shared, 'COLLAB.md'))
    expect(fs.existsSync(path.join(shared, 'COLLAB.md'))).toBe(true)
    expect(briefingPath).toBe(path.join(shared, GROUP_BRIEFING_FILENAME))
    expect(fs.existsSync(path.join(dir, 'COLLAB.md'))).toBe(false)
    const briefing = fs.readFileSync(briefingPath!, 'utf-8')
    // Member ids are discoverable from files alone (no PTY writes).
    expect(briefing).toContain(`--task ${g.id} --subtask ${a.id}`)
    expect(briefing).toContain('claude')
    expect(briefing).toContain('opencode')
  })
})

// A live agent described itself as being "in a different task worktree with
// another agent working alongside" after its own task was retired. Joining a
// running session to a second task used to leave it recorded in both, and the
// PTY — still in the first worktree — then reported the second task's id.
describe('a session belongs to exactly one task', () => {
  it('refuses to join a session that is already another task agent', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const one = sm.createTaskGroup({ repoPath: dir, title: 'First', userGoal: 'a' })
    const two = sm.createTaskGroup({ repoPath: dir, title: 'Second', userGoal: 'b' })
    const states: Record<string, any> = { s1: { id: 's1', type: 'claude', status: 'running' } }

    const linked = linkSessionToGroup(sm, states, one.id, 's1', dir)
    expect(linked.joined).toBe(true)

    // Joining the same live session to a second task must be refused, not
    // silently re-homed.
    expect(() => linkSessionToGroup(sm, states, two.id, 's1', dir))
      .toThrow(/already an agent of task/i)
    // And it is still owned by the first task only.
    expect(sm.listSubTasks(one.id).filter(s => s.sessionId === 's1')).toHaveLength(1)
    expect(sm.listSubTasks(two.id).filter(s => s.sessionId === 's1')).toHaveLength(0)
  })

  it('is idempotent for the same task', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: dir, title: 'Same', userGoal: 'a' })
    const states: Record<string, any> = { s1: { id: 's1', type: 'claude', status: 'running' } }
    expect(linkSessionToGroup(sm, states, g.id, 's1', dir).joined).toBe(true)
    // Re-joining to the same task is a no-op, not a second subtask.
    expect(linkSessionToGroup(sm, states, g.id, 's1', dir).joined).toBe(false)
    expect(sm.listSubTasks(g.id).filter(s => s.sessionId === 's1')).toHaveLength(1)
  })

  it('allows a different session into the same task', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: dir, title: 'Two agents', userGoal: 'a' })
    const states: Record<string, any> = {
      s1: { id: 's1', type: 'claude', status: 'running' },
      s2: { id: 's2', type: 'opencode', status: 'running' },
    }
    expect(linkSessionToGroup(sm, states, g.id, 's1', dir).joined).toBe(true)
    expect(linkSessionToGroup(sm, states, g.id, 's2', dir).joined).toBe(true)
  })
})
