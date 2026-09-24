import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { WorktreeLifecycle, detectBuildCommand, runCommands } from './worktreeLifecycle'
import { StateManager, CoordinatorError } from './stateManager'

export interface TaskMergePreview {
  taskGroupId: string
  branchName: string
  diffSummary: string
  actualFiles: string[]
  conflictFiles: string[]
  error?: string
}

export interface TaskMergeResult extends TaskMergePreview {
  ok: boolean
  /** True when a candidate commit exists but needs explicit user confirm. */
  needsConfirm: boolean
  buildPassed: boolean
  mergeCommitSha?: string
  resolvedDiff?: string
}

interface PreparedCandidate {
  taskGroupId: string
  scratchPath: string
  scratchBranch: string
  integrationBranch: string
  integrationRef: string
  head: string
}

/** v2 merge flow for TaskGroups. Mirrors MergeGate's scratch-merge + CAS
 *  promotion, but operates on task/<branch> worktrees. Clean merges promote
 *  automatically after build/test; LLM-resolved conflicts ALWAYS stop at a
 *  prepared candidate that needs explicit user confirm (confirmMerge). */
export class TaskMerger {
  private repoPath: string
  private worktreeLifecycle: WorktreeLifecycle
  private stateManager: StateManager
  private mergeLock = false
  private candidates = new Map<string, PreparedCandidate>()
  private llm?: (prompt: string) => Promise<string | null>

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

  private groupOrThrow(taskGroupId: string) {
    const group = this.stateManager.getTaskGroup(taskGroupId)
    if (!group) throw new CoordinatorError('NOT_FOUND', `Task ${taskGroupId} not found`)
    if (!group.branchName) throw new CoordinatorError('INVALID_STATE', `Task ${taskGroupId} has no branch yet — launch it first`)
    return group
  }

  private failResult(taskGroupId: string, branchName: string, error: string): TaskMergeResult {
    return { ok: false, needsConfirm: false, taskGroupId, branchName, diffSummary: '', actualFiles: [], conflictFiles: [], buildPassed: false, error }
  }

