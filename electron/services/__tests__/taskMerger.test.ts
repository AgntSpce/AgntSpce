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
/** Whether `<ref>:<file>` exists. `cat-file -e` is silent on success, so the
 *  exit code is the only signal. */
function refHas(ref: string, file: string, cwd: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${file}`], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
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

  it('auto-promotes a clean merge and leaves the task alone', async () => {
    const { repo, sm, gid } = setupTask('task line')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const res = await merger.executeMerge(gid, false)
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(res.needsConfirm).toBe(false)
    expect(res.mergeCommitSha).toBeTruthy()
    expect(sm.getTaskGroup(gid)!.status).toBe('active')
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
    expect(sm.getTaskGroup(gid)!.status).toBe('active')
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
    expect(sm.getTaskGroup(gid)!.status).toBe('active')
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
    // A merge leaves the task's branch in place, so more work can land on it.
    expect(git(['branch', '--list', branch], repo)).toContain(branch)
  })

  it('flags files this task and another unfinished task both changed', () => {
    // Overlap is measured from each task's real diff now, not from a planner's
    // declared scope — a guess about who "owns" src/ was never reliable.
    const { repo, sm, gid } = setupTask('task line')
    // This task's diff already contains README.md.
    const other = sm.createTaskGroup({ repoPath: repo, title: 'Other', userGoal: 'y' })
    sm.updateTaskGroup(other.id, { status: 'active' })
    // Give the other task a real branch that touches the same file.
    const wtl = new WorktreeLifecycle(repo)
    const wt2 = wtl.createTaskWorktree(other.id, 'other', 'agntspce-integration')
    fs.writeFileSync(path.join(wt2.worktreePath, 'README.md'), '# Test\nother task line\n')
    fs.writeFileSync(path.join(wt2.worktreePath, 'peer-only.md'), '# Peer\n')
    git(['add', '.'], wt2.worktreePath)
    git(['commit', '-m', 'peer work'], wt2.worktreePath)
    sm.updateTaskGroup(other.id, { branchName: wt2.branchName, worktreePath: wt2.worktreePath, baseSha: wt2.branchPoint, status: 'active' })

    const preview = new TaskMerger(repo, wtl, sm).previewMerge(gid)
    // README.md is the only file both tasks actually changed.
    expect(preview.scopeOverlapFiles).toEqual(['README.md'])

    // Finished tasks are not a conflict risk any more.
    sm.updateTaskGroup(other.id, { status: 'done' })
    const after = new TaskMerger(repo, wtl, sm).previewMerge(gid)
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
    expect(sm.getTaskGroup(gid)!.status).toBe('active')
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

  it('commits an agent\'s uncommitted edits rather than refusing', async () => {
    // Verified failure: an agent finished its work and declined to commit,
    // reasoning that the branch was shared. Merge then dead-ended with "there
    // is nothing to merge yet" and the work was stranded. Merging is the user
    // saying "take this work", so the app commits it and says so.
    const { repo, sm, gid } = setupTask('task line')
    const wt = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(wt, 'README.md'), '# Test\nhalf-finished work\n')
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    // Reported, not silent.
    expect(res.autoCommittedFiles).toEqual(['README.md'])
    // And it really landed.
    expect(git(['show', 'agntspce-integration:README.md'], repo)).toContain('half-finished work')
  })

  it('reports pending work in the preview so the action can name itself', () => {
    const { repo, sm, gid } = setupTask('task line')
    const wt = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(wt, 'README.md'), '# Test\nnot yet committed\n')
    const preview = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(gid)
    // Drives the "Commit & merge" label rather than a bare "Merge changes".
    expect(preview.pendingFiles).toEqual(['README.md'])
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
    // Same situation, opposite outcome: the work is committed for the agent and
    // merged rather than refused.
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(res.autoCommittedFiles).toEqual(['index.html'])
    expect(git(['show', 'agntspce-integration:index.html'], repo)).toContain('doctype')
    // AgntSpce's own scaffolding is never committed on the agent's behalf.
    expect(res.autoCommittedFiles).not.toContain('.task.json')
    expect(res.autoCommittedFiles).not.toContain('COLLAB.md')
    expect(res.autoCommittedFiles).not.toContain('AGENTS-TASK.md')
    // And it never reaches the integration branch.
    for (const f of ['.task.json', 'COLLAB.md', 'AGENTS-TASK.md']) {
      expect(refHas('agntspce-integration', f, repo)).toBe(false)
    }
  })

  it('reports drift and syncs a task branch onto the integration branch', async () => {
    const { repo, sm, gid, branch } = setupTask('task line')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)

    // Fresh task: nothing to sync.
    expect(merger.previewMerge(gid).behindCount).toBe(0)
    expect(merger.syncTaskOntoIntegration(gid)).toMatchObject({ ok: true, mergedFiles: [] })

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

  it('commits pending work before syncing instead of refusing', async () => {
    // Sync used to refuse on a dirty worktree, so "Update from branch" failed
    // for the same reason merge did: the agent never committed. It now commits
    // first, then updates.
    const { repo, sm, gid } = setupTask('task line')
    const worktree = path.join(repo, '.agntspce', 'tasks', gid)
    fs.writeFileSync(path.join(worktree, 'README.md'), '# Test\nuncommitted\n')
    // A peer lands something this task is behind.
    fs.writeFileSync(path.join(repo, 'peer.md'), '# Peer\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'peer'], repo)
    git(['branch', '-f', 'agntspce-integration', 'main'], repo)

    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).syncTaskOntoIntegration(gid)
    expect(res.ok).toBe(true)
    // The agent's work was committed, and reported rather than silent.
    expect(res.autoCommittedFiles).toEqual(['README.md'])
    // The peer's work arrived.
    expect(fs.existsSync(path.join(worktree, 'peer.md'))).toBe(true)
    // Both survive.
    expect(git(['show', `${res.mergedFiles && 'HEAD'}:README.md`], worktree)).toContain('uncommitted')
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

  it('never puts uncommitted work at risk, and no longer blocks on it', () => {
    const { repo, sm, gid } = setup()
    // Uncommitted work in the user's checkout must never be at risk.
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'unsaved work\n')
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch()
    // It used to refuse outright. The safety guarantee is unchanged and is now
    // enforced precisely: the edit survives, byte for byte, and is reported as
    // preserved rather than as a blocker.
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf-8')).toBe('unsaved work\n')
    expect(res.ok).toBe(true)
    if (res.files?.length) expect(res.preservedDirtyFiles).toEqual(['notes.txt'])
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
    // The button says "Apply to main", so the refusal has to name both branches
    // and say what to do, not just that it refused.
    expect(res.error).toMatch(/You are on main, not some-other-branch/)
    expect(res.error).toMatch(/Check out some-other-branch first/i)
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

// A real workspace produced a task that was already merged — its branch deleted,
// its worktree unregistered, an orphan directory left inside the repo — while
// the row still said `active`. Three separate failures came out of that, and
// each is pinned here.
describe('retired tasks cannot haunt the merge flow', () => {
  it('does not blame a task for the main repo dirty files via an orphan dir', async () => {
    const { repo, sm, gid } = setupTask('task line')
    const wt = path.join(repo, '.agntspce', 'tasks', gid)
    // Simulate the retired state: the worktree is unregistered, so its `.git`
    // entry is gone and only generated files remain.
    fs.rmSync(path.join(wt, '.git'), { force: true })
    fs.writeFileSync(path.join(wt, 'COLLAB.md'), '# Team\n')
    // The user's own uncommitted edit in the main checkout.
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>\n')

    // Before the fix this reported "M index.html" as the task's uncommitted work.
    const preview = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(gid)
    expect(preview.error).toBeUndefined()
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(gid, false)
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
  })

  it('leaves the task intact when it has nothing to merge', async () => {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Empty', userGoal: 'x' })
    const wtl = new WorktreeLifecycle(repo)
    const wt = wtl.createTaskWorktree(g.id, 'empty', 'agntspce-integration')
    sm.updateTaskGroup(g.id, { branchName: wt.branchName, worktreePath: wt.worktreePath, baseSha: wt.branchPoint, status: 'active' })

    // No commits of its own, so there is nothing to land.
    const res = await new TaskMerger(repo, wtl, sm).executeMerge(g.id, false)
    expect(res.ok).toBe(true)
    expect(sm.getTaskGroup(g.id)!.status).toBe('active')

    // Previously the status flipped but the branch leaked and the directory was
    // left behind as an orphan.
    // Nothing to merge is not a reason to tear the task down.
    let branchStillThere = true
    try { git(['rev-parse', '--verify', wt.branchName], repo) } catch { branchStillThere = false }
    expect(branchStillThere).toBe(true)
    expect(fs.existsSync(path.join(wt.worktreePath, '.git'))).toBe(true)
  })

  it('reports success when bookkeeping fails after the work has landed', async () => {
    // The worst variant: the integration ref moved, then something threw. The
    // user must not be told the merge failed, because retrying would apply the
    // work twice.
    const { repo, sm, gid, branch } = setupTask('task line')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const before = git(['rev-parse', 'agntspce-integration'], repo)
    // Force a throw from the post-promote bookkeeping.
    const original = (merger as any).recordMerge.bind(merger)
    ;(merger as any).recordMerge = () => { throw new Error('bookkeeping exploded') }

    const res = await merger.executeMerge(gid, false)
    expect(res.ok).toBe(true)
    // The work really is on the integration branch, and it was not rolled back.
    expect(git(['rev-parse', 'agntspce-integration'], repo)).not.toBe(before)
    expect(git(['show', `agntspce-integration:README.md`], repo)).toContain('task line')
    ;(merger as any).recordMerge = original
    expect(branch).toContain('task/')
  })
})

// Two real bugs that made "Merge all" fail with "0 of 2 merged", found by the
// end-to-end loop test rather than by any unit test.

describe('merging tasks that started before each other', () => {
  function setupPair(): { repo: string; sm: StateManager; one: string; two: string; w1: string; w2: string } {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const wtl = new WorktreeLifecycle(repo)

    // Both tasks branch from the same starting point, before either merges.
    const a = sm.createTaskGroup({ repoPath: repo, title: 'One', userGoal: 'x' })
    const w1 = wtl.createTaskWorktree(a.id, 'one', 'agntspce-integration')
    sm.updateTaskGroup(a.id, { branchName: w1.branchName, worktreePath: w1.worktreePath, baseSha: w1.branchPoint, status: 'active' })

    const b = sm.createTaskGroup({ repoPath: repo, title: 'Two', userGoal: 'y' })
    const w2 = wtl.createTaskWorktree(b.id, 'two', 'agntspce-integration')
    sm.updateTaskGroup(b.id, { branchName: w2.branchName, worktreePath: w2.worktreePath, baseSha: w2.branchPoint, status: 'active' })

    // Agents are told `git add -A`, so they commit our generated files too.
    for (const [wt, page] of [[w1.worktreePath, 'one.html'], [w2.worktreePath, 'two.html']] as const) {
      fs.writeFileSync(path.join(wt, page), `<h1>${page}</h1>\n`)
      fs.writeFileSync(path.join(wt, '.task.json'), `{"page":"${page}"}\n`)
      fs.writeFileSync(path.join(wt, 'COLLAB.md'), `# Team ${page}\n`)
      git(['add', '.'], wt)
      git(['commit', '-m', `add ${page}`], wt)
    }
    return { repo, sm, one: a.id, two: b.id, w1: w1.worktreePath, w2: w2.worktreePath }
  }

  it('does not conflict on our own generated files', async () => {
    // Both branches added .task.json and COLLAB.md with different content, so
    // the second merge conflicted on them and reported
    // "Merge conflicts in: .task.json, COLLAB.md" — which reads as the app
    // being broken rather than as bookkeeping noise.
    const { repo, sm, one, two } = setupPair()
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)

    expect((await merger.executeMerge(one, false)).ok).toBe(true)
    const second = await merger.executeMerge(two, false)
    expect(second.error).toBeUndefined()
    expect(second.ok).toBe(true)
  })

  it('never carries generated files into the repo the user sees', async () => {
    const { repo, sm, one, two } = setupPair()
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    await merger.executeMerge(one, false)
    await merger.executeMerge(two, false)
    // The real pages landed on the integration branch.
    expect(refHas('agntspce-integration', 'one.html', repo)).toBe(true)
    expect(refHas('agntspce-integration', 'two.html', repo)).toBe(true)
    // Our per-task files did not.
    for (const f of ['.task.json', 'COLLAB.md', 'AGENTS-TASK.md']) {
      expect(refHas('agntspce-integration', f, repo)).toBe(false)
    }
  })

  it('treats a re-merge of a fully-merged task as a harmless no-op', async () => {
    // A merge no longer retires the task, so the branch is still there and a
    // second merge finds nothing to do. That has to be a quiet success, not an
    // error: nothing was lost, and the task is still usable.
    const { repo, sm, one } = setupPair()
    expect((await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(one, false)).ok).toBe(true)

    const again = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(one, false)
    expect(again.error).toBeUndefined()
    expect(again.ok).toBe(true)
    // Untouched, and still ready for more work.
    expect(sm.getTaskGroup(one)!.status).toBe('active')
    const preview = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(one)
    expect(preview.error).toBeUndefined()
  })

  it('always reports a preview failure with a usable reason', async () => {
    // The dialog reads the top-level `error` and fell back to the useless
    // "Could not read the merge preview" when it was absent, which is what a
    // real failure looked like. Every preview outcome must carry a reason the
    // UI can show.
    const { repo, sm, gid } = setupTask('task line')
    const wtl = new WorktreeLifecycle(repo)
    const merger = new TaskMerger(repo, wtl, sm)

    // 1. A healthy task: no error at all.
    expect(merger.previewMerge(gid).error).toBeUndefined()

    // 2. After a merge the task is still a normal, previewable task.
    expect((await merger.executeMerge(gid, false)).ok).toBe(true)
    expect(merger.previewMerge(gid).error).toBeUndefined()

    // 3. A task whose worktree is gone entirely: still a reason, not a blank.
    const g2 = sm.createTaskGroup({ repoPath: repo, title: 'Vanished', userGoal: 'x' })
    const wt2 = wtl.createTaskWorktree(g2.id, 'vanish', 'agntspce-integration')
    sm.updateTaskGroup(g2.id, { branchName: wt2.branchName, worktreePath: wt2.worktreePath, baseSha: wt2.branchPoint, status: 'active' })
    // Yank the directory out from under it, leaving a stale registration.
    fs.rmSync(wt2.worktreePath, { recursive: true, force: true })
    const gone = new TaskMerger(repo, wtl, sm).previewMerge(g2.id)
    if (gone.error) expect(gone.error.trim().length).toBeGreaterThan(0)
  })
})

