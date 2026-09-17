import { useCallback, useEffect, useRef } from 'react'
import type { FileTreeNode } from '../types'
import { getFileIconClass } from '../utils/fileIcons'

export interface PendingCreate {
  type: 'file' | 'folder'
  /** Relative path of the directory the item is created in ('' = tree root). */
  parentPath: string
  name: string
  onNameChange: (name: string) => void
  onCommit: () => void
  onCancel: () => void
}

interface FileTreeProps {
  nodes: FileTreeNode[]
  expandedFolders: Set<string>
  selectedFilePath: string | null
  selectedFolderPath?: string | null
  onToggleFolder: (path: string) => void
  onSelectFile: (path: string) => void
  onSelectFolder?: (path: string) => void
  onContextMenu?: (e: React.MouseEvent, path: string, isDirectory: boolean) => void
  depth?: number
  /** Relative path of the directory this level lists ('' = tree root). */
  levelPath?: string
  pending?: PendingCreate | null
  /** Relative path of the row to flash with the just-created glow. */
  highlightPath?: string | null
}

function FileIcon({ name }: { name: string }) {
  const icon = getFileIconClass(name)
  return <i className={`codicon codicon-${icon}`} style={{ fontSize: 14, flexShrink: 0, color: 'var(--text-primary)' }} />
}

export function FileTree({
  nodes,
  expandedFolders,
  selectedFilePath,
  selectedFolderPath,
  onToggleFolder,
  onSelectFile,
  onSelectFolder,
  onContextMenu,
  depth = 0,
  levelPath = '',
  pending = null,
  highlightPath = null,
}: FileTreeProps) {
  // Merge the in-progress creation row into this level (when it belongs
  // here) using the same ordering as the backend: folders first, then
  // alphabetical. An empty typed name sorts before everything, so a new
  // folder starts at the top and a new file below the folders — then glides
  // into alphabetical position as letters are typed.
  const entries: { key: string; isDir: boolean; name: string; node?: FileTreeNode }[] =
    nodes.map((n) => ({ key: n.path, isDir: n.type === 'directory', name: n.name, node: n }))
  if (pending && pending.parentPath === levelPath) {
    // Sort key stays empty while typing so the row holds its slot (folder at
    // the top, file below the folders) until Enter commits — VS Code style.
    // The typed text is display-only via the pending prop.
    entries.push({
      key: '__pending__',
      isDir: pending.type === 'folder',
      name: '',
    })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  if (entries.length === 0) {
    return <div className="file-tree-empty">Empty folder</div>
  }

  return (
    <div className="file-tree">
      {entries.map((entry) => (
        entry.key === '__pending__' && pending ? (
          <PendingRow key="__pending__" depth={depth} pending={pending} />
        ) : (
          <TreeNode
            key={entry.key}
            node={entry.node!}
            expandedFolders={expandedFolders}
            selectedFilePath={selectedFilePath}
            selectedFolderPath={selectedFolderPath}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
            onSelectFolder={onSelectFolder}
            onContextMenu={onContextMenu}
            pending={pending}
            highlightPath={highlightPath}
            depth={depth}
          />
        )
      ))}
    </div>
  )
}

function PendingRow({ depth, pending }: { depth: number; pending: PendingCreate }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try { inputRef.current?.focus({ preventScroll: true }) } catch {}
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="file-tree-node">
      <div
        className="file-tree-item pending"
        style={{ paddingLeft: depth * 16 + 8 }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      >
        {pending.type === 'folder' ? (
          <>
            <i
              className="codicon codicon-chevron-right"
              style={{ fontSize: 12, flexShrink: 0, width: 16 }}
            />
            <i
              className="codicon codicon-folder"
              style={{ fontSize: 14, flexShrink: 0, marginRight: 4 }}
            />
          </>
        ) : (
          <>
            <span style={{ width: 16, flexShrink: 0 }} />
            <i
              className="codicon codicon-new-file"
              style={{ fontSize: 14, flexShrink: 0, marginRight: 4 }}
            />
          </>
        )}
        <input
          ref={inputRef}
          autoFocus
          className="file-tree-inline-input"
          value={pending.name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => pending.onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pending.onCommit() }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pending.onCancel() }
          }}
          onBlur={() => pending.onCommit()}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  )
}

function TreeNode({
  node,
  expandedFolders,
  selectedFilePath,
  selectedFolderPath,
  onToggleFolder,
  onSelectFile,
  onSelectFolder,
  onContextMenu,
  pending,
  highlightPath,
  depth,
}: {
  node: FileTreeNode
  expandedFolders: Set<string>
  selectedFilePath: string | null
  selectedFolderPath?: string | null
  onToggleFolder: (path: string) => void
  onSelectFile: (path: string) => void
  onSelectFolder?: (path: string) => void
  onContextMenu?: (e: React.MouseEvent, path: string, isDirectory: boolean) => void
  pending?: PendingCreate | null
  highlightPath?: string | null
  depth: number
}) {
  const isDirectory = node.type === 'directory'
  const isExpanded = expandedFolders.has(node.path)
  const isSelected = selectedFilePath === node.path
  const isFolderSelected = isDirectory && selectedFolderPath === node.path

  const handleClick = useCallback(() => {
    if (isDirectory) {
      onToggleFolder(node.path)
      onSelectFolder?.(node.path)
    } else {
      onSelectFile(node.path)
    }
  }, [isDirectory, node.path, onToggleFolder, onSelectFolder, onSelectFile])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onContextMenu?.(e, node.path, isDirectory)
  }, [onContextMenu, node.path, isDirectory])

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-item ${isSelected ? 'selected' : ''}${isFolderSelected ? ' folder-selected' : ''}${highlightPath === node.path ? ' just-created' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={node.path}
      >
        {isDirectory ? (
          <i
            className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`}
            style={{ fontSize: 12, flexShrink: 0, width: 16 }}
          />
        ) : (
          <span style={{ width: 16, flexShrink: 0 }} />
        )}
        {isDirectory ? (
          <i
            className={`codicon ${isExpanded ? 'codicon-folder-opened' : 'codicon-folder'}`}
            style={{ fontSize: 14, flexShrink: 0, marginRight: 4 }}
          />
        ) : (
          <FileIcon name={node.name} />
        )}
        <span className="file-tree-label">{node.name}</span>
      </div>
      {isDirectory && isExpanded && node.children && (
        <div className="file-tree-children">
          <FileTree
            nodes={node.children}
            expandedFolders={expandedFolders}
            selectedFilePath={selectedFilePath}
            selectedFolderPath={selectedFolderPath}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
            onSelectFolder={onSelectFolder}
            onContextMenu={onContextMenu}
            levelPath={node.path}
            pending={pending}
            highlightPath={highlightPath}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  )
}
