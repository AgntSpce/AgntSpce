import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'

/** App-internal, gitignored metadata dir: coordinator db, logs, task worktrees. */
const AGNTSPCE_META_DIR = '.agntspce'

function resolveWorkspaceRoot(ctx: ServerContext): string {
  const ws = ctx.workspaceManager.getActiveWorkspace()
  if (!ws?.repository?.path) return ''
  return path.resolve(ws.repository.path)
}

/**
 * True only for paths inside a workspace the user has actually added. The
 * sidebar renders a tree per workspace row, so this must accept EVERY workspace,
 * not just the active one — scoping it to the active root made expanding any
 * other workspace fail the guard outright.
 *
 * Traversal protection is unchanged in spirit: the allow-list is still exactly
 * the user's own workspace roots, so `..` cannot escape one.
 */
function isPathInWorkspace(ctx: ServerContext, targetPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath)
  let roots: string[] = []
  try {
    roots = (ctx.workspaceManager.listWorkspaces() || [])
      .filter(ws => ws?.repository?.path)
      .map(ws => path.resolve(ws.repository!.path!))
  } catch { roots = [] }
  if (roots.length === 0) {
    const active = resolveWorkspaceRoot(ctx)
    if (active) roots = [active]
  }
  return roots.some(root => resolvedTarget === root || resolvedTarget.startsWith(root + path.sep))
}

async function getRepoRoot(wsPath: string): Promise<string> {
  try {
    const { spawnSync } = await import('child_process')
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: wsPath, encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim()
    }
    return wsPath
  } catch {
    return wsPath
  }
}

// ── Per-workspace file trash (recycle bin) ─────────────────────────────
// Explorer deletes move here instead of unlinking, so files stay
// recoverable. One trash dir per workspace id under the app userData dir,
// plus a small JSON index describing each entry.
interface TrashEntry {
  id: string
  name: string
  relPath: string
  absolutePath: string
  storedName: string
  isDirectory: boolean
  deletedAt: string
}

function sanitizeTrashId(wsId: string): string {
  return String(wsId || 'default').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80) || 'default'
}

function trashDirFor(wsId: string): string {
  return path.join(app.getPath('userData'), 'trash', sanitizeTrashId(wsId))
}

function trashIndexPath(wsId: string): string {
  return path.join(trashDirFor(wsId), 'index.json')
}