  /** Read-only preview: clean check + diff stat + trial merge for conflicts. */
  previewMerge(taskGroupId: string): TaskMergePreview {
    const group = this.groupOrThrow(taskGroupId)
    const branchName = group.branchName!
    const integrationBranch = this.stateManager.getIntegrationBranch()
    let scratch: { worktreePath: string; branchName: string } | null = null
    try {
      if (group.worktreePath && fs.existsSync(group.worktreePath)) {
        const wtStatus = this.execGit(['status', '--porcelain'], group.worktreePath)
        if (wtStatus) return { taskGroupId, branchName, diffSummary: '', actualFiles: [], conflictFiles: [], error: `Worktree has uncommitted changes:\n${wtStatus}` }
      }
      const diffStat = this.execGit(['diff', '--stat', `${integrationBranch}...${branchName}`])
      const actualFiles = this.execGit(['diff', '--name-only', `${integrationBranch}...${branchName}`]).split('\n').filter(Boolean)

      const integrationRef = this.execGit(['rev-parse', integrationBranch])
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)
      let conflictFiles: string[] = []
      try {
        this.execGit(['merge', branchName, '--no-commit', '--no-ff'], scratch.worktreePath)
      } catch {
        const unmerged = this.execGit(['diff', '--name-only', '--diff-filter=U'], scratch.worktreePath)
        if (unmerged) conflictFiles = unmerged.split('\n').filter(Boolean)
        try { this.execGit(['merge', '--abort'], scratch.worktreePath) } catch {}
      }
      return { taskGroupId, branchName, diffSummary: diffStat || '(no changes)', actualFiles, conflictFiles }
    } catch (e: any) {
      return { taskGroupId, branchName, diffSummary: '', actualFiles: [], conflictFiles: [], error: e?.message || 'Preview failed' }
    } finally {
      if (scratch) this.worktreeLifecycle.removeScratchWorktree(scratch.worktreePath)
    }
  }

  /** Execute a merge. Clean path auto-promotes; conflict path either resolves
   *  via LLM into a confirm-pending candidate or returns blocked. */
  async executeMerge(taskGroupId: string, autoResolve = true): Promise<TaskMergeResult> {
    if (this.mergeLock) {
      const group = this.groupOrThrow(taskGroupId)
      return { ...this.failResult(taskGroupId, group.branchName ?? '', 'A merge is already in progress. Wait for it to complete.'), needsConfirm: false }
    }
    const group = this.groupOrThrow(taskGroupId)
    const branchName = group.branchName!
    const integrationBranch = this.stateManager.getIntegrationBranch()
    this.mergeLock = true
    let scratch: { worktreePath: string; branchName: string } | null = null
    try {
      this.stateManager.updateTaskGroup(taskGroupId, { status: 'merging' })
      const preview = this.previewMerge(taskGroupId)
      if (preview.error) {
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
        return { ...preview, ok: false, needsConfirm: false, buildPassed: false }
      }
      if (preview.actualFiles.length === 0 && !preview.diffSummary) {
        this.stateManager.updateTaskGroup(taskGroupId, { status: 'done', completedAt: Date.now() })
        return { ...preview, ok: true, needsConfirm: false, buildPassed: true }
      }

      const integrationRef = this.execGit(['rev-parse', integrationBranch])
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)

      if (preview.conflictFiles.length > 0) {
        if (!autoResolve || !this.llm) {
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: `Merge conflicts in: ${preview.conflictFiles.join(', ')}. Resolve them or retry with auto-resolve.` }
        }
        const resolved = await this.resolveWithLlm(taskGroupId, branchName, integrationBranch, preview.conflictFiles, scratch.worktreePath)
        if (!resolved.applied) {
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: resolved.error || 'LLM resolution failed to apply' }
        }
        const verified = this.verifyCandidate(scratch.worktreePath)
        if (!verified.ok) {
          this.stateManager.updateTaskGroup(taskGroupId, { status: 'active' })
          return { ...preview, ok: false, needsConfirm: false, buildPassed: false, error: verified.error }
        }
        this.execGit(['commit', '-m', `agntspce merge (LLM-resolved): ${taskGroupId} (${branchName}) into ${integrationBranch}`], scratch.worktreePath)
        const head = this.execGit(['rev-parse', 'HEAD'], scratch.worktreePath)
        const resolvedDiff = this.execGit(['diff', `${integrationRef}..${head}`], scratch.worktreePath).slice(0, 20000)
        this.candidates.set(taskGroupId, {
          taskGroupId, scratchPath: scratch.worktreePath, scratchBranch: scratch.branchName,
          integrationBranch, integrationRef, head,
        })
        scratch = null // owned by the candidate now; confirmMerge cleans up
        return { ...preview, ok: false, needsConfirm: true, buildPassed: true, mergeCommitSha: head, resolvedDiff }
      }

      // Clean path: merge, verify, promote immediately.
      this.execGit(['merge', branchName, '--no-commit', '--no-ff'], scratch.worktreePath)
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
      this.mergeLock = false
    }
  }

  /** Promote a confirm-pending candidate after the user approves the diff. */
  confirmMerge(taskGroupId: string): TaskMergeResult {
    const candidate = this.candidates.get(taskGroupId)
    if (!candidate) {
      const group = this.groupOrThrow(taskGroupId)
      return { ...this.failResult(taskGroupId, group.branchName ?? '', 'No pending merge candidate — run merge first'), needsConfirm: false }
    }
    try {
      const currentRef = this.execGit(['rev-parse', candidate.integrationBranch])
      if (currentRef !== candidate.integrationRef) {
        return { ...this.failResult(taskGroupId, '', `Integration branch moved (${candidate.integrationRef.slice(0, 8)} → ${currentRef.slice(0, 8)}). Candidate invalidated — merge again.`), needsConfirm: false }
      }
      this.promote(candidate.head, candidate.integrationBranch, candidate.integrationRef)
      const group = this.groupOrThrow(taskGroupId)
      const diffSummary = this.execGit(['diff', '--stat', `${candidate.integrationRef}..${candidate.head}`])
      this.finishTask(taskGroupId, group.branchName ?? '', candidate.integrationBranch, candidate.head, diffSummary)
      return {
        ok: true, needsConfirm: false, taskGroupId, branchName: group.branchName ?? '',
        diffSummary: diffSummary || '(merged)', actualFiles: [], conflictFiles: [],
        buildPassed: true, mergeCommitSha: candidate.head,
      }
    } finally {
      this.worktreeLifecycle.removeScratchWorktree(candidate.scratchPath)
      this.candidates.delete(taskGroupId)
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
    taskGroupId: string, branchName: string, integrationBranch: string,
    conflictFiles: string[], scratchPath: string
  ): Promise<{ applied: boolean; error?: string }> {
    if (!this.llm) return { applied: false, error: 'No LLM configured for conflict resolution' }
    try {
      const group = this.groupOrThrow(taskGroupId)
      const chunks: string[] = []
      for (const f of conflictFiles.slice(0, 8)) {
        const ours = this.safeShow(`${integrationBranch}:${f}`, scratchPath)
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
      this.execGit(['add', '-A'], scratchPath)
      const remaining = this.execGit(['diff', '--name-only', '--diff-filter=U'], scratchPath)
      if (remaining) return { applied: false, error: `Patch applied but conflicts remain in: ${remaining}` }
      return { applied: true }
    } catch (e: any) {
      return { applied: false, error: `LLM resolution failed: ${(e as Error).message.slice(0, 500)}` }
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
