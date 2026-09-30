import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { StateManager } from './stateManager'

const execFileAsync = promisify(execFile)

export interface FileConflictEvent {
  file: string
  editorAgentId: string
  editorTaskId: string
  conflictingAgentIds: string[]
  conflictingTaskIds: string[]
  changedAt: number
}

export interface FileWatcherOptions {
  stateManager: StateManager
  repoPath: string
  worktreeBase: string
  debounceMs?: number
  pollMs?: number
  onConflict: (event: FileConflictEvent) => void
}

// 3.2 live file watcher: watches worktrees for edits that step on another
// agent's claims and notifies both sides. Reuses the scope-overlap logic from
// mergeGate.ts:104-128 (declared + actual files of active tasks). Uses
// `fs.watch` recursive where available with a git-status polling fallback for
// platforms without recursive watch support.
export class FileWatcher {
  private stateManager: StateManager
  private repoPath: string
  private worktreeBase: string
  private debounceMs: number
  private pollMs: number
  private onConflict: (event: FileConflictEvent) => void
  private watcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastEmitAt: Record<string, number> = {}
  private lastGitSnapshot: Record<string, string> = {}
  private closed = false

  constructor(options: FileWatcherOptions) {
    this.stateManager = options.stateManager
    this.repoPath = options.repoPath
    this.worktreeBase = options.worktreeBase
    this.debounceMs = options.debounceMs ?? 1000
    this.pollMs = options.pollMs ?? 3000
    this.onConflict = options.onConflict
  }

  start(): void {
    if (!fs.existsSync(this.worktreeBase)) return
    try {
      this.watcher = fs.watch(this.worktreeBase, { recursive: true }, (_event, filename) => {
        if (typeof filename !== 'string') return
        this.handleChangedFile(filename)
      })
      this.watcher.on('error', () => this.fallbackToPolling())
    } catch {
      this.fallbackToPolling()
    }

    // Capture the baseline git snapshot so the first poll detects changes made
    // after start() (previously the first snapshot was always skipped).
    this.captureBaseline()

    // Polling fallback also catches changes that recursive watch misses and
    // picks up new worktrees that appear after start().
    this.pollTimer = setInterval(() => this.pollGitStatus(), this.pollMs)
    this.pollTimer.unref()
  }

  private async captureBaseline(): Promise<void> {
    const tasks = this.stateManager.getActiveTasks().filter(t => t.worktreePath)
    for (const t of tasks) {
      if (!t.worktreePath) continue
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: t.worktreePath, timeout: 8000 })
        this.lastGitSnapshot['task:' + t.id] = stdout
      } catch {}
    }
  }

  close(): void {
    this.closed = true
    if (this.watcher) {
      try { this.watcher.close() } catch {}
      this.watcher = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private fallbackToPolling(): void {
    try { this.watcher?.close() } catch {}
    this.watcher = null
  }

  // fs.watch emits repo-relative paths under the worktree base (e.g.
  // `agntspce/task-abc/src/main.ts`). Map back to the owning agent/task.
  private handleChangedFile(relPath: string): void {
    if (this.closed) return
    const norm = relPath.split(path.sep).join('/')
    if (this.isNoise(norm)) return
    const full = path.join(this.worktreeBase, norm)
    if (!fs.existsSync(full)) return
    const owner = this.findOwner(full)
    if (!owner) return
    this.checkOverlap(owner.repoRel, owner.taskId, owner.agentId)
  }

  private isNoise(rel: string): boolean {
    const base = rel.split('/')[0]
    const noise = new Set(['.git', '.agntspce', 'node_modules', 'dist', 'build', '.next', '.vite', 'coverage', '.venv', '__pycache__'])
    return noise.has(base) || rel.includes('/.git/') || rel.endsWith('.swp') || rel.endsWith('~')
  }

  private findOwner(fullPath: string): { repoRel: string; taskId: string; agentId: string } | null {
    const repoRel = path.relative(this.repoPath, fullPath).split(path.sep).join('/')
    for (const t of this.stateManager.getActiveTasks()) {
      if (!t.worktreePath || !t.agentId) continue
      if (t.worktreePath === path.dirname(fullPath) || fullPath.startsWith(t.worktreePath + path.sep)) {
        return { repoRel, taskId: t.id, agentId: t.agentId }
      }
    }
    return null
  }

  // Live file-claim overlap: the changed file overlaps if any OTHER active task
  // has claimed it. Claims are declared by the agents themselves as they work,
  // so this stays accurate without any planner.
  private checkOverlap(repoRel: string, editorTaskId: string, editorAgentId: string): void {
    const now = Date.now()
    const last = this.lastEmitAt[editorTaskId + ':' + repoRel] || 0
    if (now - last < this.debounceMs) return
    this.lastEmitAt[editorTaskId + ':' + repoRel] = now

    const overlap = this.stateManager.checkFileOverlap([repoRel], editorTaskId)
    if (!overlap.overlaps) return

    const conflictingTaskIds = overlap.conflictingTaskIds
    const conflictingAgentIds = conflictingTaskIds
      .map(id => this.stateManager.getTask(id)?.agentId)
      .filter((a): a is string => !!a)

    this.onConflict({
      file: repoRel,
      editorAgentId,
      editorTaskId,
      conflictingAgentIds,
      conflictingTaskIds,
      changedAt: now,
    })
  }

  // Polling fallback: diff the worktrees' git status against the last snapshot
  // and re-check changed files for overlap. Cheap (one `git status --porcelain`
  // per worktree) and catches untracked edits before commits.
  private async pollGitStatus(): Promise<void> {
    if (this.closed) return
    const tasks = this.stateManager.getActiveTasks().filter(t => t.worktreePath)
    for (const t of tasks) {
      if (!t.worktreePath) continue
      let snapshot = ''
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: t.worktreePath, timeout: 8000 })
        snapshot = stdout
      } catch {
        continue
      }
      const key = 'task:' + t.id
      const prev = this.lastGitSnapshot[key]
      this.lastGitSnapshot[key] = snapshot
      if (prev === undefined || prev === snapshot) continue

      const prevSet = new Set(this.parseStatusLines(prev))
      const curLines = this.parseStatusLines(snapshot)
      for (const line of curLines) {
        if (prevSet.has(line)) continue
        const rel = line.slice(3).trim()
        if (rel && !this.isNoise(rel)) {
          this.checkOverlap(rel, t.id, t.agentId || '')
        }
      }
    }
  }

  private parseStatusLines(status: string): string[] {
    return status.split('\n').filter(Boolean)
  }
}
