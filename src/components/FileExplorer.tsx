import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { FileTreeNode } from '../types'
import { FileTree } from './FileTree'
import { copyToClipboard } from '../utils/clipboard'

// A file name counts as typed when it has a non-empty extension part:
// 'notes.txt' yes, 'notes' or 'notes.' no. Leading-dot names (.gitignore,
// .env) are allowed.
function hasFileExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && dot < name.length - 1
}

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
  /** Shared git changed-files for this workspace (from App's poll — connected, not independent). */
  gitStatusFiles?: { filePath: string; status: string }[]
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

type ExplorerGitKind = 'added' | 'modified'

function strongerGitKind(a: ExplorerGitKind | null, b: ExplorerGitKind | null): ExplorerGitKind | null {
  if (a === 'added' || b === 'added') return 'added'
  return a || b
}

// Resolve git colors for every visible tree path. `files` holds
// repo-root-relative porcelain paths; tree paths are workspace-relative, so
// resolution tries, in order: exact match, collapsed untracked-dir prefix
// ('Sub/' colors everything beneath it), then path suffix (covers
// workspaces rooted in a repo subfolder — suffixes keep at least one '/'
// so bare filenames can't false-match across directories).
function buildExplorerGitMap(
  nodes: FileTreeNode[],
  files: { path: string; kind: ExplorerGitKind }[],
): Map<string, ExplorerGitKind> {
  const exact = new Map<string, ExplorerGitKind>()
  const suffix = new Map<string, ExplorerGitKind>()
  const dirPrefixes: { prefix: string; kind: ExplorerGitKind }[] = []
  const put = (map: Map<string, ExplorerGitKind>, p: string, kind: ExplorerGitKind) => {
    map.set(p, strongerGitKind(map.get(p) ?? null, kind)!)
  }
  for (const { path, kind } of files) {
    if (path.endsWith('/')) {
      dirPrefixes.push({ prefix: path, kind })
      continue
    }
    put(exact, path, kind)
    const parts = path.split('/')
    for (let i = 1; i < parts.length - 1; i++) {
      put(suffix, parts.slice(i).join('/'), kind)
    }
  }

  const norm = (p: string) => p.replace(/\\/g, '/')
  const resolveFile = (raw: string): ExplorerGitKind | null => {
    const p = norm(raw)
    const hit = exact.get(p)
    if (hit) return hit
    for (const { prefix, kind } of dirPrefixes) {
      if (p === prefix.slice(0, -1) || p.startsWith(prefix)) return kind
    }
    return suffix.get(p) ?? null
  }

  const out = new Map<string, ExplorerGitKind>()
  const walk = (list: FileTreeNode[]): ExplorerGitKind | null => {
    let acc: ExplorerGitKind | null = null
    for (const n of list) {
      let kind: ExplorerGitKind | null
      if (n.type === 'directory') {
        const below = walk(n.children || [])
        const self = resolveFile(n.path)
        kind = strongerGitKind(self, below)
      } else {
        kind = resolveFile(n.path)
      }
      if (kind) {
        out.set(n.path, strongerGitKind(out.get(n.path) ?? null, kind)!)
        acc = strongerGitKind(acc, kind)
      }
    }
    return acc
  }
  walk(nodes)
  return out
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
  gitStatusFiles,
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
  // Small info card anchored near the right-click point (replaces alert()).
  const [infoPopup, setInfoPopup] = useState<{
    x: number
    y: number
    targetPath: string
    isDirectory: boolean
    info: any | null
    error?: string
  } | null>(null)
  const infoPopupRef = useRef<HTMLDivElement | null>(null)

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

  // Explorer row colors from App's shared git poll (same git truth as the
  // badge count and git review). U/A -> 'added' (green), M -> 'modified'
  // (yellow). Just-created paths are optimistically marked added so new
  // files light up instantly instead of waiting for the next poll.
  const gitFileKinds = useMemo(() => {
    const rows: { path: string; kind: 'added' | 'modified' }[] = []
    for (const f of gitStatusFiles || []) {
      let rel = String(f.filePath || '').replace(/\\/g, '/')
      if (!rel) continue
      if (rel.length > 1 && rel.startsWith('"') && rel.endsWith('"')) {
        rel = rel.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
      if (!rel) continue
      const kind = (f.status === 'U' || f.status === 'A') ? 'added'
        : f.status === 'M' ? 'modified'
        : null
      if (kind) rows.push({ path: rel, kind })
    }
    if (justCreated && !rows.some(r => r.path === justCreated || r.path === `${justCreated}/`)) {
      rows.push({ path: justCreated, kind: 'added' })
    }
    return rows
  }, [gitStatusFiles, justCreated])

  const gitStatuses = useMemo(
    () => buildExplorerGitMap(treeData, gitFileKinds),
    [treeData, gitFileKinds],
  )

  useEffect(() => {
    if (!infoPopup) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInfoPopup(null) }
    const onDown = (e: MouseEvent) => {
      if (infoPopupRef.current && !infoPopupRef.current.contains(e.target as Node)) setInfoPopup(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [infoPopup])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // VS Code-style inline creation: Enter submits (clearing first so
  // double-fires are no-ops). A missing extension warns ONCE and keeps the
  // box open for fixing; blur below stays silent so the alert can never loop.
  const runCreate = useCallback((parentPath: string, name: string, type: 'file' | 'folder') => {
    const base = workspacePath.replace(/\\/g, '/') + (parentPath ? '/' + parentPath : '')
    const run = type === 'file' ? createFile(`${base}/${name}`) : createFolder(`${base}/${name}`)
    run.then((res: any) => {
      if (res?.ok) {
        if (parentPath && !expandedFolders.has(parentPath)) onToggleFolder(parentPath)
        flashCreated(parentPath ? `${parentPath}/${name}` : name)
        loadTree()
      }
    })
  }, [workspacePath, createFile, createFolder, expandedFolders, onToggleFolder, loadTree, flashCreated])

  const commitPending = useCallback(() => {
    const p = pendingRef.current
    if (!p) return
    const name = p.name.trim()
    if (!name) {
      setPending(null)
      return
    }
    if (p.type === 'file' && !hasFileExtension(name)) {
      alert('Please add a file extension.')
      return
    }
    setPending(null)
    runCreate(p.parentPath, name, p.type)
  }, [runCreate])

  // Focus loss: valid names still create, but an invalid name just stays
  // open silently — alerting here would re-trigger itself via focus theft.
  const blurPending = useCallback(() => {
    const p = pendingRef.current
    if (!p) return
    const name = p.name.trim()
    if (!name) {
      setPending(null)
      return
    }
    if (p.type === 'file' && !hasFileExtension(name)) return
    setPending(null)
    runCreate(p.parentPath, name, p.type)
  }, [runCreate])

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
    const { x, y, targetPath, isDirectory } = contextMenu
    const absPath = workspacePath.replace(/\\/g, '/') + '/' + targetPath
    closeContextMenu()
    // Open the card immediately (loading state), anchored just right of the click.
    setInfoPopup({ x: x + 8, y, targetPath, isDirectory, info: null })
    getFileInfo(absPath).then((res: any) => {
      if (!res?.ok || !res.info) {
        setInfoPopup(prev => prev && prev.targetPath === targetPath
          ? { ...prev, error: res?.error || 'Could not load info.' }
          : prev)
        return
      }
      setInfoPopup(prev => prev && prev.targetPath === targetPath
        ? { ...prev, info: res.info }
        : prev)
    }).catch(() => {
      setInfoPopup(prev => prev && prev.targetPath === targetPath
        ? { ...prev, error: 'Could not load info.' }
        : prev)
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
          gitStatuses={gitStatuses}
          renaming={renaming ? {
            path: renaming.path,
            name: renaming.name,
            onNameChange: (name: string) => setRenaming(prev => (prev ? { ...prev, name } : prev)),
            onCommit: commitRename,
            onBlur: commitRename,
            onCancel: cancelRename,
          } : null}
          pending={pending ? {
            type: pending.type,
            parentPath: pending.parentPath,
            name: pending.name,
            onNameChange: (name: string) => setPending(prev => (prev ? { ...prev, name } : prev)),
            onCommit: commitPending,
            onBlur: blurPending,
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
      {infoPopup && (() => {
        const pos = clampContextMenuPos(infoPopup.x, infoPopup.y, 300, 420)
        const info = infoPopup.info
        const name = info?.name || infoPopup.targetPath.split('/').pop() || infoPopup.targetPath
        return (
          <div
            className="file-info-popup"
            ref={infoPopupRef}
            style={{ left: pos.x, top: pos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="file-info-popup-header">
              <i className={`codicon ${infoPopup.isDirectory ? 'codicon-folder' : 'codicon-file'}`} style={{ fontSize: 14, flexShrink: 0 }}></i>
              <span className="file-info-popup-name" title={name}>{name}</span>
              <button className="file-info-popup-close" onClick={() => setInfoPopup(null)} title="Close">✕</button>
            </div>
            <div className="file-info-popup-body">
              {!info && !infoPopup.error && (
                <span className="file-info-loading">Loading…</span>
              )}
              {infoPopup.error && (
                <span className="file-tree-error">{infoPopup.error}</span>
              )}
              {info && (
                <>
                  <div className="file-info-row">
                    <span className="file-info-label">Type</span>
                    <span className="file-info-value">{infoPopup.isDirectory ? 'Folder' : 'File'}</span>
                  </div>
                  {infoPopup.isDirectory ? (
                    <>
                      <div className="file-info-row">
                        <span className="file-info-label">Items</span>
                        <span className="file-info-value">{info.immediateFiles + info.immediateDirs} ({info.immediateFiles} files, {info.immediateDirs} folders)</span>
                      </div>
                      <div className="file-info-row">
                        <span className="file-info-label">Total</span>
                        <span className="file-info-value">{info.totalFiles} files, {info.totalDirs} folders, {formatBytes(info.totalSizeBytes)}{info.truncated ? ' (count capped)' : ''}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="file-info-row">
                        <span className="file-info-label">Size</span>
                        <span className="file-info-value">{formatBytes(info.sizeBytes)}</span>
                      </div>
                      {info.extension && (
                        <div className="file-info-row">
                          <span className="file-info-label">Extension</span>
                          <span className="file-info-value mono">{info.extension}</span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="file-info-row">
                    <span className="file-info-label">Relative path</span>
                    <span className="file-info-value mono">{info.relativePath || infoPopup.targetPath}</span>
                  </div>
                  <div className="file-info-row">
                    <span className="file-info-label">Absolute path</span>
                    <span className="file-info-value mono">{info.absolutePath}</span>
                  </div>
                  <div className="file-info-row">
                    <span className="file-info-label">Created</span>
                    <span className="file-info-value">{formatDateTime(info.createdAt)}</span>
                  </div>
                  <div className="file-info-row">
                    <span className="file-info-label">Modified</span>
                    <span className="file-info-value">{formatDateTime(info.modifiedAt)}</span>
                  </div>
                  <div className="file-info-row">
                    <span className="file-info-label">Accessed</span>
                    <span className="file-info-value">{formatDateTime(info.accessedAt)}</span>
                  </div>
                </>
              )}
            </div>
            {info?.absolutePath && (
              <div className="file-info-popup-footer">
                <button onClick={() => copyToClipboard(info.absolutePath)} title="Copy absolute path">Copy Path</button>
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
