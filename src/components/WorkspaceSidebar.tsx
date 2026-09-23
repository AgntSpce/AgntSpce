import { useState, useEffect, useCallback, useMemo, memo } from 'react'
import type { WorkspaceInfo, SessionState, ExecutionEvent, AgentConfig, CommandEvent, TaskGroupInfo } from '../types'
import { FileExplorer } from './FileExplorer'
import { AGENT_TYPE_SET } from '../utils/agentTypes'
import { getAgentColorImage } from '../agentImages'
import './WorkspaceSidebar.css'

interface PromptHistoryEntry {
  sessionId: string
  originalPrompt: string
  timestamp: number
}

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
  onOpenFolderDirect?: () => void
  onCloneDirect?: () => void
  expandedFolders?: Set<string>
  onToggleFolder?: (path: string) => void
  onExpandFolder?: (path: string) => void
  selectedFilePath?: string | null
  onSelectFile?: (path: string) => void
  onFileDeleted?: (relPath: string) => void
  getWorkspaceTree?: (worktreePath: string) => Promise<any>
  getFileInfo?: (absolutePath: string) => Promise<any>
  gitFilesByWorkspace?: Record<string, { filePath: string; status: string }[]>
  fileTreeRefreshTick?: number
  createFile?: (absolutePath: string) => Promise<any>
  createFolder?: (absolutePath: string) => Promise<any>
  renameFile?: (oldPath: string, newPath: string) => Promise<any>
  deleteFile?: (absolutePath: string) => Promise<any>
  /** Section header text (default 'Workspace'). */
  title?: string
  /** Row icon: 'auto' keeps the folder/file logic, 'file' forces file icons. */
  rowIcon?: 'auto' | 'file'
  /** Hide the header + button (File Explorer section only). */
  hideCreateButton?: boolean
  // ── Orca-style agent list (workspace mode) ──
  /** Currently focused agent session (highlights its row). */
  activeSessionId?: string | null
  /** Called when an agent row is clicked. */
  onSelectSession?: (sessionId: string) => void
  /** Typed / agent-start prompts per session (newest-first or oldest-first). */
  promptHistory?: PromptHistoryEntry[]
  /** Execution events carrying the agent prompt per session. */
  executionHistory?: ExecutionEvent[]
  /** Tool command events per session (secondary "working on" line). */
  commandHistory?: CommandEvent[]
  /** Agent configs for display names/icons. */
  agentConfigs?: AgentConfig[]
  /** Live terminal tails per session (disambiguates done vs needs-input). */
  sessionBuffersRef?: { current: Record<string, string> }
  /** Renderer boot time — prompts older than this predate the run. */
  appBootTime?: number
  /** v2 task groups for the active workspace. */
  taskGroups?: TaskGroupInfo[]
  /** Opens the New Task popup. */
  onOpenCreateTaskModal?: () => void
  /** Currently selected task (visual only until TaskChat lands). */
  selectedTaskId?: string | null
  /** Called when a task row is clicked. */
  onSelectTask?: (id: string) => void
  /** Group dropped sessions into a shared task. */
  onGroupSessions?: (sessionIds: string[]) => void
  /** Join a session to an existing task group. */
  onJoinGroup?: (taskGroupId: string, sessionId: string) => void
  /** Quick-create an empty task group (title only), then open it. */
  onCreateTask?: (title: string) => void
}

// ── Workspace helpers ────────────────────────────────────────────────────

// v2 task-group status → dot color.
const TASK_STATUS_COLORS: Record<string, string> = {
  planning: '#9aa0a6',
  active: '#34c759',
  paused: '#ff9f0a',
  merging: '#0a84ff',
  done: '#6e6e6e',
  abandoned: '#ff453a',
}

// ── Workspace section (default workspace mode) ─────────────────────────
// Workspace cards carry a folder gutter, a title and a branch meta row,
// followed by the v2 Tasks list. Per-agent prompt/status rows were removed;
// agent activity lives in the terminal panes and the dashboard.

function wsExpandKey(wsId: string) {
  return `ws:${wsId}`
}

// A file name counts as typed when it has a non-empty extension part.
// Leading-dot names (.gitignore, .env) are allowed.
function hasFileExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && dot < name.length - 1
}

