import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'

import WorkspaceSidebar from './components/WorkspaceSidebar'
import type { TaskMember } from './components/TaskAgentRow'
import TerminalArea from './components/TerminalArea'
import InputModal from './components/InputModal'
import AgentModal from './components/AgentModal'
import CreateWorkspaceModal from './components/CreateWorkspaceModal'
import CreateTaskModal from './components/CreateTaskModal'
import TaskChat from './components/TaskChat'
import Settings from './components/Settings'
import StatusBar from './components/StatusBar'
import TitleBar from './components/TitleBar'
import GitDiffViewer from './components/GitDiffViewer'
import CommanderPanel from './components/CommanderPanel'
import NotificationPanel from './components/NotificationPanel'
import { EditorTabs } from './components/EditorTabs'
import type { Notification } from './components/NotificationPanel'

// Heavy panels loaded on demand to keep startup bundle small.
const ChatSidebar = lazy(() => import('./components/ChatSidebar'))
const Dashboard = lazy(() => import('./components/Dashboard'))
const GitReviewPanel = lazy(() => import('./components/GitReviewPanel'))
const CodeEditor = lazy(() => import('./components/CodeEditor').then(m => ({ default: m.CodeEditor })))

import { useSocket } from './hooks/useSocket'
import useSocketEvent from './hooks/useSocketEvent'

import type { TerminalOutput, AgentConfig, AgentStartConfig, SessionState, OpenFile, WorkspaceInfo } from './types'
import '@vscode/codicons/dist/codicon.css'
import './App.css'
import { assetUrl } from './utils/assetUrl'
import { parseCombo, eventMatches, type ShortcutCombo } from './utils/shortcuts'
import { AGENT_TYPE_SET } from './utils/agentTypes'

const AGENTS_LIST: { id: string; name: string; icon: string }[] = [
  { id: 'claude', name: 'Claude Code', icon: '🤖' },
  { id: 'opencode', name: 'Opencode', icon: '🔧' },
  { id: 'codex', name: 'Codex', icon: '⚡' },
  { id: 'gemini', name: 'Gemini', icon: '✨' },
  { id: 'cursor-agent', name: 'Cursor Agent', icon: '🖥️' },
  { id: 'copilot', name: 'Copilot', icon: '🐙' },
  { id: 'mastracode', name: 'Mastra Code', icon: '🔷' },
  { id: 'droid', name: 'Droid', icon: '🤖' },
  { id: 'amp', name: 'Amp', icon: '⚡' },
  { id: 'pi', name: 'Pi', icon: '🥧' },
  { id: 'kilocode', name: 'Kilocode', icon: 'k' },
  { id: 'windsurf', name: 'Windsurf', icon: 'w' },
]

const FALLBACK_AGENTS: AgentConfig[] = [
  {
    id: 'claude', name: 'Claude Code', icon: '🤖', description: 'Anthropic Claude Code CLI',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Resume conversation' }, { id: 'resume', name: 'Resume', description: 'Restore interrupted session' }],
    flags: [
      { id: 'skipPermissions', flag: '--dangerously-skip-permissions', label: '🚀 YOLO Mode', description: 'YOLO Mode (skip permissions)', category: 'permissions', default: true },
      { id: 'verbose', flag: '--verbose', label: '📝 Verbose', description: 'Verbose output mode', category: 'output', default: false },
      { id: 'debug', flag: '--debug', label: '🐛 Debug', description: 'Debug mode with detailed logging', category: 'output', default: false },
    ],
    defaultMode: 'fresh',
  },
  {
    id: 'opencode', name: 'Opencode', icon: '🔧', description: 'AI-powered coding agent CLI',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'codex', name: 'Codex', icon: '⚡', description: 'OpenAI Codex CLI',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue most recent session' }, { id: 'resume', name: 'Resume', description: 'Resume interrupted session' }],
    models: ['gpt-4', 'gpt-5', 'gpt-5-codex'],
    defaultModel: 'gpt-5-codex',
    reasoningLevels: ['low', 'medium', 'high'],
    defaultReasoning: 'high',
    verbosityLevels: ['low', 'medium', 'high'],
    defaultVerbosity: 'high',
    flags: [
      { id: 'yolo', flag: '--dangerously-bypass-approvals-and-sandbox', label: '🚀 YOLO Mode', description: 'No approvals + no sandboxing (extremely dangerous)', category: 'sandbox', default: true },
      { id: 'workspaceWrite', flag: '--sandbox workspace-write', label: '📝 Workspace Write', description: 'Write files in workspace only (safer than YOLO)', category: 'sandbox', default: false },
      { id: 'readOnly', flag: '--sandbox read-only', label: '👀 Read Only', description: 'Read-only access (safest, no modifications)', category: 'sandbox', default: false },
      { id: 'neverAsk', flag: '--ask-for-approval never', label: '⚡ Never Ask', description: 'Never ask for permission', category: 'approvals', default: false },
      { id: 'askOnRequest', flag: '--ask-for-approval on-request', label: '🛡️ Ask on Risk', description: 'Ask only on risky operations', category: 'approvals', default: false },
    ],
    defaultMode: 'fresh',
  },
  {
    id: 'gemini', name: 'Gemini', icon: '✨', description: 'Google Gemini CLI',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }, { id: 'resume', name: 'Resume', description: 'Resume saved session' }],
    models: ['gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-pro',
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'cursor-agent', name: 'Cursor Agent', icon: '🖥️', description: 'Cursor AI coding agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'copilot', name: 'Copilot', icon: '🐙', description: 'GitHub Copilot CLI',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'explain', name: 'Explain', description: 'Explain code' }, { id: 'suggest', name: 'Suggest', description: 'Suggest code' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'mastracode', name: 'Mastra Code', icon: '🔷', description: 'Mastra Code AI agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'droid', name: 'Droid', icon: '🤖', description: 'Factory AI Droid coding agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }, { id: 'resume', name: 'Resume', description: 'Resume saved session' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'amp', name: 'Amp', icon: '⚡', description: 'Amplified Amp coding agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'agent', name: 'Agent', description: 'Run in agent mode' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'pi', name: 'Pi', icon: '🥧', description: 'Pi coding agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }, { id: 'resume', name: 'Resume', description: 'Resume saved session' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'kilocode', name: 'Kilocode', icon: 'k', description: 'Kilocode AI coding agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }],
    flags: [],
    defaultMode: 'fresh',
  },
  {
    id: 'windsurf', name: 'Windsurf', icon: 'w', description: 'Windsurf AI coding agent',
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }],
    flags: [],
    defaultMode: 'fresh',
  },
]

interface ModalState {
  open: boolean
  title: string
  defaultValue?: string
  onSubmit: (value: string) => void
}

const NOOP = () => {}