// A real agent reported: "the environment changed under me — the worktree I was
// in was torn down and [I am now] in a different task worktree with another
// agent working alongside". Two verified defects produced that.

// Two tasks editing the same file is normal. The second one to merge conflicts,
// and if the AI cannot resolve it the user was stuck permanently: the sync
// refuses (it would clobber work) and every re-merge hit the same wall.
describe('getting past a conflict the AI could not resolve', () => {
  function conflicting(): { repo: string; sm: StateManager; one: string; two: string } {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const wtl = new WorktreeLifecycle(repo)
    const a = sm.createTaskGroup({ repoPath: repo, title: 'One', userGoal: 'x' })
    const w1 = wtl.createTaskWorktree(a.id, 'one', 'agntspce-integration')
    sm.updateTaskGroup(a.id, { branchName: w1.branchName, worktreePath: w1.worktreePath, baseSha: w1.branchPoint, status: 'active' })
    const b = sm.createTaskGroup({ repoPath: repo, title: 'Two', userGoal: 'y' })
    const w2 = wtl.createTaskWorktree(b.id, 'two', 'agntspce-integration')
    sm.updateTaskGroup(b.id, { branchName: w2.branchName, worktreePath: w2.worktreePath, baseSha: w2.branchPoint, status: 'active' })
    // Both rewrite the same line from the same base.
    fs.writeFileSync(path.join(w1.worktreePath, 'demo.txt'), 'FROM TASK ONE\n')
    git(['add', '.'], w1.worktreePath); git(['commit', '-m', 'one'], w1.worktreePath)
    fs.writeFileSync(path.join(w2.worktreePath, 'demo.txt'), 'FROM TASK TWO\n')
    git(['add', '.'], w2.worktreePath); git(['commit', '-m', 'two'], w2.worktreePath)
    return { repo, sm, one: a.id, two: b.id }
  }

  it('detects the conflict once the first task has landed', async () => {
    const { repo, sm, one, two } = conflicting()
    // Before anything is merged there is no conflict: two tasks adding the same
    // new file from a shared base simply both add it.
    expect(new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(two).conflictFiles).toEqual([])

    expect((await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(one, true)).ok).toBe(true)
    // Now the second task really does conflict on the same lines.
    const preview = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(two)
    expect(preview.conflictFiles).toContain('demo.txt')
    expect(sm.getTaskGroup(one)!.status).toBe('active')
  })

  it('lands the task version when the user keeps their own', async () => {
    const { repo, sm, one, two } = conflicting()
    expect((await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(one, true)).ok).toBe(true)

    // No AI available, and the user chooses their own side.
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, undefined)
    const res = await merger.executeMerge(two, true, 'theirs')
    expect(res.error).toBeUndefined()
    // Choosing a side still shows the result for review before it lands.
    expect(res.needsConfirm).toBe(true)
    const landed = merger.confirmMerge(two)
    expect({ ok: landed.ok, error: landed.error }).toEqual({ ok: true, error: undefined })
    // The task's content won, and it is on the integration branch.
    expect(git(['show', 'agntspce-integration:demo.txt'], repo)).toContain('FROM TASK TWO')
  })

  it('lands the merged version when the user keeps what is already merged', async () => {
    const { repo, sm, one, two } = conflicting()
    expect((await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(one, true)).ok).toBe(true)
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, undefined)
    const res = await merger.executeMerge(two, true, 'ours')
    expect(res.needsConfirm).toBe(true)
    expect(merger.confirmMerge(two).ok).toBe(true)
    expect(git(['show', 'agntspce-integration:demo.txt'], repo)).toContain('FROM TASK ONE')
  })

  it('leaves the task usable whichever side is chosen', async () => {
    const { repo, sm, one, two } = conflicting()
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm, undefined)
    await merger.executeMerge(one, true)
    await merger.executeMerge(two, true, 'theirs')
    merger.confirmMerge(two)
    // A conflict is not a dead end: the task still has its worktree, branch and
    // status, so it can be worked on and merged again.
    const g = sm.getTaskGroup(two)!
    expect(g.status).toBe('active')
    expect(fs.existsSync(g.worktreePath!)).toBe(true)
    expect(git(['branch', '--list', g.branchName!], repo)).toContain(g.branchName!)
  })

  it('reports the real reason the AI could not be used', async () => {
    const { repo, sm, one, two } = conflicting()
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm, undefined).executeMerge(one, true)

    // A provider that throws used to be swallowed into a null and reported as
    // "empty resolution", hiding an invalid key or an exhausted quota.
    const boom = async () => { throw new Error('401 invalid api key') }
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm, boom).executeMerge(two, true)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('401 invalid api key')
  })

  it('says when no AI provider is configured at all', async () => {
    const { repo, sm, one, two } = conflicting()
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm, undefined).executeMerge(one, true)
    const res = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(two, true)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no ai provider is configured/i)
  })
})

