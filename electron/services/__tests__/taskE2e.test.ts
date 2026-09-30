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
    // No planner LLM: a task is a worktree plus the agents you picked.
    const orch = new TaskOrchestrator(sm, spawner, slots)
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
    expect(sm.getTaskGroup(created.id)!.status).toBe('active')
    expect(git(['show', 'agntspce-integration:src/db.ts'], repo)).toContain('users')
    expect(git(['show', 'agntspce-integration:src/form.tsx'], repo)).toContain('./db')
    // The task keeps its worktree so its agents can keep working.
    expect(fs.existsSync(wt)).toBe(true)
  })
})

// The complete main loop the user described, end to end:
//   task commits in its worktree → per-task merge → merge all → apply to main.
// Nothing here is faked except the PTY: real worktrees, real agent commits made
// through the real collab CLI, real merges, real fast-forward. The point is to
// prove the file actually lands in the workspace folder, which is the step that
// kept reading as "the app lost my work".

/** Shared fixtures for the loop tests below. */
function setupRepo(): { repo: string; sm: StateManager; integration: string } {
  const repo = tmpDir()
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@test.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  // Real content, so the repo is not "fresh" and tasks get worktrees.
  fs.writeFileSync(path.join(repo, 'README.md'), '# App\n')
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><title>start</title>\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.agntspce/\ncoordinator.db*\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
  const sm = new StateManager(path.join(repo, '.agntspce', 'coordinator.db'), repo)
  // Use the real per-workspace branch name, not a pinned one: this is the
  // branch the user's own workflow names, and StateManager already created it.
  const integration = sm.getIntegrationBranch()
  return { repo, sm, integration }
}

/** Launch a task and return its worktree, as if an agent had been spawned. */
async function launch(repo: string, sm: StateManager, title: string, agentId: string) {
  const g = sm.createTaskGroup({ repoPath: repo, title, userGoal: 'add a page', worktreeMode: 'worktree' })
  sm.addSubTask({ taskGroupId: g.id, agentId })
  const orch = new TaskOrchestrator(sm, {
    spawnTaskSubtask: async (i: SubtaskSpawnInput) => `sess-${i.subtaskId.slice(0, 6)}`,
    closeTaskSessions: () => 0,
  }, { tryAcquire: async (n: number) => Array.from({ length: n }, () => () => {}) })
  await orch.launchTask(g.id)
  const group = sm.getTaskGroup(g.id)!
  return { gid: g.id, worktree: group.worktreePath!, branch: group.branchName! }
}

