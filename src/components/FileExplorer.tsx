import { useState, useEffect, useCallback, useRef } from 'react'
import type { FileTreeNode } from '../types'
import { FileTree } from './FileTree'
import { copyToClipboard } from '../utils/clipboard'

// Keep floating menus on-screen: clamp the click point so the ~220px-wide
// menu never renders off the right/bottom edge (where items'd be unclickable).
function clampContextMenuPos(x: number, y: number, estW = 230, estH = 340) {
  return {
    x: Math.max(4, Math.min(x, Math.max(4, window.innerWidth - estW))),
    y: Math.max(4, Math.min(y, Math.max(4, window.innerHeight - estH))),
  }
}

interface FileExplorerProps {
  workspacePath: string
  selectedFilePath: string | null
  selectedFolderPath?: string | null
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  onSelectFile: (path: string) => void
  onSelectFolder?: (path: string) => void
  refreshSignal?: number
  getWorkspaceTree: (worktreePath: string) => Promise<any>
  getFileInfo: (absolutePath: string) => Promise<any>
  /** External creation trigger (workspace-level menu): consumed once per nonce. */
  createRequest?: { type: 'file' | 'folder'; nonce: number } | null
  onCreateRequestHandled?: (nonce: number) => void
  createFile: (absolutePath: string) => Promise<any>
  createFolder: (absolutePath: string) => Promise<any>
  renameFile: (oldPath: string, newPath: string) => Promise<any>
  deleteFile: (absolutePath: string) => Promise<any>
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString()
}

