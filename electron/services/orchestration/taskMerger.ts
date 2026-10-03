import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WorktreeLifecycle, detectBuildCommand, runCommands, isTaskScaffoldStatusLine, parseStatusPath, TASK_SCAFFOLD_FILES } from './worktreeLifecycle'
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
  /** Files AgntSpce committed in the worktree on the agent's behalf, because
   *  the agent left them uncommitted. Never silent: the UI reports this. */
  autoCommittedFiles?: string[]
  /** Pending work in the worktree, before any auto-commit. Lets the UI label
   *  the action "Commit & merge" instead of "Merge changes". */
  pendingFiles?: string[]
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

  /** Run git and return stdout.
   *
   *  Only trailing whitespace is trimmed: a `git status --porcelain` line begins
   *  with its two status columns, so a full trim turns " M README.md" into
   *  "M README.md" and the path parses as "ADME.md". */
  private execGit(args: string[], cwd?: string): string {
    // See worktreeLifecycle.execGit: pipe stderr so best-effort probes don't
    // spam the host terminal; fold it into the thrown error instead.
    if (args.some(a => a === undefined || a === null || a === '')) {
      throw new Error(`git ${args.join(' ')} failed: empty revision argument`)
    }
    try {
      return execFileSync('git', args, { cwd: cwd || this.repoPath, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().replace(/\s+$/, '')
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

  /** True when the task's branch no longer exists. A task that has already been
   *  merged and retired has its branch deleted, but the DB row keeps the name —
   *  so anything that diffs the branch must check first. Without this, a
   *  re-merge died on a raw "unknown revision" git error and, worse, the catch
   *  handler reset the finished task back to 'active', resurrecting the ghost
   *  this whole path is meant to avoid. */
  private branchIsGone(branchName: string): boolean {
    return this.probeGit(['rev-parse', '--verify', '--quiet', branchName]) === null
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

  /** Files this task has actually changed that another unfinished task has also
   *  actually changed. Advisory: nothing is blocked, but a merge that will
   *  collide is far cheaper to resolve before the AI starts rewriting the same
   *  lines.
   *
   *  This used to compare the per-agent `scopeFiles` the planner declared. With
   *  no planner there are no declared scopes, and a guess is worse than nothing
   *  — so the overlap is measured from each task's real diff against the
   *  integration branch, which is both available and accurate. */
  private scopeOverlapFiles(taskGroupId: string, myFiles: string[]): string[] {
    try {
      if (myFiles.length === 0) return []
      const mine = new Set(myFiles)
      const integrationBranch = this.stateManager.getIntegrationBranch()
      const others = new Set<string>()
      for (const g of this.stateManager.listTaskGroups()) {
        if (g.id === taskGroupId) continue
        if (g.status === 'done' || g.status === 'abandoned') continue
        if (!g.branchName) continue
        const theirs = this.changedFilesOn(g.branchName, integrationBranch)
        for (const f of theirs) if (mine.has(f)) others.add(f)
      }
      return [...others].sort()
    } catch {
      return []
    }
  }

  /** Files a branch changes relative to the integration branch, repo-relative. */
  private changedFilesOn(branchName: string, integrationBranch: string): string[] {
    const range = `${integrationBranch}...${branchName}`
    const out = this.probeGit(['diff', '--name-only', range])
    if (out !== null) return out.split('\n').map(s => s.trim()).filter(Boolean)
    // New branch with no merge base: fall back to everything it has that the
    // integration branch does not.
    const direct = this.probeGit(['diff', '--name-only', integrationBranch, branchName])
    return direct !== null ? direct.split('\n').map(s => s.trim()).filter(Boolean) : []
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
  /** Undo any change the task branch made to our generated files, in the scratch
   *  worktree, so the merge does not carry them onto the integration branch.
   *
   *  Filtering them out of the reported file list is not enough: the real
   *  `git merge` brings the branch's commits wholesale, which dropped a
   *  `.task.json`, `COLLAB.md` and `AGENTS-TASK.md` into the user's project
   *  root — files that belong to a task worktree, not to their repo. Restore the
   *  integration copy where there is one, and drop the path where the task
   *  introduced it. */
  private dropScaffoldFromMerge(scaffoldFiles: string[], integrationRef: string, scratchPath: string): void {
    for (const f of scaffoldFiles) {
      const atIntegration = this.probeGit(['cat-file', '-e', `${integrationRef}:${f}`], scratchPath) !== null
      try {
        if (atIntegration) this.execGit(['checkout', integrationRef, '--', f], scratchPath)
        else this.execGit(['rm', '-f', '-q', '--', f], scratchPath)
      } catch {}
    }
  }

  private collect(group: TaskGroupOverview, integrationRef: string, scratchPath: string): Collected {
    const branchName = group.branchName!
    const diffStat = this.execGit(['diff', '--stat', `${integrationRef}...${branchName}`])
    const changed = this.execGit(['diff', '--name-only', `${integrationRef}...${branchName}`]).split('\n').filter(Boolean)
    // Files AgntSpce generates into every task root. Agents are told to
    // `git add -A`, so these get committed by the agent — and then two tasks
    // that started before each other merged conflict on them. Verified: a batch
    // of two tasks failed with "Merge conflicts in: .task.json, COLLAB.md",
    // which reads as the app being broken rather than as bookkeeping noise.
    // They are ours, per-task, and regenerated, so the integration side always
    // wins and they never count as a change.
    const isScaffold = (f: string) => TASK_SCAFFOLD_FILES.has(path.basename(f))
    const actualFiles = changed.filter(f => !isScaffold(f))

    if (actualFiles.length === 0) {
      return { diffStat, actualFiles, conflictFiles: [], mergeStaged: false, nothingToMerge: true }
    }

    let conflictFiles: string[] = []
    try {
      this.execGit(['merge', branchName, '--no-commit', '--no-ff'], scratchPath)
    } catch {
      const unmerged = this.execGit(['diff', '--name-only', '--diff-filter=U'], scratchPath)
      if (unmerged) conflictFiles = unmerged.split('\n').filter(Boolean)
      // Resolve away conflicts that are only our own bookkeeping, then carry on
      // if nothing real is left. A genuine conflict is left untouched.
      const scaffoldOnly = conflictFiles.filter(isScaffold)
      const real = conflictFiles.filter(f => !isScaffold(f))
      if (scaffoldOnly.length > 0) {
        // A conflicting generated file is never already on the integration
        // branch, so restore it there if it exists, otherwise drop it.
        this.dropScaffoldFromMerge(scaffoldOnly, integrationRef, scratchPath)
        for (const f of scaffoldOnly) {
          const i = actualFiles.indexOf(f)
          if (i >= 0) actualFiles.splice(i, 1)
        }
        conflictFiles = real
      }
      if (conflictFiles.length > 0) {
        try { this.execGit(['merge', '--abort'], scratchPath) } catch {}
        return { diffStat, actualFiles, conflictFiles, mergeStaged: false, nothingToMerge: false }
      }
      // Conflicts were only ours: the merge is still in progress and can land.
      if (this.probeGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], scratchPath)) {
        return { diffStat, actualFiles, conflictFiles: [], mergeStaged: true, nothingToMerge: false }
      }
      return { diffStat, actualFiles, conflictFiles: [], mergeStaged: false, nothingToMerge: true }
    }

    // Drop our generated files from the merge result, then confirm the merge is
    // really in progress (git merge exits 0 with nothing staged when the branch
    // is already contained in the integration tip).
    this.dropScaffoldFromMerge(changed.filter(isScaffold), integrationRef, scratchPath)
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
      scopeOverlapFiles: this.scopeOverlapFiles(taskGroupId, collected.actualFiles),
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
  syncTaskOntoIntegration(
    taskGroupId: string,
    opts: { preferSide?: 'task' | 'integration'; autoResolve?: boolean } = {}
  ): { ok: boolean; error?: string; conflictFiles?: string[]; mergedFiles?: string[]; autoCommittedFiles?: string[]; resolvedBy?: string } {
    const group = this.groupOrThrow(taskGroupId)
    if (!group.worktreePath || !fs.existsSync(group.worktreePath)) {
      return { ok: false, error: 'This task has no worktree to sync (it is running without isolation).' }
    }
    if (!group.branchName) return { ok: false, error: 'This task has no branch yet — launch it first.' }
    // Commit first. Pulling peers' work in on top of an agent's uncommitted
    // changes would either fail or silently mix them, so "Update from branch"
    // commits what is pending and then updates — the same safety net the merge
    // has, so this action cannot dead-end either.
    const preCommit = this.commitPendingWork(group, group.branchName)
    if (preCommit.error) return { ok: false, error: preCommit.error }
    const dirty = this.dirtyWorktreeError(group, 'sync')
    if (dirty) return { ok: false, error: dirty }

    const worktreePath = group.worktreePath
    const branchName = group.branchName
    const integrationBranch = this.stateManager.getIntegrationBranch()
    const behind = Number(this.execGit(['rev-list', '--count', `${branchName}..${integrationBranch}`]) || 0)
    if (behind === 0) return { ok: true, mergedFiles: [], autoCommittedFiles: preCommit.files }

    const before = this.execGit(['diff', '--name-only'], worktreePath)
    try {
      // --no-edit so a fast-forward stays a fast-forward: when the task is
      // simply behind, there is nothing to reconcile and no merge commit to
      // review. On conflict git leaves the merge in progress, which is what
      // lets the resolution below see real conflict stages.
      this.execGit(['merge', integrationBranch, '--no-edit'], worktreePath)
    } catch {
      let conflicts: string[] = []
      try { conflicts = this.execGit(['diff', '--name-only', '--diff-filter=U'], worktreePath).split('\n').filter(Boolean) } catch {}
      if (!conflicts.length) {
        this.abortSync(worktreePath)
        return { ok: false, error: `Could not sync onto ${integrationBranch}. Merge the task as-is, or resolve the task worktree first.` }
      }
      return this.resolveSyncConflict(taskGroupId, group, conflicts, preCommit.files, opts)
    }
    const after = this.execGit(['diff', '--name-only'], worktreePath)
    const touched = new Set([...before.split('\n'), ...after.split('\n')].filter(Boolean))
    return { ok: true, mergedFiles: [...touched], autoCommittedFiles: preCommit.files }
  }

  /** Finish a conflicted sync: take a side, or let the provider try, or hand
   *  the file list back so the user can choose.
   *
   *  This used to abort and return a wall of text, which was a dead end — the
   *  same task could never pull in a peer's work on a file both had touched.
   *
   *  Note the inversion: this merges *into* the task worktree, so git's
   *  `--ours` is the task branch and `--theirs` is the integration branch. The
   *  merge dialog has the opposite arrangement, which is why the choice is
   *  passed as 'task' | 'integration' rather than as ours/theirs — the same
   *  word would have meant opposite things in the two places. */
  private resolveSyncConflict(
    taskGroupId: string,
    group: TaskGroupOverview,
    conflicts: string[],
    autoCommitted: string[],
    opts: { preferSide?: 'task' | 'integration'; autoResolve?: boolean }
  ): { ok: boolean; error?: string; conflictFiles?: string[]; mergedFiles?: string[]; autoCommittedFiles?: string[]; resolvedBy?: string } {
    const worktreePath = group.worktreePath!
    const branchName = group.branchName!
    const integrationBranch = this.stateManager.getIntegrationBranch()
    const mergeInProgress = this.probeGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath) !== null

    if (mergeInProgress && opts.preferSide) {
      // Inside the live conflicted merge, so `--ours` really is the task and
      // `--theirs` really is what peers merged. Outside a merge these silently
      // keep the current content, which is how picking a side used to land the
      // wrong one.
      const side = opts.preferSide === 'task' ? '--ours' : '--theirs'
      try {
        this.execGit(['checkout', side, '--', ...conflicts], worktreePath)
        this.execGit(['add', '--', ...conflicts], worktreePath)
        this.execGit(['commit', '--no-edit'], worktreePath)
      } catch (e: any) {
        this.abortSync(worktreePath)
        return { ok: false, error: `Could not keep the ${opts.preferSide === 'task' ? 'task' : 'merged'} version of ${conflicts.join(', ')}: ${(e as Error).message}` }
      }
      return {
        ok: true,
        resolvedBy: opts.preferSide,
        mergedFiles: conflicts,
        autoCommittedFiles: autoCommitted,
      }
    }

    // The AI is opt-in here, unlike a merge. Update runs on a click with no
    // prior review step, so trying the provider first meant that an exhausted
    // account turned every update into an error — the user never reached the
    // panel, and Update looked simply broken. Hand back the conflicts and let
    // the panel offer the AI as one of several choices.
    if (opts.autoResolve === true && this.llm) {
      return this.resolveSyncConflictAsync(taskGroupId, group, conflicts, autoCommitted)
    }

    this.abortSync(worktreePath)
    return {
      ok: false,
      conflictFiles: conflicts,
      autoCommittedFiles: autoCommitted,
      error: `${integrationBranch} and this task both changed: ${conflicts.join(', ')}.`,
    }
  }

  private async resolveSyncConflictAsync(
    taskGroupId: string,
    group: TaskGroupOverview,
    conflicts: string[],
    autoCommitted: string[]
  ): Promise<{ ok: boolean; error?: string; conflictFiles?: string[]; mergedFiles?: string[]; autoCommittedFiles?: string[]; resolvedBy?: string }> {
    const worktreePath = group.worktreePath!
    const branchName = group.branchName!
    const resolved = await this.resolveWithLlm(
      taskGroupId, branchName, 'task branch', this.stateManager.getIntegrationBranch(), 'merged from other tasks',
      conflicts, worktreePath
    )
    if (!resolved.applied) {
      this.abortSync(worktreePath)
      return { ok: false, conflictFiles: conflicts, autoCommittedFiles: autoCommitted, error: resolved.error }
    }
    try {
      if (this.probeGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath)) {
        this.execGit(['commit', '--no-edit'], worktreePath)
      } else {
        this.execGit(['add', '-A'], worktreePath)
      }
    } catch (e: any) {
      this.abortSync(worktreePath)
      return { ok: false, error: `Could not record the AI's resolution: ${(e as Error).message}` }
    }
    return { ok: true, resolvedBy: 'ai', mergedFiles: conflicts, autoCommittedFiles: autoCommitted }
  }

  /** Never leave a half-merged task worktree behind.
   *
   *  A worktree stuck in a conflicted merge is worse than one that never
   *  started: the agent relaunches into a tree full of conflict markers and its
   *  next commit sweeps them into the task branch. */
  private abortSync(worktreePath: string): void {
    try { this.execGit(['merge', '--abort'], worktreePath) } catch {}
    try { this.execGit(['reset', '--hard'], worktreePath) } catch {}
  }

  /** Uncommitted work in a task worktree, ignoring our generated files.
   *  Read-only: used to label the action before the user commits to it. */
  private pendingWork(group: TaskGroupOverview): string[] {
    if (!group.worktreePath || !fs.existsSync(group.worktreePath)) return []
    if (!fs.existsSync(path.join(group.worktreePath, '.git'))) return []
    try {
      return this.execGit(['status', '--porcelain'], group.worktreePath)
        .split('\n').filter(l => l.trim().length > 0)
        .filter(line => !isTaskScaffoldStatusLine(line))
        .map(parseStatusPath).filter(Boolean)
    } catch {
      return []
    }
  }

  /** Commit a task worktree's pending work, on the agents' behalf.
   *
   *  Returns the files it committed so the merge result can say so — nothing
   *  here happens silently. */
  private commitPendingWork(
    group: TaskGroupOverview,
    branchName: string
  ): { files: string[]; error?: string } {
    if (!group.worktreePath || !fs.existsSync(group.worktreePath)) return { files: [] }
    // Never read git state from a directory that is no longer a worktree: it
    // would report the MAIN repo and blame the task for the user's own edits.
    if (!fs.existsSync(path.join(group.worktreePath, '.git'))) return { files: [] }
    const res = new WorktreeLifecycle(this.repoPath).commitTaskWorktree(
      group.worktreePath,
      `agntspce: commit task work (${branchName})`
    )
    if (res.error) return { files: [], error: res.error }
    return { files: res.committed ? res.files : [] }
  }

  /** Fold the source branch into the integration branch, best-effort.
   *
   *  The integration branch is a one-time snapshot of the source branch, taken
   *  when it is first created (`stateManager.initIntegrationBranch`). Nothing
   *  ever moved it forward again, so every commit the user made on their own
   *  branch widened the gap — until "apply to main" refused with a
   *  fast-forward error naming a branch they had never heard of.
   *
   *  This runs on the merge path, not the apply path. Apply deliberately
   *  refuses to touch the user's checkout, but keeping AgntSpce's own
   *  integration branch current is bookkeeping the user never asked for and
   *  should never pay for.
   *
   *  Never fails a merge over this. If the sync conflicts, it is skipped and
   *  the merge proceeds exactly as before — the apply-time error remains as a
   *  backstop, but a housekeeping step must not be able to make a merge
   *  undeliverable. */
  syncSourceIntoIntegration(): { synced: boolean; reason?: string } {
    const integrationBranch = this.stateManager.getIntegrationBranch()
    let sourceBranch = ''
    try { sourceBranch = this.stateManager.getSourceBranch() } catch { return { synced: false } }
    if (!sourceBranch || sourceBranch === integrationBranch) return { synced: false }
    const sourceRef = this.probeGit(['rev-parse', '--verify', '--quiet', sourceBranch])
    const integrationRef = this.probeGit(['rev-parse', '--verify', '--quiet', integrationBranch])
    if (!sourceRef || !integrationRef) return { synced: false }
    // The integration branch already contains the source branch — nothing to do.
    if (this.probeGit(['merge-base', '--is-ancestor', sourceRef, integrationRef]) !== null) return { synced: false }
    // Source is strictly ahead: a plain ref move, no merge commit, no worktree.
    if (this.probeGit(['merge-base', '--is-ancestor', integrationRef, sourceRef]) !== null) {
      try {
        // The old-value argument makes this a compare-and-swap: if the branch
        // moved since it was read, this fails instead of clobbering the move.
        this.execGit(['update-ref', `refs/heads/${integrationBranch}`, sourceRef, integrationRef])
        return { synced: true }
      } catch (e: any) {
        return { synced: false, reason: (e as Error).message }
      }
    }
    // Genuinely diverged, so bringing them together needs a real merge. It runs
    // in a throwaway worktree, never in the user's checkout.
    let scratchPath = ''
    try {
      scratchPath = this.worktreeLifecycle.createScratchWorktree(integrationRef).worktreePath
      this.execGit(['merge', sourceBranch, '--no-edit'], scratchPath)
      const head = this.execGit(['rev-parse', 'HEAD'], scratchPath)
      this.execGit(['update-ref', `refs/heads/${integrationBranch}`, head, integrationRef])
      return { synced: true }
    } catch (e: any) {
      if (scratchPath) { try { this.execGit(['merge', '--abort'], scratchPath) } catch {} }
      return { synced: false, reason: (e as Error).message }
    } finally {
      if (scratchPath) { try { this.worktreeLifecycle.removeScratchWorktree(scratchPath) } catch {} }
    }
  }

  /** Shared preflight for everything that lands the integration branch on the
   *  user's own branch: apply, merge, rebase. All three need the same answer to
   *  "which branch, and is it safe to touch" — and all three must refuse the
   *  same branches, or the safe path and the ones buttoned around it would
   *  disagree about what AgntSpce is allowed to rewrite. */
  private resolveApplyTarget(targetBranch?: string): { ok: true; current: string; target: string } | { ok: false; error: string } {
    const integrationBranch = this.stateManager.getIntegrationBranch()
    let current = ''
    try { current = this.execGit(['symbolic-ref', '--short', 'HEAD']) } catch {
      return { ok: false, error: 'HEAD is detached, so there is no branch to apply onto. Check out a branch first.' }
    }
    const target = (targetBranch ?? current).trim()
    if (!target) return { ok: false, error: 'Could not determine which branch to apply onto.' }
    if (target === integrationBranch) return { ok: true, current, target }
    // The user may be sitting on a task branch (in-repo mode checks one out).
    // Moving that would rewrite their task, which is not what "apply" means.
    if (target.startsWith('task/')) {
      return { ok: false, error: `You are on the task branch ${target}. Check out your own branch first, then apply.` }
    }
    if (target !== current) {
      return { ok: false, error: `You are on ${current}, not ${target}. Check out ${target} first, then apply — AgntSpce will not switch branches for you.` }
    }
    try { this.execGit(['rev-parse', integrationBranch]) } catch {
      return { ok: false, error: `No ${integrationBranch} branch exists yet — merge a task first.` }
    }
    return { ok: true, current, target }
  }

  /** Bring the integration branch into the user's branch with a real merge.
   *
   *  This is the action behind the "Merge into main" button that appears when a
   *  fast-forward is impossible. It deliberately does what `apply` refuses to:
   *  creates a merge commit in the user's checkout. That is why it is a
   *  separate, explicitly-invoked operation rather than something `apply` does
   *  on its own — and why it only ever runs on the branch the user is standing
   *  on, never a task branch and never the integration branch itself.
   *
   *  A conflict aborts the merge and restores the tree exactly as it was. A
   *  half-finished merge sitting in someone's checkout is far worse than a
   *  refusal, so this never leaves MERGE_HEAD behind. */
  mergeIntegrationIntoBranch(targetBranch?: string): { ok: boolean; error?: string; branch?: string; files?: string[]; conflictFiles?: string[]; upToDate?: boolean } {
    const resolved = this.resolveApplyTarget(targetBranch)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const { target } = resolved
    const integrationBranch = this.stateManager.getIntegrationBranch()

    const ahead = this.probeGit(['rev-list', '--count', `${integrationBranch}..${target}`]) ?? '0'
    const behind = this.probeGit(['rev-list', '--count', `${target}..${integrationBranch}`]) ?? '0'
    const files = this.execGit(['diff', '--name-only', target, integrationBranch]).split('\n').filter(Boolean)

    // Same dirty-file reasoning as apply: only the files the merge actually
    // writes can block it, so an unrelated scratch edit is never a wall.
    const status = this.execGit(['status', '--porcelain'])
      .split('\n').filter(l => l.trim().length > 0)
      .filter(line => !isTaskScaffoldStatusLine(line))
    const blocking = status.map(parseStatusPath).filter(Boolean).filter(f => files.includes(f))
    if (blocking.length > 0) {
      return {
        ok: false,
        conflictFiles: blocking,
        error: `${blocking.length} file(s) the merge would write are edited locally: ${blocking.join(', ')}. Commit or discard those first, then merge.`,
      }
    }

    try {
      this.execGit(['merge', integrationBranch, '--no-edit'])
    } catch (e: any) {
      // Put the checkout back exactly as it was. Without this the user is left
      // mid-merge in their own working tree, which `git merge --abort` is the
      // only way out of and which nothing in the UI would mention.
      let conflicts: string[] = []
      try { this.execGit(['merge', '--abort']) } catch {}
      try { conflicts = this.execGit(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean) } catch {}
      if (conflicts.length) {
        return {
          ok: false,
          conflictFiles: conflicts,
          error: `Merge hit conflicts in ${conflicts.length} file(s): ${conflicts.join(', ')}. Nothing was changed — resolve them on ${target} and merge again.`,
        }
      }
      return { ok: false, error: `Could not merge ${integrationBranch} into ${target}: ${(e as Error).message}` }
    }
    return { ok: true, branch: target, files, upToDate: ahead === '0' }
  }

  /** Rebase the user's branch onto the integration branch.
   *
   *  The linear-history alternative to `mergeIntegrationIntoBranch`, and the
   *  only one of the two that rewrites commits, so it is a separate call the UI
   *  has to ask for explicitly. Aborts and restores the tree on conflict, same
   *  as the merge. */
  rebaseBranchOntoIntegration(targetBranch?: string): { ok: boolean; error?: string; branch?: string; files?: string[]; conflictFiles?: string[] } {
    const resolved = this.resolveApplyTarget(targetBranch)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const { target } = resolved
    const integrationBranch = this.stateManager.getIntegrationBranch()
    const files = this.execGit(['diff', '--name-only', target, integrationBranch]).split('\n').filter(Boolean)
    try {
      this.execGit(['rebase', integrationBranch])
    } catch (e: any) {
      let conflicts: string[] = []
      try { this.execGit(['rebase', '--abort']) } catch {}
      try { conflicts = this.execGit(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean) } catch {}
      if (conflicts.length) {
        return {
          ok: false,
          conflictFiles: conflicts,
          error: `Rebase hit conflicts in ${conflicts.length} file(s): ${conflicts.join(', ')}. Nothing was changed — your commits are intact on ${target}.`,
        }
      }
      return { ok: false, error: `Could not rebase ${target} onto ${integrationBranch}: ${(e as Error).message}` }
    }
    return { ok: true, branch: target, files }
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
  applyIntegrationToBranch(targetBranch?: string): { ok: boolean; error?: string; branch?: string; files?: string[]; upToDate?: boolean; uncommittedFiles?: string[]; conflictFiles?: string[]; safeDirtyFiles?: string[]; preservedDirtyFiles?: string[]; needsMerge?: boolean; integrationBranch?: string; ahead?: number; behind?: number } {
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
      return { ok: false, error: `You are on ${current}, not ${target}. Check out ${target} first, then apply — AgntSpce will not switch branches for you.` }
    }
    // Only the user's own changes are reported. AgntSpce's task files are
    // excluded from git, but if that is missing the refusal would otherwise
    // blame the user for our bookkeeping and they could not tell the two apart.
    const status = this.execGit(['status', '--porcelain'])
      .split('\n').filter(l => l.trim().length > 0)
      .filter(line => !isTaskScaffoldStatusLine(line))
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
      // Naming the command matters: "merge it yourself" reads as a chore with
      // no instructions, and the integration branch is an internal name the
      // user has no reason to know. Spell out the exact command, both
      // directions, so the fix is copy-pasteable from the error itself.
      const ahead = this.probeGit(['rev-list', '--count', `${integrationBranch}..${target}`]) ?? '?'
      const behind = this.probeGit(['rev-list', '--count', `${target}..${integrationBranch}`]) ?? '?'
      return {
        ok: false,
        // Tells the UI this is the "both branches moved" case specifically, so
        // it can offer the merge/rebase buttons instead of a generic alert. The
        // counts and files come with it so the dialog can show what is actually
        // waiting rather than making the user go look.
        needsMerge: true,
        integrationBranch,
        ahead: Number(ahead),
        behind: Number(behind),
        files: this.execGit(['diff', '--name-only', target, integrationBranch]).split('\n').filter(Boolean),
        error: `${target} and ${integrationBranch} have both moved on, so ${integrationBranch} cannot be fast-forwarded onto it.`
          + `\n\n  git merge ${integrationBranch}      # bring the merged tasks in (keeps your ${ahead} commit(s))`
          + `\n  git rebase ${integrationBranch}     # or replay your commits on top instead`
          + `\n\n${behind} merged commit(s) are waiting on ${integrationBranch}.`
          + `\nAgntSpce will not rewrite your branch — run one of the above from ${target}.`,
        conflictFiles: [],
      }
    }
    const files = this.execGit(['diff', '--name-only', target, integrationBranch]).split('\n').filter(Boolean)

    // A dirty tree does not block a fast-forward. `git merge --ff-only` only
    // refuses when the incoming commits touch a file that is dirty locally —
    // edits to files nobody changed ride along untouched. Refusing on *any*
    // dirt meant one unrelated scratch edit stranded every merged task behind a
    // "commit or stash everything" wall, which is what made Apply look broken.
    const dirtyFiles = status.map(parseStatusPath).filter(Boolean)
    const blocking = dirtyFiles.filter(f => files.includes(f))
    const harmless = dirtyFiles.filter(f => !files.includes(f))
    if (blocking.length > 0) {
      return {
        ok: false,
        error: `${integrationBranch} also changes ${blocking.length} file(s) you have edited locally: ${blocking.join(', ')}. Those cannot be applied over your unsaved version — commit them, or discard just those files and apply again.`
          + (harmless.length ? `\n\nYour other uncommitted change(s) (${harmless.join(', ')}) are untouched by this and are not a problem.` : ''),
        uncommittedFiles: status,
        conflictFiles: blocking,
        safeDirtyFiles: harmless,
      }
    }

    try {
      this.execGit(['merge', '--ff-only', integrationBranch])
    } catch (e: any) {
      return { ok: false, error: `Could not fast-forward ${target} onto ${integrationBranch}: ${(e as Error).message}` }
    }
    return { ok: true, branch: target, files, preservedDirtyFiles: harmless }
  }

  /** Discard the user's local edits for specific files, so they can unblock an
   *  apply without a blanket `git checkout .`.
   *
   *  Deliberately explicit and per-file. Resolving an apply conflict means one
   *  version has to go, and doing that to someone's working tree by inference
   *  is how real work gets destroyed. The UI lists the exact files, the user
   *  picks, and only those are reverted. */
  discardLocalEdits(files: string[]): { ok: boolean; error?: string; discarded: string[] } {
    if (!files.length) return { ok: true, discarded: [] }
    let current = ''
    try { current = this.execGit(['symbolic-ref', '--short', 'HEAD']) } catch {
      return { ok: false, error: 'HEAD is detached, so there is no branch to apply onto.' }
    }
    if (current.startsWith('task/')) {
      return { ok: false, error: `You are on the task branch ${current}. Check out your own branch first.` }
    }
    const safe = files.filter(f => f && !path.isAbsolute(f) && !f.startsWith('..'))
    if (safe.length !== files.length) {
      return { ok: false, error: 'Refusing to discard a path outside the repository.' }
    }
    try {
      this.execGit(['checkout', '--', ...safe])
    } catch (e: any) {
      return { ok: false, error: `Could not discard ${safe.join(', ')}: ${(e as Error).message}` }
    }
    return { ok: true, discarded: safe }
  }

  /** Full context for one conflicting file, for a human or an agent to work from.
   *
   *  Everything needed to decide, in one place: what this task wrote, what the
   *  integration branch has, and the real three-way diff. A solver handed only
   *  "demo.txt conflicts" has to rediscover all of it by hand. */
  describeConflict(taskGroupId: string, file: string): { file: string; taskSide: string; mergedSide: string; diff: string } | null {
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group?.branchName) return null
    const integrationBranch = this.stateManager.getIntegrationBranch()
    const taskSide = this.safeShow(`${group.branchName}:${file}`, this.repoPath)
    const mergedSide = this.safeShow(`${integrationBranch}:${file}`, this.repoPath)
    // `...` is the symmetric-difference form: task-only changes against
    // merged-only changes, which is the choice actually being made.
    let diff = ''
    try { diff = this.execGit(['diff', `${integrationBranch}...${group.branchName}`, '--', file], this.repoPath) } catch {}
    return { file, taskSide: taskSide.slice(0, 8000), mergedSide: mergedSide.slice(0, 8000), diff: diff.slice(0, 12000) }
  }

  /** The brief handed to a conflict-solving agent.
   *
   *  Written to be actionable on its own: what the task was for, which two
   *  versions disagree, and what the agent is allowed to do. Without the goal,
   *  an agent sees two blocks of text and cannot tell which one is correct. */
  buildConflictBrief(taskGroupId: string, conflictFiles: string[]): string {
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group) return ''
    const integrationBranch = this.stateManager.getIntegrationBranch()
    const details = conflictFiles.slice(0, 6).map((f) => {
      const d = this.describeConflict(taskGroupId, f)
      if (!d) return `--- ${f}\n(no detail available)`
      return [
        `--- ${f}`,
        `=== THIS TASK wrote (${group.branchName}) ===`,
        d.taskSide,
        `=== THE INTEGRATION BRANCH has (${integrationBranch}) ===`,
        d.mergedSide,
        `=== three-way diff (integration ... task) ===`,
        d.diff || '(no textual diff)',
      ].join('\n')
    })
    return [
      `A git merge conflict is blocking "${group.title}" from merging into ${integrationBranch}.`,
      ``,
      `Task goal: ${group.userGoal}`,
      `Task branch: ${group.branchName}`,
      `Integration branch: ${integrationBranch}`,
      `Conflicting file(s): ${conflictFiles.join(', ')}`,
      ``,
      `You are running in this task's own worktree at ${group.worktreePath}.`,
      `Nothing is merged yet. Two versions of the file above disagree.`,
      ``,
      `Decide what the correct combined result should be, then edit the file(s) in`,
      `this worktree to that result. Keep both sides' intent where they do not`,
      `actually conflict, and prefer the version that matches the task goal.`,
      `Do not run git commands - AgntSpce performs the merge once you are done.`,
      `When you have made the edits, say so and stop.`,
      ``,
      ...details,
    ].join('\n')
  }

  /** Read-only preview: clean check + diff stat + trial merge for conflicts. */
  previewMerge(taskGroupId: string): TaskMergePreview {
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    if (!group.branchName) {
      return {
        taskGroupId, branchName: '', diffSummary: '', actualFiles: [], conflictFiles: [],
        scopeOverlapFiles: [], error: 'This task is already merged — it has no branch left to merge.',
      }
    }
    if (group.branchName && this.branchIsGone(group.branchName)) {
      return {
        taskGroupId, branchName: group.branchName, diffSummary: '', actualFiles: [], conflictFiles: [],
        scopeOverlapFiles: [], error: 'This task is already merged — its branch was retired when it landed.',
      }
    }
    const integrationBranch = this.stateManager.getIntegrationBranch()
    let scratch: Scratch | null = null
    // Read before the trial merge mutates the scratch worktree, so the UI can
    // label the action "Commit & merge" when there is uncommitted work.
    const pending = this.pendingWork(group)
    try {
      // No dirty-check bail-out here. Merging now commits pending work on the
      // agent's behalf, so an uncommitted worktree is a normal state that the
      // preview should describe, not refuse to describe — that refusal is what
      // left the user with a dead end and no idea what would be merged.
      const integrationRef = this.execGit(['rev-parse', integrationBranch])
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)
      const collected = this.collect(group, integrationRef, scratch.worktreePath)
      if (collected.mergeStaged) {
        try { this.execGit(['merge', '--abort'], scratch.worktreePath) } catch {}
      }
      const preview = this.previewFrom(taskGroupId, group, collected)
      if (pending.length > 0) preview.pendingFiles = pending
      return preview
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
    // A retired task's directory can outlive its worktree as an orphan inside the
    // repo (`.agntspce/` is gitignored, so removing the worktree leaves the
    // generated COLLAB.md/.task.json behind). Running `git status` in such a
    // directory does not inspect the task at all — git walks up and reports the
    // MAIN repo, so the task gets blamed for the user's own uncommitted edits.
    // Verified: an orphan dir produced "Modified, never committed: M index.html"
    // for a file that task never touched. A real linked worktree always has a
    // `.git` entry (a file, not a directory).
    if (!fs.existsSync(path.join(group.worktreePath, '.git'))) return null
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
  /** Merge a task into the integration branch.
   *
   *  `preferSide` is the escape hatch. When the AI cannot resolve a conflict
   *  the user used to be stuck forever: the sync refuses (it would clobber
   *  work), and re-merging hits the same wall. Taking one side outright is a
   *  deliberate, visible choice the user makes, not a silent guess — 'ours' is
   *  the integration branch (work already merged), 'theirs' is the task. */
  async executeMerge(
    taskGroupId: string,
    autoResolve = true,
    preferSide?: 'ours' | 'theirs'
  ): Promise<TaskMergeResult> {
    if (this.locked || repoMergeLocks.has(this.repoPath)) {
      const group = this.groupOrThrow(taskGroupId)
      return { ...this.failResult(taskGroupId, group.branchName ?? '', 'A merge is already in progress for this repository. Wait for it to complete.'), needsConfirm: false }
    }
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    const branchName = group.branchName
    // No branch: the task is finished. A completed merge retires the worktree
    // and clears the branch, so this is the expected state of a task whose work
    // already landed — not an error, and not something to re-merge.
    if (!branchName) {
      return {
        ok: true, needsConfirm: false, taskGroupId, branchName: '',
        diffSummary: '(already merged)', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [],
        buildPassed: true,
      }
    }
    // Already merged and retired. Returning success (rather than falling through
    // to a raw git error) is what stops merge-all from reporting a finished task
    // as a failure, and stops the catch handler from flipping it back to
    // 'active'. A pre-fix database still has the dead branch recorded.
    if (this.branchIsGone(branchName)) {
      return {
        ok: true, needsConfirm: false, taskGroupId, branchName,
        diffSummary: '(already merged)', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [],
        buildPassed: true,
      }
    }
    const integrationBranch = this.stateManager.getIntegrationBranch()
    this.locked = true
    repoMergeLocks.add(this.repoPath)
    let scratch: Scratch | null = null
    // Set the moment the integration ref actually moves. Past this point the
    // work IS on the integration branch: reporting a failure, or rolling the
    // status back to 'active', would tell the user their work was lost while it
    // sits merged on the branch — the worst possible outcome for a merge, since
    // retrying would apply it twice.
    let landed = false
    try {
      // A stale candidate from an earlier attempt can never be confirmed once
      // the integration branch moves, so drop it before starting over.
      this.clearCandidate(taskGroupId)
      group.mergeCandidateRef = null
      group.mergeCandidateBase = null
      this.stateManager.updateTaskGroup(taskGroupId, { status: 'merging' })
      // Commit on the agent's behalf before deciding anything. A worktree the
      // agent never committed used to dead-end here with "there is nothing to
      // merge yet", even though the work was sitting there finished. Merging is
      // the user saying "take this work", so take it.
      const autoCommit = this.commitPendingWork(group, branchName)
      if (autoCommit.error) {
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
        return { ...this.failResult(taskGroupId, branchName, autoCommit.error), needsConfirm: false }
      }
      const dirty = this.dirtyWorktreeError(group)
      if (dirty) {
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
        return { ...this.failResult(taskGroupId, branchName, dirty), needsConfirm: false }
      }

      // Keep the integration branch current with the user's branch before
      // landing anything on it. Best-effort: a skipped sync just leaves the
      // fast-forward error waiting at apply time, which is a far better
      // failure than refusing to merge.
      this.syncSourceIntoIntegration()

      const integrationRef = this.execGit(['rev-parse', integrationBranch])
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)
      const collected = this.collect(group, integrationRef, scratch.worktreePath)
      const preview = this.previewFrom(taskGroupId, group, collected)
      // The user clicked merge, so they get told what was committed for the
      // agent rather than finding out from the history. Every `{ ...preview }`
      // return below carries this.
      if (autoCommit.files.length > 0) preview.autoCommittedFiles = autoCommit.files

      if (collected.nothingToMerge) {
        // Nothing to land, but the task is finished either way, so retire it
        // like a real merge. This path used to only flip the status, leaking the
        // task branch and leaving an orphan directory that later reported the
        // main repo's dirty files as this task's.
        this.recordMerge(taskGroupId, branchName, integrationBranch, integrationRef, '(no changes to merge)')
        return { ...preview, ok: true, needsConfirm: false, buildPassed: true }
      }

      if (collected.conflictFiles.length > 0) {
        // `collect` aborts its trial merge, so the scratch worktree has no
        // conflict stages here. Re-run the merge to get them back before asking
        // git for one side - `git checkout --theirs` outside a conflicted merge
        // silently keeps the current content, which is how "keep the task's
        // version" quietly landed the integration version instead. Scoped to
        // preferSide: the LLM path expects the clean, aborted tree.
        if (preferSide) {
          try {
            this.execGit(['merge', branchName, '--no-commit', '--no-ff'], scratch.worktreePath)
          } catch {
            // Expected: this is the conflict we are about to resolve.
          }
        }
        // The user picked a side: take it for the conflicting files and let the
        // merge finish, rather than dead-ending.
        if (preferSide) {
          try {
            this.execGit(['checkout', `--${preferSide}`, '--', ...collected.conflictFiles], scratch.worktreePath)
            this.execGit(['add', '--', ...collected.conflictFiles], scratch.worktreePath)
          } catch (e: any) {
            try { this.execGit(['merge', '--abort'], scratch.worktreePath) } catch {}
            this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
            return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: `Could not take the ${preferSide === 'ours' ? 'integration' : 'task'} version of ${collected.conflictFiles.join(', ')}: ${(e as Error).message}` }
          }
        } else if (!autoResolve || !this.llm) {
          try { this.execGit(['merge', '--abort'], scratch.worktreePath) } catch {}
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return {
            ...preview, ok: false, needsConfirm: false, buildPassed: false,
            error: this.llm
              ? `Merge conflicts in: ${collected.conflictFiles.join(', ')}. Let the AI resolve it, or choose which version to keep.`
              : `Merge conflicts in ${collected.conflictFiles.join(', ')} and no AI provider is configured to resolve them. Add one in Settings, or choose which version to keep.`,
          }
        }
        const resolved = preferSide
          ? { applied: true }
          : await this.resolveWithLlm(taskGroupId, integrationRef, 'integration', branchName, 'task branch', collected.conflictFiles, scratch.worktreePath)
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
      landed = true
      this.recordMerge(taskGroupId, branchName, integrationBranch, head, preview.diffSummary)
      return { ...preview, ok: true, needsConfirm: false, buildPassed: true, mergeCommitSha: head }
    } catch (e: any) {
      const msg = e instanceof CoordinatorError ? e.message : (e as Error).message
      if (landed) {
        // The integration branch already carries this work. Finish the task
        // bookkeeping and report success — never a failure the user would retry.
        try { this.recordMerge(taskGroupId, branchName, integrationBranch, '', '(merged)') } catch {}
        return {
          ok: true, needsConfirm: false, taskGroupId, branchName,
          diffSummary: '(merged)', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [],
          buildPassed: true,
        }
      }
      try { this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' }) } catch {}
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
      this.recordMerge(taskGroupId, branchName, integrationBranch, head, diffSummary)
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

  /** Ask the configured provider to resolve conflicted files.
   *
   *  The two sides are passed by ref *and* label because the roles invert
   *  depending on the direction: merging a task into the integration branch has
   *  integration on one side, but syncing a task *onto* integration has the task
   *  branch first. Getting that backwards would have shown the model the two
   *  versions and told it which was which, incorrectly. */
  private async resolveWithLlm(
    taskGroupId: string,
    oursRef: string, oursLabel: string,
    theirsRef: string, theirsLabel: string,
    conflictFiles: string[], scratchPath: string
  ): Promise<{ applied: boolean; error?: string }> {
    if (!this.llm) {
      return {
        applied: false,
        error: 'No AI provider is configured, so conflicts cannot be resolved automatically. Add one in Settings, or choose which version to keep.',
      }
    }
    try {
      const group = this.groupOrThrow(taskGroupId)
      const chunks: string[] = []
      for (const f of conflictFiles.slice(0, 8)) {
        const ours = this.safeShow(`${oursRef}:${f}`, scratchPath)
        const theirs = this.safeShow(`${theirsRef}:${f}`, scratchPath)
        chunks.push(`--- ${f} (${oursLabel})\n${ours.slice(0, 4000)}\n--- ${f} (${theirsLabel})\n${theirs.slice(0, 4000)}`)
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
      let patch: string | null
      try {
        patch = await this.llm(prompt)
      } catch (e: any) {
        // The provider failed. Say why - an invalid key or a spent quota is
        // fixable, and "empty resolution" gave the user nothing to act on.
        return { applied: false, error: describeLlmFailure(e) }
      }
      if (!patch || patch.trim().length < 20) {
        return {
          applied: false,
          error: `The AI replied with nothing usable for ${conflictFiles.join(', ')}. Retry, or resolve the conflict in the task worktree.`,
        }
      }
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

  /** Retire a task that has landed.
   *
   *  Verified failure: this deleted the worktree without stopping the agents
   *  running inside it, and left `worktree_path`/`branch_name` populated. A live
   *  agent then reported "the environment changed under me — the worktree I was
   *  in was torn down", and any later relaunch or follow-up re-spawned it into
   *  that deleted directory.
   *
   *  So: stop the agents first, then clear the pointers to the worktree that is
   *  about to stop existing, then remove it. A task that no longer has a
   *  worktree must not still claim one. */
  /** A merge is just a merge. The task is left completely alone.
   *
   *  It used to retire the task here: stop its agents, mark it done, delete its
   *  worktree and drop its branch. That made a merged task unusable — a live
   *  agent watched its directory disappear ("the environment changed under
   *  me"), its buttons vanished, and adding an agent failed because there was
   *  no worktree left to put one in.
   *
   *  So a merge now moves only the *branch*: the task keeps its worktree, its
   *  branch, its agents and their sessions. Work continues in the same place,
   *  and Merge / Update keep working for the next round exactly as they did the
   *  first time. A task is discarded with Delete, which is the one action that
   *  should remove a worktree.
   *
   *  The one field written here is the status, and only to clear the transient
   *  'merging' the merge set on the way in. Leaving it there would hide the
   *  task's own Merge and Update buttons, which only appear for an active task.
   */
  private recordMerge(
    taskGroupId: string,
    branchName: string,
    integrationBranch: string,
    head: string,
    diffSummary: string
  ): void {
    try { this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' }) } catch {}
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


/** Turn a provider failure into something the user can act on.
 *
 *  A raw provider message was the whole error, so an exhausted-credit reply
 *  arrived as a wall of third-party text with no indication that the real
 *  choice was still open: merge this yourself, right now, by picking a side.
 *  The detail is kept — it is the only place the credit URL appears — but it is
 *  demoted below the part that tells you what to do next. */
function describeLlmFailure(e: any): string {
  const raw = String(e?.message || e)
  const lower = raw.toLowerCase()
  if (/credit|insufficient_quota|quota|billing|balance|upgrade.*paid|payment/.test(lower)) {
    return [
      `Your AI provider has no credits left, so it cannot resolve conflicts right now.`,
      ``,
      `You do not have to wait: keep this task's version, or keep the merged one, and it lands immediately.`,
      ``,
      `Provider said: ${raw.slice(0, 400)}`,
    ].join('\n')
  }
  if (/401|unauthor|invalid.*key|api[- ]?key/.test(lower)) {
    return [
      `Your AI provider rejected the request (an invalid or missing API key), so it cannot resolve conflicts.`,
      ``,
      `You can still resolve this now by keeping either version below.`,
      ``,
      `Provider said: ${raw.slice(0, 400)}`,
    ].join('\n')
  }
  if (/timeout|timed out|network|econn|enotfound|fetch failed|socket/.test(lower)) {
    return [
      `Could not reach the AI provider.`,
      ``,
      `You can still resolve this now by keeping either version below.`,
      ``,
      `Provider said: ${raw.slice(0, 400)}`,
    ].join('\n')
  }
  return `The AI could not be reached: ${raw.slice(0, 400)}`
}
