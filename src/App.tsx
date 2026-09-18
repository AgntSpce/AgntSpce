import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'

import WorkspaceSidebar from './components/WorkspaceSidebar'
import TerminalArea from './components/TerminalArea'
import InputModal from './components/InputModal'
import AgentModal from './components/AgentModal'
import CreateWorkspaceModal from './components/CreateWorkspaceModal'
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

import type { TerminalOutput, AgentConfig, AgentStartConfig, SessionState, OpenFile } from './types'
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
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }],
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
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }],
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
    modes: [{ id: 'fresh', name: 'Fresh', description: 'Start new session' }, { id: 'continue', name: 'Continue', description: 'Continue last session' }],
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
    sessions, workspaces, activeWorkspace,
    onTerminalOutput, sendTerminalInput, sendTerminalResize,
    restartSession, resumeSession, switchWorkspace, createWorkspace,
    deleteWorkspace, listDeletedWorkspaces, restoreWorkspace, permanentDeleteWorkspace,
    closeTab, startAgent, fetchAgentConfigs, fetchInstalledAgents, createRawSession, createAgentSession,
    createWorkspaceFromGit,
    getGitFileDiff, getGitLog, getGitBranches, getGitCommitFiles,
    getGitFullStatus, gitStageFile, gitUnstageFile, gitCommit, gitPull, gitPush, gitFetch,
    setUserSettings, updateWorkspaceConfig, refreshWorkspaces,
    getWorkspaceTree, readFile, getFileInfo, writeFile, createFile, createFolder, renameFile, deleteFile,
    trashList, trashRestore, trashDelete, trashEmpty,
    emit, chatGetModels, chatSendStream, chatStopStream, chatGetHistory, chatDeleteThread,
    chatListThreads, chatCreateThread, chatRenameThread, chatClearThread,
    onChatStreamChunk, onChatResponse, onChatError, onChatThreads,
    executionHistory,
    filterStats, commandHistory, searchEvents, promptHistory,
    getOrchestratorStats,
    sessionCompressionModes, setSessionCompressionMode,
  } = useSocket()
  const tokensSaved = useMemo(() => {
    const orig = executionHistory.reduce((s: number, e: any) => s + (e.totalOriginalTokens || 0), 0)
    const filt = executionHistory.reduce((s: number, e: any) => s + (e.totalFilteredTokens || 0), 0)
    return orig - filt
  }, [executionHistory])
  const writeBuffersRef = useRef<Record<string, string>>({})
  const MAX_BUFFER_BYTES = 16384
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
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
  const [createWorkspaceModalOpen, setCreateWorkspaceModalOpen] = useState(false)
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

  useEffect(() => {
    if (activeWorkspace?.id && activeWorkspaceId !== activeWorkspace.id) {
      setActiveWorkspaceId(activeWorkspace.id)
    }
  }, [activeWorkspace])

  const editWorkspace = useCallback((id: string, name: string, _path: string) => {
    updateWorkspaceConfig(id, { name }).then(() => refreshWorkspaces())
  }, [updateWorkspaceConfig, refreshWorkspaces])

  const addWorkspace = useCallback((name: string, path: string, scripts?: { setupScript?: string; teardownScript?: string }) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
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
      }
    })
  }, [createWorkspace, switchWorkspace])

  const removeWorkspace = useCallback((id: string) => {
    const wsSessions = Object.entries(sessions)
      .filter(([, s]) => s.repositoryName === id || s.id.startsWith(id))
      .map(([sid]) => sid)
    if (wsSessions.length > 0) closeTab(wsSessions)
    if (activeWorkspaceId === id) {
      setActiveWorkspaceId(workspaces.length > 1 ? workspaces.find(w => w.id !== id)?.id ?? null : null)
    }
  }, [sessions, closeTab, activeWorkspaceId, workspaces])

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

  const agentSessions = useMemo(
    () => Object.values(sessions).filter(s => AGENT_TYPE_SET.has(s.type)).slice(0, 12),
    [sessions]
  )
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
    setCreateWorkspaceModalOpen(true)
  }, [])

  async function handleCreateWorkspaceLocal(name: string, path: string, scripts?: { setupScript?: string; teardownScript?: string }) {
    addWorkspace(name, path, scripts)
  }

  async function handleCreateWorkspaceFromGit(gitUrl: string, name?: string, scripts?: { setupScript?: string; teardownScript?: string }) {
    const res = await createWorkspaceFromGit(gitUrl, name, scripts)
    if (res?.ok) {
      switchWorkspace(res.workspace.id)
    } else {
      throw new Error(res?.error || 'Failed to clone repository')
    }
  }

  const handleSelectWorkspace = useCallback((id: string) => {
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
    const result = await window.electronAPI?.importWorkspace()
    if (result?.workspace) {
      handleSelectWorkspace(result.workspace.id)
    }
  }, [handleSelectWorkspace])

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

  const handleSelectAgent = useCallback((agentId: string) => {
    if (AGENT_TYPE_SET.has(agentId)) {
      const defaultConfig = { agentId, mode: 'fresh', flags: [] }
      createAgentSession(agentId, defaultConfig, wsPath)
    } else {
      handleNewTerminal(agentId)
    }
  }, [createAgentSession, wsPath, handleNewTerminal])

  useEffect(() => {
    if (!activeSessionId && agentSessions.length > 0) {
      setActiveSessionId(agentSessions[0].id)
    }
  }, [agentSessions.length])

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
      <Settings theme={theme} onThemeChange={setTheme} onFontSizeChange={setFontSize} onFontFamilyChange={setFontFamily} onPrefsChange={(prefs) => { setUserSettings({ autoRestartSessions: prefs.autoStart }) }} onClose={() => setActiveView(null)} />
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