export function FileExplorer({
  workspacePath,
  selectedFilePath,
  selectedFolderPath,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onSelectFolder,
  refreshSignal,
  getWorkspaceTree,
  getFileInfo,
  createRequest = null,
  onCreateRequestHandled,
  createFile,
  createFolder,
  renameFile,
  deleteFile,
}: FileExplorerProps) {
  const [treeData, setTreeData] = useState<FileTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ type: 'file' | 'folder'; parentPath: string; name: string } | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const renamingRef = useRef(renaming)
  renamingRef.current = renaming
  // Briefly glow the row that was just created so its landing spot is obvious.
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const justCreatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (justCreatedTimerRef.current) clearTimeout(justCreatedTimerRef.current)
  }, [])
  const flashCreated = useCallback((relPath: string) => {
    setJustCreated(relPath)
    if (justCreatedTimerRef.current) clearTimeout(justCreatedTimerRef.current)
    justCreatedTimerRef.current = setTimeout(() => {
      justCreatedTimerRef.current = null
      setJustCreated(null)
    }, 2200)
  }, [])
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    targetPath: string
    isDirectory: boolean
  } | null>(null)

  const loadTree = useCallback(async () => {
    if (!workspacePath) return
    setLoading(true)
    setError(null)
    try {
      const res = await getWorkspaceTree(workspacePath)
      if (res?.ok) {
        setTreeData(res.tree)
      } else {
        setError(res?.error || 'Failed to load tree')
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load tree')
    } finally {
      setLoading(false)
    }
  }, [workspacePath, getWorkspaceTree])

  useEffect(() => {
    loadTree()
  }, [loadTree, refreshSignal])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // VS Code-style inline creation: commit the pending row (Enter/blur),
  // clearing first so double-fires (Enter + blur) are no-ops.
  const commitPending = useCallback(() => {
    const p = pendingRef.current
    if (!p) return
    setPending(null)
    const name = p.name.trim()
    if (!name) return
    const base = workspacePath.replace(/\\/g, '/') + (p.parentPath ? '/' + p.parentPath : '')
    const run = p.type === 'file' ? createFile(`${base}/${name}`) : createFolder(`${base}/${name}`)
    run.then((res: any) => {
      if (res?.ok) {
        if (p.parentPath && !expandedFolders.has(p.parentPath)) onToggleFolder(p.parentPath)
        flashCreated(p.parentPath ? `${p.parentPath}/${name}` : name)
        loadTree()
      }
    })
  }, [workspacePath, createFile, createFolder, expandedFolders, onToggleFolder, loadTree, flashCreated])

  const cancelPending = useCallback(() => {
    setPending(null)
  }, [])

  // VS Code-style inline rename: Enter/blur commits (clearing first so the
  // pair can't double-fire), Esc or unchanged/empty/slashed names cancel.
  // The committed name comes straight from the input (ground truth), and
  // backend failures surface instead of failing silently. The refresh
  // re-sorts, so a renamed item glides to its new alpha slot.
  const commitRename = useCallback((name: string) => {
    const r = renamingRef.current
    if (!r) return
    setRenaming(null)
    const trimmed = name.trim()
    const oldName = r.path.split('/').pop() || ''
    if (!trimmed || trimmed === oldName || trimmed.includes('/')) return
    // lastIndexOf returns -1 for root-level items — slice(0, -1) would chop
    // the last char ('1.html' -> parent '1.htm'), so guard explicitly.
    const sep = r.path.lastIndexOf('/')
    const parentPath = sep >= 0 ? r.path.slice(0, sep) : ''
    const newRelPath = parentPath ? `${parentPath}/${trimmed}` : trimmed
    const wsRoot = workspacePath.replace(/\\/g, '/')
    renameFile(`${wsRoot}/${r.path}`, `${wsRoot}/${newRelPath}`).then((res: any) => {
      if (res?.ok) {
        flashCreated(newRelPath)
        loadTree()
      } else {
        alert(`Could not rename "${oldName}"${res?.error ? `: ${res.error}` : '.'}`)
      }
    }).catch(() => {
      alert(`Could not rename "${oldName}".`)
    })
  }, [workspacePath, renameFile, loadTree, flashCreated])

  const cancelRename = useCallback(() => {
    setRenaming(null)
  }, [])

  // Workspace-level menu trigger: create at the tree root.
  const handledCreateNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (createRequest && handledCreateNonceRef.current !== createRequest.nonce) {
      handledCreateNonceRef.current = createRequest.nonce
      setPending({ type: createRequest.type, parentPath: '', name: '' })
      onCreateRequestHandled?.(createRequest.nonce)
    }
  }, [createRequest, onCreateRequestHandled])

  useEffect(() => {
    if (contextMenu) {
      const handler = () => closeContextMenu()
      document.addEventListener('click', handler)
      return () => document.removeEventListener('click', handler)
    }
  }, [contextMenu, closeContextMenu])

  const handleRename = useCallback(() => {
    if (!contextMenu) return
    const targetPath = contextMenu.targetPath
    closeContextMenu()
    setPending(null)
    setRenaming({ path: targetPath, name: targetPath.split('/').pop() || '' })
  }, [contextMenu, closeContextMenu])

  const handleDelete = useCallback(() => {
    if (!contextMenu) return
    const name = contextMenu.targetPath.split('/').pop() || ''
    if (confirm(`Delete "${name}"?`)) {
      const absPath = workspacePath.replace(/\\/g, '/') + '/' + contextMenu.targetPath
      deleteFile(absPath).then((res: any) => {
        if (res?.ok) loadTree()
      })
    }
    closeContextMenu()
  }, [contextMenu, workspacePath, deleteFile, loadTree, closeContextMenu])

  const handleNewFile = useCallback(() => {
    if (!contextMenu) return
    const targetPath = contextMenu.targetPath
    const parentPath = contextMenu.isDirectory ? targetPath : targetPath.split('/').slice(0, -1).join('/')
    closeContextMenu()
    if (parentPath && !expandedFolders.has(parentPath)) onToggleFolder(parentPath)
    setPending({ type: 'file', parentPath, name: '' })
  }, [contextMenu, expandedFolders, onToggleFolder, closeContextMenu])

  const handleNewFolder = useCallback(() => {
    if (!contextMenu) return
    const targetPath = contextMenu.targetPath
    const parentPath = contextMenu.isDirectory ? targetPath : targetPath.split('/').slice(0, -1).join('/')
    closeContextMenu()
    if (parentPath && !expandedFolders.has(parentPath)) onToggleFolder(parentPath)
    setPending({ type: 'folder', parentPath, name: '' })
  }, [contextMenu, expandedFolders, onToggleFolder, closeContextMenu])

  const handleInfo = useCallback(() => {
    if (!contextMenu) return
    const targetPath = contextMenu.targetPath
    const isDirectory = contextMenu.isDirectory
    const absPath = workspacePath.replace(/\\/g, '/') + '/' + targetPath
    closeContextMenu()
    getFileInfo(absPath).then((res: any) => {
      if (!res?.ok || !res.info) {
        alert(`Could not load info for "${targetPath}"${res?.error ? `: ${res.error}` : '.'}`)
        return
      }
      const info = res.info
      const lines = [
        `Name: ${info.name}`,
        `Type: ${isDirectory ? 'Folder' : 'File'}`,
      ]
      if (isDirectory) {
        lines.push(`Items: ${info.immediateFiles + info.immediateDirs} (${info.immediateFiles} files, ${info.immediateDirs} folders)`)
        lines.push(`Total contents: ${info.totalFiles} files, ${info.totalDirs} folders, ${formatBytes(info.totalSizeBytes)}${info.truncated ? ' (count capped)' : ''}`)
      } else {
        lines.push(`Size: ${formatBytes(info.sizeBytes)}`)
        if (info.extension) lines.push(`Extension: ${info.extension}`)
      }
      lines.push(`Relative path: ${info.relativePath || targetPath}`)
      lines.push(`Absolute path: ${info.absolutePath}`)
      lines.push(`Created: ${formatDateTime(info.createdAt)}`)
      lines.push(`Modified: ${formatDateTime(info.modifiedAt)}`)
      lines.push(`Accessed: ${formatDateTime(info.accessedAt)}`)
      alert(lines.join('\n'))
    }).catch(() => {
      alert(`Could not load info for "${targetPath}".`)
    })
  }, [contextMenu, workspacePath, getFileInfo, closeContextMenu])

  const handleCopyRelativePath = useCallback(() => {
    if (!contextMenu) return
    copyToClipboard(contextMenu.targetPath)
    closeContextMenu()
  }, [contextMenu, closeContextMenu])

  const handleTreeContextMenu = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    setContextMenu({ x: e.clientX, y: e.clientY, targetPath: path, isDirectory })
  }, [])

  return (
    <div className="file-explorer">
      {loading && <div className="file-tree-loading">Loading...</div>}
      {error && <div className="file-tree-error">{error}</div>}
      {!loading && !error && (
        <FileTree
          nodes={treeData}
          expandedFolders={expandedFolders}
          selectedFilePath={selectedFilePath}
          selectedFolderPath={selectedFolderPath}
          onToggleFolder={onToggleFolder}
          onSelectFile={onSelectFile}
          onSelectFolder={onSelectFolder}
          onContextMenu={handleTreeContextMenu}
          highlightPath={justCreated}
          renaming={renaming ? {
            path: renaming.path,
            name: renaming.name,
            onNameChange: (name: string) => setRenaming(prev => (prev ? { ...prev, name } : prev)),
            onCommit: commitRename,
            onCancel: cancelRename,
          } : null}
          pending={pending ? {
            type: pending.type,
            parentPath: pending.parentPath,
            name: pending.name,
            onNameChange: (name: string) => setPending(prev => (prev ? { ...prev, name } : prev)),
            onCommit: commitPending,
            onCancel: cancelPending,
          } : null}
        />
      )}
      {contextMenu && (() => {
        const pos = clampContextMenuPos(contextMenu.x, contextMenu.y)
        return (
        <div
          className="file-context-menu"
          style={{ left: pos.x, top: pos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="file-context-menu-item" onClick={handleNewFile}>
            <i className="codicon codicon-new-file" style={{ fontSize: 13, marginRight: 6 }} />
            New File
          </button>
          <button className="file-context-menu-item" onClick={handleNewFolder}>
            <i className="codicon codicon-new-folder" style={{ fontSize: 13, marginRight: 6 }} />
            New Folder
          </button>
          <div className="file-context-menu-separator" />
          <button className="file-context-menu-item" onClick={handleRename}>
            <i className="codicon codicon-edit" style={{ fontSize: 13, marginRight: 6 }} />
            Rename
          </button>
          <button className="file-context-menu-item" onClick={handleDelete}>
            <i className="codicon codicon-trash" style={{ fontSize: 13, marginRight: 6 }} />
            Delete
          </button>
          <div className="file-context-menu-separator" />
          <button className="file-context-menu-item" onClick={() => {
            if (contextMenu) {
              const absPath = workspacePath.replace(/\\/g, '/') + '/' + contextMenu.targetPath
              navigator.clipboard.writeText(absPath)
            }
            closeContextMenu()
          }}>
            <i className="codicon codicon-copy" style={{ fontSize: 13, marginRight: 6 }} />
            Copy Path
          </button>
          <button className="file-context-menu-item" onClick={handleCopyRelativePath}>
            <i className="codicon codicon-copy" style={{ fontSize: 13, marginRight: 6 }} />
            Copy Relative Path
          </button>
          <div className="file-context-menu-separator" />
          <button className="file-context-menu-item" onClick={handleInfo}>
            <i className="codicon codicon-info" style={{ fontSize: 13, marginRight: 6 }} />
            Info
          </button>
        </div>
        )
      })()}
    </div>
  )
}
