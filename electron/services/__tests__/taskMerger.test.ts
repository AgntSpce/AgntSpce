import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { StateManager } from '../orchestration/stateManager'
import { WorktreeLifecycle } from '../orchestration/worktreeLifecycle'
import { TaskMerger } from '../orchestration/taskMerger'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-merger-'))
  tmpDirs.push(dir)
  return dir
}
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}
function initRepo(dir: string): void {
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@test.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\nline\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'init'], dir)
  git(['branch', 'agntspce-integration', 'main'], dir)
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function setupTask(line: string): { repo: string; sm: StateManager; gid: string; branch: string } {
  const repo = tmpDir()
  initRepo(repo)
  const sm = new StateManager(path.join(repo, 'c.db'), repo)
  const g = sm.createTaskGroup({ repoPath: repo, title: 'Feature', userGoal: 'x' })
  const wtl = new WorktreeLifecycle(repo)
  const res = wtl.createTaskWorktree(g.id, 'feature', 'agntspce-integration')
  fs.writeFileSync(path.join(res.worktreePath, 'README.md'), `# Test\n${line}\n`)
  git(['add', '.'], res.worktreePath)
  git(['commit', '-m', 'task work'], res.worktreePath)
  sm.updateTaskGroup(g.id, { branchName: res.branchName, worktreePath: res.worktreePath, baseSha: res.branchPoint, status: 'active' })
  return { repo, sm, gid: g.id, branch: res.branchName }
}

describe('TaskMerger', () => {
  it('previews diffs without merging', () => {
    const { repo, sm, gid } = setupTask('task line')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const preview = merger.previewMerge(gid)
    expect(preview.error).toBeUndefined()
    expect(preview.conflictFiles).toEqual([])
    expect(preview.actualFiles).toContain('README.md')
    expect(preview.diffSummary).toContain('README.md')
    // Preview leaves the integration branch untouched.
    expect(git(['rev-parse', 'agntspce-integration'], repo)).toBe(git(['rev-parse', 'main'], repo))
  })

  it('auto-promotes clean merges and retires the worktree', async () => {
    const { repo, sm, gid } = setupTask('task line')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const res = await merger.executeMerge(gid, false)
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(res.needsConfirm).toBe(false)
    expect(res.mergeCommitSha).toBeTruthy()
    expect(sm.getTaskGroup(gid)!.status).toBe('done')
    expect(git(['show', 'agntspce-integration:README.md'], repo)).toContain('task line')
  })

  it('blocks on conflicts without auto-resolve', async () => {
    const { repo, sm, gid } = setupTask('task line')
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\nintegration line\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'integration work'], repo)
    git(['checkout', 'agntspce-integration'], repo)
    git(['merge', 'main', '--no-ff', '-m', 'sync'], repo)
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const preview = merger.previewMerge(gid)
    expect(preview.conflictFiles).toContain('README.md')
    const res = await merger.executeMerge(gid, false)
    expect(res.ok).toBe(false)
    expect(res.conflictFiles).toContain('README.md')
    expect(res.error).toMatch(/conflict/i)
  })

  it('resolves via LLM into a confirm-pending candidate, then promotes on confirm', async () => {
    const { repo, sm, gid } = setupTask('task line')
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\nintegration line\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'integration work'], repo)
    git(['checkout', 'agntspce-integration'], repo)
    git(['merge', 'main', '--no-ff', '-m', 'sync'], repo)

    const patch = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,2 +1,2 @@',
      ' # Test',
      '-integration line',
      '+task line',
      '',
    ].join('\n')
    const llm = async () => patch
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, llm)
    const res = await merger.executeMerge(gid, true)
    expect(res.ok).toBe(false)
    expect(res.needsConfirm).toBe(true)
    expect(res.mergeCommitSha).toBeTruthy()
    // Nothing landed yet — confirm gate holds.
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8')).not.toContain('task line')
    expect(sm.getTaskGroup(gid)!.status).toBe('merging')

    const confirmed = merger.confirmMerge(gid)
    expect(confirmed.ok).toBe(true)
    expect(sm.getTaskGroup(gid)!.status).toBe('done')
    // update-ref moves the branch under the checked-out tree; reset to refresh.
    git(['reset', '--hard', 'agntspce-integration'], repo)
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf-8')).toContain('task line')
  })
})