function App() {
  const {
    sessions, workspaces, activeWorkspace: _globalActiveWorkspace,
    onTerminalOutput, onSessionResumed, sendTerminalInput, sendTerminalResize,
    restartSession, resumeSession, switchWorkspace, createWorkspace,
    deleteWorkspace, listDeletedWorkspaces, restoreWorkspace, permanentDeleteWorkspace,
    closeTab, startAgent, fetchAgentConfigs, fetchInstalledAgents, createRawSession, createAgentSession,
    createWorkspaceFromGit,
    getGitFileDiff, getGitLog, getGitBranches, getGitCommitFiles,
    getGitFullStatus, gitStageFile, gitUnstageFile, gitCommit, gitPull, gitPush, gitFetch,
    setUserSettings, updateWorkspaceConfig, refreshWorkspaces,
    taskGroups, listTaskGroups, createTaskGroup, onTaskGroupsChanged,
    renameTaskGroup, deleteTaskGroup,
    getTaskDetail, launchTask, closeTask, taskFollowup,
    mergeTask, confirmTaskMerge,
    getWorkspaceTree, readFile, getFileInfo, writeFile, createFile, createFolder, renameFile, deleteFile,
    trashList, trashRestore, trashDelete, trashEmpty,
    emit, chatGetModels, chatSendStream, chatStopStream, chatGetHistory, chatDeleteThread,
    chatListThreads, chatCreateThread, chatRenameThread, chatClearThread,
    onChatStreamChunk, onChatResponse, onChatError, onChatThreads,
    executionHistory,
    filterStats, commandHistory, searchEvents, promptHistory,
    getOrchestratorStats, sessionStartedAt,
    sessionCompressionModes, setSessionCompressionMode,
    getTokenUsage,
  } = useSocket()
  // Per-window workspace: one window, one workspace.
  // - App restart (first window, no ?blank): restore the last workspace from
  //   localStorage so you land where you left off.
  // - New windows (?blank=1 from main): always start blank, even if other
  //   windows have workspaces. sessionStorage is per-window.
  const isBlankWindow = useMemo(() => {
    try { return new URLSearchParams(window.location.search).has('blank') } catch { return false }
  }, [])
  const [windowWorkspaceId, setWindowWorkspaceId] = useState<string | null>(() => {
    try {
      if (new URLSearchParams(window.location.search).has('blank')) return null
      return sessionStorage.getItem('agntspce-window-workspace')
        || localStorage.getItem('agntspce-last-workspace')
    } catch { return null }
  })
  useEffect(() => {
    try {
      if (windowWorkspaceId) {
        sessionStorage.setItem('agntspce-window-workspace', windowWorkspaceId)
        localStorage.setItem('agntspce-last-workspace', windowWorkspaceId)
      } else {
        sessionStorage.removeItem('agntspce-window-workspace')
        if (!isBlankWindow) localStorage.removeItem('agntspce-last-workspace')
      }
    } catch {}
  }, [windowWorkspaceId, isBlankWindow])
  void _globalActiveWorkspace
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceInfo | null>(null)
  const activeWorkspace = useMemo(() => {
    if (windowWorkspaceId) {
      const found = workspaces.find(w => w.id === windowWorkspaceId)
      if (found) return found
      if (pendingWorkspace && pendingWorkspace.id === windowWorkspaceId) return pendingWorkspace
    }
    return null
  }, [workspaces, windowWorkspaceId, pendingWorkspace])
  useEffect(() => {
    if (activeWorkspace && pendingWorkspace && pendingWorkspace.id === activeWorkspace.id) {
      setPendingWorkspace(null)
    }
  }, [activeWorkspace, pendingWorkspace])
  const tokensSaved = useMemo(() => {
    const orig = executionHistory.reduce((s: number, e: any) => s + (e.totalOriginalTokens || 0), 0)
    const filt = executionHistory.reduce((s: number, e: any) => s + (e.totalFilteredTokens || 0), 0)
    return orig - filt
  }, [executionHistory])
  const writeBuffersRef = useRef<Record<string, string>>({})
  const MAX_BUFFER_BYTES = 16384
  const [modal, setModal] = useState<ModalState | null>(null)
  const [agentConfigs, setAgentConfigs] = useState<AgentConfig[]>([])
  const [agentModalSession, setAgentModalSession] = useState<string | null>(null)
  const [gitDiffContents, setGitDiffContents] = useState<Record<string, string>>({})
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [deletedWorkspaces, setDeletedWorkspaces] = useState<{ id: string; name: string; deletedAt: string }[]>([])
  const [activeView, setActiveView] = useState<'dashboard' | 'settings' | 'git-review' | 'rtk' | null>(null)
  const [leftDrag, setLeftDrag] = useState(false)
  const [rightDrag, setRightDrag] = useState(false)
  const [terminalDrag, setTerminalDrag] = useState(false)
  const [gitChangeCount, setGitChangeCount] = useState(0)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('agent-workspace-theme') as 'dark' | 'light') || 'dark'
  })
  const [promptCompressionEnabled, setPromptCompressionEnabled] = useState(() => {
    try {
      const prefs = JSON.parse(localStorage.getItem('agent-workspace-prefs') || '{}')
      return prefs.promptCompressionEnabled !== false
    } catch {
      return true
    }
  })
  const [createWorkspaceModalOpen, setCreateWorkspaceModalOpen] = useState(false)
  const [createTaskModalOpen, setCreateTaskModalOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [commanderOpen, setCommanderOpen] = useState(false)
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false)
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState<string | null>(null)

  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  // Persisted per workspace so the explorer reopens exactly as left (VS Code
  // behavior) across app restarts. Guarded by a suppress flag so loading a
  // workspace's saved set doesn't immediately overwrite it with stale state.
  const suppressExpandedSaveRef = useRef(false)
  useEffect(() => {
    const wsId = activeWorkspace?.id
    if (!wsId) return
    suppressExpandedSaveRef.current = true
    try {
      const raw = localStorage.getItem(`agent-workspace-expanded:${wsId}`)
      const arr = raw ? JSON.parse(raw) : null
      setExpandedFolders(new Set(
        Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, 1000) : []
      ))
    } catch {
      setExpandedFolders(new Set())
    }
  }, [activeWorkspace?.id])
  useEffect(() => {
    const wsId = activeWorkspace?.id
    if (!wsId) return
    if (suppressExpandedSaveRef.current) {
      suppressExpandedSaveRef.current = false
      return
    }
    try {
      localStorage.setItem(
        `agent-workspace-expanded:${wsId}`,
        JSON.stringify([...expandedFolders].slice(0, 1000))
      )
    } catch {}
  }, [expandedFolders, activeWorkspace?.id])
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set())
  const dirtyFilesRef = useRef<Set<string>>(new Set())
  useEffect(() => { dirtyFilesRef.current = dirtyFiles }, [dirtyFiles])
  const [editorScrollPositions, setEditorScrollPositions] = useState<Record<string, { line: number; column: number }>>({})
  const scrollPositionsRef = useRef<Record<string, { line: number; column: number }>>({})
  const [viewMode, setViewMode] = useState<'agents' | 'files'>('agents')

  const [agentPickerTrigger, setAgentPickerTrigger] = useState(0)

  const [notifications, setNotifications] = useState<Notification[]>([])

  const [fontSize, setFontSize] = useState(() => {
    try { return parseInt(localStorage.getItem('agent-workspace-font-size') || '16') } catch { return 16 }
  })
  const [fontFamily, setFontFamily] = useState(() => {
    try { return localStorage.getItem('agent-workspace-font-family') || "'JetBrains Mono', 'Fira Code', Menlo, monospace'" } catch { return "'JetBrains Mono', 'Fira Code', Menlo, monospace'" }
  })
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(true)
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false)
  const appBodyRef = useRef<HTMLDivElement>(null)
  const [leftWidth, setLeftWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('agent-workspace-left-width')
      if (saved) return parseInt(saved, 10)
    } catch {}
    return Math.round(window.innerWidth * 0.15)
  })
  const leftWidthRef = useRef(leftWidth)
  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('agent-workspace-chat-width')
      if (saved) return parseInt(saved, 10)
    } catch {}
    return Math.round(window.innerWidth * 0.20)
  })
  const [bottomShellOpen, setBottomShellOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(() => {
    try {
      const saved = localStorage.getItem('agent-workspace-terminal-height')
      if (saved) return parseInt(saved, 10)
    } catch {}
    return 40
  })
  const dragging = useRef<'left' | 'right' | 'terminal' | null>(null)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Active document-level drag listeners — removed on unmount if a drag is
  // still in flight (e.g. workspace switch tears the panel down mid-drag).
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  useEffect(() => { leftWidthRef.current = leftWidth }, [leftWidth])

  useEffect(() => {
    try { localStorage.setItem('agent-workspace-left-width', String(leftWidth)) } catch {}
  }, [leftWidth])

  useEffect(() => {
    try { localStorage.setItem('agent-workspace-chat-width', String(chatWidth)) } catch {}
  }, [chatWidth])

  useEffect(() => {
    try { localStorage.setItem('agent-workspace-terminal-height', String(terminalHeight)) } catch {}
  }, [terminalHeight])

  const [installedAgents, setInstalledAgents] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchAgentConfigs().then(configs => {
      if (configs.length > 0) setAgentConfigs(configs)
      else setAgentConfigs(FALLBACK_AGENTS)
    }).catch(() => setAgentConfigs(FALLBACK_AGENTS))
    fetchInstalledAgents().then(data => {
      setInstalledAgents(new Set(Object.keys(data).filter(k => data[k])))
    }).catch(() => {})
  }, [])

  const refreshDeleted = useCallback(() => {
    listDeletedWorkspaces().then(setDeletedWorkspaces)
  }, [listDeletedWorkspaces])

  useEffect(() => { refreshDeleted() }, [])

  // v2 Tasks: reload the active workspace's task groups whenever the
  // workspace changes or the backend reports a change.
  useEffect(() => {
    if (activeWorkspace?.id) listTaskGroups(activeWorkspace.id).catch(() => {})
  }, [activeWorkspace?.id, listTaskGroups])

  useSocketEvent<{ workspaceId: string }>(onTaskGroupsChanged, (data) => {
    if (!data?.workspaceId || data.workspaceId === activeWorkspace?.id) {
      listTaskGroups(activeWorkspace?.id).catch(() => {})
    }
  }, [onTaskGroupsChanged, activeWorkspace?.id, listTaskGroups])

  const handleCreateTaskGroup = useCallback(async (input: { title: string; userGoal: string; worktreeMode: 'worktree' | 'in-repo'; agents: { agentId: string; model?: string }[]; repoPath?: string }) => {
    const res = await createTaskGroup({ ...input, workspaceId: activeWorkspace?.id })
    if (res?.ok) listTaskGroups(activeWorkspace?.id).catch(() => {})
    return res ?? { ok: false, error: 'No response from server' }
  }, [createTaskGroup, activeWorkspace?.id, listTaskGroups])

  // Mixed-repo workspaces carry per-terminal repositories; offer them as
  // pinned-repo choices. Single-repo workspaces hide the picker.
  const taskRepoChoices = useMemo(() => {
    const out: { name: string; path: string }[] = []
    const seen = new Set<string>()
    const push = (name: string, path: string) => {
      if (!path || seen.has(path)) return
      seen.add(path)
      out.push({ name, path })
    }
    const terms = (activeWorkspace as any)?.terminals
    const list = Array.isArray(terms) ? terms : []
    for (const t of list) {
      if (t?.repository?.path) push(t.repository.name || t.repository.path, t.repository.path)
    }
    if (activeWorkspace?.repository?.path) push(activeWorkspace.name || activeWorkspace.repository.path, activeWorkspace.repository.path)
    return out.length > 1 ? out : []
  }, [activeWorkspace])

  const tasksApi = useMemo(() => ({
    getDetail: getTaskDetail,
    launchTask,
    closeTask,
    taskFollowup,
    mergeTask,
    confirmTaskMerge,
  }), [getTaskDetail, launchTask, closeTask, taskFollowup, mergeTask, confirmTaskMerge])

  useEffect(() => {
    localStorage.setItem('agent-workspace-theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem('agent-workspace-font-size', String(fontSize))
  }, [fontSize])

  useEffect(() => {
    localStorage.setItem('agent-workspace-font-family', fontFamily)
  }, [fontFamily])

  useEffect(() => {
    document.documentElement.style.setProperty('--terminal-height', `${terminalHeight}%`)
  }, [terminalHeight])

  useEffect(() => {
    if (appBodyRef.current) {
      const totalW = appBodyRef.current.getBoundingClientRect().width
      setLeftWidth(Math.round(totalW * 0.12))
    }
  }, [])

  const showModal = useCallback((title: string, onSubmit: (value: string) => void, defaultValue?: string) => {
    setModal({ open: true, title, onSubmit, defaultValue })
  }, [])

  const closeModal = useCallback(() => {
    setModal(null)
  }, [])

  function handleModalSubmit(value: string) {
    modal?.onSubmit(value)
    closeModal()
  }

  const handleStartAgent = useCallback((sessionId: string, config: AgentStartConfig) => {
    startAgent(sessionId, config)
  }, [startAgent])

  const handleShowAgentModal = useCallback((sessionId: string) => {
    setAgentModalSession(sessionId)
  }, [])

  useSocketEvent<TerminalOutput>(onTerminalOutput, (data) => {
    const current = (writeBuffersRef.current[data.sessionId] || '') + data.data
    writeBuffersRef.current[data.sessionId] = current.length > MAX_BUFFER_BYTES
      ? current.slice(-MAX_BUFFER_BYTES)
      : current
  }, [onTerminalOutput])

  const prevSessionRef = useRef<Record<string, SessionState>>({})
  const firstMountRef = useRef(true)
  const notifDebounceRef = useRef<Record<string, number>>({})
  useEffect(() => {
    if (firstMountRef.current) {
      firstMountRef.current = false
      prevSessionRef.current = sessions
      return
    }
    const prev = prevSessionRef.current
    const newNots: Notification[] = []
    const now = Date.now()

    for (const [id, s] of Object.entries(sessions)) {
      const prevS = prev[id]
      if (!prevS) continue
      if (prevS.status !== s.status) {
        if (prevS.status === 'busy' && s.status === 'idle') {
          const key = `complete-${id}`
          if ((notifDebounceRef.current[key] || 0) + 2000 > now) continue
          notifDebounceRef.current[key] = now
          newNots.push({ id: `not-complete-${id}-${now}`, type: 'session-complete', title: 'Task complete', detail: `${s.type} session ${id.slice(-8)} finished`, timestamp: now, read: false })
        }
      }
    }

    for (const id of Object.keys(prev)) {
      if (!sessions[id]) {
        const key = `exit-${id}`
        if ((notifDebounceRef.current[key] || 0) + 2000 > now) continue
        notifDebounceRef.current[key] = now
        newNots.push({ id: `not-exited-${id}-${now}`, type: 'session-exited', title: 'Session closed', detail: `${prev[id].type} session ${id.slice(-8)} ended`, timestamp: now, read: false })
        delete writeBuffersRef.current[id]
      }
    }

    if (newNots.length > 0) {
      setNotifications(prev => [...newNots, ...prev].slice(0, 100))
    }

    prevSessionRef.current = sessions
  }, [sessions])

  // Per-window: do not auto-follow global activeWorkspace — new windows stay blank
  // until the user opens a folder in that window. The window's choice lives
  // in sessionStorage (per-window).
  useEffect(() => {
    // If this window has no selection yet and global has one, keep blank.
    // Only sync windowWorkspaceId when user explicitly picks (via handlers below).
  }, [])

  const editWorkspace = useCallback((id: string, name: string, _path: string) => {
    updateWorkspaceConfig(id, { name }).then(() => refreshWorkspaces())
  }, [updateWorkspaceConfig, refreshWorkspaces])

  const addWorkspace = useCallback((name: string, path: string, scripts?: { setupScript?: string; teardownScript?: string }) => {
    const normalizedPath = path.replace(/\\/g, '/')
    const existingByPath = workspaces.find(w => (w.repository?.path || '').replace(/\\/g, '/') === normalizedPath)
    if (existingByPath) {
      setPendingWorkspace(null)
      setWindowWorkspaceId(existingByPath.id)
      switchWorkspace(existingByPath.id)
      return
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const existingById = workspaces.find(w => w.id === id)
    if (existingById) {
      setPendingWorkspace(null)
      setWindowWorkspaceId(existingById.id)
      switchWorkspace(existingById.id)
      return
    }
    const pending = { id, name, workspaceType: 'single-repo', repository: { path, type: 'generic' } } as WorkspaceInfo
    setPendingWorkspace(pending)
    setWindowWorkspaceId(id)
    createWorkspace({
      id,
      name,
      workspaceType: 'single-repo',
      repository: { path, type: 'generic' },
      worktrees: { enabled: false, count: 0, namingPattern: 'work{n}', autoCreate: false },
      setupScript: scripts?.setupScript,
      teardownScript: scripts?.teardownScript,
    }).then((res: any) => {
      if (res?.ok) {
        switchWorkspace(id)
      } else {
        // If backend says ID exists, it may have been created elsewhere; try to open it
        const fallback = workspaces.find(w => w.id === id)
        if (fallback) {
          setPendingWorkspace(null)
          setWindowWorkspaceId(fallback.id)
          switchWorkspace(fallback.id)
        } else {
          setPendingWorkspace(null)
          setWindowWorkspaceId(null)
          alert(res?.error || 'Failed to create workspace')
        }
      }
    }).catch((e: any) => {
      setPendingWorkspace(null)
      setWindowWorkspaceId(null)
      alert(e?.message || 'Failed to create workspace')
    })
  }, [createWorkspace, switchWorkspace, workspaces])

  const removeWorkspace = useCallback((id: string) => {
    const wsSessions = Object.entries(sessions)
      .filter(([, s]) => s.repositoryName === id || s.id.startsWith(id))
      .map(([sid]) => sid)
    if (wsSessions.length > 0) closeTab(wsSessions)
    if (windowWorkspaceId === id) {
      setWindowWorkspaceId(null)
    }
  }, [sessions, closeTab, windowWorkspaceId])

  const wsPath = activeWorkspace?.repository?.path

  // Single shared git poll for the whole app: per-workspace changed files
  // feed both the activity badge count and the explorer row colors, so every
  // surface reflects the same git truth (connected, not independent polls).
  const [gitFilesByWs, setGitFilesByWs] = useState<Record<string, { filePath: string; status: string }[]>>({})
  useEffect(() => {
    let active = true
    const poll = async () => {
      const entries = await Promise.all(workspaces.map(async (w) => {
        const p = w.repository?.path
        if (!p) return [w.id, []] as const
        try {
          const s = await getGitFullStatus(p)
          const files = (s?.files || []).map((f: any) => ({ filePath: f.filePath, status: f.status }))
          return [w.id, files] as const
        } catch {
          return [w.id, []] as const
        }
      }))
      if (!active) return
      const next: Record<string, { filePath: string; status: string }[]> = {}
      for (const [id, files] of entries) next[id] = files
      setGitFilesByWs(next)
      const activeFiles = entries.find(([id]) => id === activeWorkspace?.id)?.[1] || []
      setGitChangeCount(prev => (prev === activeFiles.length ? prev : activeFiles.length))
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { active = false; clearInterval(id) }
  }, [workspaces, activeWorkspace?.id, getGitFullStatus])

  const [openGroupId, setOpenGroupId] = useState<string | null>(() => {
    try {
      if (!windowWorkspaceId) return null
      return localStorage.getItem(`agntspce-open-group:${windowWorkspaceId}`)
    } catch { return null }
  })
  const [openGroupSessions, setOpenGroupSessions] = useState<string[]>([])
  const [openGroupWorktree, setOpenGroupWorktree] = useState<string | null>(null)
  const openGroupRequestRef = useRef(0)
  useEffect(() => {
    try {
      if (openGroupId && activeWorkspace?.id) {
        sessionStorage.setItem('agntspce-open-group', openGroupId)
        localStorage.setItem(`agntspce-open-group:${activeWorkspace.id}`, openGroupId)
      } else {
        sessionStorage.removeItem('agntspce-open-group')
        if (activeWorkspace?.id) localStorage.removeItem(`agntspce-open-group:${activeWorkspace.id}`)
      }
    } catch {}
  }, [openGroupId, activeWorkspace?.id])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || taskGroups.length === 0) return
    const stored = (() => {
      try { return localStorage.getItem(`agntspce-open-group:${workspaceId}`) } catch { return null }
    })()
    if (stored && taskGroups.some(t => t.id === stored)) {
      setOpenGroupId(prev => prev === stored ? prev : stored)
    }
  }, [activeWorkspace?.id, taskGroups])

  const refreshOpenGroup = useCallback(async (groupId: string | null) => {
    const requestId = ++openGroupRequestRef.current
    if (!groupId) {
      setOpenGroupSessions([])
      setOpenGroupWorktree(null)
      return
    }
    try {
      const res = await getTaskDetail(groupId)
      const subs = res?.detail?.subtasks || []
      const live = new Set<string>()
      for (const sub of subs as any[]) {
        if (sub.sessionId && sessions[sub.sessionId]) live.add(sub.sessionId)
      }
      for (const session of Object.values(sessions)) {
        if (session.taskGroupId === groupId) live.add(session.id)
      }
      if (requestId !== openGroupRequestRef.current) return
      setOpenGroupSessions([...live])
      setOpenGroupWorktree(
        res?.detail?.group?.worktreePath ||
        taskGroups.find(t => t.id === groupId)?.worktreePath ||
        null
      )
    } catch {
      if (requestId !== openGroupRequestRef.current) return
      setOpenGroupSessions([])
      setOpenGroupWorktree(null)
    }
  }, [getTaskDetail, sessions, taskGroups])

  useEffect(() => {
    refreshOpenGroup(openGroupId)
  }, [openGroupId, refreshOpenGroup])

  useSocketEvent<{ workspaceId: string }>(onTaskGroupsChanged, () => {
    if (openGroupId) refreshOpenGroup(openGroupId)
  }, [onTaskGroupsChanged, openGroupId, refreshOpenGroup])

  const groupCreateInFlight = useRef<Promise<{ id: string; worktreePath: string | null } | null> | null>(null)
  const ensureOpenGroupForNewAgent = useCallback((): Promise<{ id: string; worktreePath: string | null } | null> => {
    if (openGroupId) return Promise.resolve({ id: openGroupId, worktreePath: openGroupWorktree })
    if (groupCreateInFlight.current) return groupCreateInFlight.current
    const promise = (async () => {
      if (!activeWorkspace?.id) {
        alert('Open a workspace before adding an agent.')
        return null
      }
      const existing = [...taskGroups].reverse().find(t =>
        t.title === 'Unnamed task' && (t.members || []).every(m => !m.sessionId)
      )
      if (existing) {
        setOpenGroupSessions([])
        setOpenGroupWorktree(existing.worktreePath || null)
        setOpenGroupId(existing.id)
        setSelectedTaskId(null)
        setActiveView(null)
        setFileExplorerOpen(false)
        setViewMode('agents')
        refreshOpenGroup(existing.id)
        return { id: existing.id, worktreePath: existing.worktreePath || null }
      }
      let res: Awaited<ReturnType<typeof createTaskGroup>>
      try {
        res = await createTaskGroup({
          title: 'Unnamed task',
          userGoal: '',
          worktreeMode: 'worktree',
          agents: [],
          workspaceId: activeWorkspace.id,
        })
      } catch (error: any) {
        alert(error?.message || 'Failed to create task')
        return null
      }
      if (!res?.ok || !res.taskGroup?.id) {
        alert(res?.error || 'Failed to create task')
        return null
      }
      listTaskGroups(activeWorkspace.id).catch(() => {})
      setOpenGroupSessions([])
      setOpenGroupWorktree(res.taskGroup.worktreePath || null)
      setOpenGroupId(res.taskGroup.id)
      setSelectedTaskId(null)
      setActiveView(null)
      setFileExplorerOpen(false)
      setViewMode('agents')
      refreshOpenGroup(res.taskGroup.id)
      return { id: res.taskGroup.id, worktreePath: res.taskGroup.worktreePath || null }
    })()
    groupCreateInFlight.current = promise
    promise.finally(() => {
      if (groupCreateInFlight.current === promise) groupCreateInFlight.current = null
    })
    return promise
  }, [activeWorkspace?.id, createTaskGroup, listTaskGroups, openGroupId, openGroupWorktree, refreshOpenGroup, taskGroups])

  const handleSelectTask = useCallback((id: string) => {
    setActiveSessionId(null)
    setOpenGroupSessions([])
    setOpenGroupWorktree(null)
    setOpenGroupId(id)
    refreshOpenGroup(id)
    setActiveView(null)
    setFileExplorerOpen(false)
    setViewMode('agents')
  }, [refreshOpenGroup])
  const fetchGroupMembers = useCallback(async (taskGroupId: string): Promise<TaskMember[]> => {
    try {
      const res = await getTaskDetail(taskGroupId)
      return (res?.detail?.subtasks || []).map((s: any) => ({
        sessionId: (s.sessionId as string | null) ?? null,
        agentId: s.agentId as string,
        status: s.status as string,
        title: s.title as string,
        model: (s.model as string | null) ?? null,
        assignmentPrompt: (s.assignmentPrompt as string) || '',
        subtaskId: (s.id as string) || '',
        lastEventAt: (s.lastEventAt as number | null) ?? null,
      }))
    } catch {
      return []
    }
  }, [getTaskDetail])

  const handleRenameTask = useCallback(async (taskGroupId: string, title: string) => {
    try {
      await renameTaskGroup(taskGroupId, title)
      listTaskGroups(activeWorkspace?.id).catch(() => {})
    } catch {}
  }, [renameTaskGroup, activeWorkspace?.id, listTaskGroups])

  const handleDeleteTask = useCallback(async (taskGroupId: string) => {
    try {
      await deleteTaskGroup(taskGroupId)
      if (openGroupId === taskGroupId) {
        setOpenGroupId(null)
        setOpenGroupSessions([])
        setOpenGroupWorktree(null)
      }
      if (selectedTaskId === taskGroupId) setSelectedTaskId(null)
      listTaskGroups(activeWorkspace?.id).catch(() => {})
    } catch {}
  }, [deleteTaskGroup, openGroupId, selectedTaskId, activeWorkspace?.id, listTaskGroups])

  // Quick-create: title only → empty planning group → open its fresh agents
  // page. Running sessions are untouched; agents added there auto-join.
  const handleQuickCreateTask = useCallback(async (title: string) => {
    try {
      const res = await createTaskGroup({
        title,
        userGoal: '',
        worktreeMode: 'worktree',
        agents: [],
        workspaceId: activeWorkspace?.id,
      })
      if (res?.ok && res.taskGroup?.id) {
        listTaskGroups(activeWorkspace?.id).catch(() => {})
        setActiveSessionId(null)
        setOpenGroupSessions([])
        setOpenGroupWorktree(null)
        setOpenGroupId(res.taskGroup.id)
        // Worktree is created server-side at group creation: record it now
        // so agents added immediately spawn inside it, not the repo root.
        if (res.taskGroup.worktreePath) setOpenGroupWorktree(res.taskGroup.worktreePath)
        setSelectedTaskId(null)
        refreshOpenGroup(res.taskGroup.id)
        setActiveView(null)
        setFileExplorerOpen(false)
        setViewMode('agents')
      } else {
        alert(res?.error || 'Failed to create task')
      }
    } catch (e: any) {
      alert(e?.message || 'Failed to create task')
    }
  }, [createTaskGroup, activeWorkspace?.id, listTaskGroups, refreshOpenGroup])

  const agentSessions = useMemo(() => {
    const all = Object.values(sessions).filter(s => AGENT_TYPE_SET.has(s.type))
    if (!openGroupId) return []
    const memberIds = new Set(
      (taskGroups.find(group => group.id === openGroupId)?.members || [])
        .map(member => member.sessionId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
    return all
      .filter(s => s.taskGroupId === openGroupId || openGroupSessions.includes(s.id) || memberIds.has(s.id))
      .slice(0, 12)
  }, [sessions, taskGroups, openGroupId, openGroupSessions])
  const shellSessions = useMemo(
    () => Object.values(sessions).filter(s => s.type === 'shell'),
    [sessions]
  )

  const handleNewTerminal = useCallback((type?: string) => {
    createRawSession(type, wsPath)
  }, [createRawSession, wsPath])

  const handleToggleChatSidebar = useCallback(() => {
    setChatSidebarOpen(o => {
      if (!o && appBodyRef.current) {
        const totalW = appBodyRef.current.getBoundingClientRect().width
        setChatWidth(Math.round(totalW * 0.15))
      }
      return !o
    })
  }, [])

  const handleToggleWorkspaceSidebar = useCallback(() => {
    setWorkspaceSidebarOpen(o => {
      if (!o && appBodyRef.current) {
        const totalW = appBodyRef.current.getBoundingClientRect().width
        setLeftWidth(Math.round(totalW * 0.12))
      }
      return !o
    })
  }, [])

  const handleToggleBottomShell = useCallback(() => {
    if (!bottomShellOpen && shellSessions.length === 0) {
      handleNewTerminal('shell')
    }
    setBottomShellOpen(o => !o)
  }, [bottomShellOpen, shellSessions.length, handleNewTerminal])

  const handleToggleNewAgentPicker = useCallback(() => {
    setViewMode('agents')
    setActiveView(null)
    setBottomShellOpen(false)
    setSelectedFilePath(null)
    setAgentPickerTrigger(t => t + 1)
  }, [])

  const handleCreateWorkspace = useCallback(() => {
    if (activeWorkspace) {
      alert('This window already has a workspace.\nUse File → New Window to open another project.')
      return
    }
    setCreateWorkspaceModalOpen(true)
  }, [activeWorkspace])

  const handleOpenFolderDirect = useCallback(async () => {
    if (activeWorkspace) {
      alert('This window already has a workspace.\nUse File → New Window to open another project.')
      return
    }
    try {
      const selected = await window.electronAPI?.selectDirectory()
      if (!selected) return
      const defaultName = selected.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Workspace'
      showModal('Workspace name:', (name) => {
        const finalName = name.trim() || defaultName
        addWorkspace(finalName, selected)
      }, defaultName)
    } catch {}
  }, [activeWorkspace, addWorkspace, showModal])

  const handleCloneDirect = useCallback(async () => {
    if (activeWorkspace) {
      alert('This window already has a workspace.\nUse File → New Window to open another project.')
      return
    }
    try {
      const baseFolder = await window.electronAPI?.selectDirectory()
      if (!baseFolder) return
      showModal('Enter GitHub URL:', async (gitUrl) => {
        const url = gitUrl.trim()
        if (!url) return
        const repoName = url.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || 'repo'
        const id = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
        const clonePath = baseFolder.replace(/\\/g, '/').replace(/\/$/, '') + '/' + repoName
        const normalizedClone = clonePath.replace(/\\/g, '/')
        const existingByPath = workspaces.find(w => (w.repository?.path || '').replace(/\\/g, '/') === normalizedClone)
        if (existingByPath) {
          setPendingWorkspace(null)
          setWindowWorkspaceId(existingByPath.id)
          switchWorkspace(existingByPath.id)
          return
        }
        const existingById = workspaces.find(w => w.id === id)
        if (existingById) {
          setPendingWorkspace(null)
          setWindowWorkspaceId(existingById.id)
          switchWorkspace(existingById.id)
          return
        }
        setPendingWorkspace({ id, name: repoName, workspaceType: 'single-repo', repository: { path: clonePath, type: 'git' } } as WorkspaceInfo)
        setWindowWorkspaceId(id)
        try {
          const res = await createWorkspaceFromGit(url, undefined, undefined, baseFolder)
          if (res?.ok) {
            setWindowWorkspaceId(res.workspace.id)
            switchWorkspace(res.workspace.id)
          } else {
            // If backend says already exists, open the existing one
            const fallback = workspaces.find(w => w.id === id)
            if (fallback) {
              setPendingWorkspace(null)
              setWindowWorkspaceId(fallback.id)
              switchWorkspace(fallback.id)
            } else {
              setPendingWorkspace(null)
              setWindowWorkspaceId(null)
              alert(res?.error || 'Failed to clone repository')
            }
          }
        } catch (e: any) {
          const msg = e?.message || ''
          if (msg.includes('already exists')) {
            const fallback = workspaces.find(w => w.id === id)
            if (fallback) {
              setPendingWorkspace(null)
              setWindowWorkspaceId(fallback.id)
              switchWorkspace(fallback.id)
              return
            }
          }
          setPendingWorkspace(null)
          setWindowWorkspaceId(null)
          alert(e?.message || 'Failed to clone repository')
        }
      })
    } catch {}
  }, [activeWorkspace, createWorkspaceFromGit, switchWorkspace, showModal, workspaces])

  async function handleCreateWorkspaceLocal(name: string, path: string, scripts?: { setupScript?: string; teardownScript?: string }) {
    addWorkspace(name, path, scripts)
  }

  async function handleCreateWorkspaceFromGit(gitUrl: string, name?: string, scripts?: { setupScript?: string; teardownScript?: string }) {
    if (activeWorkspace) {
      alert('This window already has a workspace.\nUse File → New Window to open another project.')
      throw new Error('Window already has a workspace')
    }
    const res = await createWorkspaceFromGit(gitUrl, name, scripts)
    if (res?.ok) {
      setWindowWorkspaceId(res.workspace.id)
      switchWorkspace(res.workspace.id)
    } else {
      throw new Error(res?.error || 'Failed to clone repository')
    }
  }

  const handleSelectWorkspace = useCallback((id: string) => {
    setWindowWorkspaceId(id)
    setActiveSessionId(null)
    setOpenGroupId(null)
    setOpenGroupSessions([])
    setOpenGroupWorktree(null)
    switchWorkspace(id)
    setWorkspaceSidebarOpen(true)
    setFileExplorerOpen(false)
    setActiveView(null)
    setViewMode('agents')
    setSelectedFilePath(null)
    if (appBodyRef.current) {
      const totalW = appBodyRef.current.getBoundingClientRect().width
      setLeftWidth(Math.round(totalW * 0.12))
    }
  }, [switchWorkspace])

  const handleToggleView = useCallback((view: 'dashboard' | 'settings' | 'git-review') => {
    setActiveView(prev => prev === view ? null : view)
  }, [])

  const handleLoadWorkspace = useCallback(async () => {
    if (activeWorkspace) {
      alert('This window already has a workspace.\nUse File → New Window to open another project.')
      return
    }
    const result = await window.electronAPI?.importWorkspace()
    if (result?.workspace) {
      handleSelectWorkspace(result.workspace.id)
    }
  }, [handleSelectWorkspace, activeWorkspace])

  function dismissNotification(id: string) {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
  }

  function dismissAllNotifications() {
    setNotifications([])
  }

  // Cmd/Ctrl+R: ask for confirmation inside the active agent's own window
  // before closing it. Only fires while agent panes are visible (not in the
  // file viewer or over a full-page dashboard/settings view). Reads live
  // state through shortcutDepsRef (declared below, read at call time only).
  const requestCloseActiveAgent = useCallback(() => {
    const { activeSessionId, agentSessions, viewMode, activeView } = shortcutDepsRef.current
    if (viewMode !== 'agents' || activeView === 'dashboard' || activeView === 'settings') return
    if (agentSessions.length === 0) return
    const target = activeSessionId && agentSessions.some(s => s.id === activeSessionId)
      ? activeSessionId
      : agentSessions[0].id
    setPendingCloseSessionId(target)
  }, [])

  const commanderCommands = useMemo(() => [
    { id: 'commander', category: 'Navigation', label: 'Open Command Palette', description: 'Search and run commands', combo: 'cmd+k', action: () => { setCommanderOpen(o => !o) } },
    { id: 'new-agent', category: 'Terminals', label: 'New Agent Session', description: 'Create a new AI agent terminal', combo: 'cmd+a', action: () => { handleToggleNewAgentPicker() } },
    { id: 'close-agent', category: 'Terminals', label: 'Close Active Agent', description: 'Confirm inside the pane, then close the active agent session', combo: 'cmd+r', action: () => { requestCloseActiveAgent() } },
    { id: 'new-shell', category: 'Terminals', label: 'New Shell Terminal', description: 'Open a shell terminal', combo: 'cmd+s', action: () => { handleToggleBottomShell() } },
    { id: 'new-workspace', category: 'Workspaces', label: 'Create Workspace', description: 'Create a new workspace', combo: 'cmd+n', action: () => { setCreateWorkspaceModalOpen(true) } },
    { id: 'new-task', category: 'Tasks', label: 'Create Task', description: 'Create a multi-agent task in this workspace', action: () => { setCreateTaskModalOpen(true) } },
    { id: 'load-workspace', category: 'Workspaces', label: 'Open Workspace', description: 'Load a workspace file', combo: 'cmd+o', action: () => { handleLoadWorkspace() } },
    { id: 'new-window', category: 'Terminals', label: 'New Window', description: 'Open a new app window', combo: 'cmd+t', action: () => { window.electronAPI?.newWindow?.() } },
    { id: 'focus-mode', category: 'View', label: 'Toggle Focus Mode', description: 'Dim inactive terminals', combo: 'cmd+f', action: () => { setFocusMode(o => !o) } },
    { id: 'toggle-chat', category: 'View', label: 'Toggle Chat Sidebar', description: 'Show/hide the chat panel', combo: 'cmd+b', action: () => { handleToggleChatSidebar() } },
    { id: 'toggle-workspace-sidebar', category: 'View', label: 'Toggle Workspace Sidebar', description: 'Show/hide workspace list', combo: 'cmd+e', action: () => { handleToggleWorkspaceSidebar() } },
    { id: 'toggle-shell', category: 'View', label: 'Toggle Shell Panel', description: 'Show/hide the bottom shell panel', combo: 'cmd+\\', action: () => { handleToggleBottomShell() } },
    { id: 'show-dashboard', category: 'View', label: 'Show Dashboard', description: 'View workspace stats and activity', combo: 'cmd+d', action: () => { handleToggleView('dashboard') } },
    { id: 'show-git-review', category: 'View', label: 'Show Git Review', description: 'Review git changes and comments', combo: 'cmd+g', action: () => { handleToggleView('git-review') } },
    { id: 'show-settings', category: 'View', label: 'Show Settings', description: 'Configure preferences', combo: 'cmd+j', action: () => { handleToggleView('settings') } },
    { id: 'clear-notifications', category: 'Notifications', label: 'Clear Notifications', description: 'Dismiss all notifications', action: () => { dismissAllNotifications() } },
  ], [setFocusMode, handleToggleChatSidebar, handleToggleWorkspaceSidebar, handleToggleBottomShell, setActiveView, setCommanderOpen, handleLoadWorkspace, handleToggleNewAgentPicker, handleToggleView, requestCloseActiveAgent])

  const shortcuts = useMemo(() => {
    return commanderCommands
      .map(c => {
        if (!c.combo) return null
        const parsed = parseCombo(c.combo)
        if (!parsed) return null
        return { id: c.id, combo: parsed.combo, display: parsed.display, action: c.action }
      })
      .filter((s): s is { id: string; combo: ShortcutCombo; display: string; action: () => void } => s !== null)
  }, [commanderCommands])

  const commanderDisplay = useMemo(() => {
    return commanderCommands.map(c => {
      const parsed = c.combo ? parseCombo(c.combo) : null
      return { ...c, display: parsed?.display }
    })
  }, [commanderCommands])

  const handleDeleteWorkspace = useCallback((id: string) => {
    deleteWorkspace(id)
    removeWorkspace(id)
    setTimeout(refreshDeleted, 500)
  }, [deleteWorkspace, removeWorkspace, refreshDeleted])

  const handleRestoreWorkspace = useCallback((id: string) => {
    restoreWorkspace(id).then(ok => {
      if (ok) refreshDeleted()
    })
  }, [restoreWorkspace, refreshDeleted])

  const handlePermanentDelete = useCallback((id: string) => {
    permanentDeleteWorkspace(id).then(() => refreshDeleted())
  }, [permanentDeleteWorkspace, refreshDeleted])

  // Per-workspace file trash (recycle bin): files deleted in the explorer
  // land here and stay recoverable until removed or the bin is emptied.
  const [fileTrash, setFileTrash] = useState<{ id: string; name: string; relPath: string; isDirectory: boolean; deletedAt: string }[]>([])
  const refreshFileTrash = useCallback(() => {
    const wsId = activeWorkspace?.id
    if (!wsId) {
      setFileTrash([])
      return Promise.resolve()
    }
    return trashList(wsId).then((res: any) => {
      if (res?.ok) setFileTrash(res.entries || [])
    }).catch(() => {})
  }, [activeWorkspace?.id, trashList])

  useEffect(() => {
    refreshFileTrash()
    const id = setInterval(refreshFileTrash, 5000)
    return () => clearInterval(id)
  }, [refreshFileTrash])

  const handleRecoverTrashFile = useCallback((id: string) => {
    const wsId = activeWorkspace?.id
    if (!wsId) return
    trashRestore(wsId, id).then(() => {
      refreshFileTrash()
      setFileTreeRefreshTick(t => t + 1)
    })
  }, [activeWorkspace?.id, trashRestore, refreshFileTrash])

  const handleDeleteTrashFile = useCallback((id: string) => {
    const wsId = activeWorkspace?.id
    if (!wsId) return
    trashDelete(wsId, id).then(() => refreshFileTrash())
  }, [activeWorkspace?.id, trashDelete, refreshFileTrash])

  const handleEmptyFileTrash = useCallback(() => {
    const wsId = activeWorkspace?.id
    if (!wsId) return
    trashEmpty(wsId).then(() => refreshFileTrash())
  }, [activeWorkspace?.id, trashEmpty, refreshFileTrash])

  // Bumped after a trash recover so explorer trees reload and show it again.
  const [fileTreeRefreshTick, setFileTreeRefreshTick] = useState(0)

  const handleSelectAgent = useCallback(async (agentId: string) => {
    if (!AGENT_TYPE_SET.has(agentId)) {
      handleNewTerminal(agentId)
      return
    }
    const group = await ensureOpenGroupForNewAgent()
    if (!group) return
    const groupId = group.id
    let cwd = group.worktreePath
    for (let attempt = 0; !cwd && attempt < 12; attempt++) {
      try {
        const res = await getTaskDetail(groupId)
        const taskGroup = res?.detail?.group
        cwd = taskGroup?.worktreePath || (taskGroup?.worktreeMode === 'in-repo' ? taskGroup?.repoPath : null) || null
        if (cwd) setOpenGroupWorktree(cwd)
      } catch {}
      if (!cwd) await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!cwd) {
      alert('The task workspace is still being prepared. Try again in a moment.')
      return
    }
    const defaultConfig = { agentId, mode: 'fresh', flags: [] }
    createAgentSession(agentId, defaultConfig, cwd, groupId)
  }, [createAgentSession, ensureOpenGroupForNewAgent, getTaskDetail, handleNewTerminal])

  useEffect(() => {
    if (activeSessionId && agentSessions.some(s => s.id === activeSessionId)) return
    setActiveSessionId(agentSessions[0]?.id || null)
  }, [activeSessionId, agentSessions])

  const handleCloseAgentTab = useCallback((sessionId: string) => {
    closeTab([sessionId])
    if (activeSessionId === sessionId) {
      const remaining = agentSessions.filter(s => s.id !== sessionId)
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
    }
  }, [closeTab, activeSessionId, agentSessions])

  const handleCloseConfirm = useCallback((sessionId: string, confirmed: boolean) => {
    setPendingCloseSessionId(null)
    if (confirmed) handleCloseAgentTab(sessionId)
  }, [handleCloseAgentTab])

  const handleNewShell = useCallback(() => {
    handleNewTerminal('shell')
    setBottomShellOpen(true)
  }, [handleNewTerminal])

  const menuActionRef = useRef<Record<string, (...args: any[]) => void>>({})
  menuActionRef.current = {
    handleNewTerminal, handleNewShell, handleCreateWorkspace, emit,
    handleSelectWorkspace, handleToggleChatSidebar, handleToggleWorkspaceSidebar,
    setFocusMode, handleLoadWorkspace, setActiveView, handleToggleBottomShell,
    handleToggleNewAgentPicker, handleToggleView,
  }

  useEffect(() => {
    const unsub = window.electronAPI?.onMenuAction?.((action, data) => {
      const ref = menuActionRef.current
      switch (action) {
        case 'new-agent': ref.handleToggleNewAgentPicker(); break
        case 'new-shell': ref.handleToggleBottomShell(); break
        case 'new-workspace': ref.handleCreateWorkspace(); break
        case 'save-workspace': ref.emit('save-workspace'); break
        case 'save-workspace-as': {
          window.electronAPI?.exportWorkspace().then(path => {
            if (path) alert(`Workspace exported to ${path}`)
          })
          break
        }
        case 'load-workspace': ref.handleLoadWorkspace(); break
        case 'duplicate-workspace': {
          const name = prompt('New workspace name:')
          if (name?.trim()) {
            window.electronAPI?.duplicateWorkspace(name.trim()).then(dup => {
              if (dup) ref.handleSelectWorkspace(dup.id)
            })
          }
          break
        }
        case 'switch-workspace': ref.handleSelectWorkspace(data); break
        case 'toggle-chat-sidebar': ref.handleToggleChatSidebar(); break
        case 'toggle-workspace-sidebar': ref.handleToggleWorkspaceSidebar(); break
        case 'toggle-focus': ref.setFocusMode((o: boolean) => !o); break
        case 'show-dashboard': ref.handleToggleView('dashboard'); break
        case 'show-git-review': ref.handleToggleView('git-review'); break
        case 'show-settings': ref.handleToggleView('settings'); break
        case 'show-shortcuts': alert(
          '⌘A — New Agent\n⌘S — Shell Panel (Save File in file viewer)\n⌘N — New Workspace\n⌘O — Open Workspace\n⌘T — New Window\n' +
          '⌘B — Chat Sidebar\n⌘E — Workspace Sidebar\n⌘F — Focus Mode\n' +
          '⌘D — Dashboard\n⌘G — Git Review\n⌘J — Settings\n⌘K — Command Palette\n' +
          '⌘Tab / ⌘⇧Tab — Cycle Tabs\n⌘1-9 — Go to Tab'
        ); break
        case 'show-about': alert('AgntSpce — Currently in Beta'); break
      }
    })
    return () => unsub?.()
  }, [])

  // Latest session state for the keydown handler — reading through a ref lets
  // the listener stay bound for the app lifetime instead of being removed and
  // re-added on every status flip (which also re-rendered the whole tree).
  const isFileViewerOpen = (viewMode === 'files' || openFiles.some(f => f.isDiff)) && (!activeView || activeView === 'git-review')
  const shortcutDepsRef = useRef({ activeSessionId, agentSessions, viewMode, activeView, isFileViewerOpen, saveFile: null as null | (() => void) })
  shortcutDepsRef.current = { activeSessionId, agentSessions, viewMode, activeView, isFileViewerOpen, saveFile: null }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey
      if (!isMeta) return
      const { activeSessionId, agentSessions } = shortcutDepsRef.current

      if (e.key === 'Tab') {
        e.preventDefault()
        const idx = agentSessions.findIndex(s => s.id === activeSessionId)
        if (idx < 0) {
          if (agentSessions.length > 0) setActiveSessionId(agentSessions[0].id)
          return
        }
        const dir = e.shiftKey ? -1 : 1
        const next = (idx + dir + agentSessions.length) % agentSessions.length
        setActiveSessionId(agentSessions[next].id)
        return
      }

      const num = parseInt(e.key)
      if (num >= 1 && num <= 9 && num <= agentSessions.length) {
        e.preventDefault()
        setActiveSessionId(agentSessions[num - 1].id)
        return
      }

      const match = shortcuts.find(s => eventMatches(e, s.combo))
      if (match) {
        // In the file viewer Cmd+S saves the open file instead of toggling
        // the shell panel. Skip when Monaco already handled it
        // (defaultPrevented) so the file isn't written twice.
        if (match.id === 'new-shell' && shortcutDepsRef.current.isFileViewerOpen && !e.defaultPrevented) {
          e.preventDefault()
          shortcutDepsRef.current.saveFile?.()
          return
        }
        // Don't hijack editing verbs (select-all / save / find) while the
        // user is typing in an input, textarea, Monaco editor or xterm.
        const target = e.target as HTMLElement | null
        const inEditable = !!target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        )
        if (inEditable && /^[asf]$/i.test(e.key)) return
        e.preventDefault()
        match.action()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // shortcuts is stable (static combo list); sessions state read via ref
  }, [shortcuts])

  function onResizerMouseDown(side: 'left' | 'right') {
    return (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragging.current = side
      if (side === 'left') setLeftDrag(true)
      if (side === 'right') setRightDrag(true)
      const startX = e.clientX
      const startLeft = leftWidth
      const startChat = chatWidth

      const leftMin = 140
      const leftMax = Math.round((appBodyRef.current?.getBoundingClientRect().width || window.innerWidth) * 0.30)

      function onMove(ev: MouseEvent) {
        if (!appBodyRef.current) return
        const bodyRect = appBodyRef.current.getBoundingClientRect()
        const totalW = bodyRect.width
        const chatMin = Math.round(totalW * 0.10)
        const chatMax = Math.round(totalW * 0.25)

        if (dragging.current === 'left') {
          const dx = ev.clientX - startX
          let newW = Math.max(leftMin, startLeft + dx)
          if (chatSidebarOpen) {
            newW = Math.min(newW, leftMax, totalW - chatWidth - 200)
          } else {
            newW = Math.min(newW, leftMax)
          }

          const collapseThreshold = Math.round(totalW * 0.05)

          if (newW < collapseThreshold) {
            newW = Math.max(newW, collapseThreshold)
            if (!collapseTimerRef.current) {
              collapseTimerRef.current = setTimeout(() => {
                collapseTimerRef.current = null
                setLeftWidth(0)
                setWorkspaceSidebarOpen(false)
              }, 250)
            }
          } else {
            if (collapseTimerRef.current) {
              clearTimeout(collapseTimerRef.current)
              collapseTimerRef.current = null
            }
          }

          setLeftWidth(newW)
          leftWidthRef.current = newW
        } else if (dragging.current === 'right') {
          const dx = startX - ev.clientX
          let newW = Math.max(chatMin, startChat + dx)
          newW = Math.min(newW, chatMax, totalW - leftWidth - 180)
          setChatWidth(newW)
        }
      }

      function onUp() {
        setLeftDrag(false)
        setRightDrag(false)
        dragging.current = null
        if (collapseTimerRef.current) {
          clearTimeout(collapseTimerRef.current)
          collapseTimerRef.current = null
        }
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        dragCleanupRef.current = null
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      dragCleanupRef.current = onUp
    }
  }

  const onTerminalResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = 'terminal'
    setTerminalDrag(true)
    const startY = e.clientY
    const startHeight = terminalHeight
    const mainContent = e.currentTarget.closest('.main-content')
    const mainHeight = mainContent ? mainContent.getBoundingClientRect().height : window.innerHeight
    const minHeightPct = Math.max(8, Math.round((120 / mainHeight) * 100))
    const maxHeightPct = Math.min(85, Math.round((mainHeight * 0.75 / mainHeight) * 100))

    function onMove(ev: MouseEvent) {
      if (dragging.current !== 'terminal') return
      const dy = startY - ev.clientY
      const newHeight = Math.max(minHeightPct, Math.min(maxHeightPct, startHeight + (dy / mainHeight) * 100))
      setTerminalHeight(Math.round(newHeight))
    }

    function onUp() {
      setTerminalDrag(false)
      dragging.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      dragCleanupRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    dragCleanupRef.current = onUp
  }, [terminalHeight])

  function setView(view: 'dashboard' | 'settings' | null) {
    setActiveView(activeView === view ? null : view)
  }

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (path === '__collapse_all__') {
        next.clear()
        return next
      }
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const expandFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }, [])

  const detectLanguage = useCallback((filePath: string): string => {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      json: 'json', md: 'markdown', css: 'css', html: 'html',
      py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
      cpp: 'cpp', c: 'c', h: 'c', sh: 'shell', bash: 'shell',
      yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
      svg: 'xml', xml: 'xml', env: 'plaintext', gitignore: 'plaintext',
      lock: 'json', vue: 'html', svelte: 'html',
    }
    return langMap[ext] || 'plaintext'
  }, [])

  const openGitDiffTab = useCallback(async (filePath: string, status: string, commitHash?: string) => {
    const tabId = `git-diff:${filePath}:${commitHash || 'staged'}`
    const existing = openFiles.find(f => f.id === tabId)
    if (existing) {
      setActiveFileId(tabId)
      return
    }
    const fileName = filePath.split('/').pop() || filePath
    const diffEntry: OpenFile = {
      id: tabId,
      filePath,
      fileName: `${fileName} (diff)`,
      language: detectLanguage(filePath),
      isDirty: false,
      isDiff: true,
      gitStatus: status,
      commitHash,
    }
    setOpenFiles(prev => [...prev, diffEntry])
    setActiveFileId(tabId)
    setViewMode('files')
    if (gitDiffContents[tabId]) return
    const worktreePath = activeWorkspace?.repository?.path || ''
    if (!worktreePath) return
    const base = commitHash === 'working'
      ? undefined
      : commitHash === 'EMPTY'
        ? 'EMPTY'
        : commitHash ? `${commitHash}^` : '--cached'
    const head = commitHash === 'working' || commitHash === 'EMPTY' ? undefined : commitHash
    getGitFileDiff(worktreePath, filePath, base, head).then(content => {
      if (content) {
        setGitDiffContents(prev => ({ ...prev, [tabId]: content }))
      }
    })
  }, [openFiles, detectLanguage, gitDiffContents, activeWorkspace, getGitFileDiff])

  const selectFile = useCallback(async (filePath: string) => {
    setSelectedFilePath(filePath)
    setViewMode('files')
    setActiveView(null)
    const absPath = wsPath ? wsPath.replace(/\\/g, '/') + '/' + filePath : filePath

    const existingFile = openFiles.find(f => f.filePath === filePath)
    if (existingFile) {
      setActiveFileId(existingFile.id)
      return true
    }

    try {
      const res = await readFile(absPath)
      if (res?.ok) {
        const fileName = filePath.split('/').pop() || filePath
        const newFile: OpenFile = {
          id: filePath,
          filePath,
          fileName,
          language: detectLanguage(filePath),
          isDirty: false,
        }
        setOpenFiles(prev => [...prev, newFile])
        setActiveFileId(filePath)
        setFileContents(prev => ({ ...prev, [filePath]: res.content }))
        return true
      }
    } catch (err) {
      console.error('Failed to read file:', err)
    }
    return false
  }, [wsPath, openFiles, readFile, detectLanguage])

  const closeFile = useCallback((fileId: string) => {
    // Compute the next active file outside the updater — updaters must stay
    // pure (they run twice under StrictMode).
    setOpenFiles(prev => prev.filter(f => f.id !== fileId))
    if (activeFileId === fileId) {
      const idx = openFiles.findIndex(f => f.id === fileId)
      const next = openFiles.filter(f => f.id !== fileId)
      if (next.length > 0) {
        const newIdx = Math.min(idx, next.length - 1)
        setActiveFileId(next[newIdx].id)
      } else {
        setActiveFileId(null)
      }
    }
    setFileContents(prev => {
      const next = { ...prev }
      delete next[fileId]
      return next
    })
    setDirtyFiles(prev => {
      const next = new Set(prev)
      next.delete(fileId)
      return next
    })
    setGitDiffContents(prev => {
      const next = { ...prev }
      delete next[fileId]
      return next
    })
    // Keep the current main view: closing the last tab lands on the viewer
    // empty state (No files here + New/Open buttons) instead of agents.
    setSelectedFilePath(null)
  }, [activeFileId, openFiles])

  // Drop viewer tabs showing a deleted path (file or anything under a
  // deleted folder, including diff tabs). Falls back to a remaining tab, or
  // back to the agents section when nothing is left open.
  const handleExplorerFileDeleted = useCallback((relPath: string) => {
    refreshFileTrash()
    const matches = (filePath: string) => filePath === relPath || filePath.startsWith(`${relPath}/`)
    const remaining = openFiles.filter(f => !matches(f.filePath))
    const removedIds = new Set(openFiles.filter(f => matches(f.filePath)).map(f => f.id))
    if (removedIds.size === 0) return
    setOpenFiles(remaining)
    if (activeFileId && removedIds.has(activeFileId)) {
      if (remaining.length > 0) {
        const idx = openFiles.findIndex(f => f.id === activeFileId)
        const next = remaining[Math.min(Math.max(0, idx), remaining.length - 1)]
        setActiveFileId(next.id)
      } else {
        setActiveFileId(null)
      }
    }
    setFileContents(prev => {
      const next = { ...prev }
      for (const id of removedIds) delete next[id]
      return next
    })
    setDirtyFiles(prev => {
      const next = new Set(prev)
      for (const id of removedIds) next.delete(id)
      return next
    })
    setGitDiffContents(prev => {
      const next = { ...prev }
      for (const id of removedIds) delete next[id]
      return next
    })
    // Keep the current main view: if the viewer was open it now shows the
    // empty state (No files here + New/Open buttons) instead of jumping away.
    setSelectedFilePath(null)
  }, [openFiles, activeFileId, refreshFileTrash])

  // Hide the file viewer and show the agents section. Open files (and their
  // dirty state) are kept — reopening any file returns to the viewer.
  const handleCloseFileViewer = useCallback(() => {
    setViewMode('agents')
  }, [])

  // File Explorer empty-state: create a file at the active workspace root,
  // then open it in the viewer.
  const handleNewFileFromExplorer = useCallback(() => {
    const root = wsPath?.replace(/\\/g, '/')
    if (!root) {
      alert('No workspace selected.')
      return
    }
    showModal('New file name:', (name) => {
      const trimmed = name.trim().replace(/\\/g, '/')
      if (!trimmed) return
      const dot = trimmed.lastIndexOf('.')
      if (!(dot >= 0 && dot < trimmed.length - 1)) {
        alert('Please add a file extension.')
        return
      }
      createFile(`${root}/${trimmed}`).then((res: any) => {
        if (res?.ok) {
          setFileTreeRefreshTick(t => t + 1)
          selectFile(trimmed)
        } else {
          alert(`Could not create "${trimmed}"${res?.error ? `: ${res.error}` : '.'}`)
        }
      })
    })
  }, [wsPath, showModal, createFile, selectFile])

  // File viewer empty-state: open a file via the native system file picker
  // (same Finder-style dialog as workspace creation), scoped to files
  // inside the active workspace so they stay editable and savable.
  const handleOpenFileByPath = useCallback(() => {
    if (!wsPath) {
      alert('No workspace selected.')
      return
    }
    window.electronAPI?.selectFile?.().then((picked: string | null | undefined) => {
      if (!picked) return
      const root = wsPath.replace(/\\/g, '/')
      const norm = picked.replace(/\\/g, '/')
      const rel = norm === root ? '' : norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : null
      if (!rel) {
        alert('Please pick a file inside the active workspace.')
        return
      }
      selectFile(rel).then(ok => {
        if (!ok) alert(`Could not open "${rel}".`)
      })
    })
  }, [wsPath, selectFile])

  // Workspace select inside the File Explorer section: switch + expand the
  // workspace but never leave the current main view (no agents jump).
  const handleSelectWorkspaceFilesOnly = useCallback((id: string) => {
    switchWorkspace(id)
    expandFolder(`ws:${id}`)
  }, [switchWorkspace, expandFolder])

  const handleFileContentChange = useCallback((value: string | undefined) => {
    if (!activeFileId || value === undefined) return
    setFileContents(prev => ({ ...prev, [activeFileId]: value }))
    if (dirtyFilesRef.current.has(activeFileId)) return
    setDirtyFiles(prev => {
      const next = new Set(prev)
      next.add(activeFileId)
      return next
    })
    setOpenFiles(prev => prev.map(f =>
      f.id === activeFileId ? { ...f, isDirty: true } : f
    ))
  }, [activeFileId])

  const handleSaveFile = useCallback(async () => {
    if (!activeFileId) return
    const absPath = wsPath ? wsPath.replace(/\\/g, '/') + '/' + activeFileId : activeFileId
    const content = fileContents[activeFileId]
    if (content === undefined) return
    try {
      const res = await writeFile(absPath, content)
      if (res?.ok) {
        setDirtyFiles(prev => {
          const next = new Set(prev)
          next.delete(activeFileId)
          return next
        })
        setOpenFiles(prev => prev.map(f =>
          f.id === activeFileId ? { ...f, isDirty: false } : f
        ))
      }
    } catch (err) {
      console.error('Failed to save file:', err)
    }
  }, [activeFileId, wsPath, fileContents, writeFile])

  // Publish the latest viewer state for the app-lifetime keydown handler.
  shortcutDepsRef.current.saveFile = handleSaveFile
  shortcutDepsRef.current.isFileViewerOpen = isFileViewerOpen

  const handleEditorScrollChange = useCallback((line: number, column: number) => {
    if (!activeFileId) return
    const prev = scrollPositionsRef.current[activeFileId]
    if (prev && prev.line === line && prev.column === column) return
    scrollPositionsRef.current = { ...scrollPositionsRef.current, [activeFileId]: { line, column } }
    setEditorScrollPositions(prev => ({
      ...prev,
      [activeFileId]: { line, column },
    }))
  }, [activeFileId])

  const activeFile = useMemo(
    () => openFiles.find(f => f.id === activeFileId) || null,
    [openFiles, activeFileId],
  )
  const activeFileContent = activeFileId ? fileContents[activeFileId] : ''
  const isActiveFileDirty = activeFileId ? dirtyFiles.has(activeFileId) : false

  const pageViews = useMemo(() => [
    { id: 'dashboard', label: 'Dashboard', icon: '◉', render: () => (
      <Suspense fallback={<div className="panel-suspense-fallback" />}>
        <Dashboard
          workspaces={workspaces}
          sessions={sessions}
          activeWorkspace={activeWorkspace}
          deletedWorkspaces={deletedWorkspaces}
          onSelect={(id) => { switchWorkspace(id); setActiveView(null); setViewMode('agents'); setSelectedFilePath(null) }}
          onDelete={handleDeleteWorkspace}
          onRestore={handleRestoreWorkspace}
          onPermanentDelete={handlePermanentDelete}
          onNewWorkspace={handleCreateWorkspace}
          onClose={() => setActiveView(null)}
          filterStats={filterStats}
          searchEvents={searchEvents}
          commandHistory={commandHistory}
          promptHistory={promptHistory}
          getOrchestratorStats={getOrchestratorStats}
        />
      </Suspense>
    )},
    { id: 'settings', label: 'Settings', icon: '⚙', render: () => (
      <Settings theme={theme} onThemeChange={setTheme} onFontSizeChange={setFontSize} onFontFamilyChange={setFontFamily} onPrefsChange={(prefs) => { setPromptCompressionEnabled(prefs.promptCompressionEnabled !== false); setUserSettings({ autoRestartSessions: prefs.autoStart }) }} onClose={() => setActiveView(null)} />
    )},
  ], [workspaces, sessions, activeWorkspace, deletedWorkspaces, switchWorkspace, handleDeleteWorkspace, handleRestoreWorkspace, handlePermanentDelete, handleCreateWorkspace, filterStats, searchEvents, commandHistory, promptHistory, getOrchestratorStats, theme, setUserSettings])

  const agentsList = useMemo(() => AGENTS_LIST.filter(a => installedAgents.has(a.id)), [installedAgents])

  const chatSocket = useMemo(() => ({
    chatGetModels,
    chatSendStream,
    chatStopStream,
    chatGetHistory,
    chatListThreads,
    chatCreateThread,
    chatRenameThread,
    chatClearThread,
    chatDeleteThread,
    onChatStreamChunk,
    onChatResponse,
    onChatError,
    onChatThreads,
  }), [chatGetModels, chatSendStream, chatStopStream, chatGetHistory, chatListThreads, chatCreateThread, chatRenameThread, chatClearThread, chatDeleteThread, onChatStreamChunk, onChatResponse, onChatError, onChatThreads])

  const handleViewChange = useCallback((view: string | null) => {
    setActiveView(view as typeof activeView)
  }, [])

  return (
    <div className="app">
      <TitleBar
        getOrchestratorStats={getOrchestratorStats}
        onAddAgent={handleToggleNewAgentPicker}
        onSelectAgent={handleSelectAgent}
        agentsList={agentsList}
        agentPickerTrigger={agentPickerTrigger}
        onToggleChatSidebar={handleToggleChatSidebar}
        chatSidebarOpen={chatSidebarOpen}
      />
      <div className="app-body" ref={appBodyRef}>
          <div className="activity-bar">
            <div className="activity-bar-top">
              <div className="activity-logo" title="AgntSpce">
                <img src={assetUrl('/img/logo.png')} alt="AgntSpce" width="24" height="24" style={{ objectFit: 'contain' }} />
              </div>
              <button
                className="activity-bar-btn active"
                onClick={() => {
                  if (activeView === 'git-review' || !workspaceSidebarOpen) {
                    setWorkspaceSidebarOpen(true)
                    setFileExplorerOpen(false)
                    setActiveView(null)
                    setViewMode('agents')
                  } else {
                    setWorkspaceSidebarOpen(false)
                  }
                }}
                title="Explorer (Workspaces)"
              >
                <svg width="24" height="24" viewBox="0 0 256 256" fill="none" aria-hidden="true">
                  <g transform="translate(1.4065934065934016 1.4065934065934016) scale(2.81 2.81)">
                    <path d="M 45 44.652 c -0.196 0 -0.392 -0.039 -0.576 -0.116 L 0.908 26.21 C 0.358 25.979 0 25.44 0 24.843 s 0.358 -1.136 0.908 -1.367 L 44.425 5.151 c 0.367 -0.156 0.784 -0.155 1.151 0 l 43.516 18.325 c 0.551 0.231 0.908 0.77 0.908 1.367 s -0.357 1.136 -0.908 1.367 L 45.576 44.535 C 45.392 44.613 45.196 44.652 45 44.652 z M 5.307 24.843 L 45 41.559 l 39.693 -16.716 L 45 8.128 L 5.307 24.843 z" fill="currentColor" />
                    <path d="M 45 64.809 c -0.196 0 -0.392 -0.039 -0.576 -0.116 L 0.908 46.367 c -0.755 -0.318 -1.11 -1.188 -0.791 -1.943 c 0.317 -0.755 1.188 -1.11 1.943 -0.791 L 45 61.715 l 42.94 -18.082 c 0.759 -0.318 1.625 0.037 1.943 0.791 c 0.318 0.755 -0.037 1.625 -0.792 1.943 L 45.576 64.693 C 45.392 64.77 45.196 64.809 45 64.809 z" fill="currentColor" />
                    <path d="M 45 84.966 c -0.196 0 -0.392 -0.039 -0.576 -0.116 L 0.908 66.525 c -0.755 -0.319 -1.11 -1.188 -0.791 -1.943 c 0.317 -0.755 1.188 -1.11 1.943 -0.792 L 45 81.872 L 87.94 63.79 c 0.759 -0.319 1.625 0.038 1.943 0.792 c 0.318 0.755 -0.037 1.625 -0.792 1.943 L 45.576 84.85 C 45.392 84.927 45.196 84.966 45 84.966 z" fill="currentColor" />
                  </g>
                </svg>
              </button>
              <button
                className={`activity-bar-btn ${fileExplorerOpen ? 'active' : ''}`}
                onClick={() => {
                  if (fileExplorerOpen) {
                    setFileExplorerOpen(false)
                  } else {
                    setFileExplorerOpen(true)
                    setWorkspaceSidebarOpen(false)
                    setActiveView(null)
                    setViewMode('files')
                  }
                }}
                title="File Explorer"
              >
                <i className="codicon codicon-file" style={{ fontSize: 24 }}></i>
              </button>
              <button
                className={`activity-bar-btn ${activeView === 'git-review' ? 'active' : ''}`}
                onClick={() => {
                  if (activeView === 'git-review') {
                    setActiveView(null)
                  } else {
                    setWorkspaceSidebarOpen(false)
                    setFileExplorerOpen(false)
                    setActiveView('git-review')
                  }
                }}
                title="Source Control"
              >
                <i className="codicon codicon-source-control" style={{ fontSize: 24 }}></i>
                {gitChangeCount > 0 && (
                  <span className="activity-bar-badge">{gitChangeCount > 99 ? '99+' : gitChangeCount}</span>
                )}
              </button>
            </div>
            <div className="activity-bar-bottom">
              <button
                className={`activity-bar-btn ${bottomShellOpen ? 'active' : ''}`}
                onClick={() => { if (bottomShellOpen) { setBottomShellOpen(false) } else { if (shellSessions.length === 0) handleNewTerminal('shell'); setBottomShellOpen(true); setActiveView(null) } }}
                title="Terminal"
              >
                <i className="codicon codicon-terminal" style={{ fontSize: 24 }}></i>
              </button>
              <button
                className={`activity-bar-btn ${activeView === 'dashboard' ? 'active' : ''}`}
                onClick={() => setView('dashboard')}
                title="Dashboard"
              >
                <i className="codicon codicon-dashboard" style={{ fontSize: 24 }}></i>
              </button>
              <button
                className={`activity-bar-btn ${activeView === 'settings' ? 'active' : ''}`}
                onClick={() => setView('settings')}
                title="Settings"
              >
                <i className="codicon codicon-settings-gear" style={{ fontSize: 24 }}></i>
              </button>
              {tokensSaved > 0 && (
                <div className="activity-bar-tokens" title={`${tokensSaved.toLocaleString()} tokens saved`}>
                  <i className="codicon codicon-organization" style={{ fontSize: 14 }}></i>
                  <span>{tokensSaved >= 1000 ? `${(tokensSaved / 1000).toFixed(1)}k` : tokensSaved}</span>
                </div>
              )}
            </div>
          </div>
        <div className={`panel-left${leftDrag ? ' no-transition' : ''}`} style={{ width: (workspaceSidebarOpen || activeView === 'git-review' || fileExplorerOpen) ? leftWidth : 0 }}>
          {workspaceSidebarOpen && activeView !== 'git-review' && !fileExplorerOpen && (
            <WorkspaceSidebar
              workspaces={workspaces}
              sessions={sessions}
              activeWorkspace={activeWorkspace}
              deletedWorkspaces={deletedWorkspaces}
              onSelect={handleSelectWorkspace}
              onAdd={addWorkspace}
              onEdit={editWorkspace}
              onRemove={removeWorkspace}
              onDelete={handleDeleteWorkspace}
              onRestore={handleRestoreWorkspace}
              onPermanentDelete={handlePermanentDelete}
              showModal={showModal}
              closeModal={closeModal}
              onOpenCreateModal={handleCreateWorkspace}
              onOpenFolderDirect={handleOpenFolderDirect}
              onCloneDirect={handleCloneDirect}
              activeSessionId={activeSessionId}
              onSelectSession={setActiveSessionId}
              promptHistory={promptHistory}
              executionHistory={executionHistory}
              commandHistory={commandHistory}
              agentConfigs={agentConfigs}
              sessionBuffersRef={writeBuffersRef}
              appBootTime={sessionStartedAt}
               taskGroups={taskGroups}
               onOpenCreateTaskModal={() => setCreateTaskModalOpen(true)}
               selectedTaskId={selectedTaskId}
               openTaskId={openGroupId}
               onSelectTask={handleSelectTask}
              onCreateTask={handleQuickCreateTask}
              onFetchMembers={fetchGroupMembers}
              onTerminalOutput={onTerminalOutput}
              onSessionResumed={onSessionResumed}
              getTokenUsage={getTokenUsage}
              onRenameTask={handleRenameTask}
              onDeleteTask={handleDeleteTask}
              onOpenTaskDetails={setSelectedTaskId}
            />
          )}
          {activeView === 'git-review' && (
            <Suspense fallback={<div className="panel-suspense-fallback" />}>
              <GitReviewPanel
                worktreePath={activeWorkspace?.repository?.path || ''}
                onSelectDiff={(filePath, status, commitHash) => openGitDiffTab(filePath, status, commitHash)}
                getGitFullStatus={getGitFullStatus}
                getGitFileDiff={getGitFileDiff}
                getGitLog={getGitLog}
                getGitBranches={getGitBranches}
                getGitCommitFiles={getGitCommitFiles}
                gitStageFile={gitStageFile}
                gitUnstageFile={gitUnstageFile}
                gitCommit={gitCommit}
                gitPull={gitPull}
                gitPush={gitPush}
                gitFetch={gitFetch}
              />
            </Suspense>
          )}
          {fileExplorerOpen && (
            <WorkspaceSidebar
              workspaces={workspaces}
              sessions={sessions}
              activeWorkspace={activeWorkspace}
              deletedWorkspaces={deletedWorkspaces}
              onSelect={handleSelectWorkspaceFilesOnly}
              onAdd={addWorkspace}
              onEdit={editWorkspace}
              onRemove={removeWorkspace}
              onDelete={handleDeleteWorkspace}
              onRestore={handleRestoreWorkspace}
              onPermanentDelete={handlePermanentDelete}
              showModal={showModal}
              closeModal={closeModal}
              onOpenCreateModal={handleCreateWorkspace}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              onExpandFolder={expandFolder}
              selectedFilePath={selectedFilePath}
              onSelectFile={selectFile}
              onFileDeleted={handleExplorerFileDeleted}
              getWorkspaceTree={getWorkspaceTree}
              getFileInfo={getFileInfo}
              gitFilesByWorkspace={gitFilesByWs}
              fileTreeRefreshTick={fileTreeRefreshTick}
              createFile={createFile}
              createFolder={createFolder}
              renameFile={renameFile}
              deleteFile={deleteFile}
              title="File Explorer"
              rowIcon="file"
              hideCreateButton
            />
          )}
        </div>
        {(workspaceSidebarOpen || activeView === 'git-review' || fileExplorerOpen) && <div className="resizer" onMouseDown={onResizerMouseDown('left')} />}
        <main className={`main-content${(viewMode === 'files' || openFiles.some(f => f.isDiff)) && (!activeView || activeView === 'git-review') ? ' file-viewer' : ''}`}>
          {!activeWorkspace ? (
            <div className="welcome-page">
              <div className="welcome-page-content">
                <img src={assetUrl('/img/logo.png')} alt="AgntSpce" width="64" height="64" style={{ objectFit: 'contain', opacity: 0.9 }} />
                <h2>No folder opened</h2>
                <p>One window, one workspace. Open a folder or clone a repository to get started.</p>
                <div className="welcome-actions">
                  <button className="welcome-btn primary" onClick={handleOpenFolderDirect}>
                    <i className="codicon codicon-folder-opened" style={{ marginRight: 6 }}></i>
                    Open Folder
                  </button>
                  <button className="welcome-btn" onClick={handleCloneDirect}>
                    <i className="codicon codicon-source-control" style={{ marginRight: 6 }}></i>
                    Clone from GitHub
                  </button>
                </div>
                <p className="welcome-hint">Local Folder · Clone from Git — shown in the Workspace section</p>
              </div>
            </div>
          ) : (
            <>
              {(viewMode === 'files' || openFiles.some(f => f.isDiff)) && (!activeView || activeView === 'git-review') && (
                <div className="editor-area">
                  {openFiles.length > 0 ? (
                    <>
                      <EditorTabs
                        openFiles={openFiles}
                        activeFileId={activeFileId}
                        onSelectFile={(id) => {
                          setActiveFileId(id)
                          if (!openFiles.find(f => f.id === id)?.isDiff) {
                            setSelectedFilePath(id)
                          }
                        }}
                        onCloseFile={closeFile}
                        onCloseViewer={handleCloseFileViewer}
                      />
                      {activeFile?.isDiff ? (
                        <GitDiffViewer
                          key={activeFile.id}
                          diffContent={gitDiffContents[activeFile.id] || ''}
                          filePath={activeFile.filePath}
                          gitStatus={activeFile.gitStatus || ''}
                          theme={theme}
                          language={activeFile.language}
                        />
                      ) : activeFile ? (
                        <Suspense fallback={<div className="editor-suspense-fallback" />}>
                          <CodeEditor
                            key={activeFile.id}
                            filePath={activeFile.filePath}
                            content={activeFileContent}
                            language={activeFile.language}
                            isDirty={isActiveFileDirty}
                            theme={theme}
                            fontSize={fontSize}
                            fontFamily={fontFamily}
                            scrollPosition={editorScrollPositions[activeFile.id] || null}
                            onContentChange={handleFileContentChange}
                            onSave={handleSaveFile}
                            onScrollChange={handleEditorScrollChange}
                          />
                        </Suspense>
                      ) : null}
                    </>
                  ) : (
                    <div className="editor-empty-state">
                      <div className="editor-empty-state-content">
                        <i className="codicon codicon-file" style={{ fontSize: 48, opacity: 0.3 }}></i>
                        <p>No files here</p>
                        <div className="open-files-actions">
                          <button className="open-files-btn" onClick={handleNewFileFromExplorer}>New File</button>
                          <button className="open-files-btn" onClick={handleOpenFileByPath}>Open File</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <TerminalArea
            sessions={agentSessions}
            shellSessions={shellSessions}
            onInput={sendTerminalInput}
            onResize={sendTerminalResize}
            onRestart={restartSession}
            onResumeSession={resumeSession}
            onStartAgent={handleStartAgent}
            onShowAgentModal={handleShowAgentModal}
            onNewAgent={NOOP}
            onSelectAgent={handleSelectAgent}
            onNewShell={handleNewShell}
            onCloseTab={handleCloseAgentTab}
            onActiveSessionChange={setActiveSessionId}
            activeSessionId={activeSessionId}
            writeBuffersRef={writeBuffersRef}
            agentConfigs={agentConfigs}
            focusMode={focusMode}
            agentsList={agentsList}
            bottomShellOpen={bottomShellOpen}
            onToggleShell={handleToggleBottomShell}
            chatSidebarOpen={chatSidebarOpen}
            shellOnly={viewMode === 'files'}
            onToggleChatSidebar={handleToggleChatSidebar}
            onTerminalOutput={onTerminalOutput}
            sessionCompressionModes={sessionCompressionModes}
            promptCompressionEnabled={promptCompressionEnabled}
            onSessionCompressionModeChange={setSessionCompressionMode}
            onTerminalResizerMouseDown={onTerminalResizerMouseDown}
            terminalHeight={terminalHeight}
            terminalDrag={terminalDrag}
            agentPickerTrigger={agentPickerTrigger}
            pageViews={pageViews}
            activeView={activeView}
            onViewChange={handleViewChange}
            fontSize={fontSize}
            fontFamily={fontFamily}
            pendingCloseSessionId={pendingCloseSessionId}
            onCloseConfirm={handleCloseConfirm}
          />
            </>
          )}
        </main>
        <div className="resizer" style={{ opacity: chatSidebarOpen ? 1 : 0, pointerEvents: chatSidebarOpen ? 'auto' : 'none' }} onMouseDown={onResizerMouseDown('right')} />
        <div className={`panel-right${rightDrag ? ' no-transition' : ''}`} style={{ width: chatSidebarOpen ? chatWidth : 0 }}>
          {chatSidebarOpen && (
            <Suspense fallback={<div className="panel-suspense-fallback" />}>
              <ChatSidebar
                onClose={() => setChatSidebarOpen(false)}
                onNavigateToSettings={() => setActiveView('settings')}
                socket={chatSocket}
              />
            </Suspense>
          )}
        </div>
      </div>
      <CreateWorkspaceModal
        open={createWorkspaceModalOpen}
        onClose={() => setCreateWorkspaceModalOpen(false)}
        onCreateLocal={handleCreateWorkspaceLocal}
        onCreateFromGit={handleCreateWorkspaceFromGit}
      />
      <CreateTaskModal
        open={createTaskModalOpen}
        onClose={() => setCreateTaskModalOpen(false)}
        onCreate={handleCreateTaskGroup}
        onLaunched={(taskGroupId: string) => {
          setCreateTaskModalOpen(false)
          setActiveView(null)
          setFileExplorerOpen(false)
          setViewMode('agents')
          listTaskGroups(activeWorkspace?.id).catch(() => {})
          setActiveSessionId(null)
          setOpenGroupSessions([])
          setOpenGroupWorktree(null)
          setOpenGroupId(taskGroupId)
          refreshOpenGroup(taskGroupId)
        }}
        agentsList={agentsList}
        repoName={activeWorkspace?.name || ''}
        repoPath={activeWorkspace?.repository?.path || ''}
        availableRepos={taskRepoChoices}
      />
      {selectedTaskId && (
        <TaskChat
          taskGroupId={selectedTaskId}
          tasksApi={tasksApi}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
      <InputModal
        open={modal?.open || false}
        title={modal?.title || ''}
        defaultValue={modal?.defaultValue}
        onSubmit={handleModalSubmit}
        onCancel={closeModal}
      />
      <AgentModal
        open={agentModalSession !== null}
        sessionId={agentModalSession}
        agentConfigs={agentConfigs}
        onStart={handleStartAgent}
        onClose={() => setAgentModalSession(null)}
      />
      {commanderOpen && (
        <CommanderPanel commands={commanderDisplay} onClose={() => setCommanderOpen(false)} />
      )}
      {notificationPanelOpen && (
        <NotificationPanel
          notifications={notifications}
          onDismiss={dismissNotification}
          onDismissAll={dismissAllNotifications}
          onClose={() => setNotificationPanelOpen(false)}
        />
      )}
      <StatusBar
        sessions={sessions}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        notificationPanelOpen={notificationPanelOpen}
        onNotificationClick={() => setNotificationPanelOpen(o => !o)}
        unreadCount={notifications.filter(n => !n.read).length}
        fileTrash={fileTrash}
        onRecoverFile={handleRecoverTrashFile}
        onDeleteTrashFile={handleDeleteTrashFile}
        onEmptyTrash={handleEmptyFileTrash}
      />
    </div>
  )
}

export default App
