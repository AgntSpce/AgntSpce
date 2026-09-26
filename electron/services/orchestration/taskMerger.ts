import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WorktreeLifecycle, detectBuildCommand, runCommands, isTaskScaffoldStatusLine } from './worktreeLifecycle'
import { StateManager, CoordinatorError, type TaskGroupOverview } from './stateManager'

export interface TaskMergePreview {
  taskGroupId: string
  branchName: string
  diffSummary: string
  actualFiles: string[]
  conflictFiles: string[]
  /** Files this task claims that other unfinished tasks also claim. */
  scopeOverlapFiles: string[]
  /** The branch this task will merge into, so the UI can name it. */
  integrationBranch?: string
  /** Commits landed on the integration branch that this task does not have. */
  behindCount?: number
  /** Of this task's changed files, the ones another task has since touched. */
  behindFiles?: string[]
  /** A prepared-but-unlanded merge already exists for this task. */
  pendingCandidate?: { ref: string; diff: string } | null
  error?: string
}

export interface TaskMergeResult extends TaskMergePreview {
  ok: boolean
  /** True when a candidate commit exists but needs explicit user confirm. */
  needsConfirm: boolean
  buildPassed: boolean
  mergeCommitSha?: string
  resolvedDiff?: string
  /** Batch merges only: not attempted because an earlier task failed. */
  skipped?: boolean
}

/** Repo-scoped merge lock. Keyed by repo path so it holds across TaskMerger
 *  instances — the socket layer builds a fresh merger per event, so an
 *  instance field would never actually gate anything. */
const repoMergeLocks = new Set<string>()

interface Scratch {
  worktreePath: string
  branchName: string
}

/** What a single trial merge tells us about a candidate. */
interface Collected {
  diffStat: string
  actualFiles: string[]
  conflictFiles: string[]
  /** True when the scratch tree is left with a clean merge staged. */
  mergeStaged: boolean
  /** True when the branch is already contained in the integration tip. */
  nothingToMerge: boolean
  error?: string
}

/** v2 merge flow for TaskGroups. Mirrors MergeGate's scratch-merge + CAS
 *  promotion, but operates on task/<branch> worktrees. Clean merges promote
 *  automatically after build/test; LLM-resolved conflicts ALWAYS stop at a
 *  prepared candidate that needs explicit user confirm (confirmMerge). */
export class TaskMerger {
  private repoPath: string
  private worktreeLifecycle: WorktreeLifecycle
  private stateManager: StateManager
  private llm?: (prompt: string) => Promise<string | null>
  private locked = false

  constructor(repoPath: string, worktreeLifecycle: WorktreeLifecycle, stateManager: StateManager, llm?: (prompt: string) => Promise<string | null>) {
    this.repoPath = repoPath
    this.worktreeLifecycle = worktreeLifecycle
    this.stateManager = stateManager
    this.llm = llm
  }

