import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StateManager } from '../orchestration/stateManager'
import { buildGroupPreamble, injectGroupContext } from '../orchestration/groupSync'

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

  it('injects into running member PTYs and refreshes COLLAB.md', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: dir, title: 'G' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })
    sm.updateSubTaskStatus(a.id, 'running', 'sess-a')
    sm.updateSubTaskStatus(b.id, 'running', 'sess-b')

    const written: string[] = []
    const { injected } = injectGroupContext(sm, { writeToSession: (id, text) => { written.push(id + ':' + text.slice(0, 20)); return true } }, g.id, dir)
    expect(injected).toBe(2)
    expect(written.some(w => w.startsWith('sess-a:'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'COLLAB.md'))).toBe(true)
    // No trailing newline: must not auto-submit into a live TUI.
    const full = (() => {
      const out: string[] = []
      injectGroupContext(sm, { writeToSession: (_id, text) => { out.push(text); return true } }, g.id, dir)
      return out[0]!
    })()
    expect(full.endsWith('\n')).toBe(false)
  })
})