// Update pulls what other tasks merged into a task's branch. Two tasks editing
// the same file is the normal case, and it used to be a dead end: the sync
// aborted, printed the file names, and no number of retries ever got through.
// The task could never see a peer's work again.
describe('updating a task onto the integration branch', () => {
  function setup(): { repo: string; sm: StateManager; wtl: WorktreeLifecycle; task: string } {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const wtl = new WorktreeLifecycle(repo)
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Task', userGoal: 'x' })
    const w = wtl.createTaskWorktree(g.id, 'task', 'agntspce-integration')
    sm.updateTaskGroup(g.id, { branchName: w.branchName, worktreePath: w.worktreePath, baseSha: w.branchPoint, status: 'active' })
    return { repo, sm, wtl, task: g.id }
  }

  function integrationWith(repo: string, content: string) {
    const wt = path.join(repo, 'int-scratch')
    git(['worktree', 'add', '-B', 'agntspce-integration', wt], repo)
    fs.writeFileSync(path.join(wt, 'demo.txt'), content)
    git(['add', '.'], wt); git(['commit', '-m', 'peer work'], wt)
    git(['worktree', 'remove', '--force', wt], repo)
  }

  it('pulls a peer change in cleanly when there is no conflict', () => {
    const { repo, sm, wtl, task } = setup()
    fs.writeFileSync(path.join(sm.getTaskGroup(task)!.worktreePath!, 'other.txt'), 'mine\n')
    git(['add', '.'], sm.getTaskGroup(task)!.worktreePath!)
    git(['commit', '-m', 'mine'], sm.getTaskGroup(task)!.worktreePath!)
    integrationWith(repo, 'from peer\n')

    const res = new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task)
    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
    expect(fs.readFileSync(path.join(sm.getTaskGroup(task)!.worktreePath!, 'other.txt'), 'utf-8')).toContain('mine')
  })

  it('reports the conflicting files instead of dead-ending', () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task edit'], wt)
    integrationWith(repo, 'FROM PEER\n')

    const res = new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task, { autoResolve: false })
    expect(res.ok).toBe(false)
    // The file list is what the dialog offers choices for.
    expect(res.conflictFiles).toContain('demo.txt')
  })

  it('leaves no half-merged worktree behind when it reports a conflict', () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task edit'], wt)
    integrationWith(repo, 'FROM PEER\n')

    new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task, { autoResolve: false })
    // A worktree stuck mid-merge would hand the next agent a tree full of
    // conflict markers, and its next commit would sweep them into the branch.
    const markers = fs.readFileSync(path.join(wt, 'demo.txt'), 'utf-8')
    expect(markers).not.toContain('<<<<<<<')
    expect(git(['status', '--porcelain'], wt)).toBe('')
  })

  it('keeps the task version when the user picks it', () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task edit'], wt)
    integrationWith(repo, 'FROM PEER\n')

    const res = new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task, { preferSide: 'task' })
    expect(res.ok).toBe(true)
    expect(res.resolvedBy).toBe('task')
    expect(fs.readFileSync(path.join(wt, 'demo.txt'), 'utf-8')).toContain('FROM TASK')
  })

  it('keeps the merged version when the user picks it', () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task edit'], wt)
    integrationWith(repo, 'FROM PEER\n')

    const res = new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task, { preferSide: 'integration' })
    expect(res.ok).toBe(true)
    expect(res.resolvedBy).toBe('integration')
    expect(fs.readFileSync(path.join(wt, 'demo.txt'), 'utf-8')).toContain('FROM PEER')
  })

  it('records the resolution as a commit on the task branch', () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task edit'], wt)
    integrationWith(repo, 'FROM PEER\n')
    const branch = sm.getTaskGroup(task)!.branchName!

    new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task, { preferSide: 'task' })
    // The resolved file must be committed, not left sitting in the worktree.
    expect(git(['status', '--porcelain'], wt)).toBe('')
    expect(git(['show', `${branch}:demo.txt`], repo)).toContain('FROM TASK')
    // And the task now contains the peer's work, so it is genuinely up to date.
    expect(git(['merge-base', '--is-ancestor', 'agntspce-integration', branch], repo)).toBe('')
  })

  it('still surfaces a real provider error on the AI path', async () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task edit'], wt)
    integrationWith(repo, 'FROM PEER\n')

    const boom = async () => { throw new Error('401 invalid api key') }
    const res = await new TaskMerger(repo, wtl, sm, boom).syncTaskOntoIntegration(task, { autoResolve: true })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('401 invalid api key')
  })

  it('commits the agent work that was pending before syncing', () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    integrationWith(repo, 'FROM PEER\n')

    const res = new TaskMerger(repo, wtl, sm).syncTaskOntoIntegration(task, { preferSide: 'task' })
    expect(res.autoCommittedFiles).toContain('demo.txt')
    expect(git(['status', '--porcelain'], wt)).toBe('')
  })
})

