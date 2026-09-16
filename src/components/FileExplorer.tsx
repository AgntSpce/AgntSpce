import { useState, useEffect, useCallback } from 'react'
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
  showModal: (title: string, onSubmit: (value: string) => void, defaultValue?: string) => void
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
  showModal,
  createFile,
  createFolder,
  renameFile,
  deleteFile,
}: FileExplorerProps) {
  const [treeData, setTreeData] = useState<FileTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    const oldName = targetPath.split('/').pop() || ''
    // Native prompt() is a no-op in Electron — use the app's input modal.
    showModal('Rename to:', (newName) => {
      const trimmed = newName.trim()
      if (!trimmed || trimmed === oldName) return
      const parentPath = targetPath.slice(0, targetPath.lastIndexOf('/'))
      const newPath = parentPath ? `${parentPath}/${trimmed}` : trimmed
      const absOldPath = workspacePath.replace(/\\/g, '/') + '/' + targetPath
      const absNewPath = workspacePath.replace(/\\/g, '/') + '/' + newPath
      renameFile(absOldPath, absNewPath).then((res: any) => {
        if (res?.ok) loadTree()
      })
    }, oldName)
    closeContextMenu()
  }, [contextMenu, workspacePath, renameFile, loadTree, closeContextMenu, showModal])

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
    const basePath = contextMenu
      ? workspacePath.replace(/\\/g, '/') + '/' + (contextMenu.isDirectory ? contextMenu.targetPath : contextMenu.targetPath.split('/').slice(0, -1).join('/'))
      : workspacePath.replace(/\\/g, '/')
    showModal('File name:', (name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      createFile(`${basePath}/${trimmed}`).then((res: any) => {
        if (res?.ok) loadTree()
      })
    })
    closeContextMenu()
  }, [contextMenu, workspacePath, createFile, loadTree, closeContextMenu, showModal])

  const handleNewFolder = useCallback(() => {
    const basePath = contextMenu
      ? workspacePath.replace(/\\/g, '/') + '/' + (contextMenu.isDirectory ? contextMenu.targetPath : contextMenu.targetPath.split('/').slice(0, -1).join('/'))
      : workspacePath.replace(/\\/g, '/')
    showModal('Folder name:', (name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      createFolder(`${basePath}/${trimmed}`).then((res: any) => {
        if (res?.ok) loadTree()
      })
    })
    closeContextMenu()
  }, [contextMenu, workspacePath, createFolder, loadTree, closeContextMenu, showModal])

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
