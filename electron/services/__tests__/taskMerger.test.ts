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

/** Same as setupTask, but the integration branch has moved on and both sides
 *  touched README.md, so the merge conflicts. */
function setupConflictingTask(): { repo: string; sm: StateManager; gid: string; branch: string } {
  const s = setupTask('task line')
  fs.writeFileSync(path.join(s.repo, 'README.md'), '# Test\nintegration line\n')
  git(['add', '.'], s.repo)
  git(['commit', '-m', 'integration work'], s.repo)
  git(['checkout', 'agntspce-integration'], s.repo)
  git(['merge', 'main', '--no-ff', '-m', 'sync'], s.repo)
  return s
}

const RESOLUTION_PATCH = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,2 @@',
  ' # Test',
  '-integration line',
  '+task line',
  '',
].join('\n')

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

  it('keeps the prepared candidate in the DB, so a fresh merger can confirm it', async () => {
    const { repo, sm, gid } = setupConflictingTask()
    const llm = async () => RESOLUTION_PATCH
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm, llm).executeMerge(gid, true)
    expect(res.needsConfirm).toBe(true)

    // The candidate must live in the DB, not on the instance: the socket layer
    // builds a new TaskMerger for every event, so an in-memory map made this
    // step unreachable in the real app.
    expect(sm.getTaskGroup(gid)!.mergeCandidateRef).toBeTruthy()
    expect(sm.getTaskGroup(gid)!.mergeCandidateBase).toBeTruthy()

    // A brand-new instance, exactly like the next socket event would build.
    const fresh = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, llm)
    expect(fresh.previewMerge(gid).pendingCandidate).toBeTruthy()
    const confirmed = fresh.confirmMerge(gid)
    expect(confirmed.ok).toBe(true)
    expect(sm.getTaskGroup(gid)!.status).toBe('done')
    expect(sm.getTaskGroup(gid)!.mergeCandidateRef).toBeNull()
  })

  it('lands an AI-resolved merge as a real two-parent commit and reclaims the branch', async () => {
    const { repo, sm, gid, branch } = setupConflictingTask()
    const llm = async () => RESOLUTION_PATCH
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, llm)
    expect((await merger.executeMerge(gid, true)).needsConfirm).toBe(true)
    expect(merger.confirmMerge(gid).ok).toBe(true)

    // Two parents: the integration tip and the task branch. A single-parent
    // commit here used to make `merge-base --is-ancestor` fail during cleanup,
    // leaking the task branch forever.
    const parents = git(['rev-list', '--parents', '-n', '1', 'agntspce-integration'], repo).split(/\s+/).filter(Boolean)
    expect(parents.length).toBe(3) // commit + 2 parents
    // The task branch is an ancestor now, so cleanup removes it.
    expect(git(['branch', '--list', branch], repo)).toBe('')
  })

  it('flags files claimed by other unfinished tasks', () => {
    const { repo, sm, gid } = setupTask('task line')
    sm.addSubTask({ taskGroupId: gid, agentId: 'claude', scopeFiles: ['src/a.ts', 'src/b.ts'] })
    const other = sm.createTaskGroup({ repoPath: repo, title: 'Other', userGoal: 'y' })
    sm.updateTaskGroup(other.id, { status: 'active' })
    sm.addSubTask({ taskGroupId: other.id, agentId: 'codex', scopeFiles: ['src/b.ts', 'src/c.ts'] })

    const preview = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(gid)
    expect(preview.scopeOverlapFiles).toEqual(['src/b.ts'])

    // Finished tasks are not a conflict risk any more.
    sm.updateTaskGroup(other.id, { status: 'done' })
    const after = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(gid)
    expect(after.scopeOverlapFiles).toEqual([])
  })

  it('finishes a task with nothing to merge instead of erroring', async () => {
    const { repo, sm, gid } = setupTask('task line')
    // Fold the task branch into the integration branch behind the merger's back,
    // so the task has no changes left. This used to fall through to `git commit`
    // and fail with "nothing to commit, working tree clean".
    git(['merge', '--no-ff', '-m', 'already landed', 'agntspce-integration'], path.join(repo, '.agntspce', 'tasks', gid))
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(sm.getTaskGroup(gid)!.status).toBe('done')
  })

  it('ignores generated task scaffolding but still blocks on real uncommitted work', async () => {
    const { repo, sm, gid } = setupTask('task line')
    // Exactly what AgntSpce writes into every task worktree at launch.
    const wt = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(wt, '.task.json'), '{"id":"x"}\n')
    fs.writeFileSync(path.join(wt, 'COLLAB.md'), '# Team\n')
    fs.writeFileSync(path.join(wt, 'AGENTS-TASK.md'), '# Briefing\n')

    // Untracked scaffolding alone must not make the task unmergeable.
    const preview = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(gid)
    expect(preview.error).toBeUndefined()
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
  })

  it('still refuses to merge when a tracked file has uncommitted edits', async () => {
    const { repo, sm, gid } = setupTask('task line')
    const wt = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(wt, 'README.md'), '# Test\nhalf-finished work\n')
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/uncommitted changes/i)
    expect(res.error).toContain('README.md')
  })

  it('blocks a second merge for the same repo while one is resolving', async () => {
    // Only the AI path is genuinely async, so that is the only place two merges
    // can interleave. Hold the LLM open to simulate it.
    const { repo, sm, gid } = setupConflictingTask()
    let release: (patch: string) => void = () => {}
    const llm = () => new Promise<string>(resolve => { release = resolve })
    const pending = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, llm).executeMerge(gid, true)
    await new Promise(r => setImmediate(r))

    const blocked = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm, llm).executeMerge(gid, true)
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toMatch(/already in progress/i)

    release(RESOLUTION_PATCH)
    expect((await pending).needsConfirm).toBe(true)
  })
})