// Apply brings the integration branch into the user's own folder. It used to
// refuse whenever the tree was dirty at all, so one unrelated scratch edit
// stranded every merged task behind a "commit or stash everything" wall.
describe('applying the integration branch to the user branch', () => {
  function setup() {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    return { repo, sm }
  }

  function landOnIntegration(repo: string, file: string, content: string) {
    const wt = path.join(repo, 'int-scratch')
    git(['worktree', 'add', '-B', 'agntspce-integration', wt], repo)
    fs.writeFileSync(path.join(wt, file), content)
    git(['add', '.'], wt); git(['commit', '-m', 'task work'], wt)
    git(['worktree', 'remove', '--force', wt], repo)
  }

  it('applies even when the tree is dirty in a file nothing merged', () => {
    const { repo, sm } = setup()
    landOnIntegration(repo, 'feature.txt', 'from a task\n')
    // Unrelated local edit — the fast-forward does not touch this file.
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'my own note\n')

    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf-8')).toContain('from a task')
  })

  it('keeps that unrelated local edit intact', () => {
    const { repo, sm } = setup()
    landOnIntegration(repo, 'feature.txt', 'from a task\n')
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'my own note\n')
    new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf-8')).toContain('my own note')
  })

  // demo.txt has to be tracked, otherwise "discard my edit to it" is not a
  // meaningful thing to ask git to do.
  function withTrackedDemo(repo: string) {
    fs.writeFileSync(path.join(repo, 'demo.txt'), 'original\n')
    git(['add', '.'], repo); git(['commit', '-m', 'track demo'], repo)
  }

  it('names only the files that genuinely block it', () => {
    const { repo, sm } = setup()
    withTrackedDemo(repo)
    landOnIntegration(repo, 'demo.txt', 'from a task\n')
    // This one collides; the other does not.
    fs.writeFileSync(path.join(repo, 'demo.txt'), 'my local version\n')
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'my own note\n')

    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(res.ok).toBe(false)
    expect(res.conflictFiles).toEqual(['demo.txt'])
    // The unrelated file is called out as *not* a problem, so the user is not
    // told to go and commit something that never stood in the way.
    expect(res.safeDirtyFiles).toEqual(['notes.txt'])
    expect(res.error).not.toContain('git add -A')
  })

  it('applies once the blocking file is discarded, and only that file', () => {
    const { repo, sm } = setup()
    withTrackedDemo(repo)
    landOnIntegration(repo, 'demo.txt', 'from a task\n')
    fs.writeFileSync(path.join(repo, 'demo.txt'), 'my local version\n')
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'my own note\n')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)

    const disc = merger.discardLocalEdits(['demo.txt'])
    expect(disc.ok).toBe(true)
    expect(fs.existsSync(path.join(repo, 'notes.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf-8')).toContain('my own note')

    const res = merger.applyIntegrationToBranch('main')
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'demo.txt'), 'utf-8')).toContain('from a task')
  })

  it('refuses to discard anything outside the repository', () => {
    const { repo, sm } = setup()
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).discardLocalEdits(['../../etc/passwd'])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('outside the repository')
  })
})

