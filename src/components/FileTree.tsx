import { useCallback, useEffect, useRef } from 'react'
import type { FileTreeNode } from '../types'
import { getFileIconClass, getFileIconColor, getFileDevicon } from '../utils/fileIcons'
import { assetUrl } from '../utils/assetUrl'

export interface PendingCreate {
  type: 'file' | 'folder'
  /** Relative path of the directory the item is created in ('' = tree root). */
  parentPath: string
  name: string
  onNameChange: (name: string) => void
  /** Explicit submit (Enter): may show the extension warning. */
  onCommit: () => void
  /** Focus loss: must stay silent (an alert() would steal focus and loop). */
  onBlur: () => void
  onCancel: () => void
}

export interface PendingRename {
  /** Relative path of the item being renamed. */
  path: string
  name: string
  onNameChange: (name: string) => void
  /** Name is passed explicitly from the input (ground truth at commit time). */
  onCommit: (name: string) => void
  /** Focus loss: must stay silent (an alert() would steal focus and loop). */
  onBlur: (name: string) => void
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
  renaming?: PendingRename | null
  /** Explorer git colors, independent of git review: rel path -> added/modified. */
  gitStatuses?: Map<string, 'added' | 'modified'>
}

function FileIcon({ name }: { name: string }) {
  const devicon = getFileDevicon(name)
  if (devicon) {
    return <img className="file-devicon" src={assetUrl(`/img/devicon/${devicon}`)} alt="" draggable={false} />
  }
  const icon = getFileIconClass(name)
  const color = getFileIconColor(name)
  return <i className={`codicon codicon-${icon}`} style={{ fontSize: 14, flexShrink: 0, color: color ?? 'var(--text-primary)' }} />
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
  renaming = null,
  gitStatuses,
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
            renaming={renaming}
            gitStatuses={gitStatuses}
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
          onBlur={() => pending.onBlur()}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  )
}

function RenameInput({ renaming }: { renaming: PendingRename }) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Capture the initial name once: selection must anchor to what was there
  // when editing started, not to later keystrokes.
  const initialNameRef = useRef(renaming.name)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        const el = inputRef.current
        if (!el) return
        el.focus({ preventScroll: true })
        // VS Code style: select the stem, leave the extension (.html, .py…)
        // unselected. Dotfiles (dot at 0) and extensionless names select all.
        const dot = initialNameRef.current.lastIndexOf('.')
        if (dot > 0) el.setSelectionRange(0, dot)
        else el.select()
      } catch {}
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  const commitFromDom = () => {
    renaming.onCommit(inputRef.current?.value ?? renaming.name)
  }

  const blurFromDom = () => {
    renaming.onBlur(inputRef.current?.value ?? renaming.name)
  }

  return (
    <input
      ref={inputRef}
      autoFocus
      className="file-tree-inline-input"
      value={renaming.name}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => renaming.onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitFromDom() }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renaming.onCancel() }
          }}
          onBlur={() => blurFromDom()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
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
  renaming,
  depth,
  gitStatuses,
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
  renaming?: PendingRename | null
  depth: number
  gitStatuses?: Map<string, 'added' | 'modified'>
}) {
  const isDirectory = node.type === 'directory'
  const isExpanded = expandedFolders.has(node.path)
  const isSelected = selectedFilePath === node.path
  const isFolderSelected = isDirectory && selectedFolderPath === node.path
  const gitKind = gitStatuses?.get(node.path)
  const gitClass = gitKind === 'added' ? ' explorer-git-added' : gitKind === 'modified' ? ' explorer-git-modified' : ''

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
    // Swallow right-clicks on a row that's mid-rename to avoid stale states.
    if (renaming?.path === node.path) {
      e.stopPropagation()
      return
    }
    onContextMenu?.(e, node.path, isDirectory)
  }, [onContextMenu, node.path, isDirectory, renaming])

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-item ${isSelected ? 'selected' : ''}${isFolderSelected ? ' folder-selected' : ''}${highlightPath === node.path ? ' just-created' : ''}${gitClass}`}
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
        {renaming && renaming.path === node.path ? (
          <RenameInput renaming={renaming} />
        ) : (
          <span className="file-tree-label">{node.name}</span>
        )}
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
            renaming={renaming}
            gitStatuses={gitStatuses}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  )
}