describe('the whole loop: commit → merge → merge all → apply to main', () => {

  it('gets a new file from an agent into the workspace folder', async () => {
    const { repo, sm, integration } = setupRepo()
    // Two tasks, created before either has merged.
    const one = await launch(repo, sm, 'Page one', 'claude')
    const two = await launch(repo, sm, 'Page two', 'opencode')

    // Each agent edits and commits in its own worktree.
    fs.writeFileSync(path.join(one.worktree, 'one.html'), '<h1>one</h1>\n')
    git(['add', '.'], one.worktree)
    git(['commit', '-m', 'add one'], one.worktree)
    fs.writeFileSync(path.join(two.worktree, 'two.html'), '<h1>two</h1>\n')
    git(['add', '.'], two.worktree)
    git(['commit', '-m', 'add two'], two.worktree)

    // Nothing is visible anywhere yet — the whole point of isolation.
    expect(fs.existsSync(path.join(repo, 'one.html'))).toBe(false)
    expect(refHas('main', 'one.html', repo)).toBe(false)

    // Per-task merge, as the row button does.
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    const r1 = await merger.executeMerge(one.gid, false)
    expect(r1.error).toBeUndefined()
    expect(r1.ok).toBe(true)
    // Landed on the integration branch, still not in the folder.
    expect(refHas(integration, 'one.html', repo)).toBe(true)
    expect(fs.existsSync(path.join(repo, 'one.html'))).toBe(false)

    // Merge all picks up the second task too.
    const { runMergeAll } = await import('../../server/handlers/tasks')
    const batch = await runMergeAll([one.gid, two.gid], id => new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(id, true))
    // Both succeed: the second merges for real, and the already-merged first is
    // recognised as done rather than reported as a failure.
    expect(batch.filter(r => r.ok)).toHaveLength(2)
    expect(batch.filter(r => !r.ok && !r.skipped && !r.needsConfirm)).toHaveLength(0)
    // And the retired one is not resurrected.
    expect(sm.getTaskGroup(one.gid)!.status).toBe('active')
    expect(refHas(integration, 'two.html', repo)).toBe(true)

    // Both tasks are retired: done, no branch left behind.
    expect(sm.getTaskGroup(one.gid)!.status).toBe('active')
    expect(sm.getTaskGroup(two.gid)!.status).toBe('active')
    // Their branches survive, so either task can be worked on and merged again.
    expect(git(['branch', '--list', one.branch], repo)).toContain(one.branch)
    expect(git(['branch', '--list', two.branch], repo)).toContain(two.branch)
    // And they are all still usable for the next round.
    expect([one.gid, two.gid].every(id => sm.getTaskGroup(id)!.status === 'active')).toBe(true)

    // Apply to main — the button in the Tasks header.
    const applied = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(applied.error).toBeUndefined()
    expect(applied.ok).toBe(true)
    expect(applied.branch).toBe('main')
    expect(applied.files.sort()).toEqual(['one.html', 'two.html'])

    // The files are now in the workspace folder, and main has the work.
    expect(fs.existsSync(path.join(repo, 'one.html'))).toBe(true)
    expect(fs.existsSync(path.join(repo, 'two.html'))).toBe(true)
    expect(git(['show', 'main:one.html'], repo)).toContain('one')
    // A real merge commit, not a squash.
    expect(git(['rev-list', '--parents', '-n', '1', 'main'], repo).split(/\s+/).length).toBe(3)
    // AgntSpce's own per-task files must never end up in the user's project.
    // The agents' `git add -A` commits them, and a real merge brings every
    // commit, so they have to be actively reverted during the merge.
    for (const f of ['.task.json', 'COLLAB.md', 'AGENTS-TASK.md']) {
      expect(fs.existsSync(path.join(repo, f))).toBe(false)
      expect(refHas('main', f, repo)).toBe(false)
    }
    // The repo tree is exactly the user's own files plus the two pages.
    expect(git(['ls-tree', '-r', '--name-only', 'main'], repo).split('\n').filter(Boolean).sort())
      .toEqual(['.gitignore', 'README.md', 'index.html', 'one.html', 'two.html'])
  })

  it('is idempotent: applying again reports up to date rather than failing', async () => {
    const { repo, sm } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    fs.writeFileSync(path.join(t.worktree, 'p.html'), '<h1>p</h1>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'p'], t.worktree)
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)

    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)
    expect(merger.applyIntegrationToBranch('main').ok).toBe(true)
    const again = merger.applyIntegrationToBranch('main')
    expect(again.ok).toBe(true)
    expect(again.upToDate).toBe(true)
  })

  it('names the uncommitted files when the merge really would overwrite them', async () => {
    // Applying over uncommitted work risks losing it, so the genuinely
    // overlapping files are still refused. An earlier attempt to auto-commit
    // these was removed: committing them to main gives it a commit the
    // integration branch lacks, so the apply then cannot fast-forward. What
    // changed is the scope — only files the merge touches are in the way.
    const { repo, sm } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    fs.writeFileSync(path.join(t.worktree, 'index.html'), '<!doctype html><title>theirs</title>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'p'], t.worktree)
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)

    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>\n')
    const refused = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(refused.ok).toBe(false)
    expect(refused.uncommittedFiles?.join(' ')).toContain('index.html')
    expect(refused.conflictFiles).toEqual(['index.html'])
    expect(refused.error).toContain('index.html')
  })

  it('does not blame AgntSpce for its own files when refusing', async () => {
    // Our task files used to be written to the project root and then listed in
    // this refusal, so the user could not tell which changes were theirs.
    const { repo, sm } = setupRepo()
    fs.writeFileSync(path.join(repo, '.task.json'), '{"a":1}\n')
    fs.writeFileSync(path.join(repo, 'COLLAB.md'), '# Team\n')
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    // Nothing of the user's is dirty, so the apply is not blocked at all.
    expect(res.uncommittedFiles).toBeUndefined()
    expect(res.error).toBeUndefined()
  })

  it('applies around uncommitted work in files nothing merged, without touching it', async () => {
    const { repo, sm } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    fs.writeFileSync(path.join(t.worktree, 'p.html'), '<h1>p</h1>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'p'], t.worktree)
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)

    // The user has their own uncommitted work in an unrelated file. Blocking
    // here stranded every merged task behind a commit-everything wall.
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><title>mine</title>\n')
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(res.ok).toBe(true)
    // The task's work landed, and their unsaved edit is intact.
    expect(fs.existsSync(path.join(repo, 'p.html'))).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'index.html'), 'utf-8')).toContain('mine')
  })

  it('blocks only on files the merge itself changes, naming them', async () => {
    const { repo, sm } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    fs.writeFileSync(path.join(t.worktree, 'index.html'), '<!doctype html><title>theirs</title>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'p'], t.worktree)
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)

    // Same file, edited locally: this one genuinely cannot be applied over.
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><title>mine</title>\n')
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'unrelated\n')
    const res = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(res.ok).toBe(false)
    expect(res.conflictFiles).toEqual(['index.html'])
    expect(res.safeDirtyFiles).toEqual(['notes.txt'])
    // Nothing landed, and both local edits survive.
    expect(fs.readFileSync(path.join(repo, 'index.html'), 'utf-8')).toContain('mine')
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf-8')).toContain('unrelated')
  })
})