// Keep the floating menu on-screen (mirrors FileExplorer's helper).
function clampContextMenuPos(x: number, y: number, estW = 230, estH = 340) {
  return {
    x: Math.max(4, Math.min(x, Math.max(4, window.innerWidth - estW))),
    y: Math.max(4, Math.min(y, Math.max(4, window.innerHeight - estH))),
  }
}

const WorkspaceAgentsPanel = memo(function WorkspaceAgentsPanel({
  workspaces,
  sessions,
  activeWorkspace,
  deletedWorkspaces,
  onSelect,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  onOpenCreateModal,
  showModal,
  activeSessionId,
  onSelectSession,
  taskGroups,
  selectedTaskId,
  onSelectTask,
  onOpenFolderDirect,
  onCloneDirect,
  onGroupSessions,
  onJoinGroup,
  onCreateTask,
}: {
  workspaces: WorkspaceInfo[]
  sessions: Record<string, SessionState>
  activeWorkspace: WorkspaceInfo | null
  deletedWorkspaces: DeletedWs[]
  onSelect: (id: string) => void
  onEdit: (id: string, name: string, path: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
  onPermanentDelete: (id: string) => void
  onOpenCreateModal: () => void
  showModal: (title: string, onSubmit: (value: string) => void, defaultValue?: string) => void
  activeSessionId?: string | null
  onSelectSession?: (sessionId: string) => void
  promptHistory?: PromptHistoryEntry[]
  executionHistory?: ExecutionEvent[]
  commandHistory?: CommandEvent[]
  agentConfigs?: AgentConfig[]
  sessionBuffersRef?: { current: Record<string, string> }
  /** Renderer boot time — prompts older than this predate the run. */
  appBootTime?: number
  /** v2 task groups for the active workspace. */
  taskGroups?: TaskGroupInfo[]
  /** Opens the New Task popup. */
  onOpenCreateTaskModal?: () => void
  /** Currently selected task (visual only until TaskChat lands). */
  selectedTaskId?: string | null
  /** Called when a task row is clicked. */
  onSelectTask?: (id: string) => void
  onOpenFolderDirect?: () => void
  onCloneDirect?: () => void
  /** Group dropped sessions into a shared task. */
  onGroupSessions?: (sessionIds: string[]) => void
  /** Join a session to an existing task group. */
  onJoinGroup?: (taskGroupId: string, sessionId: string) => void
  /** Quick-create an empty task group (title only), then open it. */
  onCreateTask?: (title: string) => void
}) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  useEffect(() => {
    if (!menuOpenId) return
    const handler = () => setMenuOpenId(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [menuOpenId])

  // Latest known git branch per workspace, from agent sessions (most recent
  // first). Replaces the old aggregate-status gutter data.
  const branchByWorkspace = useMemo(() => {
    const map = new Map<string, string>()
    for (const ws of workspaces) map.set(ws.id, '')
    const list = Object.values(sessions).filter(s => AGENT_TYPE_SET.has(s.type))
    list.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    for (const s of list) {
      const key = s.repositoryName && map.has(s.repositoryName)
        ? s.repositoryName
        : activeWorkspace?.id || ''
      if (s.branch && s.branch !== 'unknown' && !map.get(key)) map.set(key, s.branch)
    }
    return map
  }, [sessions, workspaces, activeWorkspace?.id])

  const closeMenu = useCallback(() => setMenuOpenId(null), [])

  return (
    <aside className="sidebar orca-workspace-sidebar">
      <div className="sidebar-top">
        <div className="sidebar-header">
          <h2>Workspace</h2>
        </div>

        <div className="workspace-list orca-workspace-list">
          {(activeWorkspace ? [activeWorkspace] : []).map(ws => {
            const branch = branchByWorkspace.get(ws.id) || ''
            return (
              <div key={ws.id} className="orca-ws-card active orca-ws-card-centered">
                <div className="orca-ws-centered" onClick={() => onSelect(ws.id)} title={ws.name}>
                  <span className="orca-ws-title orca-ws-title-large">{ws.name}</span>
                  {branch && (
                    <div className="orca-ws-meta orca-ws-meta-centered">
                      <i className="codicon codicon-git-branch" />
                      <span className="orca-ws-branch">{branch}</span>
                    </div>
                  )}
                </div>
                <span className="workspace-tree-actions workspace-tree-actions-centered" onClick={e => e.stopPropagation()}>
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
                        onClick={() => {
                          closeMenu()
                          showModal('Rename workspace:', (name) => {
                            onEdit(ws.id, name, ws.repository?.path || '')
                          }, ws.name)
                        }}
                      >Rename</button>
                      <button
                        className="workspace-tree-menu-item danger"
                        onClick={() => {
                          closeMenu()
                          if (confirm(`Delete workspace "${ws.name}"?`)) onDelete(ws.id)
                        }}
                      >Delete</button>
                    </div>
                  )}
                </span>
                {/* Agents + Add a Task live inside the card, right under the name */}
                <div className="workspace-agents-top workspace-agents-inline">
                  <div className="sidebar-header tasks-header">
                    <h2>Agents</h2>
                  </div>
                  <div
                    className="agent-row-list"
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault()
                      const dragged = e.dataTransfer.getData('text/agntspce-session')
                      if (dragged) onGroupSessions?.([dragged])
                    }}
                  >
                    {Object.values(sessions)
                      .filter(s => AGENT_TYPE_SET.has(s.type))
                      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
                      .map(s => (
                        <div
                          key={s.id}
                          className={`agent-row-item${activeSessionId === s.id ? ' active' : ''}`}
                          draggable
                          onDragStart={e => {
                            e.dataTransfer.setData('text/agntspce-session', s.id)
                            e.dataTransfer.effectAllowed = 'link'
                          }}
                          onDragOver={e => e.preventDefault()}
                          onDrop={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            const dragged = e.dataTransfer.getData('text/agntspce-session')
                            if (dragged && dragged !== s.id) onGroupSessions?.([dragged, s.id])
                          }}
                          onClick={() => onSelectSession?.(s.id)}
                          title={`${s.type} · ${s.id.slice(-4)} — drag onto another agent to group`}
                        >
                          <img
                            className="task-agent-logo"
                            src={getAgentColorImage(s.type)}
                            alt={s.type}
                            draggable={false}
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                          <span className="task-row-title">{s.type}</span>
                        </div>
                      ))}
                  </div>
                  <button
                    className="sidebar-create-btn primary sidebar-add-task-btn"
                    onClick={() => showModal('Task name:', (name) => {
                      if (name.trim()) onCreateTask?.(name.trim())
                    })}
                  >
                    Add a Task
                  </button>
                </div>
              </div>
            )
          })}

          {!activeWorkspace && (
            <div className="sidebar-empty sidebar-create-workspace">
              <p className="sidebar-empty-title">No folder opened</p>
              <p className="sidebar-empty-desc">Open a folder or clone a repository. One window, one workspace.</p>
              <div className="sidebar-create-actions">
                <button className="sidebar-create-btn primary" onClick={onOpenFolderDirect || onOpenCreateModal}>
                  <i className="codicon codicon-folder-opened" style={{ marginRight: 6 }}></i>
                  Open Folder
                </button>
                <button className="sidebar-create-btn" onClick={onCloneDirect || onOpenCreateModal}>
                  <i className="codicon codicon-source-control" style={{ marginRight: 6 }}></i>
                  Clone from GitHub
                </button>
              </div>
              <div className="sidebar-create-hint">
                Local Folder · Clone from Git
              </div>
            </div>
          )}
        </div>

        {/* ── v2 Tasks: one shared worktree per task, N agents ── */}
        {activeWorkspace && (taskGroups || []).length > 0 && (
          <div className="workspace-tasks-top">
            <div className="sidebar-header tasks-header">
              <h2>Tasks</h2>
            </div>
            <div className="task-list">
              {(taskGroups || []).map(t => (
                <div
                  key={t.id}
                  className={`task-row${selectedTaskId === t.id ? ' active' : ''}`}
                  onClick={() => onSelectTask?.(t.id)}
                  title={`${t.userGoal || t.title} — drop an agent here to join`}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => {
                    e.preventDefault()
                    const dragged = e.dataTransfer.getData('text/agntspce-session')
                    if (dragged) onJoinGroup?.(t.id, dragged)
                  }}
                >
                  <span className="task-status-dot" style={{ background: TASK_STATUS_COLORS[t.status] ?? '#9aa0a6' }} />
                  <span className="task-row-title">{t.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

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

export default memo(function WorkspaceSidebar({
  workspaces, sessions, activeWorkspace, deletedWorkspaces,
  onSelect, onEdit, onDelete, onRestore, onPermanentDelete,
  onOpenCreateModal, showModal,
  expandedFolders, onToggleFolder, onExpandFolder, selectedFilePath, onSelectFile, onFileDeleted,
  getWorkspaceTree, getFileInfo, gitFilesByWorkspace, fileTreeRefreshTick, createFile, createFolder, renameFile, deleteFile,
  title = 'Workspace', rowIcon = 'auto', hideCreateButton = false,
  taskGroups, selectedTaskId, onSelectTask,
  onOpenFolderDirect, onCloneDirect,
  activeSessionId, onSelectSession, onGroupSessions, onJoinGroup,
  onCreateTask,
}: Props) {
  // File Explorer panel keeps the legacy file-tree UI. The Workspace panel
  // is now the Orca-style workspace + agents list (no file explorer).
  const isFileExplorer = title === 'File Explorer'
  if (!isFileExplorer) {
    return (
      <WorkspaceAgentsPanel
        workspaces={workspaces}
        sessions={sessions}
        activeWorkspace={activeWorkspace}
        deletedWorkspaces={deletedWorkspaces}
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={onDelete}
        onRestore={onRestore}
        onPermanentDelete={onPermanentDelete}
        onOpenCreateModal={onOpenCreateModal}
        showModal={showModal}
        taskGroups={taskGroups}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
        onOpenFolderDirect={onOpenFolderDirect}
        onCloneDirect={onCloneDirect}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onGroupSessions={onGroupSessions}
        onJoinGroup={onJoinGroup}
        onCreateTask={onCreateTask}
      />
    )
  }

  return (
    <WorkspaceSidebarFiles
      workspaces={workspaces} activeWorkspace={activeWorkspace} deletedWorkspaces={deletedWorkspaces}
      onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} onRestore={onRestore} onPermanentDelete={onPermanentDelete}
      onOpenCreateModal={onOpenCreateModal} showModal={showModal}
      expandedFolders={expandedFolders} onToggleFolder={onToggleFolder} onExpandFolder={onExpandFolder}
      selectedFilePath={selectedFilePath} onSelectFile={onSelectFile} onFileDeleted={onFileDeleted}
      getWorkspaceTree={getWorkspaceTree} getFileInfo={getFileInfo} gitFilesByWorkspace={gitFilesByWorkspace}
      fileTreeRefreshTick={fileTreeRefreshTick} createFile={createFile} createFolder={createFolder}
      renameFile={renameFile} deleteFile={deleteFile}
      title={title} rowIcon={rowIcon} hideCreateButton={hideCreateButton}
    />
  )
})

const WorkspaceSidebarFiles = memo(function WorkspaceSidebarFiles({
  workspaces, activeWorkspace, deletedWorkspaces,
  onSelect, onEdit, onDelete, onRestore, onPermanentDelete,
  onOpenCreateModal, showModal,
  expandedFolders, onToggleFolder, onExpandFolder, selectedFilePath, onSelectFile, onFileDeleted,
  getWorkspaceTree, getFileInfo, gitFilesByWorkspace, fileTreeRefreshTick, createFile, createFolder, renameFile, deleteFile,
  title = 'Workspace', rowIcon = 'auto', hideCreateButton = false,
}: {
  workspaces: WorkspaceInfo[]
  activeWorkspace: WorkspaceInfo | null
  deletedWorkspaces: DeletedWs[]
  onSelect: (id: string) => void
  onEdit: (id: string, name: string, path: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
  onPermanentDelete: (id: string) => void
  onOpenCreateModal: () => void
  showModal: (title: string, onSubmit: (value: string) => void, defaultValue?: string) => void
  expandedFolders?: Set<string>
  onToggleFolder?: (path: string) => void
  onExpandFolder?: (path: string) => void
  selectedFilePath?: string | null
  onSelectFile?: (path: string) => void
  onFileDeleted?: (relPath: string) => void
  getWorkspaceTree?: (worktreePath: string) => Promise<any>
  getFileInfo?: (absolutePath: string) => Promise<any>
  gitFilesByWorkspace?: Record<string, { filePath: string; status: string }[]>
  fileTreeRefreshTick?: number
  createFile?: (absolutePath: string) => Promise<any>
  createFolder?: (absolutePath: string) => Promise<any>
  renameFile?: (oldPath: string, newPath: string) => Promise<any>
  deleteFile?: (absolutePath: string) => Promise<any>
  title?: string
  rowIcon?: 'auto' | 'file'
  hideCreateButton?: boolean
}) {
  const [showTrash, setShowTrash] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number; wsId: string } | null>(null)
  // Inline-creation triggers for each workspace's tree (consumed by FileExplorer).
  const [createRequests, setCreateRequests] = useState<Record<string, { type: 'file' | 'folder'; nonce: number }>>({})
  const [selectedFolderPath, setSelectedFolderPath] = useState<Record<string, string | null>>({})
  const [refreshSignal, setRefreshSignal] = useState(0)

  const closeContextMenu = useCallback(() => { setMenuOpenId(null); setWsMenu(null) }, [])

  useEffect(() => {
    if (menuOpenId || wsMenu) {
      const handler = () => closeContextMenu()
      document.addEventListener('click', handler)
      return () => document.removeEventListener('click', handler)
    }
  }, [menuOpenId, wsMenu, closeContextMenu])

  const handleCreateFile = useCallback((ws: WorkspaceInfo) => {
    if (!createFile || !onExpandFolder) return
    setMenuOpenId(null)
    setWsMenu(null)
    const wsPath = ws.repository?.path || ''
    if (!wsPath) return
    const selectedFolder = selectedFolderPath[ws.id] || null
    showModal('New file name:', (name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      if (!hasFileExtension(trimmed)) {
        alert('Please add a file extension.')
        return
      }
      if (selectedFolder) onExpandFolder(selectedFolder)
      onExpandFolder(wsExpandKey(ws.id))
      const base = selectedFolder ? wsPath.replace(/\\/g, '/') + '/' + selectedFolder.replace(/\\/g, '/') : wsPath.replace(/\\/g, '/')
      createFile(`${base}/${trimmed}`).then(() => setRefreshSignal(s => s + 1))
    })
  }, [showModal, selectedFolderPath, createFile, onExpandFolder])

  const handleCreateFolder = useCallback((ws: WorkspaceInfo) => {
    if (!createFolder || !onExpandFolder) return
    setMenuOpenId(null)
    setWsMenu(null)
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

  const handleWsContextMenu = useCallback((e: React.MouseEvent, wsId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuOpenId(null)
    setWsMenu({ x: e.clientX, y: e.clientY, wsId })
  }, [])

  // Workspace-menu creation: expand the tree and ask its FileExplorer to
  // show the inline row at the root (consumed once per nonce).
  const requestWsCreate = useCallback((ws: WorkspaceInfo, type: 'file' | 'folder') => {
    if (!onExpandFolder) return
    setWsMenu(null)
    onExpandFolder(wsExpandKey(ws.id))
    setCreateRequests(prev => ({ ...prev, [ws.id]: { type, nonce: Date.now() } }))
  }, [onExpandFolder])

  const handleCreateRequestHandled = useCallback((wsId: string, nonce: number) => {
    setCreateRequests(prev => {
      if (prev[wsId]?.nonce !== nonce) return prev
      const next = { ...prev }
      delete next[wsId]
      return next
    })
  }, [])

  const canShowTree = !!(expandedFolders && onToggleFolder && onExpandFolder && getWorkspaceTree && getFileInfo && createFile && createFolder && renameFile && deleteFile && onSelectFile)

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        {/* Header */}
        <div className="sidebar-header">
          <h2>{title}</h2>
          {!hideCreateButton && (
            <div className="sidebar-header-buttons">
              <button className="add-btn" onClick={onOpenCreateModal} title="New workspace">+</button>
            </div>
          )}
        </div>

        {/* Workspace list */}
        <div className="workspace-list">
          {workspaces.map(ws => {
            const isActive = activeWorkspace?.id === ws.id
            const isExpanded = expandedFolders?.has(wsExpandKey(ws.id))
            const wsPath = ws.repository?.path || ''

            return (
              <div key={ws.id} className={`workspace-tree-item${isActive ? ' active' : ''}`}>
                {/* Workspace row: arrow + name */}
                <div className="workspace-tree-row" onContextMenu={(e) => handleWsContextMenu(e, ws.id)}>
                  <div
                    className="workspace-tree-arrow"
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleFolder?.(wsExpandKey(ws.id))
                    }}
                  >
                    <i
                      className={`codicon codicon-chevron-${isExpanded ? 'down' : 'right'}`}
                      style={{ fontSize: 12, width: 16 }}
                    />
                  </div>
                  {rowIcon === 'file' ? (
                    <i className="codicon codicon-file workspace-icon" style={{ fontSize: 14, flexShrink: 0, color: 'var(--text-primary)' }} />
                  ) : (
                    <i className={`codicon ${selectedFilePath ? 'codicon-file' : 'codicon-folder'} workspace-icon`} style={{ fontSize: 14, flexShrink: 0, color: 'var(--text-primary)' }} />
                  )}
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
                {isExpanded && wsPath && canShowTree && (
                  <div className="workspace-inline-tree">
                    <FileExplorer
                      workspacePath={wsPath}
                      selectedFilePath={selectedFilePath || null}
                      selectedFolderPath={selectedFolderPath[ws.id] || null}
                      expandedFolders={expandedFolders!}
                      onToggleFolder={onToggleFolder!}
                      onSelectFile={onSelectFile!}
                      onSelectFolder={(path) => setSelectedFolderPath(prev => ({ ...prev, [ws.id]: path }))}
                      refreshSignal={refreshSignal}
                      extraRefreshSignal={fileTreeRefreshTick}
                      getWorkspaceTree={getWorkspaceTree!}
                      getFileInfo={getFileInfo!}
                      gitStatusFiles={gitFilesByWorkspace?.[ws.id] ?? []}
                      createRequest={createRequests[ws.id] ?? null}
                      onCreateRequestHandled={(nonce) => handleCreateRequestHandled(ws.id, nonce)}
                      createFile={createFile!}
                      createFolder={createFolder!}
                      renameFile={renameFile!}
                      deleteFile={deleteFile!}
                      onFileDeleted={onFileDeleted}
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

        {/* Right-click floating menu on a workspace row */}
        {wsMenu && (() => {
          const ws = workspaces.find(w => w.id === wsMenu.wsId)
          if (!ws) return null
          const pos = clampContextMenuPos(wsMenu.x, wsMenu.y)
          const dismiss = () => setWsMenu(null)
          return (
            <div
              className="file-context-menu"
              style={{ left: pos.x, top: pos.y }}
              onClick={e => e.stopPropagation()}
            >
              <button className="file-context-menu-item" onClick={() => requestWsCreate(ws, 'file')}>
                <i className="codicon codicon-new-file" style={{ fontSize: 13, marginRight: 6 }} />
                New File
              </button>
              <button className="file-context-menu-item" onClick={() => requestWsCreate(ws, 'folder')}>
                <i className="codicon codicon-new-folder" style={{ fontSize: 13, marginRight: 6 }} />
                New Folder
              </button>
              <div className="file-context-menu-separator" />
              <button
                className="file-context-menu-item"
                onClick={() => { setRefreshSignal(s => s + 1); dismiss() }}
              >
                <i className="codicon codicon-refresh" style={{ fontSize: 13, marginRight: 6 }} />
                Refresh
              </button>
              <div className="file-context-menu-separator" />
              <button
                className="file-context-menu-item"
                onClick={() => {
                  dismiss()
                  showModal('Rename workspace:', (name) => {
                    onEdit(ws.id, name, ws.repository?.path || '')
                  }, ws.name)
                }}
              >
                <i className="codicon codicon-edit" style={{ fontSize: 13, marginRight: 6 }} />
                Rename
              </button>
              <button
                className="file-context-menu-item danger"
                onClick={() => {
                  dismiss()
                  if (confirm(`Delete workspace "${ws.name}"?`)) onDelete(ws.id)
                }}
              >
                <i className="codicon codicon-trash" style={{ fontSize: 13, marginRight: 6 }} />
                Delete
              </button>
            </div>
          )
        })()}

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
