import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Per-task scaffolding AgntSpce writes into every task worktree.
 *
 *  These are generated, never committed, and are rewritten on every collab
 *  event, so they always show up as untracked noise. Anything that decides
 *  "does this worktree have real work in it?" must ignore them — otherwise a
 *  freshly launched task can never be merged.
 *
 *  Writers: `.task.json` → taskPlanner.writeTaskMetaFile, `COLLAB.md` →
 *  collabShim.COLLAB_MD_FILENAME, `AGENTS-TASK.md` → groupSync.GROUP_BRIEFING_FILENAME. */
export const TASK_SCAFFOLD_FILES: ReadonlySet<string> = new Set([
  '.task.json',
  'COLLAB.md',
  'AGENTS-TASK.md',
])

/** True when a `git status --porcelain` line refers only to generated
 *  scaffolding. Handles the `XY path` and `XY path -> path` (rename) forms. */
export function isTaskScaffoldStatusLine(line: string): boolean {
  const raw = line.slice(3).trim()
  const arrow = raw.indexOf(' -> ')
  const p = (arrow >= 0 ? raw.slice(0, arrow) : raw).trim().replace(/^"(.*)"$/, '$1')
  return TASK_SCAFFOLD_FILES.has(p)
}

function detectPackageManager(repoPath: string): string {
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(repoPath, 'package-lock.json'))) return 'npm'
  if (fs.existsSync(path.join(repoPath, 'Cargo.lock'))) return 'cargo'
  if (fs.existsSync(path.join(repoPath, 'go.mod'))) return 'go'
  if (fs.existsSync(path.join(repoPath, 'Gemfile.lock'))) return 'bundle'
  return ''
}

function detectInstallCommand(pm: string): string[] | null {
  switch (pm) {
    case 'pnpm': return ['pnpm', 'install', '--frozen-lockfile']
    case 'yarn': return ['yarn', 'install', '--frozen-lockfile']
    case 'npm': return ['npm', 'ci']
    case 'cargo': return ['cargo', 'build']
    case 'go': return ['go', 'mod', 'download']
    case 'bundle': return ['bundle', 'install']
    default: return null
  }
}

export function detectBuildCommand(repoPath: string): { build: string[] | null; test: string[] | null } {
  const pkg = path.join(repoPath, 'package.json')
  try {
    const json = JSON.parse(fs.readFileSync(pkg, 'utf-8'))
    return {
      build: json.scripts?.build ? ['npm', 'run', 'build'] : null,
      test: json.scripts?.test ? ['npm', 'run', 'test'] : null,
    }
  } catch {
    return { build: null, test: null }
  }
}

export function runCommands(repoPath: string, cmds: string[][]): { ok: boolean; output?: string; error?: string } {
  let allOutput = ''
  for (const cmd of cmds) {
    try {
      const label = cmd.join(' ')
      const output = execFileSync(cmd[0], cmd.slice(1), {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      })
      allOutput += `$ ${label}\n${output.slice(0, 1000)}\n`
    } catch (e) {
      const err = (e as Error).message
      return { ok: false, error: `Command failed: ${cmd.join(' ')}: ${err.slice(0, 1000)}` }
    }
  }
  return { ok: true, output: allOutput }
}

export interface WorktreeResult {
  worktreePath: string
  branchName: string
  branchPoint: string
}

export interface ScratchWorktreeResult {
  worktreePath: string
  branchName: string
}

export class WorktreeLifecycle {
  private repoPath: string
  private baseDir: string