async function readTrashIndex(wsId: string): Promise<TrashEntry[]> {
  try {
    const raw = await fs.readFile(trashIndexPath(wsId), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeTrashIndex(wsId: string, entries: TrashEntry[]): Promise<void> {
  await fs.mkdir(trashDirFor(wsId), { recursive: true })
  await fs.writeFile(trashIndexPath(wsId), JSON.stringify(entries, null, 2), 'utf-8')
}

// Stored file must stay inside its workspace trash dir (guards a tampered index).
function trashStoredPath(wsId: string, storedName: string): string | null {
  const dir = trashDirFor(wsId)
  const resolved = path.resolve(dir, storedName)
  if (resolved === dir || !resolved.startsWith(dir + path.sep)) return null
  return resolved
}

// Move that also works across volumes (rename fails with EXDEV there).
async function movePath(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  try {
    await fs.rename(src, dest)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    await fs.cp(src, dest, { recursive: true })
    await fs.rm(src, { recursive: true, force: true })
  }
}

export function registerFileHandlers(ctx: ServerContext, socket: Socket): void {
  socket.on('get-workspace-tree', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, worktreePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      // Root the tree at EXACTLY the requested path. The client joins its own
      // `workspacePath` onto the relative paths we return, so if we silently
      // climbed to a parent git root the client would build absolute paths
      // that point somewhere else entirely — which the workspace guard then
      // rejects as "Path is outside the workspace". That is what broke opening
      // a task's worktree.
      const root = path.resolve(worktreePath)
      async function readDir(dirPath: string, relativeRoot: string): Promise<any[]> {
        const entries: any[] = []
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
        dirEntries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        for (const entry of dirEntries) {
          // Hidden files and folders ARE shown. The exceptions are tool
          // internals that aren't the user's project: `.agntspce` (app state —
          // coordinator db, logs, and every OTHER task's worktree) and `.git`
          // (VCS object store). Both would otherwise flood the tree with
          // folders the user never meant to see.
          if (entry.name === AGNTSPCE_META_DIR || entry.name === '.git') continue
          const fullPath = path.join(dirPath, entry.name)
          const relativePath = path.relative(relativeRoot, fullPath).replace(/\\/g, '/')
          if (entry.isDirectory()) {
            const children = await readDir(fullPath, relativeRoot)
            entries.push({ name: entry.name, path: relativePath, type: 'directory', children })
          } else {
            entries.push({ name: entry.name, path: relativePath, type: 'file' })
          }
        }
        return entries
      }
      const tree = await readDir(root, root)
      if (callback) callback({ ok: true, tree, root })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error?.message || String(error) })
    }
  })

  socket.on('read-file', async ({ absolutePath }: { absolutePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, absolutePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      const stat = await fs.stat(absolutePath)
      if (stat.isDirectory()) {
        if (callback) callback({ ok: false, error: 'Is a directory' })
        return
      }
      const content = await fs.readFile(absolutePath, 'utf-8')
      if (callback) callback({ ok: true, content })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('write-file', async ({ absolutePath, content }: { absolutePath: string, content: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, absolutePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      await fs.writeFile(absolutePath, content, 'utf-8')
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('create-file', async ({ absolutePath }: { absolutePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, absolutePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      try {
        const existing = await fs.stat(absolutePath)
        if (existing) {
          if (callback) callback({ ok: false, error: 'A file or folder with this name already exists' })
          return
        }
      } catch {}
      await fs.writeFile(absolutePath, '', 'utf-8')
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('create-folder', async ({ absolutePath }: { absolutePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, absolutePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      try {
        const existing = await fs.stat(absolutePath)
        if (existing) {
          if (callback) callback({ ok: false, error: 'A file or folder with this name already exists' })
          return
        }
      } catch {}
      await fs.mkdir(absolutePath, { recursive: true })
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('rename-file', async ({ oldPath, newPath }: { oldPath: string, newPath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, oldPath) || !isPathInWorkspace(ctx, newPath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      await fs.rename(oldPath, newPath)
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('delete-file', async ({ absolutePath }: { absolutePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, absolutePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      const resolved = path.resolve(absolutePath)
      const stat = await fs.stat(resolved)
      const wsId = ctx.workspaceManager.getActiveWorkspace()?.id || 'default'
      const dir = trashDirFor(wsId)
      await fs.mkdir(dir, { recursive: true })
      const root = await getRepoRoot(path.dirname(resolved))
      const relPath = path.relative(root, resolved).replace(/\\/g, '/')
      const base = path.basename(resolved) || 'item'
      const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`
      const entry: TrashEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: base,
        relPath,
        absolutePath: resolved,
        storedName,
        isDirectory: stat.isDirectory(),
        deletedAt: new Date().toISOString(),
      }
      await movePath(resolved, path.join(dir, storedName))
      const entries = await readTrashIndex(wsId)
      entries.unshift(entry)
      await writeTrashIndex(wsId, entries)
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('trash-list', async ({ workspaceId }: { workspaceId: string }, callback?: Function) => {
    try {
      const wsId = sanitizeTrashId(workspaceId)
      const entries = await readTrashIndex(wsId)
      // Self-heal: drop index rows whose stored file is gone.
      const kept: TrashEntry[] = []
      for (const e of entries) {
        const stored = trashStoredPath(wsId, e.storedName)
        if (!stored) continue
        try {
          await fs.stat(stored)
          kept.push(e)
        } catch {}
      }
      if (kept.length !== entries.length) await writeTrashIndex(wsId, kept)
      if (callback) callback({ ok: true, entries: kept })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('trash-restore', async ({ workspaceId, id }: { workspaceId: string; id: string }, callback?: Function) => {
    try {
      const wsId = sanitizeTrashId(workspaceId)
      const entries = await readTrashIndex(wsId)
      const idx = entries.findIndex(e => e.id === id)
      if (idx < 0) {
        if (callback) callback({ ok: false, error: 'Trash entry not found' })
        return
      }
      const entry = entries[idx]
      if (!isPathInWorkspace(ctx, entry.absolutePath)) {
        if (callback) callback({ ok: false, error: 'Original location is outside the workspace' })
        return
      }
      const stored = trashStoredPath(wsId, entry.storedName)
      if (!stored) {
        if (callback) callback({ ok: false, error: 'Invalid trash entry' })
        return
      }
      try {
        await fs.stat(stored)
      } catch {
        if (callback) callback({ ok: false, error: 'Trashed file is missing' })
        return
      }
      // Never overwrite: find a free sibling name when something is back there.
      let target = entry.absolutePath
      try {
        await fs.stat(target)
        const dirn = path.dirname(target)
        const ext = path.extname(entry.name)
        const stem = path.basename(entry.name, ext)
        let n = 1
        for (;;) {
          const candidate = path.join(dirn, `${stem} (restored${n > 1 ? ` ${n}` : ''})${ext}`)
          try {
            await fs.stat(candidate)
            n++
          } catch {
            target = candidate
            break
          }
        }
      } catch {}
      await movePath(stored, target)
      entries.splice(idx, 1)
      await writeTrashIndex(wsId, entries)
      if (callback) callback({ ok: true, restoredPath: target })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('trash-delete', async ({ workspaceId, id }: { workspaceId: string; id: string }, callback?: Function) => {
    try {
      const wsId = sanitizeTrashId(workspaceId)
      const entries = await readTrashIndex(wsId)
      const idx = entries.findIndex(e => e.id === id)
      if (idx < 0) {
        if (callback) callback({ ok: false, error: 'Trash entry not found' })
        return
      }
      const stored = trashStoredPath(wsId, entries[idx].storedName)
      if (stored) {
        try { await fs.rm(stored, { recursive: true, force: true }) } catch {}
      }
      entries.splice(idx, 1)
      await writeTrashIndex(wsId, entries)
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('trash-empty', async ({ workspaceId }: { workspaceId: string }, callback?: Function) => {
    try {
      const wsId = sanitizeTrashId(workspaceId)
      await fs.rm(trashDirFor(wsId), { recursive: true, force: true })
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('get-file-info', async ({ absolutePath }: { absolutePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, absolutePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      const root = resolveWorkspaceRoot(ctx)
      const resolved = path.resolve(absolutePath)
      const stat = await fs.stat(resolved)
      const birthMs = stat.birthtimeMs || (stat as any).ctimeMs || 0
      const info: Record<string, any> = {
        name: path.basename(resolved),
        absolutePath: resolved,
        relativePath: root ? path.relative(root, resolved).replace(/\\/g, '/') : path.basename(resolved),
        type: stat.isDirectory() ? 'directory' : 'file',
        sizeBytes: stat.isDirectory() ? 0 : stat.size,
        createdAt: birthMs ? new Date(birthMs).toISOString() : null,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        accessedAt: new Date(stat.atimeMs).toISOString(),
      }
      if (stat.isFile()) {
        const ext = path.extname(resolved)
        if (ext) info.extension = ext
      } else {
        // Directory rollup: immediate breakdown + recursive totals.
        // Dotfiles skipped (matches get-workspace-tree); entry cap keeps
        // huge trees (node_modules) from stalling the stat call.
        const MAX_ENTRIES = 20000
        let immediateFiles = 0
        let immediateDirs = 0
        let totalFiles = 0
        let totalDirs = 0
        let totalSize = 0
        let visited = 0
        let truncated = false
        const stack: { dir: string; immediate: boolean }[] = [{ dir: resolved, immediate: true }]
        while (stack.length > 0) {
          const { dir, immediate } = stack.pop()!
          let entries
          try {
            entries = await fs.readdir(dir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue
            if (++visited > MAX_ENTRIES) { truncated = true; break }
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (immediate) immediateDirs++
              totalDirs++
              stack.push({ dir: full, immediate: false })
            } else if (entry.isFile()) {
              if (immediate) immediateFiles++
              totalFiles++
              try {
                totalSize += (await fs.stat(full)).size
              } catch {}
            }
          }
          if (truncated) break
        }
        info.immediateFiles = immediateFiles
        info.immediateDirs = immediateDirs
        info.totalFiles = totalFiles
        info.totalDirs = totalDirs
        info.totalSizeBytes = totalSize
        info.truncated = truncated
      }
      if (callback) callback({ ok: true, info })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })
}