  private execGit(args: string[], cwd?: string): string {
    // See worktreeLifecycle.execGit: pipe stderr so best-effort probes don't
    // spam the host terminal; fold it into the thrown error instead.
    if (args.some(a => a === undefined || a === null || a === '')) {
      throw new Error(`git ${args.join(' ')} failed: empty revision argument`)
    }
    try {
      return execFileSync('git', args, { cwd: cwd || this.repoPath, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    } catch (e: any) {
      const stderr = String(e?.stderr || '').trim()
      throw new Error(stderr ? `git ${args.join(' ')} failed: ${stderr.slice(0, 500)}` : (e?.message || String(e)))
    }
  }

  /** Non-throwing probe for refs that legitimately may not exist (e.g.
   *  MERGE_HEAD). execGit throws on a non-zero exit, which would turn "no merge
   *  in progress" into a merge failure. */
  private probeGit(args: string[], cwd?: string): string | null {
    try {
      return execFileSync('git', args, { cwd: cwd || this.repoPath, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    } catch {
      return null
    }
  }

  private groupOrThrow(taskGroupId: string) {
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    if (!group.branchName) throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} has no branch yet — launch it first`)
    return group
  }

  private failResult(taskGroupId: string, branchName: string, error: string): TaskMergeResult {
    return { ok: false, needsConfirm: false, taskGroupId, branchName, diffSummary: '', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [], buildPassed: false, error }
  }

  /** Files this task claims that other unfinished tasks also claim. Advisory:
   *  nothing is blocked, but a merge that will collide is far cheaper to
   *  resolve before the AI starts rewriting the same lines. */
  private scopeOverlapFiles(taskGroupId: string): string[] {
    try {
      const mine = new Set<string>()
      for (const s of this.stateManager.listSubTasks(taskGroupId)) {
        for (const f of s.scopeFiles || []) if (f) mine.add(f)
      }
      if (mine.size === 0) return []
      const others = new Set<string>()
      for (const g of this.stateManager.listTaskGroups()) {
        if (g.id === taskGroupId) continue
        if (g.status === 'done' || g.status === 'abandoned') continue
        for (const s of this.stateManager.listSubTasks(g.id)) {
          for (const f of s.scopeFiles || []) if (f && mine.has(f)) others.add(f)
        }
      }
      return [...others].sort()
    } catch {
      return []
    }
  }

  /** Locate the worktree that has `branchName` checked out, so a parked merge
   *  candidate can be cleaned up after a restart. */
  private findScratchPathForBranch(branchName: string): string | null {
    try {
      const raw = this.execGit(['worktree', 'list', '--porcelain'])
      let current: string | null = null
      for (const line of raw.split('\n')) {
        if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch ') && current) {
          const ref = line.slice('branch '.length).trim()
          if (ref === `refs/heads/${branchName}`) return current
        }
      }
    } catch {}
    return null
  }

  /** One trial merge in the scratch worktree: diffstat, changed files, and an
   *  empirically measured conflict list. On a clean merge the merge is left
   *  staged so the caller can commit it without redoing the work. */
  private collect(group: TaskGroupOverview, integrationRef: string, scratchPath: string): Collected {
    const branchName = group.branchName!
    const diffStat = this.execGit(['diff', '--stat', `${integrationRef}...${branchName}`])
    const actualFiles = this.execGit(['diff', '--name-only', `${integrationRef}...${branchName}`]).split('\n').filter(Boolean)

    if (actualFiles.length === 0) {
      return { diffStat, actualFiles, conflictFiles: [], mergeStaged: false, nothingToMerge: true }
    }

    let conflictFiles: string[] = []
    try {
      this.execGit(['merge', branchName, '--no-commit', '--no-ff'], scratchPath)
    } catch {
      const unmerged = this.execGit(['diff', '--name-only', '--diff-filter=U'], scratchPath)
      if (unmerged) conflictFiles = unmerged.split('\n').filter(Boolean)
      try { this.execGit(['merge', '--abort'], scratchPath) } catch {}
      return { diffStat, actualFiles, conflictFiles, mergeStaged: false, nothingToMerge: false }
    }

    // `git merge` exits 0 with nothing staged when the branch is already
    // contained in the integration tip — there is no MERGE_HEAD in that case.
    const mergeHead = this.probeGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], scratchPath)
    if (!mergeHead) {
      return { diffStat, actualFiles, conflictFiles: [], mergeStaged: false, nothingToMerge: true }
    }
    return { diffStat, actualFiles, conflictFiles: [], mergeStaged: true, nothingToMerge: false }
  }

  private previewFrom(taskGroupId: string, group: TaskGroupOverview, collected: Collected): TaskMergePreview {
    let pendingCandidate: { ref: string; diff: string } | null = null
    // Surface a candidate that is already prepared but not landed, so a restart
    // between "AI resolved it" and "human confirmed it" is recoverable.
    if (group.mergeCandidateRef && group.mergeCandidateBase) {
      try {
        const head = this.execGit(['rev-parse', group.mergeCandidateRef])
        pendingCandidate = {
          ref: group.mergeCandidateRef,
          diff: this.execGit(['diff', `${group.mergeCandidateBase}..${head}`]).slice(0, 20000),
        }
      } catch {
        pendingCandidate = null
      }
    }
    const integrationBranch = this.stateManager.getIntegrationBranch()
    return {
      taskGroupId,
      branchName: group.branchName ?? '',
      diffSummary: collected.diffStat || '(no changes)',
      actualFiles: collected.actualFiles,
      conflictFiles: collected.conflictFiles,
      scopeOverlapFiles: this.scopeOverlapFiles(taskGroupId),
      integrationBranch,
      ...this.driftSince(taskGroupId, integrationBranch, collected.actualFiles),
      pendingCandidate,
    }
  }

  /** How far this task has fallen behind the integration branch, and which of
   *  its own files another task has touched since it branched.
   *
   *  This is the "keep yourself updated" signal: a task that is behind but does
   *  not yet conflict is cheap to fix now and expensive to fix after the merge
   *  starts rewriting the same lines. */
  private driftSince(taskGroupId: string, integrationBranch: string, actualFiles: string[]): { behindCount: number; behindFiles: string[] } {
    try {
      const branchName = this.stateManager.getTaskGroup(taskGroupId)?.branchName
      if (!branchName) return { behindCount: 0, behindFiles: [] }
      const behind = Number(this.execGit(['rev-list', '--count', `${branchName}..${integrationBranch}`]) || 0)
      if (!behind || actualFiles.length === 0) return { behindCount: behind || 0, behindFiles: [] }
      const mergeBase = this.execGit(['merge-base', branchName, integrationBranch])
      const moved = this.execGit(['diff', '--name-only', `${mergeBase}..${integrationBranch}`]).split('\n').filter(Boolean)
      const mine = new Set(actualFiles)
      return { behindCount: behind, behindFiles: moved.filter(f => mine.has(f)) }
    } catch {
      return { behindCount: 0, behindFiles: [] }
    }
  }

  /** Pull the integration branch into this task's own worktree so its next
   *  merge is clean. Never touches the user's checkout, and never creates a
   *  commit the merge gate would not also verify — on conflict it aborts and
   *  reports the files. */
  syncTaskOntoIntegration(taskGroupId: string): { ok: boolean; error?: string; mergedFiles?: string[] } {
    const group = this.groupOrThrow(taskGroupId)
    if (!group.worktreePath || !fs.existsSync(group.worktreePath)) {
      return { ok: false, error: 'This task has no worktree to sync (it is running without isolation).' }
    }
    if (!group.branchName) return { ok: false, error: 'This task has no branch yet — launch it first.' }
    const dirty = this.dirtyWorktreeError(group, 'sync')
    if (dirty) return { ok: false, error: dirty }

    const integrationBranch = this.stateManager.getIntegrationBranch()
    const behind = Number(this.execGit(['rev-list', '--count', `${group.branchName}..${integrationBranch}`]) || 0)
    if (behind === 0) return { ok: true, mergedFiles: [] }

    const before = this.execGit(['diff', '--name-only'], group.worktreePath)
    try {
      this.execGit(['merge', integrationBranch, '--no-edit'], group.worktreePath)
    } catch {
      let conflicts: string[] = []
      try { conflicts = this.execGit(['diff', '--name-only', '--diff-filter=U'], group.worktreePath).split('\n').filter(Boolean) } catch {}
      try { this.execGit(['merge', '--abort'], group.worktreePath) } catch {}
      return {
        ok: false,
        error: conflicts.length
          ? `Syncing onto ${integrationBranch} conflicts in: ${conflicts.join(', ')}. Resolve them in the task worktree, or merge the task as-is.`
          : `Could not sync onto ${integrationBranch}. Merge the task as-is, or resolve the task worktree first.`,
      }
    }
    const after = this.execGit(['diff', '--name-only'], group.worktreePath)
    const touched = new Set([...before.split('\n'), ...after.split('\n')].filter(Boolean))
    return { ok: true, mergedFiles: [...touched] }
  }

  /** Fast-forward the user's own checked-out branch onto the integration branch.
   *
   *  Merges land on `<workspace>_agntspce` on purpose: the user keeps control of
   *  when their branch moves. But with nothing bridging the two, merged work
   *  stayed stranded on a branch the user had no reason to know about and the
   *  folder they were looking at never changed — the exact "my file never
   *  appeared" confusion this closes.
   *
   *  Deliberately a fast-forward only. If the user's branch has commits the
   *  integration branch does not contain, this refuses and says so rather than
   *  creating a merge commit in someone's checkout, and it never touches a
   *  dirty tree. */
  applyIntegrationToBranch(targetBranch?: string): { ok: boolean; error?: string; branch?: string; files?: string[]; upToDate?: boolean } {
    const integrationBranch = this.stateManager.getIntegrationBranch()
    let current = ''
    try { current = this.execGit(['symbolic-ref', '--short', 'HEAD']) } catch {
      return { ok: false, error: 'HEAD is detached, so there is no branch to apply onto. Check out a branch first.' }
    }
    const target = (targetBranch ?? current).trim()
    if (!target) return { ok: false, error: 'Could not determine which branch to apply onto.' }
    if (target === integrationBranch) {
      return { ok: true, branch: target, files: [], upToDate: true }
    }
    // The user may be sitting on a task branch (in-repo mode checks one out).
    // Moving that would rewrite their task, which is not what "apply" means.
    if (target.startsWith('task/')) {
      return { ok: false, error: `You are on the task branch ${target}. Check out your own branch first, then apply.` }
    }
    if (target !== current) {
      return { ok: false, error: `${target} is not the branch you have checked out (you are on ${current}). Apply only affects the current branch.` }
    }
    const status = this.execGit(['status', '--porcelain'])
    if (status) {
      return { ok: false, error: `Your working tree has uncommitted changes, so ${integrationBranch} cannot be applied onto ${target} without risking them:\n${status.split('\n').filter(Boolean).join('\n')}\n\nCommit or stash them, then apply.` }
    }
    let integrationSha = ''
    try { integrationSha = this.execGit(['rev-parse', integrationBranch]) } catch {
      return { ok: false, error: `No ${integrationBranch} branch exists yet — merge a task first.` }
    }
    const targetSha = this.execGit(['rev-parse', target])
    if (targetSha === integrationSha) return { ok: true, branch: target, files: [], upToDate: true }
    // Fast-forward is only possible when the target is an ancestor of the
    // integration branch. Anything else has diverged and needs a real merge.
    const isAncestor = this.probeGit(['merge-base', '--is-ancestor', target, integrationBranch]) !== null
    if (!isAncestor) {
      return {
        ok: false,
        error: `${target} has commits that ${integrationBranch} does not, so it cannot be fast-forwarded. Merge ${integrationBranch} into ${target} yourself (or rebase) — AgntSpce will not rewrite your branch.`,
      }
    }
    const files = this.execGit(['diff', '--name-only', target, integrationBranch]).split('\n').filter(Boolean)
    try {
      this.execGit(['merge', '--ff-only', integrationBranch])
    } catch {
      return { ok: false, error: `Could not fast-forward ${target} onto ${integrationBranch}.` }
    }
    return { ok: true, branch: target, files }
  }

  /** Read-only preview: clean check + diff stat + trial merge for conflicts. */
  previewMerge(taskGroupId: string): TaskMergePreview {
    const group = this.groupOrThrow(taskGroupId)
    const integrationBranch = this.stateManager.getIntegrationBranch()
    let scratch: Scratch | null = null
    try {
      const dirty = this.dirtyWorktreeError(group)
      if (dirty) {
        return { taskGroupId, branchName: group.branchName ?? '', diffSummary: '', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [], error: dirty }
      }
      const integrationRef = this.execGit(['rev-parse', integrationBranch])
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)
      const collected = this.collect(group, integrationRef, scratch.worktreePath)
      if (collected.mergeStaged) {
        try { this.execGit(['merge', '--abort'], scratch.worktreePath) } catch {}
      }
      return this.previewFrom(taskGroupId, group, collected)
    } catch (e: any) {
      return { taskGroupId, branchName: group.branchName ?? '', diffSummary: '', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [], error: e?.message || 'Preview failed' }
    } finally {
      if (scratch) this.worktreeLifecycle.removeScratchWorktree(scratch.worktreePath)
    }
  }

  /** Block a merge when the task worktree still holds uncommitted work.
   *
   *  Generated scaffolding (COLLAB.md, .task.json, AGENTS-TASK.md) is written
   *  by AgntSpce itself and is untracked in every task worktree, so counting it
   *  as "uncommitted changes" made every freshly launched task unmergeable. */
  private dirtyWorktreeError(group: TaskGroupOverview, action: 'merge' | 'sync' = 'merge'): string | null {
    if (!group.worktreePath || !fs.existsSync(group.worktreePath)) return null
    const wtStatus = this.execGit(['status', '--porcelain'], group.worktreePath)
    if (!wtStatus) return null
    const blocking = wtStatus.split('\n').filter(Boolean).filter(line => !isTaskScaffoldStatusLine(line))
    if (blocking.length === 0) return null
    // "Uncommitted changes" reads as a broken app. The useful framing is that
    // there is simply nothing to merge yet, plus the exact command that fixes
    // it - the agent almost never committed, and the user cannot see that from
    // a git status line.
    const untracked = blocking.filter(l => l.startsWith('??'))
    const tracked = blocking.filter(l => !l.startsWith('??'))
    const parts: string[] = []
    if (untracked.length) parts.push(`New files, never committed:\n${untracked.join('\n')}`)
    if (tracked.length) parts.push(`Modified, never committed:\n${tracked.join('\n')}`)
    const headline = action === 'merge'
      ? `This task's work has not been committed, so there is nothing to merge yet.`
      : `This task's worktree has uncommitted work, so syncing the integration branch into it could clobber it.`
    return [
      headline,
      ``,
      ...parts,
      ``,
      `Ask the task's agent to commit its work, or commit it yourself:`,
      `  cd ${group.worktreePath} && git add -A && git commit -m "wip: task output"`,
      ``,
      action === 'merge' ? `Then merge again.` : `Then sync again.`,
    ].join('\n')
  }

  /** Execute a merge. Clean path auto-promotes; conflict path either resolves
   *  via LLM into a confirm-pending candidate or returns blocked. */
  async executeMerge(taskGroupId: string, autoResolve = true): Promise<TaskMergeResult> {
    if (this.locked || repoMergeLocks.has(this.repoPath)) {
      const group = this.groupOrThrow(taskGroupId)
      return { ...this.failResult(taskGroupId, group.branchName ?? '', 'A merge is already in progress for this repository. Wait for it to complete.'), needsConfirm: false }
    }
    const group = this.groupOrThrow(taskGroupId)
    const branchName = group.branchName!
    const integrationBranch = this.stateManager.getIntegrationBranch()
    this.locked = true
    repoMergeLocks.add(this.repoPath)
    let scratch: Scratch | null = null
    try {
      // A stale candidate from an earlier attempt can never be confirmed once
      // the integration branch moves, so drop it before starting over.
      this.clearCandidate(taskGroupId)
      group.mergeCandidateRef = null
      group.mergeCandidateBase = null
      this.stateManager.updateTaskGroup(taskGroupId, { status: 'merging' })
      const dirty = this.dirtyWorktreeError(group)
      if (dirty) {
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
        return { ...this.failResult(taskGroupId, branchName, dirty), needsConfirm: false }
      }

      const integrationRef = this.execGit(['rev-parse', integrationBranch])
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)
      const collected = this.collect(group, integrationRef, scratch.worktreePath)
      const preview = this.previewFrom(taskGroupId, group, collected)

      if (collected.nothingToMerge) {
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'done', completedAt: Date.now() })
        return { ...preview, ok: true, needsConfirm: false, buildPassed: true }
      }

      if (collected.conflictFiles.length > 0) {
        if (!autoResolve || !this.llm) {
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: `Merge conflicts in: ${collected.conflictFiles.join(', ')}. Resolve them or retry with auto-resolve.` }
        }
        const resolved = await this.resolveWithLlm(taskGroupId, branchName, integrationRef, collected.conflictFiles, scratch.worktreePath)
        if (!resolved.applied) {
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: resolved.error || 'LLM resolution failed to apply' }
        }
        const verified = this.verifyCandidate(scratch.worktreePath)
        if (!verified.ok) {
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: verified.error }
        }
        const head = this.commitResolvedCandidate(
          scratch, integrationRef, branchName,
          `agntspce merge (LLM-resolved): ${taskGroupId} (${branchName}) into ${integrationBranch}`
        )
        const resolvedDiff = this.execGit(['diff', `${integrationRef}..${head}`], scratch.worktreePath).slice(0, 20000)
        this.stateManager.updateTaskGroup(taskGroupId, { mergeCandidateRef: scratch.branchName, mergeCandidateBase: integrationRef })
        scratch = null // owned by the parked candidate; confirmMerge cleans it up
        return { ...preview, ok: false, needsConfirm: true, buildPassed: true, mergeCommitSha: head, resolvedDiff }
      }

      // Clean path: the merge is already staged from collect(), so verify and promote.
      const verified = this.verifyCandidate(scratch.worktreePath)
      if (!verified.ok) {
        try { this.execGit(['merge', '--abort'], scratch.worktreePath) } catch {}
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
        return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: verified.error }
      }
      this.execGit(['commit', '-m', `agntspce merge: ${taskGroupId} (${branchName}) into ${integrationBranch}`], scratch.worktreePath)
      const head = this.execGit(['rev-parse', 'HEAD'], scratch.worktreePath)
      this.promote(head, integrationBranch, integrationRef)
      this.finishTask(taskGroupId, branchName, integrationBranch, head, preview.diffSummary)
      return { ...preview, ok: true, needsConfirm: false, buildPassed: true, mergeCommitSha: head }
    } catch (e: any) {
      try { this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' }) } catch {}
      const msg = e instanceof CoordinatorError ? e.message : (e as Error).message
      return { ...this.failResult(taskGroupId, branchName, msg), needsConfirm: false }
    } finally {
      if (scratch) this.worktreeLifecycle.removeScratchWorktree(scratch.worktreePath)
      this.locked = false
      repoMergeLocks.delete(this.repoPath)
    }
  }

  /** Commit the AI-resolved tree as a real two-parent merge commit.
   *
   *  The AI patch is applied to a clean checkout of the integration tip, so a
   *  plain `git commit` would produce a single-parent commit. That breaks
   *  `git log --merges` and, worse, makes `git merge-base --is-ancestor` fail in
   *  the branch cleanup — leaking the task branch forever. commit-tree lets us
   *  keep the resolved content while recording both real parents. */
  private commitResolvedCandidate(scratch: Scratch, integrationRef: string, branchName: string, message: string): string {
    const tree = this.execGit(['write-tree'], scratch.worktreePath)
    const taskHead = this.execGit(['rev-parse', branchName])
    const commit = this.execGit(['commit-tree', tree, '-p', integrationRef, '-p', taskHead, '-m', message], scratch.worktreePath)
    // Park the commit on the scratch branch so it survives GC and confirmMerge
    // can find both the commit and its worktree from the recorded ref.
    this.execGit(['update-ref', `refs/heads/${scratch.branchName}`, commit])
    return commit
  }

  private clearCandidate(taskGroupId: string): void {
    try {
      const group = this.stateManager.getTaskGroup(taskGroupId)
      if (!group?.mergeCandidateRef) return
      this.discardCandidate(scratchBranch(group.mergeCandidateRef))
      this.stateManager.updateTaskGroup(taskGroupId, { mergeCandidateRef: null, mergeCandidateBase: null })
    } catch {}
  }

  private discardCandidate(scratchBranch: string): void {
    try {
      const path = this.findScratchPathForBranch(scratchBranch)
      if (path) this.worktreeLifecycle.removeScratchWorktree(path)
    } catch {}
    try { this.execGit(['branch', '-D', scratchBranch]) } catch {}
  }

  /** Promote a confirm-pending candidate after the user approves the diff. */
  confirmMerge(taskGroupId: string): TaskMergeResult {
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group) return this.failResult(taskGroupId, '', `Task ${taskGroupId} not found`)
    const scratchBranch = group.mergeCandidateRef
    const candidateBase = group.mergeCandidateBase
    if (!scratchBranch || !candidateBase) {
      return this.failResult(taskGroupId, group.branchName ?? '', 'No pending merge candidate — run merge first')
    }
    const integrationBranch = this.stateManager.getIntegrationBranch()
    const branchName = group.branchName ?? ''
    let scratchPath: string | null = null
    try {
      const head = this.execGit(['rev-parse', scratchBranch])
      const currentRef = this.execGit(['rev-parse', integrationBranch])
      if (currentRef !== candidateBase) {
        return this.failResult(taskGroupId, branchName, `Integration branch moved (${candidateBase.slice(0, 8)} → ${currentRef.slice(0, 8)}). Candidate invalidated — merge again.`)
      }
      scratchPath = this.findScratchPathForBranch(scratchBranch)
      this.promote(head, integrationBranch, candidateBase)
      const diffSummary = this.execGit(['diff', '--stat', `${candidateBase}..${head}`])
      this.finishTask(taskGroupId, branchName, integrationBranch, head, diffSummary)
      this.stateManager.updateTaskGroup(taskGroupId, { mergeCandidateRef: null, mergeCandidateBase: null })
      return {
        ok: true, needsConfirm: false, taskGroupId, branchName,
        diffSummary: diffSummary || '(merged)', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [],
        buildPassed: true, mergeCommitSha: head,
      }
    } finally {
      if (scratchPath) {
        try { this.worktreeLifecycle.removeScratchWorktree(scratchPath) } catch {}
      }
      try { this.execGit(['branch', '-D', scratchBranch]) } catch {}
      try { this.stateManager.updateTaskGroup(taskGroupId, { mergeCandidateRef: null, mergeCandidateBase: null }) } catch {}
    }
  }

  /** Serialize multi-task merges; conflict-resolved tasks stay pending-confirm. */
  async mergeAll(taskGroupIds: string[], autoResolve = true): Promise<TaskMergeResult[]> {
    const out: TaskMergeResult[] = []
    for (const id of taskGroupIds) {
      out.push(await this.executeMerge(id, autoResolve))
    }
    return out
  }

  private async resolveWithLlm(
    taskGroupId: string, branchName: string, integrationRef: string,
    conflictFiles: string[], scratchPath: string
  ): Promise<{ applied: boolean; error?: string }> {
    if (!this.llm) return { applied: false, error: 'No LLM configured for conflict resolution' }
    try {
      const group = this.groupOrThrow(taskGroupId)
      const chunks: string[] = []
      for (const f of conflictFiles.slice(0, 8)) {
        const ours = this.safeShow(`${integrationRef}:${f}`, scratchPath)
        const theirs = this.safeShow(`${branchName}:${f}`, scratchPath)
        chunks.push(`--- ${f} (integration)\n${ours.slice(0, 4000)}\n--- ${f} (task branch)\n${theirs.slice(0, 4000)}`)
      }
      let conventions = ''
      try {
        const collabPath = group.worktreePath ? `${group.worktreePath}/COLLAB.md` : ''
        if (collabPath && fs.existsSync(collabPath)) conventions = fs.readFileSync(collabPath, 'utf-8').slice(0, 2000)
      } catch {}
      const prompt = [
        `Resolve these git merge conflicts. Reply with ONLY a unified diff patch (no prose) that applies with \`git apply\` inside the merged tree. Paths relative to repo root.`,
        `Task: ${group.title}. Goal: ${group.userGoal}`,
        conventions ? `Team conventions:\n${conventions}` : '',
        ...chunks,
      ].filter(Boolean).join('\n\n')
      const patch = await this.llm(prompt)
      if (!patch || patch.trim().length < 20) return { applied: false, error: 'LLM returned an empty resolution' }
      // git apply reads a missing trailing newline as a truncated hunk
      // ("corrupt patch"), so normalize before feeding it via stdin.
      const raw = extractPatch(patch)
      const body = raw.endsWith('\n') ? raw : raw + '\n'
      // Validate before touching the tree.
      execFileSync('git', ['apply', '--check', '--whitespace=fix', '-'], { cwd: scratchPath, input: body, encoding: 'utf-8', timeout: 30000 })
      execFileSync('git', ['apply', '--whitespace=fix', '-'], { cwd: scratchPath, input: body, encoding: 'utf-8', timeout: 30000 })
      // There is no merge in progress in this scratch tree, so `git diff
      // --diff-filter=U` can never report anything. Scan the resolved files for
      // leftover conflict markers instead — that failure mode is real and would
      // otherwise only surface at build time.
      const stillMarked = conflictFiles.filter(f => this.hasConflictMarkers(scratchPath, f))
      if (stillMarked.length > 0) {
        return { applied: false, error: `Resolution left conflict markers in: ${stillMarked.join(', ')}` }
      }
      this.execGit(['add', '-A'], scratchPath)
      return { applied: true }
    } catch (e: any) {
      return { applied: false, error: `LLM resolution failed: ${(e as Error).message.slice(0, 500)}` }
    }
  }

  private hasConflictMarkers(worktreePath: string, relativePath: string): boolean {
    try {
      const abs = path.join(worktreePath, relativePath)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false
      const text = fs.readFileSync(abs, 'utf-8')
      return /^<<<<<<< /m.test(text) || /^>>>>>>> /m.test(text)
    } catch {
      return false
    }
  }

  private safeShow(revPath: string, cwd: string): string {
    try {
      return execFileSync('git', ['show', revPath], { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).toString().slice(0, 4000)
    } catch {
      return '(unavailable)'
    }
  }

  private verifyCandidate(worktreePath: string): { ok: boolean; error?: string } {
    const depResult = this.worktreeLifecycle.installDependencies(worktreePath)
    if (!depResult.ok) return { ok: false, error: depResult.error }
    const cmd = detectBuildCommand(worktreePath)
    const buildCmds: string[][] = []
    if (cmd.build) buildCmds.push(cmd.build)
    if (cmd.test) buildCmds.push(cmd.test)
    if (buildCmds.length > 0) {
      const buildOk = runCommands(worktreePath, buildCmds)
      if (!buildOk.ok) return { ok: false, error: `Build/test failed in merged candidate: ${buildOk.error}` }
    }
    return { ok: true }
  }

  private promote(head: string, integrationBranch: string, integrationRef: string): void {
    const currentRef = this.execGit(['rev-parse', integrationBranch])
    if (currentRef !== integrationRef) {
      throw new CoordinatorError('CONFLICT', `Integration branch moved (${integrationRef.slice(0, 8)} → ${currentRef.slice(0, 8)}). Retry the merge.`)
    }
    this.execGit(['update-ref', `refs/heads/${integrationBranch}`, head, integrationRef])
  }

  private finishTask(taskGroupId: string, branchName: string, integrationBranch: string, head: string, diffSummary: string): void {
    this.stateManager.updateTaskGroup(taskGroupId, { status: 'done', completedAt: Date.now() })
    try {
      const wtl = new WorktreeLifecycle(this.repoPath)
      wtl.removeTaskWorktree(taskGroupId, integrationBranch)
    } catch {}
    try {
      this.stateManager.sendMessage('agntspce-coordinator', null, true, `Task ${taskGroupId} merged: ${branchName} → ${integrationBranch}\n${diffSummary}\nHEAD: ${head}`)
    } catch {}
  }
}

function extractPatch(text: string): string {
  const fenced = text.match(/```(?:diff|patch)?\s*([\s\S]*?)\s*```/)
  const body = (fenced ? fenced[1] : text).trim()
  const idx = body.search(/^diff --git /m)
  return idx >= 0 ? body.slice(idx) : body
}