  constructor(repoPath: string) {
    this.repoPath = repoPath
    this.baseDir = path.join(path.dirname(path.resolve(repoPath)), '.agntspce', 'worktrees')
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  private execGit(args: string[], cwd?: string): string {
    // Pipe stderr: best-effort git probes (dirty-worktree removal, missing
    // refs) must not spam the host terminal; the message is folded into the
    // thrown error instead. Empty args are rejected outright — git reports
    // those as the cryptic "fatal: Needed a single revision".
    if (args.some(a => a === undefined || a === null || a === '')) {
      throw new Error(`git ${args.join(' ')} failed: empty revision argument`)
    }
    try {
      return execFileSync('git', args, {
        cwd: cwd || this.repoPath,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch (e: any) {
      const stderr = String(e?.stderr || '').trim()
      throw new Error(stderr ? `git ${args.join(' ')} failed: ${stderr.slice(0, 500)}` : (e?.message || String(e)))
    }
  }

  getRepoPath(): string {
    return this.repoPath
  }

  createWorktree(id: string, sourceRef: string): WorktreeResult {
    const branchName = `worktree/${id}`
    const worktreePath = path.join(this.baseDir, id)

    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree path already exists: ${worktreePath}`)
    }

    const branchPoint = this.execGit(['rev-parse', sourceRef])

    this.execGit(['worktree', 'add', '-b', branchName, worktreePath, branchPoint])

    return { worktreePath, branchName, branchPoint }
  }

  createScratchWorktree(sourceRef: string): ScratchWorktreeResult {
    const shortRef = sourceRef.slice(0, 8)
    const ts = Date.now()
    const branchName = `agntspce-scratch-merge-${shortRef}-${ts}`
    const dirName = `scratch-merge-${shortRef}-${ts}`
    const worktreePath = path.join(this.baseDir, dirName)

    if (fs.existsSync(worktreePath)) {
      this.removeScratchWorktree(worktreePath)
    }

    this.execGit(['worktree', 'add', '-b', branchName, worktreePath, sourceRef])

    return { worktreePath, branchName }
  }

  // 5.4 no-worktree mode: create the task branch in the main repo (checked out
  // by the agent working in-place) instead of a detached git worktree.
  createInRepoBranch(taskId: string, sourceRef: string): void {
    const branchName = `worktree/${taskId}`
    try {
      this.execGit(['branch', '-D', branchName])
    } catch {}
    this.execGit(['branch', branchName, sourceRef])
    this.execGit(['checkout', branchName])
  }

  // 5.4 no-worktree teardown: after a successful merge, return the repo working
  // tree to the integration branch and delete the (now-merged) task branch.
  // A checked-out branch cannot be deleted, so checkout must come first.
  cleanupInRepoTaskBranch(taskId: string, integrationBranch: string): void {
    const branchName = `worktree/${taskId}`
    try {
      this.execGit(['checkout', integrationBranch])
    } catch {}
    try {
      this.execGit(['branch', '-D', branchName])
    } catch {}
  }

  removeScratchWorktree(worktreePath: string): void {
    if (!fs.existsSync(worktreePath)) return
    try {
      const branch = this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
      this.execGit(['worktree', 'remove', '--force', worktreePath])
      if (branch && branch !== 'HEAD') {
        this.execGit(['branch', '-D', branch])
      }
    } catch {}
    try { fs.rmSync(worktreePath, { recursive: true, force: true }) } catch {}
  }

  installDependencies(worktreePath: string): { ok: boolean; output?: string; error?: string } {
    const pm = detectPackageManager(worktreePath)
    if (!pm) return { ok: true, output: 'No package manager detected, skipping install' }

    const cmd = detectInstallCommand(pm)
    if (!cmd) return { ok: true, output: 'No install command for detected package manager, skipping' }

    try {
      const output = execFileSync(cmd[0], cmd.slice(1), {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return { ok: true, output: output.slice(0, 2000) }
    } catch (e) {
      return { ok: false, error: `Dependency install failed for ${pm}: ${(e as Error).message.slice(0, 1000)}` }
    }
  }

  removeWorktree(id: string, integrationBranch?: string): void {
    const branchName = `worktree/${id}`
    const worktreePath = path.join(this.baseDir, id)

    if (!fs.existsSync(worktreePath)) {
      this.deleteBranchIfMerged(branchName, integrationBranch)
      return
    }

    try {
      this.execGit(['worktree', 'remove', worktreePath])
    } catch {
      try {
        this.execGit(['worktree', 'remove', '--force', worktreePath])
      } catch {}
    }

    this.deleteBranchIfMerged(branchName, integrationBranch)

    try {
      fs.rmSync(worktreePath, { recursive: true, force: true })
    } catch {}
  }

  private deleteBranchIfMerged(branchName: string, integrationBranch?: string): void {
    if (!integrationBranch) return
    try {
      // git merge-base --is-ancestor exits 0 (true) when the branch has been
      // merged into the integration branch. Only delete merged branches so
      // unmerged work is never destroyed by teardown.
      this.execGit(['merge-base', '--is-ancestor', branchName, integrationBranch])
      this.execGit(['branch', '-D', branchName])
    } catch {
      // Branch is unmerged (or missing) — keep it so the work survives.
    }
  }

  worktreeExists(id: string): boolean {
    return fs.existsSync(path.join(this.baseDir, id))
  }

  getWorktreePath(id: string): string {
    return path.join(this.baseDir, id)
  }

  getBranchName(id: string): string {
    return `worktree/${id}`
  }

  // ── v2 Tasks system (1 Task = 1 worktree under <repo>/.agntspce/tasks/) ──
  // Kept additive: the legacy worktree/<id> flow above stays for the old
  // coordinator path until sessionManager migrates off worktreeHelper.

  getTaskBaseDir(): string {
    return path.join(this.repoPath, '.agntspce', 'tasks')
  }

  getTaskWorktreePath(taskId: string): string {
    return path.join(this.getTaskBaseDir(), taskId)
  }

  static sanitizeTaskSlug(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
    return slug
  }

  /** True when `cwd` is inside a git working tree. Quiet by design: this is a
   *  capability probe for folders that may not be repos at all, so it must not
   *  print `fatal: not a git repository` into the host terminal. */
  static isGitRepository(cwd: string): boolean {
    try {
      const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim()
      return out === 'true'
    } catch {
      return false
    }
  }

  /** True when the repo has at least one commit. `git worktree add -b` cannot
   *  branch from an unborn HEAD, so a freshly `git init`-ed folder is a repo but
   *  still cannot host worktrees. */
  static hasCommits(cwd: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      })
      return true
    } catch {
      return false
    }
  }

  buildTaskBranchName(taskId: string, slug: string): string {
    const short = taskId.replace(/-/g, '').slice(0, 8)
    return `task/${slug}-${short}`
  }

  private branchExists(branchName: string): boolean {
    try {
      this.execGit(['rev-parse', '--verify', branchName])
      return true
    } catch {
      return false
    }
  }

  deduplicateBranchName(base: string): string {
    if (!this.branchExists(base)) return base
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`
      if (!this.branchExists(candidate)) return candidate
    }
    throw new Error(`Could not find a free branch name for base: ${base}`)
  }

  private listWorktreePaths(): Map<string, string> {
    // Returns map of worktree path -> branch (from `git worktree list --porcelain`).
    const out = new Map<string, string>()
    try {
      const raw = this.execGit(['worktree', 'list', '--porcelain'])
      let currentPath = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch ') && currentPath) {
          out.set(currentPath, line.slice('branch '.length).trim().replace('refs/heads/', ''))
          currentPath = ''
        } else if (line === '' ) currentPath = ''
      }
    } catch {}
    return out
  }

  private pruneWorktrees(): void {
    try {
      this.execGit(['worktree', 'prune'])
    } catch {}
  }

  createTaskWorktree(taskId: string, slug: string, sourceRef: string): WorktreeResult {
    const cleanSlug = WorktreeLifecycle.sanitizeTaskSlug(slug)
    const branchName = this.deduplicateBranchName(this.buildTaskBranchName(taskId, cleanSlug))
    const worktreePath = this.getTaskWorktreePath(taskId)

    fs.mkdirSync(this.getTaskBaseDir(), { recursive: true })
    this.ensureTasksIgnored()

    if (fs.existsSync(worktreePath)) {
      // Adopt the existing path if git already tracks it (race/retry safe).
      const tracked = this.listWorktreePaths().get(path.resolve(worktreePath))
      if (tracked) {
        const branchPoint = this.execGit(['rev-parse', sourceRef])
        return { worktreePath, branchName: tracked, branchPoint }
      }
      throw new Error(`Task worktree path already exists: ${worktreePath}`)
    }

    const branchPoint = this.execGit(['rev-parse', sourceRef])
    this.pruneWorktrees()

    try {
      this.execGit(['worktree', 'add', '-b', branchName, worktreePath, branchPoint])
    } catch (err: any) {
      const msg = (err as Error)?.message || ''
      if (/already exists|already used|already checked out/i.test(msg)) {
        const tracked = this.listWorktreePaths().get(path.resolve(worktreePath))
        if (tracked) return { worktreePath, branchName: tracked, branchPoint }
      }
      throw err
    }

    return { worktreePath, branchName, branchPoint }
  }

  removeTaskWorktree(taskId: string, integrationBranch?: string): void {
    const worktreePath = this.getTaskWorktreePath(taskId)
    let branchName: string | null = null
    try {
      branchName = this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
    } catch {}

    if (fs.existsSync(worktreePath)) {
      try {
        this.execGit(['worktree', 'remove', worktreePath])
      } catch {
        try {
          this.execGit(['worktree', 'remove', '--force', worktreePath])
        } catch {}
      }
      // `worktree remove` deletes the directory; rmSync clears any leftovers
      // if git left the path behind without registering an error.
      try { fs.rmSync(worktreePath, { recursive: true, force: true }) } catch {}
    }

    if (branchName && branchName !== 'HEAD') {
      this.deleteTaskBranchIfMerged(branchName, integrationBranch)
    }
    this.pruneWorktrees()
  }

  private deleteTaskBranchIfMerged(branchName: string, integrationBranch?: string): void {
    if (!integrationBranch) return
    try {
      this.execGit(['merge-base', '--is-ancestor', branchName, integrationBranch])
      this.execGit(['branch', '-D', branchName])
    } catch {
      // Unmerged (or missing) — keep it so the work survives.
    }
  }

  taskWorktreeExists(taskId: string): boolean {
    return fs.existsSync(this.getTaskWorktreePath(taskId))
  }

  /** Keep task worktrees out of `git status`: the worktree dir contains a
   *  `.git` pointer file, which git otherwise reports as an embedded repo.
   *  Appends `.agntspce/` (whole dir is machine-local state: db, logs, tasks)
   *  to the repo's .gitignore when no covering pattern exists. Idempotent. */
  ensureTasksIgnored(): void {
    const gitignorePath = path.join(this.repoPath, '.gitignore')
    let content = ''
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8')
    } catch {
      content = ''
    }
    const covered = content.split('\n').some(line => {
      const t = line.trim()
      return t === '.agntspce/' || t === '.agntspce' || t === '/.agntspce/' || t === '/.agntspce'
    })
    if (covered) return
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
    const suffix = '\n'
    fs.writeFileSync(gitignorePath, `${content}${prefix}.agntspce/${suffix}`, 'utf-8')
  }