// Verified on a brand-new workspace: both tasks came back as worktreeMode
// "none" with a null branch, so no Merge button and no Update button appeared,
// and the agent's index.html landed untracked in the user's own folder where it
// refused every apply. Cause: a rule that treated a dotfiles-only repo as "too
// empty to isolate", which removed the branch and the worktree together.
describe('a brand-new workspace still isolates', () => {
  function freshRepo(): { repo: string; sm: StateManager; integration: string } {
    const repo = tmpDir()
    git(['init', '-b', 'main'], repo)
    git(['config', 'user.email', 'test@test.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    // Exactly what initGitFolder leaves behind: nothing but dotfiles.
    fs.writeFileSync(path.join(repo, '.gitignore'), '.agntspce/\n')
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{}\n')
    git(['add', '.'], repo)
    git(['commit', '-m', 'init'], repo)
    fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
    const sm = new StateManager(path.join(repo, '.agntspce', 'coordinator.db'), repo)
    return { repo, sm, integration: sm.getIntegrationBranch() }
  }

  it('gives the first task a worktree and a branch, so merge and update exist', async () => {
    const { repo, sm } = freshRepo()
    const g = sm.createTaskGroup({ repoPath: repo, title: 'First', userGoal: 'make a page', worktreeMode: 'worktree' })
    sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const orch = new TaskOrchestrator(sm, {
      spawnTaskSubtask: async (i: SubtaskSpawnInput) => `sess-${i.subtaskId.slice(0, 6)}`,
      closeTaskSessions: () => 0,
    }, { tryAcquire: async (n: number) => Array.from({ length: n }, () => () => {}) })
    await orch.launchTask(g.id)
    const group = sm.getTaskGroup(g.id)!

    // The three things the UI needs for Merge and Update.
    expect(group.branchName).toBeTruthy()
    expect(group.baseSha).toBeTruthy()
    expect(group.worktreePath).toBeTruthy()
    expect(fs.existsSync(path.join(group.worktreePath!, '.git'))).toBe(true)
    // And it is a real worktree, not the user's own folder.
    expect(group.worktreePath).not.toBe(repo)

    // The agent's file stays in the worktree, not in the user's checkout.
    fs.writeFileSync(path.join(group.worktreePath!, 'index.html'), '<!doctype html>\n')
    expect(fs.existsSync(path.join(repo, 'index.html'))).toBe(false)
  })

  it("keeps the user's folder clean so apply is not blocked", async () => {
    const { repo, sm } = freshRepo()
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Second', userGoal: 'make a page', worktreeMode: 'worktree' })
    sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const orch = new TaskOrchestrator(sm, {
      spawnTaskSubtask: async (i: SubtaskSpawnInput) => `sess-${i.subtaskId.slice(0, 6)}`,
      closeTaskSessions: () => 0,
    }, { tryAcquire: async (n: number) => Array.from({ length: n }, () => () => {}) })
    await orch.launchTask(g.id)
    const group = sm.getTaskGroup(g.id)!

    fs.writeFileSync(path.join(group.worktreePath!, 'index.html'), '<!doctype html>\n')
    git(['add', '.'], group.worktreePath!)
    git(['commit', '-m', 'page'], group.worktreePath!)
    const merged = await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(g.id, false)
    expect(merged.ok).toBe(true)

    // Nothing of the user's own is dirty, so apply goes through.
    const applied = new TaskMerger(repo, new WorktreeLifecycle(repo), sm).applyIntegrationToBranch('main')
    expect(applied.error).toBeUndefined()
    expect(applied.ok).toBe(true)
    // The file is now in their folder, which is the whole point of the flow.
    expect(fs.existsSync(path.join(repo, 'index.html'))).toBe(true)
  })
})

// A merged task used to be a dead end: the merge deleted its worktree and
// removed its branch, so the row had no directory to put an agent in and adding
// one failed. But its work is already on the integration branch, so relaunching
// from there continues the task instead of discarding it.
describe('a merge changes nothing about the task', () => {
  it('leaves the worktree, branch, status, agents and sessions alone', async () => {
    // Merging used to retire the task: agents stopped, worktree deleted, branch
    // dropped, status set to done, subtasks rewritten. That made a merged task
    // unusable - a live agent watched its directory vanish, the buttons
    // disappeared, and adding an agent failed for want of a worktree.
    //
    // A merge now moves only the branch. The task keeps everything and carries
    // on exactly as it did before the merge.
    const { repo, sm } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    const before = sm.getTaskGroup(t.gid)!
    const subsBefore = sm.listSubTasks(t.gid).map(x => ({ id: x.id, status: x.status, sessionId: x.sessionId }))

    fs.writeFileSync(path.join(t.worktree, 'index.html'), '<!doctype html>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'page'], t.worktree)
    expect((await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)).ok).toBe(true)

    const after = sm.getTaskGroup(t.gid)!
    expect(after.status).toBe(before.status)
    expect(after.branchName).toBe(before.branchName)
    expect(after.worktreePath).toBe(before.worktreePath)
    expect(after.baseSha).toBe(before.baseSha)
    // The worktree and its branch are still real, and the agent can still type.
    expect(fs.existsSync(path.join(after.worktreePath!, '.git'))).toBe(true)
    expect(git(['rev-parse', '--verify', '-q', after.branchName!], repo) || 'present').toBeTruthy()
    // Its agents are exactly as they were, with their session ids.
    expect(sm.listSubTasks(t.gid).map(x => ({ id: x.id, status: x.status, sessionId: x.sessionId }))).toEqual(subsBefore)
  })

  it('can merge again after more work, landing on top of the first merge', async () => {
    const { repo, sm, integration } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    const merger = new TaskMerger(repo, new WorktreeLifecycle(repo), sm)

    fs.writeFileSync(path.join(t.worktree, 'a.html'), '<h1>a</h1>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'a'], t.worktree)
    expect((await merger.executeMerge(t.gid, false)).ok).toBe(true)

    // Same task, same worktree, same agent - just more work.
    const wt = sm.getTaskGroup(t.gid)!.worktreePath!
    expect(fs.existsSync(wt)).toBe(true)
    fs.writeFileSync(path.join(wt, 'b.html'), '<h1>b</h1>\n')
    git(['add', '.'], wt)
    git(['commit', '-m', 'b'], wt)

    expect((await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)).ok).toBe(true)
    const landed = git(['ls-tree', '-r', '--name-only', integration], repo).split('\n')
    expect(landed).toContain('a.html')
    expect(landed).toContain('b.html')
  })

  it('leaves the task mergeable and updatable straight after a merge', async () => {
    // The UI gates Merge/Update on a live branch and worktree, so both buttons
    // must still be there for the next round.
    const { repo, sm } = setupRepo()
    const t = await launch(repo, sm, 'Page', 'claude')
    fs.writeFileSync(path.join(t.worktree, 'a.html'), '<h1>a</h1>\n')
    git(['add', '.'], t.worktree)
    git(['commit', '-m', 'a'], t.worktree)
    await new TaskMerger(repo, new WorktreeLifecycle(repo), sm).executeMerge(t.gid, false)

    const group = sm.getTaskGroup(t.gid)!
    // Exactly the conditions WorkspaceSidebar's canMergeTask/canUpdateTask use.
    expect(!!group.branchName && !!group.baseSha && group.status !== 'done').toBe(true)
    expect(!!group.branchName && !!group.worktreePath && group.status !== 'done').toBe(true)
    // And a preview still works, so the dialog opens.
    expect(new TaskMerger(repo, new WorktreeLifecycle(repo), sm).previewMerge(t.gid).error).toBeUndefined()
  })
})
