import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { StateManager } from '../orchestration/stateManager'
import { WorktreeLifecycle } from '../orchestration/worktreeLifecycle'
import { TaskMerger } from '../orchestration/taskMerger'
import { buildAssignmentPrompt, type PlanContext } from '../orchestration/taskPlanner'

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
  // Mirror a workspace we initialized ourselves: our own state lives inside the
  // repo, so it is gitignored. The fixture's coordinator db sits at the repo
  // root (the real one lives under the ignored .agntspce/), so ignore its WAL
  // sidecars too — otherwise the "dirty tree" guard sees them as user edits.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.agntspce/\nc.db*\n')
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
  // Pin the integration branch name so these tests assert against a known ref.
  // The derived per-workspace name has its own test below.
  sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
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
    expect(res.error).toMatch(/not been committed/i)
    expect(res.error).toContain('README.md')
    // The refusal has to be actionable, not just a diagnosis.
    expect(res.error).toContain('git add -A && git commit')
  })

  it('explains an agent that wrote output but never committed it', async () => {
    // The real demotest2 failure: agent ran `Write(index.html)`, stopped, and
    // the file was still untracked, so the merge had nothing to land and the
    // user never saw the file in their folder.
    const { repo, sm, gid } = setupTask('create a page')
    const wt = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(wt, '.task.json'), '{"id":"x"}\n')
    fs.writeFileSync(path.join(wt, 'COLLAB.md'), '# Team\n')
    fs.writeFileSync(path.join(wt, 'AGENTS-TASK.md'), '# Briefing\n')
    fs.writeFileSync(path.join(wt, 'index.html'), '<!doctype html>\n')

    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/nothing to merge yet/i)
    expect(res.error).toContain('index.html')
    // New files are called out separately from edits to tracked files.
    expect(res.error).toMatch(/new files, never committed/i)
    // Scaffolding AgntSpce writes itself must never be blamed on the agent.
    expect(res.error).not.toContain('.task.json')
    expect(res.error).not.toContain('COLLAB.md')
    expect(res.error).not.toContain('AGENTS-TASK.md')
  })

  it('reports drift and syncs a task branch onto the integration branch', async () => {
    const { repo, sm, gid, branch } = setupTask('task line')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)

    // Fresh task: nothing to sync.
    expect(merger.previewMerge(gid).behindCount).toBe(0)
    expect(merger.syncTaskOntoIntegration(gid)).toEqual({ ok: true, mergedFiles: [] })

    // Another task lands work on the integration branch.
    fs.writeFileSync(path.join(repo, 'other.md'), '# Other\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'other work'], repo)
    git(['checkout', 'agntspce-integration'], repo)
    git(['merge', 'main', '--no-ff', '-m', 'sync'], repo)

    const stale = merger.previewMerge(gid)
    expect(stale.behindCount).toBeGreaterThan(0)

    // Syncing happens inside the task's own worktree — the user's checkout and
    // the task branch both keep their identity.
    const res = merger.syncTaskOntoIntegration(gid)
    expect(res.ok).toBe(true)
    expect(git(['rev-list', '--count', `${branch}..agntspce-integration`], repo)).toBe('0')
    const worktree = path.join(repo, '.agntspce', 'tasks', gid)
    expect(fs.existsSync(path.join(worktree, 'other.md'))).toBe(true)
    // The task's own work is still there.
    expect(git(['show', `${branch}:README.md`], repo)).toContain('task line')
  })

  it('refuses to sync a dirty task worktree', async () => {
    const { repo, sm, gid } = setupTask('task line')
    const worktree = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(worktree, 'README.md'), '# Test\nuncommitted\n')
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).syncTaskOntoIntegration(gid)
    expect(res.ok).toBe(false)
    // Sync has its own framing: nothing to merge is not the problem, clobbering
    // the agent's uncommitted work is.
    expect(res.error).toMatch(/uncommitted work/i)
    expect(res.error).toMatch(/clobber/i)
    expect(res.error).toMatch(/then sync again/i)
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

