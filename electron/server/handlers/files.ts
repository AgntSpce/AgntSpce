import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import path from 'node:path'
import fs from 'node:fs/promises'

function resolveWorkspaceRoot(ctx: ServerContext): string {
  const ws = ctx.workspaceManager.getActiveWorkspace()
  if (!ws?.repository?.path) return ''
  return path.resolve(ws.repository.path)
}

function isPathInWorkspace(ctx: ServerContext, targetPath: string): boolean {
  const root = resolveWorkspaceRoot(ctx)
  if (!root) return false
  const resolvedTarget = path.resolve(targetPath)
  return resolvedTarget === root || resolvedTarget.startsWith(root + path.sep)
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

export function registerFileHandlers(ctx: ServerContext, socket: Socket): void {
  socket.on('get-workspace-tree', async ({ worktreePath }: { worktreePath: string }, callback?: Function) => {
    try {
      if (!isPathInWorkspace(ctx, worktreePath)) {
        if (callback) callback({ ok: false, error: 'Path is outside the workspace' })
        return
      }
      const root = await getRepoRoot(worktreePath)
      async function readDir(dirPath: string, relativeRoot: string): Promise<any[]> {
        const entries: any[] = []
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
        dirEntries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        for (const entry of dirEntries) {
          if (entry.name.startsWith('.')) continue
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
      const stat = await fs.stat(absolutePath)
      if (stat.isDirectory()) {
        await fs.rm(absolutePath, { recursive: true, force: true })
      } else {
        await fs.unlink(absolutePath)
      }
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
