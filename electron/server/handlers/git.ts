import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WorktreeLifecycle } from '../../services/orchestration/worktreeLifecycle'

export function registerGitHandlers(ctx: ServerContext, socket: Socket): void {
  socket.on('get-git-log', async ({ worktreePath, maxCount }: { worktreePath: string, maxCount?: number }, callback?: Function) => {
    try {
      const log = await ctx.gitHelper.getLog(worktreePath, maxCount)
      callback?.({ ok: true, log })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-diff', async ({ worktreePath, base, head }: { worktreePath: string, base?: string, head?: string }, callback?: Function) => {
    try {
      const diff = await ctx.gitHelper.getDiff(worktreePath, base, head)
      callback?.({ ok: true, diff })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-branches', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const branches = await ctx.gitHelper.getBranches(worktreePath)
      callback?.({ ok: true, branches })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-working-tree-diff', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const diff = await ctx.gitHelper.getWorkingTreeDiff(worktreePath)
      callback?.({ ok: true, diff })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-commit-files', async ({ worktreePath, commitHash }: { worktreePath: string, commitHash: string }, callback?: Function) => {
    try {
      const files = await ctx.gitHelper.getCommitFiles(worktreePath, commitHash)
      callback?.({ ok: true, files })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-working-tree-files', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const files = await ctx.gitHelper.getWorkingTreeFiles(worktreePath)
      callback?.({ ok: true, files })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-file-diff', async ({ worktreePath, filePath, base, head }: { worktreePath: string, filePath: string, base?: string, head?: string }, callback?: Function) => {
    try {
      const diff = await ctx.gitHelper.getFileDiff(worktreePath, filePath, base, head)
      callback?.({ ok: true, diff })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-git-full-status', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const status = await ctx.gitHelper.getFullStatus(worktreePath)
      callback?.({ ok: true, status })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-revert-file', async ({ worktreePath, filePath }: { worktreePath: string, filePath: string }, callback?: Function) => {
    try {
      const ok = await ctx.gitHelper.revertFile(worktreePath, filePath)
      callback?.({ ok })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-stage-file', async ({ worktreePath, filePath }: { worktreePath: string, filePath: string }, callback?: Function) => {
    try {
      const ok = await ctx.gitHelper.stageFile(worktreePath, filePath)
      callback?.({ ok })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-unstage-file', async ({ worktreePath, filePath }: { worktreePath: string, filePath: string }, callback?: Function) => {
    try {
      const ok = await ctx.gitHelper.unstageFile(worktreePath, filePath)
      callback?.({ ok })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-stage-all', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const ok = await ctx.gitHelper.stageAll(worktreePath)
      callback?.({ ok })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-unstage-all', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const ok = await ctx.gitHelper.unstageAll(worktreePath)
      callback?.({ ok })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-commit', async ({ worktreePath, message }: { worktreePath: string, message: string }, callback?: Function) => {
    try {
      const result = await ctx.gitHelper.commit(worktreePath, message)
      callback?.(result)
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-pull', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const result = await ctx.gitHelper.pull(worktreePath)
      callback?.(result)
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-push', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const result = await ctx.gitHelper.push(worktreePath)
      callback?.(result)
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-fetch', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const result = await ctx.gitHelper.fetch(worktreePath)
      callback?.(result)
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('git-discard-all', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      const ok = await ctx.gitHelper.discardAll(worktreePath)
      callback?.({ ok })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  // ── Workspace git readiness ────────────────────────────────────────────
  // A workspace folder is not required to be a git repo, but tasks need one:
  // `git worktree add` cannot branch from an empty repository, so "is this a
  // repo" and "does it have a commit" are two separate questions the consent
  // dialog needs answered before it can promise isolation.

  function resolveFolderPath(workspaceId?: string, repoPath?: string): string | null {
    const pinned = (repoPath ?? '').trim()
    if (pinned && fs.existsSync(pinned)) return pinned
    const ws = workspaceId ? ctx.workspaceManager.getWorkspace(workspaceId) : ctx.workspaceManager.getActiveWorkspace()
    const path = ws?.repository?.path
    return path && fs.existsSync(path) ? path : null
  }

  socket.on('check-git-repo', async ({ workspaceId, repoPath }: { workspaceId?: string; repoPath?: string }, callback?: Function) => {
    try {
      const folder = resolveFolderPath(workspaceId, repoPath)
      if (!folder) return callback?.({ ok: false, error: 'Workspace folder not found' })
      callback?.({ ok: true, path: folder, ...inspectGitFolder(folder) })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('init-git-repo', async ({ workspaceId, repoPath }: { workspaceId?: string; repoPath?: string }, callback?: Function) => {
    try {
      const folder = resolveFolderPath(workspaceId, repoPath)
      if (!folder) return callback?.({ ok: false, error: 'Workspace folder not found' })
      if (WorktreeLifecycle.isGitRepository(folder)) {
        // Already a repo — only the first commit may still be missing.
        const state = inspectGitFolder(folder)
        if (state.hasCommits) return callback?.({ ok: true, alreadyRepo: true, ...state })
      }
      const result = initGitFolder(folder)
      callback?.({ ok: true, ...result, ...inspectGitFolder(folder) })
      ctx.io.emit('workspace-changed', { workspaceId: workspaceId ?? '' })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })
}

/** Read-only look at a folder's git readiness. All probes are stderr-quiet so
 *  a non-repo folder never prints `fatal:` into the host terminal. */
export function inspectGitFolder(folder: string): {
  isRepo: boolean
  hasCommits: boolean
  /** True when the repo holds no real project files yet - only dotfiles such as
   *  the `.gitignore` and `.mcp.json` written when we initialized it. Verified
   *  case: a brand-new folder's initial commit was `.gitignore` + `.mcp.json`,
   *  so the task worktree was a near-empty checkout and isolation bought
   *  nothing while hiding the agent's output. Isolation is only worth its cost
   *  once there is something to protect. */
  isFresh: boolean
  branch: string | null
} {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: folder, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    } catch {
      return null
    }
  }
  const isRepo = run(['rev-parse', '--is-inside-work-tree']) === 'true'
  if (!isRepo) return { isRepo: false, hasCommits: false, isFresh: true, branch: null }
  const head = run(['rev-parse', '--verify', 'HEAD'])
  const branch = run(['symbolic-ref', '--short', 'HEAD'])
  // Tracked paths at HEAD; a repo of nothing but dotfiles counts as fresh.
  const tracked = run(['ls-tree', '-r', '--name-only', 'HEAD'])
  const paths = tracked ? tracked.split('\n').map(s => s.trim()).filter(Boolean) : []
  const isFresh = paths.length === 0 || paths.every(p => p.startsWith('.'))
  return { isRepo: true, hasCommits: !!head, isFresh, branch: branch || null }
}

/** `git init` + first commit.
 *
 *  The first commit is not optional: `git worktree add -b <branch>` needs a
 *  commit to branch from, which is why a freshly initialized folder used to
 *  fall through to the empty-directory path. Existing `.gitignore` is honoured
 *  and `.agntspce/` (our own DB, logs and task dirs) is always excluded, since
 *  it contains a `.git` pointer file git would otherwise flag as an embedded
 *  repository. Nothing is pushed anywhere — this is a local repo only. */
export function initGitFolder(folder: string): { created: boolean; committedFiles: number } {
  const run = (args: string[], input?: string): string => execFileSync('git', args, {
    cwd: folder, encoding: 'utf-8', timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'], input,
  }).toString().trim()

  const alreadyRepo = WorktreeLifecycle.isGitRepository(folder)
  if (!alreadyRepo) {
    run(['init', '-b', 'main'])
  } else if (WorktreeLifecycle.hasCommits(folder)) {
    // Already a real repo with history. Never stage or commit here — this
    // function's job is to make a folder *usable* by worktrees, not to record
    // whatever the user happens to have lying around.
    return { created: false, committedFiles: 0 }
  }

  const ignorePath = path.join(folder, '.gitignore')
  const current = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf-8') : ''
  const covered = current.split('\n').some(line => {
    const t = line.trim()
    return t === '.agntspce/' || t === '.agntspce' || t === '/.agntspce/' || t === '/.agntspce'
  })
  if (!covered) {
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(ignorePath, `${current}${prefix}.agntspce/\n`, 'utf-8')
  }

  run(['add', '-A'])
  const staged = run(['diff', '--cached', '--name-only'])
  const committedFiles = staged ? staged.split('\n').filter(Boolean).length : 0
  if (committedFiles > 0) {
    run(['-c', 'user.name=AgntSpce', '-c', 'user.email=agntspce@localhost', 'commit', '-m', 'Initial commit'])
  }
  return { created: !alreadyRepo, committedFiles }
}
