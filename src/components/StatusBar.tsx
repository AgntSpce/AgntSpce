import { useState, useEffect, useRef } from 'react'
import type { SessionState, WorkspaceInfo } from '../types'

interface Props {
  sessions: Record<string, SessionState>
  workspaces: WorkspaceInfo[]
  activeWorkspace: WorkspaceInfo | null
  notificationPanelOpen: boolean
  onNotificationClick: () => void
  unreadCount: number
  fileTrash: { id: string; name: string; relPath: string; isDirectory: boolean; deletedAt: string }[]
  onRecoverFile: (id: string) => void
  onDeleteTrashFile: (id: string) => void
  onEmptyTrash: () => void
}

function getSessionStats(sessions: Record<string, SessionState>) {
  const arr = Object.values(sessions)
  const total = arr.length
  const busy = arr.filter(s => s.status === 'busy' || s.status === 'waiting').length
  const shells = arr.filter(s => s.type === 'shell').length
  return { total, busy, shells }
}

export default function StatusBar({ sessions, workspaces, activeWorkspace, notificationPanelOpen, onNotificationClick, unreadCount, fileTrash, onRecoverFile, onDeleteTrashFile, onEmptyTrash }: Props) {
  const stats = getSessionStats(sessions)
  const [trashOpen, setTrashOpen] = useState(false)
  const trashRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!trashOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTrashOpen(false) }
    const onDown = (e: MouseEvent) => {
      if (trashRef.current && !trashRef.current.contains(e.target as Node)) setTrashOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [trashOpen])

  function handleDelete(id: string, name: string) {
    if (confirm(`Permanently delete "${name}"? It cannot be recovered.`)) onDeleteTrashFile(id)
  }

  function handleEmpty() {
    if (fileTrash.length === 0) return
    if (confirm(`Permanently delete ${fileTrash.length} trashed item${fileTrash.length !== 1 ? 's' : ''}? They cannot be recovered.`)) {
      onEmptyTrash()
    }
  }

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        <span className="status-bar-item status-bar-branch" title="Current workspace">
          <i className="codicon codicon-git-branch" style={{ fontSize: 14 }}></i>
          {activeWorkspace?.name || 'No workspace'}
        </span>
        <span className="status-bar-item" title="Active sessions">
          <i className="codicon codicon-person" style={{ fontSize: 14 }}></i>
          {stats.busy > 0 ? `${stats.busy}/${stats.total}` : `${stats.total}`}
        </span>
        <span className="status-bar-item" title="Shell terminals">
          <i className="codicon codicon-terminal" style={{ fontSize: 14 }}></i>
          {stats.shells}
        </span>
      </div>
      <div className="status-bar-right">
        <button
          className={`status-bar-item status-bar-notif-btn ${notificationPanelOpen ? 'active' : ''}`}
          onClick={onNotificationClick}
          title="Notifications"
        >
          <i className="codicon codicon-bell" style={{ fontSize: 14 }}></i>
          {unreadCount > 0 && <span className="status-bar-badge">{unreadCount}</span>}
        </button>
        <span className="status-bar-item" title="Workspaces">
          <i className="codicon codicon-folder" style={{ fontSize: 14 }}></i>
          {workspaces.length}
        </span>
        <button
          className={`status-bar-item status-bar-notif-btn ${trashOpen ? 'active' : ''}`}
          onMouseDown={e => e.nativeEvent.stopPropagation()}
          onClick={() => setTrashOpen(o => !o)}
          title="Trash"
        >
          <i className="codicon codicon-trash" style={{ fontSize: 14 }}></i>
          {fileTrash.length > 0 && <span className="status-bar-badge">{fileTrash.length}</span>}
        </button>
      </div>
      {trashOpen && (
        <div className="status-bar-trash-popup" ref={trashRef} onClick={e => e.stopPropagation()}>
          <div className="status-bar-trash-header">
            <span>Trash{fileTrash.length > 0 ? ` (${fileTrash.length})` : ''}</span>
            <button className="status-bar-trash-close" onClick={() => setTrashOpen(false)} title="Close">✕</button>
          </div>
          <div className="status-bar-trash-list">
            {fileTrash.length === 0 ? (
              <span className="status-bar-trash-empty">Trash is empty</span>
            ) : (
              fileTrash.map(item => (
                <div key={item.id} className="status-bar-trash-item">
                  <i className={`codicon ${item.isDirectory ? 'codicon-folder' : 'codicon-file'}`} style={{ fontSize: 13, flexShrink: 0 }}></i>
                  <span className="status-bar-trash-name" title={item.relPath || item.name}>{item.name}</span>
                  <div className="status-bar-trash-actions">
                    <button onClick={() => onRecoverFile(item.id)} title="Recover">↩ Recover</button>
                    <button className="danger" onClick={() => handleDelete(item.id, item.name)} title="Delete">✕ Delete</button>
                  </div>
                </div>
              ))
            )}
          </div>
          {fileTrash.length > 0 && (
            <div className="status-bar-trash-footer">
              <button className="status-bar-trash-empty-btn" onClick={handleEmpty}>Empty Bin</button>
            </div>
          )}
        </div>
      )}
    </footer>
  )
}