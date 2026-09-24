import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StateManager } from '../orchestration/stateManager'
import { buildGroupPreamble, syncGroupFiles, GROUP_BRIEFING_FILENAME } from '../orchestration/groupSync'

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

    const { mdPath, briefingPath } = syncGroupFiles(sm, g.id, dir)
    expect(mdPath).toBe(path.join(dir, 'COLLAB.md'))
    expect(fs.existsSync(path.join(dir, 'COLLAB.md'))).toBe(true)
    expect(briefingPath).toBe(path.join(dir, GROUP_BRIEFING_FILENAME))
    const briefing = fs.readFileSync(briefingPath!, 'utf-8')
    // Member ids are discoverable from files alone (no PTY writes).
    expect(briefing).toContain(`--task ${g.id} --subtask ${a.id}`)
    expect(briefing).toContain('claude')
    expect(briefing).toContain('opencode')
  })
})
