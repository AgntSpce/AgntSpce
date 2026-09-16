import { useState, useEffect, useCallback, memo } from 'react'
import type { WorkspaceInfo, SessionState } from '../types'
import { FileExplorer } from './FileExplorer'

interface DeletedWs {
  id: string
  name: string
  deletedAt: string
}

interface Props {
  workspaces: WorkspaceInfo[]
  sessions: Record<string, SessionState>
  activeWorkspace: WorkspaceInfo | null
  deletedWorkspaces: DeletedWs[]
  onSelect: (id: string) => void
  onAdd: (name: string, path: string) => void
  onEdit: (id: string, name: string, path: string) => void
  onRemove: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
  onPermanentDelete: (id: string) => void
  showModal: (title: string, onSubmit: (value: string) => void, defaultValue?: string) => void
  closeModal: () => void
  onOpenCreateModal: () => void
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  onExpandFolder: (path: string) => void
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
  getWorkspaceTree: (worktreePath: string) => Promise<any>
  createFile: (absolutePath: string) => Promise<any>
  createFolder: (absolutePath: string) => Promise<any>
  renameFile: (oldPath: string, newPath: string) => Promise<any>
  deleteFile: (absolutePath: string) => Promise<any>
}

function wsExpandKey(wsId: string) {
  return `ws:${wsId}`
}