// Fix 4: merged work landed on `<workspace>_agntspce` and stayed there, so the
// file the agent wrote never appeared in the folder the user was looking at.
// `applyIntegrationToBranch` fast-forwards their checked-out branch — and must
// refuse rather than rewrite anything.
describe('applying the integration branch onto the user branch', () => {
  function setup(): { repo: string; sm: StateManager; gid: string; branch: string } {
    return setupTask('task line')
  }

  it('fast-forwards main so the merged file appears in the folder', async () => {
    const { repo, sm, gid } = setup()
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)

    // Before applying, the user's checkout does not have the task's work.
    expect(git(['show', 'main:README.md'], repo)).not.toContain('task line')

    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch()
    expect(res.ok).toBe(true)
    expect(res.branch).toBe('main')
    expect(res.files).toContain('README.md')
    // Now it does — this is the step the user was missing.
    expect(git(['show', 'main:README.md'], repo)).toContain('task line')
  })

  it('reports up-to-date instead of failing when nothing has moved', () => {
    const { repo, sm } = setup()
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch()
    expect(res.ok).toBe(true)
    expect(res.upToDate).toBe(true)
  })

  it('refuses to touch a dirty working tree', () => {
    const { repo, sm, gid } = setup()
    // Uncommitted work in the user's checkout must never be at risk.
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'unsaved work\n')
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/uncommitted changes/i)
    expect(res.error).toContain('notes.txt')
    // The uncommitted file is still there.
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf-8')).toBe('unsaved work\n')
  })

  it('refuses when the user branch has diverged, rather than merging for them', async () => {
    const { repo, sm, gid } = setup()
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    // The user commits on main; the integration branch does not have it.
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'my own work\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'mine'], repo)
    const before = git(['rev-parse', 'main'], repo)

    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cannot be fast-forwarded/i)
    // No merge commit was created behind their back; main is untouched.
    expect(git(['rev-parse', 'main'], repo)).toBe(before)
  })

  it('refuses to apply onto a task branch', () => {
    const { repo, sm, branch } = setup()
    // In-repo mode checks a task branch out in the shared checkout; "apply"
    // must never move that, or it would rewrite the agent's own branch.
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch(branch)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/task branch/i)
  })

  it('refuses to apply onto a branch that is not checked out', () => {
    const { repo, sm } = setup()
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('some-other-branch')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not the branch you have checked out/i)
  })
})

// A task created before a peer merged sits behind the integration branch with
// no changes of its own. Its worktree cannot see the peer's committed files, so
// the agent reported the file simply did not exist. These cover the two halves
// of the fix: the sync path must work for an empty-but-behind task, and the
// prompt must name the branch so the agent can pull it in itself.
describe('peers work reaching a task that started empty', () => {
  it('syncs peer work into a task that has no changes of its own', () => {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const wtl = new WorktreeLifecycle(repo)

    // Our task starts first, branching from the current integration branch.
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Late', userGoal: 'x' })
    const wt = wtl.createTaskWorktree(g.id, 'late', 'agntspce-integration')
    sm.updateTaskGroup(g.id, { branchName: wt.branchName, worktreePath: wt.worktreePath, baseSha: wt.branchPoint, status: 'active' })

    // A peer then lands work on the integration branch and it gets merged.
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'peer page'], repo)
    git(['branch', '-f', 'agntspce-integration', 'main'], repo)

    // Our worktree is now behind and cannot see the peer's file — exactly what
    // made the agent report it as nonexistent.
    expect(fs.existsSync(path.join(wt.worktreePath, 'index.html'))).toBe(false)

    const merger = new TaskMerger(repo, wtl, sm)
    const preview = merger.previewMerge(g.id)
    expect(preview.actualFiles).toHaveLength(0)      // nothing of its own…
    expect((preview.behindCount ?? 0) > 0).toBe(true) // …but behind the peer

    // The sync must not be gated on having changes of its own.
    const sync = merger.syncTaskOntoIntegration(g.id)
    expect(sync.ok).toBe(true)
    expect(fs.existsSync(path.join(wt.worktreePath, 'index.html'))).toBe(true)
  })

  it('tells a worktree agent how to pull in peer work', () => {
    const ctx: PlanContext = {
      taskTitle: 'Page', userGoal: 'build it', branchName: 'task/page-1',
      worktreePath: '/repo/.agntspce/tasks/1', worktreeMode: 'worktree',
      integrationBranch: 'myrepo_agntspce',
    }
    const p = buildAssignmentPrompt(ctx, { agentId: 'claude' }, 'Markup', ['index.html'], 'opencode owns API', 'page renders')
    expect(p).toContain('PEER WORK')
    expect(p).toContain('myrepo_agntspce')
    expect(p).toContain('git merge myrepo_agntspce --no-edit')
    // It must not invite the agent to move its own branch.
    expect(p).toMatch(/never rebase/i)
  })

  it('omits peer-work instructions when there is no integration branch', () => {
    const noneCtx: PlanContext = {
      taskTitle: 'Page', userGoal: 'build it', branchName: '',
      worktreePath: '/repo', worktreeMode: 'none',
    }
    const p = buildAssignmentPrompt(noneCtx, { agentId: 'claude' }, 'Markup', [], '', 'done')
    expect(p).not.toContain('PEER WORK')
  })
})