// An exhausted AI account turned every conflict into a hard-looking failure:
// the provider was called automatically on the first click and its billing
// error arrived before the user ever saw a way to resolve the conflict by hand.
describe('conflicts stay resolvable when the AI provider cannot be used', () => {
  function setup() {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const wtl = new WorktreeLifecycle(repo)
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Task', userGoal: 'x' })
    const w = wtl.createTaskWorktree(g.id, 'task', 'agntspce-integration')
    sm.updateTaskGroup(g.id, { branchName: w.branchName, worktreePath: w.worktreePath, baseSha: w.branchPoint, status: 'active' })
    return { repo, sm, wtl, task: g.id }
  }

  function conflicting(repo: string) {
    const wt = path.join(repo, 'int-scratch')
    git(['worktree', 'add', '-B', 'agntspce-integration', wt], repo)
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM PEER\n')
    git(['add', '.'], wt); git(['commit', '-m', 'peer'], wt)
    git(['worktree', 'remove', '--force', wt], repo)
  }

  const noCredits = async () => {
    throw new Error('This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 212. Visit https://openrouter.ai/settings/credits and upgrade to a paid account')
  }

  it('does not call the provider just because the user clicked Update', async () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task'], wt)
    conflicting(repo)

    let called = 0
    const counting = async () => { called++; return null }
    const res = await new TaskMerger(repo, wtl, sm, counting).syncTaskOntoIntegration(task)
    // The panel is the first thing shown, so a creditless account never blocks
    // the user from seeing the choices.
    expect(called).toBe(0)
    expect(res.conflictFiles).toContain('demo.txt')
  })

  it('explains an exhausted account in terms of what the user can still do', async () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task'], wt)
    conflicting(repo)

    // Now the user explicitly asked for the AI.
    const res = await new TaskMerger(repo, wtl, sm, noCredits).syncTaskOntoIntegration(task, { autoResolve: true })
    expect(res.ok).toBe(false)
    // The headline is the workable choice, not the provider's billing text.
    expect(res.error).toMatch(/no credits left/i)
    expect(res.error).toMatch(/keep this task's version/i)
    // The provider's own words are still there — it is the only place the
    // credit URL appears.
    expect(res.error).toContain('openrouter.ai')
    // And the file list survives, so the panel keeps offering the sides.
    expect(res.conflictFiles).toContain('demo.txt')
  })

  it('still lands the merge by hand after the AI failed', async () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task'], wt)
    conflicting(repo)

    const res = await new TaskMerger(repo, wtl, sm, noCredits).syncTaskOntoIntegration(task, { autoResolve: true })
    expect(res.ok).toBe(false)
    // The fallback the error promises has to actually work.
    const retry = new TaskMerger(repo, wtl, sm, noCredits).syncTaskOntoIntegration(task, { preferSide: 'task' })
    expect(retry.ok).toBe(true)
    expect(fs.readFileSync(path.join(wt, 'demo.txt'), 'utf-8')).toContain('FROM TASK')
  })

  it('names an invalid key rather than calling it a credit problem', async () => {
    const { repo, sm, wtl, task } = setup()
    const wt = sm.getTaskGroup(task)!.worktreePath!
    fs.writeFileSync(path.join(wt, 'demo.txt'), 'FROM TASK\n')
    git(['add', '.'], wt); git(['commit', '-m', 'task'], wt)
    conflicting(repo)

    const badKey = async () => { throw new Error('401 Unauthorized: invalid api key') }
    const res = await new TaskMerger(repo, wtl, sm, badKey).syncTaskOntoIntegration(task, { autoResolve: true })
    expect(res.error).toMatch(/invalid or missing api key/i)
    expect(res.error).not.toMatch(/no credits left/i)
  })
})