export default memo(function WorkspaceSidebar({
  workspaces, activeWorkspace, deletedWorkspaces,
  onSelect, onEdit, onDelete, onRestore, onPermanentDelete,
  onOpenCreateModal, showModal,
  expandedFolders, onToggleFolder, onExpandFolder, selectedFilePath, onSelectFile,
  getWorkspaceTree, createFile, createFolder, renameFile, deleteFile,
}: Props) {
  const [showTrash, setShowTrash] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [selectedFolderPath, setSelectedFolderPath] = useState<Record<string, string | null>>({})
  const [refreshSignal, setRefreshSignal] = useState(0)

  const closeContextMenu = useCallback(() => setMenuOpenId(null), [])

  useEffect(() => {
    if (menuOpenId) {
      const handler = () => closeContextMenu()
      document.addEventListener('click', handler)
      return () => document.removeEventListener('click', handler)
    }
  }, [menuOpenId, closeContextMenu])

  const handleCreateFile = useCallback((ws: WorkspaceInfo) => {
    setMenuOpenId(null)
    const wsPath = ws.repository?.path || ''
    if (!wsPath) return
    const selectedFolder = selectedFolderPath[ws.id] || null
    showModal('New file name:', (name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      if (selectedFolder) onExpandFolder(selectedFolder)
      onExpandFolder(wsExpandKey(ws.id))
      const base = selectedFolder ? wsPath.replace(/\\/g, '/') + '/' + selectedFolder.replace(/\\/g, '/') : wsPath.replace(/\\/g, '/')
      createFile(`${base}/${trimmed}`).then(() => setRefreshSignal(s => s + 1))
    })
  }, [showModal, selectedFolderPath, createFile, onExpandFolder])

  const handleCreateFolder = useCallback((ws: WorkspaceInfo) => {
    setMenuOpenId(null)
    const wsPath = ws.repository?.path || ''
    if (!wsPath) return
    const selectedFolder = selectedFolderPath[ws.id] || null
    showModal('New folder name:', (name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      if (selectedFolder) onExpandFolder(selectedFolder)
      onExpandFolder(wsExpandKey(ws.id))
      const base = selectedFolder ? wsPath.replace(/\\/g, '/') + '/' + selectedFolder.replace(/\\/g, '/') : wsPath.replace(/\\/g, '/')
      createFolder(`${base}/${trimmed}`).then(() => setRefreshSignal(s => s + 1))
    })
  }, [showModal, selectedFolderPath, createFolder, onExpandFolder])

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        {/* Header */}
        <div className="sidebar-header">
          <h2>Workspace</h2>
          <div className="sidebar-header-buttons">
            <button className="add-btn" onClick={onOpenCreateModal} title="New workspace">+</button>
          </div>
        </div>

        {/* Workspace list */}
        <div className="workspace-list">
          {workspaces.map(ws => {
            const isActive = activeWorkspace?.id === ws.id
            const isExpanded = expandedFolders.has(wsExpandKey(ws.id))
            const wsPath = ws.repository?.path || ''

            return (
              <div key={ws.id} className={`workspace-tree-item${isActive ? ' active' : ''}`}>
                {/* Workspace row: arrow + name */}
                <div className="workspace-tree-row">
                  <div
                    className="workspace-tree-arrow"
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleFolder(wsExpandKey(ws.id))
                    }}
                  >
                    <i
                      className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`}
                      style={{ fontSize: 12, width: 16 }}
                    />
                  </div>
                  <i className={`codicon ${selectedFilePath ? 'codicon-file' : 'codicon-folder'} workspace-icon`} style={{ fontSize: 14, flexShrink: 0, color: 'var(--text-primary)' }} />
                  <div
                    className={`workspace-tree-name${isActive ? ' active' : ''}`}
                    onClick={() => onSelect(ws.id)}
                    title={ws.name}
                  >
                    {ws.name}
                  </div>
                  <div className="workspace-tree-actions">
                    <button
                      className="workspace-tree-dots"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenId(menuOpenId === ws.id ? null : ws.id)
                      }}
                      title="Options"
                    >⋮</button>
                    {menuOpenId === ws.id && (
                      <div className="workspace-tree-menu" onClick={e => e.stopPropagation()}>
                        <button
                          className="workspace-tree-menu-item"
                          onClick={() => handleCreateFile(ws)}
                        >
                          <i className="codicon codicon-new-file" style={{ fontSize: 13, marginRight: 6 }} />
                          New File
                        </button>
                        <button
                          className="workspace-tree-menu-item"
                          onClick={() => handleCreateFolder(ws)}
                        >
                          <i className="codicon codicon-new-folder" style={{ fontSize: 13, marginRight: 6 }} />
                          New Folder
                        </button>
                        <div className="workspace-tree-menu-separator" />
                        <button
                          className="workspace-tree-menu-item"
                          onClick={() => {
                            setMenuOpenId(null)
                            showModal('Rename workspace:', (name) => {
                              onEdit(ws.id, name, ws.repository?.path || '')
                            }, ws.name)
                          }}
                        >Rename</button>
                        <button
                          className="workspace-tree-menu-item danger"
                          onClick={() => {
                            setMenuOpenId(null)
                            if (confirm(`Delete workspace "${ws.name}"?`)) onDelete(ws.id)
                          }}
                        >Delete</button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Inline file tree when expanded */}
                {isExpanded && wsPath && (
                  <div className="workspace-inline-tree">
                    <FileExplorer
                      workspacePath={wsPath}
                      selectedFilePath={selectedFilePath}
                      selectedFolderPath={selectedFolderPath[ws.id] || null}
                      expandedFolders={expandedFolders}
                      onToggleFolder={onToggleFolder}
                      onSelectFile={onSelectFile}
                      onSelectFolder={(path) => setSelectedFolderPath(prev => ({ ...prev, [ws.id]: path }))}
                      refreshSignal={refreshSignal}
                      getWorkspaceTree={getWorkspaceTree}
                      createFile={createFile}
                      createFolder={createFolder}
                      renameFile={renameFile}
                      deleteFile={deleteFile}
                    />
                  </div>
                )}
                {isExpanded && !wsPath && (
                  <div className="workspace-inline-tree">
                    <div className="sidebar-empty">No path available</div>
                  </div>
                )}
              </div>
            )
          })}

          {workspaces.length === 0 && (
            <div className="sidebar-empty">
              No workspaces yet. Click + to create one.
            </div>
          )}
        </div>

        {/* Trash section */}
        {deletedWorkspaces.length > 0 && (
          <div className="workspace-trash">
            <div className="workspace-trash-header" onClick={() => setShowTrash(o => !o)}>
              <i
                className={`codicon codicon-chevron-${showTrash ? 'down' : 'right'}`}
                style={{ fontSize: 10, width: 14, flexShrink: 0 }}
              />
              <span>Trash ({deletedWorkspaces.length})</span>
            </div>
            {showTrash && deletedWorkspaces.map(dws => (
              <div key={dws.id} className="workspace-trash-item">
                <span className="workspace-trash-name">{dws.name}</span>
                <div className="workspace-trash-actions">
                  <button className="action-btn" onClick={() => onRestore(dws.id)} title="Restore">Restore</button>
                  <button className="action-btn danger" onClick={() => {
                    if (confirm(`Permanently delete "${dws.name}"?`)) onPermanentDelete(dws.id)
                  }} title="Permanent delete">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
})
