import { execFileSync } from 'node:child_process'
import { WorktreeLifecycle, detectBuildCommand, runCommands } from './worktreeLifecycle'
import { StateManager, CoordinatorError } from './stateManager'

export interface MergeResult {
  ok: boolean
  taskId: string
  branchName: string
  diffSummary: string
  actualFiles: string[]
  undeclaredFiles: string[]
  conflictFiles: string[]
  buildPassed: boolean
  mergeCommitSha?: string
  error?: string
  gateId?: string
}

export class MergeGate {
  private repoPath: string
  private worktreeLifecycle: WorktreeLifecycle
  private stateManager: StateManager
  private mergeLock: boolean = false

  constructor(repoPath: string, worktreeLifecycle: WorktreeLifecycle, stateManager: StateManager) {
    this.repoPath = repoPath
    this.worktreeLifecycle = worktreeLifecycle
    this.stateManager = stateManager
  }

  private execGit(args: string[], cwd?: string): string {
    // See worktreeLifecycle.execGit: pipe stderr so best-effort probes don't
    // spam the host terminal; fold it into the thrown error instead.
    if (args.some(a => a === undefined || a === null || a === '')) {
      throw new Error(`git ${args.join(' ')} failed: empty revision argument`)
    }
    try {
      const result = execFileSync('git', args, {
        cwd: cwd || this.repoPath,
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return (result || '').toString().trim()
    } catch (e: any) {
      const stderr = String(e?.stderr || '').trim()
      throw new Error(stderr ? `git ${args.join(' ')} failed: ${stderr.slice(0, 500)}` : (e?.message || String(e)))
    }
  }

  checkMergeStatus(taskId: string, agentId: string): { canMerge: boolean; reason?: string } {
    const task = this.stateManager.getTask(taskId)
    if (!task) return { canMerge: false, reason: `Task ${taskId} not found` }
    if (task.status !== 'merging') return { canMerge: false, reason: `Task status is ${task.status}, expected 'merging'` }
    if (task.agentId !== agentId) return { canMerge: false, reason: 'Only the task owner can merge this task' }
    if (!task.worktreePath) return { canMerge: false, reason: 'No worktree path for this task' }
    if (!this.worktreeLifecycle.worktreeExists(taskId)) return { canMerge: false, reason: 'Worktree no longer exists on disk' }

    return { canMerge: true }
  }

  executeMerge(taskId: string): MergeResult {
    if (this.mergeLock) {
      return this.failResult(taskId, 'A merge is already in progress. Wait for it to complete.')
    }

    const task = this.stateManager.getTask(taskId)
    if (!task) return this.failResult(taskId, `Task ${taskId} not found`)

    const branchName = task.branchName || this.worktreeLifecycle.getBranchName(taskId)
    const worktreePath = task.worktreePath || this.worktreeLifecycle.getWorktreePath(taskId)
    const branchPoint = task.branchPoint || ''
    const result: MergeResult = {
      ok: false,
      taskId,
      branchName,
      diffSummary: '',
      actualFiles: [],
      undeclaredFiles: [],
      conflictFiles: [],
      buildPassed: false,
    }

    this.mergeLock = true
    let scratch: { worktreePath: string; branchName: string } | null = null

    try {
      // ── Step 1: Verify worktree is clean ──
      const wtStatus = this.execGit(['status', '--porcelain'], worktreePath)
      if (wtStatus) {
        return this.failResult(taskId, `Worktree has uncommitted changes:\n${wtStatus}`)
      }

      // ── Step 2: Compute actual changed files ──
      const actualFiles = branchPoint
        ? this.execGit(['diff', '--name-only', `${branchPoint}..${branchName}`]).split('\n').filter(Boolean)
        : []
      result.actualFiles = actualFiles
      this.stateManager.updateTaskActualFiles(taskId, actualFiles)

      // ── Step 3: Diff summary ──
      const baseBranch = this.stateManager.getIntegrationBranch()
      const diffStat = this.execGit(['diff', '--stat', `${baseBranch}...${branchName}`])
      result.diffSummary = diffStat || '(no changes)'

      if (actualFiles.length === 0 && !diffStat) {
        result.ok = true
        result.buildPassed = true
        this.stateManager.transitionTaskStatus(taskId, 'done')
        return result
      }

      // ── Step 4: Merge-time scope check ──
      // Compare merging task's actual files against ALL other active tasks' scopes
      // (actual files if known, otherwise declared files)
      const activeTasks = this.stateManager.getActiveTasks().filter(t => t.id !== taskId)
      const activeScopeFiles = new Set<string>()
      const scopeToTask: Map<string, string[]> = new Map()
      for (const t of activeTasks) {
        const files = t.actualFiles || t.declaredFiles
        for (const f of files) {
          activeScopeFiles.add(f)
          const existing = scopeToTask.get(f) || []
          scopeToTask.set(f, [...existing, t.id])
        }
      }
      const undeclared = actualFiles.filter(f => !task.declaredFiles.includes(f))
      result.undeclaredFiles = undeclared
      const scopeOverlap = actualFiles.filter(f => activeScopeFiles.has(f))
      if (scopeOverlap.length > 0) {
        // 4.3 human control point: a risky merge (file overlap with another
        // active task) goes through a decision gate, not a silent escalation.
        // The gate blocks the merge until a human approves; rejection releases
        // the task for another agent (via coordinator resolve_gate).
        const clashTasks = [...new Set(scopeOverlap.flatMap(f => scopeToTask.get(f) || []))]
        const gate = this.stateManager.createGate(
          taskId,
          `Merge-time scope overlap: ${scopeOverlap.join(', ')} overlap with active tasks ${clashTasks.join(', ')}`
        )
        this.stateManager.postStatusUpdate(taskId, task.agentId || '', `Gate requested: merge overlaps ${scopeOverlap.join(', ')} with active tasks`)
        result.gateId = gate.id
        result.error = `Scope overlap at merge time: ${scopeOverlap.join(', ')} conflict with tasks ${[...new Set(clashTasks)].join(', ')}. Decision gate created — a human must approve before merging.`
        return result
      }

      // ── Step 5: Capture integration ref SHA for compare-and-swap ──
      const integrationRef = this.execGit(['rev-parse', baseBranch])
      if (!integrationRef) {
        return this.failResult(taskId, `Integration branch '${baseBranch}' not found in repository`)
      }

      // ── Step 6: Create scratch worktree from integration ref ──
      scratch = this.worktreeLifecycle.createScratchWorktree(integrationRef)

      // ── Step 7: Non-interactive merge of task branch into scratch ──
      let mergeConflict = false
      let mergeFailedWithoutConflict = false
      let mergeStderr = ''
      try {
        this.execGit(['merge', branchName, '--no-commit', '--no-ff'], scratch.worktreePath)
      } catch (e) {
        const errMsg = (e as Error).message
        const unmerged = this.execGit(['diff', '--name-only', '--diff-filter=U'], scratch.worktreePath)
        if (unmerged) {
          mergeConflict = true
          result.conflictFiles = unmerged.split('\n').filter(Boolean)
          this.execGit(['merge', '--abort'], scratch.worktreePath)
        } else {
          mergeFailedWithoutConflict = true
          mergeStderr = errMsg.slice(0, 1000)
          this.execGit(['merge', '--abort'], scratch.worktreePath)
        }
      }

      if (mergeConflict) {
        this.stateManager.transitionTaskStatus(taskId, 'escalated')
        this.stateManager.createEscalation(
          `Merge conflict with integration branch '${baseBranch}'`,
          `Task ${taskId} (${branchName}) has conflicts with ${baseBranch} in files: ${result.conflictFiles.join(', ')}`,
          [task.agentId || '']
        )
        return this.failResult(taskId,
          `Merge conflict in files: ${result.conflictFiles.join(', ')}. Escalation created. Worktree kept for review.`)
      }

      if (mergeFailedWithoutConflict) {
        this.stateManager.transitionTaskStatus(taskId, 'escalated')
        this.stateManager.createEscalation(
          `Candidate merge failed (non-conflict error)`,
          `Task ${taskId} (${branchName}) merge into ${baseBranch} failed:\n${mergeStderr}`,
          [task.agentId || '']
        )
        return this.failResult(taskId,
          `Merge failed (non-conflict): ${mergeStderr}. Escalation created. Worktree kept for review.`)
      }

      // Commit the merge in scratch
      this.execGit(['commit', '-m', `agntspce merge: ${taskId} (${branchName}) into ${baseBranch}`], scratch.worktreePath)

      // ── Step 8: Install deps and build+test in merged candidate ──
      const depResult = this.worktreeLifecycle.installDependencies(scratch.worktreePath)
      if (!depResult.ok) {
        this.stateManager.transitionTaskStatus(taskId, 'escalated')
        this.stateManager.createEscalation(
          `Dependency install failed in merged candidate`,
          `Task ${taskId} merged into ${baseBranch}: dependency install failed:\n${depResult.error || ''}`,
          [task.agentId || '']
        )
        return this.failResult(taskId, `${depResult.error}. Escalation created. Worktree kept for review.`)
      }

      const cmd = detectBuildCommand(scratch.worktreePath)
      const buildCmds: string[][] = []
      if (cmd.build) buildCmds.push(cmd.build)
      if (cmd.test) buildCmds.push(cmd.test)
      if (buildCmds.length > 0) {
        const buildOk = runCommands(scratch.worktreePath, buildCmds)
        result.buildPassed = buildOk.ok
        if (!buildOk.ok) {
          this.stateManager.transitionTaskStatus(taskId, 'escalated')
          this.stateManager.createEscalation(
            `Build/test failed in merged candidate`,
            `Task ${taskId} merged into ${baseBranch} failed verification:\n${buildOk.error || ''}`,
            [task.agentId || '']
          )
          return this.failResult(taskId, `Build/test failed in merged candidate: ${buildOk.error}. Escalation created. Worktree kept for review.`)
        }
      } else {
        result.buildPassed = true
      }

      // ── Step 9: Compare-and-swap integration promotion ──
      const scratchHead = this.execGit(['rev-parse', 'HEAD'], scratch.worktreePath)
      // fast-fail pre-check: if ref already moved, skip the candidate
      const currentIntegrationRef = this.execGit(['rev-parse', baseBranch])
      if (currentIntegrationRef !== integrationRef) {
        this.stateManager.createEscalation(
          `Integration branch moved during merge`,
          `Task ${taskId}: ${baseBranch} moved from ${integrationRef.slice(0, 8)} to ${currentIntegrationRef.slice(0, 8)} while candidate was being validated. Manual retry needed.`,
          [task.agentId || '']
        )
        this.stateManager.transitionTaskStatus(taskId, 'escalated')
        return this.failResult(taskId,
          `Integration branch '${baseBranch}' moved (${integrationRef.slice(0, 8)} → ${currentIntegrationRef.slice(0, 8)}). Candidate invalidated. Escalation created.`)
      }
      // atomic CAS: only update if ref still equals integrationRef
      try {
        this.execGit(['update-ref', `refs/heads/${baseBranch}`, scratchHead, integrationRef])
      } catch (e) {
        const msg = (e as Error).message.slice(0, 800)
        const currentSha = this.execGit(['rev-parse', baseBranch]).slice(0, 8)
        this.stateManager.createEscalation(
          `Integration branch CAS failed`,
          `Task ${taskId}: expected ${baseBranch} at ${integrationRef.slice(0,8)} but update-ref failed: ${msg}. Current is ${currentSha}. Manual retry needed.`,
          [task.agentId || '']
        )
        this.stateManager.transitionTaskStatus(taskId, 'escalated')
        return this.failResult(taskId, `CAS failed for ${baseBranch}: ${msg}. Escalation created. Worktree kept.`)
      }
      result.mergeCommitSha = scratchHead
      result.ok = true

      // ── Step 10: Mark task done ──
      this.stateManager.transitionTaskStatus(taskId, 'done')

      // ── Step 11: Remove task worktree/branch (successful only, merged-only) ──
      this.worktreeLifecycle.removeWorktree(taskId, baseBranch)
      this.stateManager.markWorktreeRemoved(taskId)

      // ── Step 12: Broadcast ──
      this.stateManager.sendMessage('agntspce-coordinator', null, true,
        `Task ${taskId} merged: ${branchName} → ${baseBranch}\n${diffStat}\nHEAD: ${scratchHead}`)

      return result
    } catch (e) {
      const errMsg = e instanceof CoordinatorError ? e.message : (e as Error).message
      return this.failResult(taskId, errMsg)
    } finally {
      if (scratch) {
        this.worktreeLifecycle.removeScratchWorktree(scratch.worktreePath)
      }
      this.mergeLock = false
    }
  }

  private failResult(taskId: string, error: string): MergeResult {
    return {
      ok: false,
      taskId,
      branchName: '',
      diffSummary: '',
      actualFiles: [],
      undeclaredFiles: [],
      conflictFiles: [],
      buildPassed: false,
      error,
    }
  }
}