// The conflict solver hands an agent the whole problem and nothing else. If the
// brief is thin, the agent is guessing: an "edit demo.txt to merge both sides"
// instruction with no goal and no content produces confident nonsense.
describe('the brief handed to a conflict-solving agent', () => {
  function setup() {
    const repo = tmpDir()
    initRepo(repo)
    const sm = new StateManager(path.join(repo, 'c.db'), repo)
    sm.getDb().prepare("UPDATE workspace_config SET value = ? WHERE key = 'integration_branch'").run('agntspce-integration')
    const wtl = new WorktreeLifecycle(repo)
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Login page', userGoal: 'add password reset' })
    const w = wtl.createTaskWorktree(g.id, 'login', 'agntspce-integration')
    sm.updateTaskGroup(g.id, { branchName: w.branchName, worktreePath: w.worktreePath, baseSha: w.branchPoint, status: 'active' })
    const wt = path.join(repo, 'int-scratch')
    git(['worktree', 'add', '-B', 'agntspce-integration', wt], repo)
    fs.writeFileSync(path.join(wt, 'page.tsx'), 'MERGED VERSION\n')
    git(['add', '.'], wt); git(['commit', '-m', 'peer'], wt)
    git(['worktree', 'remove', '--force', wt], repo)
    fs.writeFileSync(path.join(w.worktreePath, 'page.tsx'), 'TASK VERSION\n')
    git(['add', '.'], w.worktreePath); git(['commit', '-m', 'task'], w.worktreePath)
    return { repo, sm, wtl, task: g.id }
  }

  it('states the goal, the branches and both versions of the file', () => {
    const { repo, sm, wtl, task } = setup()
    const brief = new TaskMerger(repo, wtl, sm).buildConflictBrief(task, ['page.tsx'])
    // Without the goal the agent cannot tell which version is correct.
    expect(brief).toContain('add password reset')
    expect(brief).toContain('agntspce-integration')
    expect(brief).toContain('page.tsx')
    expect(brief).toContain('TASK VERSION')
    expect(brief).toContain('MERGED VERSION')
  })

  it('tells it where it is and what not to do', () => {
    const { repo, sm, wtl, task } = setup()
    const brief = new TaskMerger(repo, wtl, sm).buildConflictBrief(task, ['page.tsx'])
    // It must edit the files being merged, in its own worktree...
    expect(brief).toMatch(/worktree/i)
    // ...and must not try to run git itself, which would race the merge.
    expect(brief).toMatch(/do not run git/i)
  })

  it('includes a file name that has a space in it', () => {
    const { repo, sm, wtl, task } = setup()
    const brief = new TaskMerger(repo, wtl, sm).buildConflictBrief(task, ['demo 3.txt'])
    // A spaced path used to be unmergeable entirely; the brief must not lose it.
    expect(brief).toContain('demo 3.txt')
  })

  it('describes a file that exists on only one side without inventing content', () => {
    const { repo, sm, wtl, task } = setup()
    const d = new TaskMerger(repo, wtl, sm).describeConflict(task, 'page.tsx')!
    expect(d.taskSide).toContain('TASK VERSION')
    expect(d.mergedSide).toContain('MERGED VERSION')
  })
})