  // v2 in-repo mode: same branch semantics as task worktrees but checked out
  // in the main repo instead of a detached worktree. Named distinctly from the
  // legacy createInRepoBranch/cleanupInRepoTaskBranch (worktree/<id> naming),
  // which stay untouched for the old coordinator path.
  createTaskBranchInRepo(branchName: string, sourceRef: string): void {
    try {
      this.execGit(['branch', '-D', branchName])
    } catch {}
    this.execGit(['branch', branchName, sourceRef])
    this.execGit(['checkout', branchName])
  }

  cleanupTaskBranchInRepo(branchName: string, integrationBranch: string): void {
    try {
      this.execGit(['checkout', integrationBranch])
    } catch {}
    try {
      this.execGit(['branch', '-D', branchName])
    } catch {}
  }

  cleanupScratchWorktrees(): void {
    if (!fs.existsSync(this.baseDir)) return
    for (const entry of fs.readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('scratch-')) continue
      this.removeScratchWorktree(path.join(this.baseDir, entry.name))
    }
  }

  // 5.1 crash recovery: remove task worktrees whose task is no longer active
  // (done / abandoned / missing). Follows the merged-branch-only rule so an
  // unmerged branch's work survives. Returns the count removed.
  sweepOrphanWorktrees(activeTaskIds: Set<string>, integrationBranch?: string): number {
    if (!fs.existsSync(this.baseDir)) return 0
    let removed = 0
    for (const entry of fs.readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('scratch-')) continue
      const taskId = entry.name
      if (activeTaskIds.has(taskId)) continue
      try {
        this.removeWorktree(taskId, integrationBranch)
        removed++
      } catch {}
    }
    return removed
  }
}
