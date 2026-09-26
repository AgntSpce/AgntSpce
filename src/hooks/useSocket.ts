import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import type { WorkspaceInfo, SessionState, TerminalOutput, StatusChange, BranchChange, WorkspaceChange, AgentConfig, AgentStartConfig, FilterEvent, FilterStats, CommandEvent, ExecutionEvent, ChatModelInfo, ChatThread, ChatAttachment, TaskGroupInfo, CreateTaskGroupInput, AgentStatusEntry } from '../types'
import { SERVER_URL, getServerAuthToken, apiHeaders } from '../utils/serverAuth'

export type CompressionMode = 'lite' | 'medium' | 'extreme'

export interface PromptCompressEvent {
  sessionId: string
  source: 'typed' | 'agent-start'
  originalPrompt: string
  compressedPrompt: string
  originalTokens: number
  compressedTokens: number
  reduction: number
  timestamp: number
}

export interface OrchestratorTaskStats {
  total: number
  open: number
  claimed: number
  in_progress: number
  merging: number
  setup_failed: number
  done: number
  abandoned: number
  escalated: number
}

export interface OrchestratorStats {
  concurrency: { active: number, queued: number, max: number }
  sessionCount: number
  totalMemoryMB: number
  totalCpuPercent: number
  totalProcessCount?: number
  appCpuPercent?: number | null
  resourceUsage: { sessionId: string, pid: number, cpuPercent: number, memoryMB: number, subtreeMemoryMB?: number, processCount?: number, collectedAt: number }[]
  appMemory?: { mainMB: number, rendererMB: number, gpuMB: number, otherMB: number } | null
  orchestration: {
    agents: { total: number; active: number; idle: number; paused: number }
    tasks: Record<string, number>
    worktrees: number
    sessions: number
    messages: { pending: number; total: number }
    escalations: number
    gates: { blocked: number; approved: number; rejected: number }
    completions: number
  } | null
}

interface UseSocketReturn {
  connected: boolean
  sessions: Record<string, SessionState>
  workspaces: WorkspaceInfo[]
  activeWorkspace: WorkspaceInfo | null
  onTerminalOutput: (cb: (data: TerminalOutput) => void) => () => void
  onSessionResumed: (cb: (data: { sessionId: string }) => void) => () => void
  /** Structured agent lifecycle status pushed from agent hooks. Preferred over
   *  the terminal-scraped fallback for the agent rows' status line. */
  onAgentStatus: (cb: (data: { entry: AgentStatusEntry }) => void) => () => void
  onStatusChange: (cb: (data: StatusChange) => void) => () => void
  onBranchChange: (cb: (data: BranchChange) => void) => () => void
  onWorkspaceChanged: (cb: (data: WorkspaceChange) => void) => () => void
  sendTerminalInput: (sessionId: string, data: string) => void
  sendTerminalResize: (sessionId: string, cols: number, rows: number) => void
  restartSession: (sessionId: string) => void
  resumeSession: (sessionId: string) => void
  switchWorkspace: (workspaceId: string) => void
  createWorkspace: (data: any) => Promise<any>
  deleteWorkspace: (workspaceId: string) => void
  listDeletedWorkspaces: () => Promise<{ id: string; name: string; deletedAt: string }[]>
  restoreWorkspace: (workspaceId: string) => Promise<boolean>
  permanentDeleteWorkspace: (workspaceId: string) => Promise<boolean>
  refreshWorkspaces: () => void
  taskGroups: TaskGroupInfo[]
  listTaskGroups: (workspaceId?: string) => Promise<TaskGroupInfo[]>
  createTaskGroup: (input: CreateTaskGroupInput) => Promise<{ ok: boolean; taskGroup?: TaskGroupInfo; error?: string }>
  onTaskGroupsChanged: (cb: (data: { workspaceId: string }) => void) => () => void
  getTaskDetail: (taskGroupId: string) => Promise<any>
  launchTask: (taskGroupId: string) => Promise<any>
  closeTask: (taskGroupId: string, abandon?: boolean) => Promise<any>
  taskFollowup: (taskGroupId: string, message: string) => Promise<any>
  previewTaskMerge: (taskGroupId: string) => Promise<any>
  mergeTask: (taskGroupId: string, autoResolve?: boolean) => Promise<any>
  confirmTaskMerge: (taskGroupId: string) => Promise<any>
  mergeAllTasks: (taskGroupIds: string[]) => Promise<any>
  checkGitRepo: (workspaceId?: string, repoPath?: string) => Promise<any>
  initGitRepo: (workspaceId?: string, repoPath?: string) => Promise<any>
  syncTaskBranch: (taskGroupId: string) => Promise<any>
  applyTaskBranch: (branchName?: string) => Promise<any>
  groupSessions: (sessionIds: string[], title?: string) => Promise<any>
  joinGroup: (taskGroupId: string, sessionId: string) => Promise<any>
  ungroupSession: (taskGroupId: string, sessionId: string) => Promise<any>
  renameTaskGroup: (taskGroupId: string, title: string) => Promise<any>
  setTaskPinned: (taskGroupId: string, pinned: boolean) => Promise<any>
  deleteTaskGroup: (taskGroupId: string) => Promise<any>
  closeTab: (sessionIds: string[]) => void
  startAgent: (sessionId: string, config: AgentStartConfig) => void
  fetchAgentConfigs: () => Promise<AgentConfig[]>
  fetchInstalledAgents: () => Promise<Record<string, boolean>>
  createRawSession: (type?: string, workspacePath?: string) => void
  createAgentSession: (type: string, config: any, workspacePath?: string, taskGroupId?: string | null) => void
  emit: (event: string, ...args: any[]) => void
  onFilterEvent: (cb: (data: FilterEvent) => void) => () => void
  filterStats: FilterStats
  filterHistory: FilterEvent[]
  commandHistory: CommandEvent[]
  searchEvents: CommandEvent[]
  promptHistory: PromptCompressEvent[]
  executionHistory: ExecutionEvent[]
  sessionStartedAt: number
  sessionCompressionModes: Record<string, CompressionMode>
  setSessionCompressionMode: (sessionId: string, mode: CompressionMode) => void
  onSessionCompressionModeChange: (cb: (sessionId: string, mode: CompressionMode) => void) => () => void
  requestFilterStats: () => void
  createWorkspaceFromGit: (gitUrl: string, name?: string, scripts?: { setupScript?: string; teardownScript?: string }, basePath?: string) => Promise<any>
  updateWorkspaceConfig: (workspaceId: string, updates: any) => Promise<any>
  addWorktree: (workspaceId: string) => Promise<any>
  removeWorktree: (workspaceId: string, worktreeId: string) => Promise<any>
  listWorktrees: (workspaceId: string) => Promise<any[]>
  startParallelTask: (config: any) => Promise<any>
  getOrchestratorStats: () => Promise<OrchestratorStats>
  getSessionUsage: (sessionId: string) => Promise<any>
  getSessionHistory: () => Promise<any[]>
  getTokenUsage: (sessionId?: string) => Promise<any>
  getGitLog: (worktreePath: string, maxCount?: number) => Promise<any>
  getGitDiff: (worktreePath: string, base?: string, head?: string) => Promise<any>
  getGitBranches: (worktreePath: string) => Promise<any>
  getGitWorkingTreeDiff: (worktreePath: string) => Promise<any>
  getGitCommitFiles: (worktreePath: string, commitHash: string) => Promise<any>
  getGitWorkingTreeFiles: (worktreePath: string) => Promise<any>
  getGitFileDiff: (worktreePath: string, filePath: string, base?: string, head?: string) => Promise<any>
  getGitFullStatus: (worktreePath: string) => Promise<any>
  gitRevertFile: (worktreePath: string, filePath: string) => Promise<any>
  gitStageFile: (worktreePath: string, filePath: string) => Promise<any>
  gitUnstageFile: (worktreePath: string, filePath: string) => Promise<any>
  gitStageAll: (worktreePath: string) => Promise<any>
  gitUnstageAll: (worktreePath: string) => Promise<any>
  gitCommit: (worktreePath: string, message: string) => Promise<any>
  gitPull: (worktreePath: string) => Promise<any>
  gitPush: (worktreePath: string) => Promise<any>
  gitFetch: (worktreePath: string) => Promise<any>
  gitDiscardAll: (worktreePath: string) => Promise<any>
  onSessionUnhealthy: (cb: (data: { sessionId: string, reason: string, usage?: any }) => void) => () => void
  setUserSettings: (settings: { autoRestartSessions?: boolean }) => void
  getWorkspaceTree: (worktreePath: string) => Promise<any>
  readFile: (absolutePath: string) => Promise<any>
  getFileInfo: (absolutePath: string) => Promise<any>
  writeFile: (absolutePath: string, content: string) => Promise<any>
  createFile: (absolutePath: string) => Promise<any>
  createFolder: (absolutePath: string) => Promise<any>
  renameFile: (oldPath: string, newPath: string) => Promise<any>
  deleteFile: (absolutePath: string) => Promise<any>
  trashList: (workspaceId: string) => Promise<any>
  trashRestore: (workspaceId: string, id: string) => Promise<any>
  trashDelete: (workspaceId: string, id: string) => Promise<any>
  trashEmpty: (workspaceId: string) => Promise<any>
  chatGetModels: () => Promise<ChatModelInfo[]>
  chatSend: (threadId: string, providerId: string, content: string, model?: string) => Promise<any>
  chatSendStream: (threadId: string, providerId: string, content: string, model?: string, attachments?: ChatAttachment[]) => void
  chatStopStream: (threadId: string) => void
  chatGetHistory: (threadId: string) => Promise<any>
  chatListThreads: () => Promise<ChatThread[]>
  chatCreateThread: (providerId: string, model: string) => Promise<ChatThread | null>
  chatRenameThread: (threadId: string, title: string) => void
  chatClearThread: (threadId: string) => void
  chatDeleteThread: (threadId: string) => void
  onChatStreamChunk: (cb: (data: any) => void) => () => void
  onChatResponse: (cb: (data: any) => void) => () => void
  onChatError: (cb: (data: any) => void) => () => void
  onChatModels: (cb: (data: any[]) => void) => () => void
  onChatHistory: (cb: (data: any) => void) => () => void
  onChatThreads: (cb: (data: any) => void) => () => void
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [sessions, setSessions] = useState<Record<string, SessionState>>({})
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null)
  const [taskGroups, setTaskGroups] = useState<TaskGroupInfo[]>([])
  const [filterStats, setFilterStats] = useState<FilterStats>({
    totalOriginalBytes: 0, totalFilteredBytes: 0,
    totalOriginalTokens: 0, totalFilteredTokens: 0,
    eventsProcessed: 0,
  })
  const [filterHistory, setFilterHistory] = useState<FilterEvent[]>([])
  const [commandHistory, setCommandHistory] = useState<CommandEvent[]>([])
  const [searchEvents, setSearchEvents] = useState<CommandEvent[]>([])
  const [promptHistory, setPromptHistory] = useState<PromptCompressEvent[]>([])
  const [executionHistory, setExecutionHistory] = useState<ExecutionEvent[]>([])
  const [sessionStartedAt, setSessionStartedAt] = useState<number>(Date.now())
  const [sessionCompressionModes, setSessionCompressionModes] = useState<Record<string, CompressionMode>>({})
  const sessionCompressionCbs = useRef<((sessionId: string, mode: CompressionMode) => void)[]>([])
  const terminalOutputCbs = useRef<((data: TerminalOutput) => void)[]>([])
  const sessionResumedCbs = useRef<((data: { sessionId: string }) => void)[]>([])
  const agentStatusCbs = useRef<((data: { entry: AgentStatusEntry }) => void)[]>([])
  const lastStatsFetchAt = useRef(0)
  const statusChangeCbs = useRef<((data: StatusChange) => void)[]>([])
  const branchChangeCbs = useRef<((data: BranchChange) => void)[]>([])
  const workspaceChangedCbs = useRef<((data: WorkspaceChange) => void)[]>([])
  const taskGroupsChangedCbs = useRef<((data: { workspaceId: string }) => void)[]>([])
  const filterEventCbs = useRef<((data: FilterEvent) => void)[]>([])
  const sessionUnhealthyCbs = useRef<((data: { sessionId: string, reason: string, usage?: any }) => void)[]>([])
  // Pending terminal output per session, accumulated as chunks. Joining happens
  // once at flush time — re-slicing a 64KB string on every incoming chunk was
  // O(n²) under sustained output.
  //
  // Flush timing: when the window is visible we schedule on requestAnimationFrame
  // (echo lands within one display frame instead of waiting out a fixed timer —
  // this was half of the keystroke-latency tax). Hidden/throttled windows never
  // fire rAF, so a short fallback timer guarantees delivery either way;
  // first-to-fire runs and cancels its sibling. The OUTPUT_CAP trim below keeps
  // memory bounded regardless of which path fires.
  const OUTPUT_CAP = 65536
  const FLUSH_FALLBACK_MS = 40
  const FLUSH_HIDDEN_MS = 30
  const outputBuffer = useRef<Record<string, { chunks: string[], bytes: number }>>({})
  const outputTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outputRaf = useRef(0)

  // ── Analytics event batching ─────────────────────────────────────
  // Every completed tool call emits command-filter-event / execution-event /
  // filter-event. Committing each one to React state immediately re-renders
  // the whole App tree per event — with several agents finishing dozens of
  // tool calls per second, that is a guaranteed re-render storm and the main
  // remaining source of multi-agent lag. Events now accumulate in refs and
  // commit on a 250ms tick; dashboards see at most a quarter-second delay,
  // and the terminal output path is completely unaffected.
  const EVENT_BATCH_MS = 250
  const cmdEventBuf = useRef<CommandEvent[]>([])
  const searchEventBuf = useRef<CommandEvent[]>([])
  const promptEventBuf = useRef<PromptCompressEvent[]>([])
  const execEventBuf = useRef<ExecutionEvent[]>([])
  const filterEventBuf = useRef<FilterEvent[]>([])
  const filterDeltaBuf = useRef<{ ob: number; fb: number; ot: number; ft: number } | null>(null)
  const eventBatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushEventBatches = useCallback(() => {
    eventBatchTimer.current = null
    if (cmdEventBuf.current.length) {
      const batch = cmdEventBuf.current
      cmdEventBuf.current = []
      setCommandHistory(prev => [...batch.slice().reverse(), ...prev].slice(0, 500))
    }
    if (searchEventBuf.current.length) {
      const batch = searchEventBuf.current
      searchEventBuf.current = []
      setSearchEvents(prev => [...batch.slice().reverse(), ...prev].slice(0, 100))
    }
    if (promptEventBuf.current.length) {
      const batch = promptEventBuf.current
      promptEventBuf.current = []
      setPromptHistory(prev => [...batch.slice().reverse(), ...prev].slice(0, 500))
    }
    if (execEventBuf.current.length) {
      const batch = execEventBuf.current
      execEventBuf.current = []
      setExecutionHistory(prev => [...batch.slice().reverse(), ...prev].slice(0, 100))
    }
    if (filterEventBuf.current.length || filterDeltaBuf.current) {
      const fBatch = filterEventBuf.current
      const delta = filterDeltaBuf.current
      filterEventBuf.current = []
      filterDeltaBuf.current = null
      setFilterStats(prev => ({
        totalOriginalBytes: prev.totalOriginalBytes + (delta?.ob ?? 0),
        totalFilteredBytes: prev.totalFilteredBytes + (delta?.fb ?? 0),
        totalOriginalTokens: prev.totalOriginalTokens + (delta?.ot ?? 0),
        totalFilteredTokens: prev.totalFilteredTokens + (delta?.ft ?? 0),
        eventsProcessed: prev.eventsProcessed + fBatch.length,
      }))
      if (fBatch.length) setFilterHistory(prev => [...fBatch.slice().reverse(), ...prev].slice(0, 200))
    }
  }, [])

  const scheduleEventBatch = useCallback(() => {
    if (!eventBatchTimer.current) {
      eventBatchTimer.current = setTimeout(flushEventBatches, EVENT_BATCH_MS)
    }
  }, [flushEventBatches])

  const flushOutput = useCallback(() => {
    if (outputRaf.current) {
      cancelAnimationFrame(outputRaf.current)
      outputRaf.current = 0
    }
    if (outputTimer.current) {
      clearTimeout(outputTimer.current)
      outputTimer.current = null
    }
    const buffer = outputBuffer.current
    outputBuffer.current = {}
    for (const [sessionId, entry] of Object.entries(buffer)) {
      if (!entry.chunks.length) continue
      const data = entry.chunks.join('').slice(-OUTPUT_CAP)
      const payload = { sessionId, data }
      terminalOutputCbs.current.forEach(cb => cb(payload))
    }
  }, [])

  const pushOutput = useCallback((sessionId: string, data: string) => {
    if (!data) return
    const entry = outputBuffer.current[sessionId] ?? (outputBuffer.current[sessionId] = { chunks: [], bytes: 0 })
    entry.chunks.push(data)
    entry.bytes += data.length
    if (entry.bytes > OUTPUT_CAP * 2) {
      // Amortized trim to the last OUTPUT_CAP bytes
      let dropped = 0
      let i = 0
      while (i < entry.chunks.length && dropped < entry.bytes - OUTPUT_CAP) {
        dropped += entry.chunks[i].length
        i++
      }
      entry.chunks = entry.chunks.slice(i)
      entry.bytes -= dropped
    }
    if (!outputTimer.current && !outputRaf.current) {
      if (!document.hidden) {
        outputRaf.current = requestAnimationFrame(() => { outputRaf.current = 0; flushOutput() })
        outputTimer.current = setTimeout(flushOutput, FLUSH_FALLBACK_MS)
      } else {
        outputTimer.current = setTimeout(flushOutput, FLUSH_HIDDEN_MS)
      }
    }
  }, [flushOutput])

  // Drop buffered output for sessions that are gone after a full snapshot
  // (connect / workspace switch) — otherwise up to 64KB per orphan lingers.
  const pruneOutputBuffers = useCallback((keepIds: string[]) => {
    const keep = new Set(keepIds)
    for (const id of Object.keys(outputBuffer.current)) {
      if (!keep.has(id)) delete outputBuffer.current[id]
    }
  }, [])

  useEffect(() => {
    let disposed = false
    void (async () => {
      const token = await getServerAuthToken()
      if (disposed) return
      const socket = io(SERVER_URL, token ? { auth: { token } } : {})
      socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      const now = Date.now()
      setSessionStartedAt(now)
      setFilterStats({ totalOriginalBytes: 0, totalFilteredBytes: 0, totalOriginalTokens: 0, totalFilteredTokens: 0, eventsProcessed: 0 })
      setFilterHistory([])
      setCommandHistory([])
      setSearchEvents([])
      setPromptHistory([])
      setExecutionHistory([])
      cmdEventBuf.current = []
      searchEventBuf.current = []
      promptEventBuf.current = []
      execEventBuf.current = []
      filterEventBuf.current = []
      filterDeltaBuf.current = null
      if (eventBatchTimer.current) { clearTimeout(eventBatchTimer.current); eventBatchTimer.current = null }
socket.emit('get-cumulative-stats', {})
      socket.emit('get-filter-stats', {})
    })
    socket.on('disconnect', () => setConnected(false))

    socket.on('workspace-info', (data: { active: WorkspaceInfo | null; available: WorkspaceInfo[] }) => {
      setActiveWorkspace(data.active)
      setWorkspaces(data.available || [])
    })

    socket.on('sessions', (data: Record<string, SessionState>) => {
      setSessions(data || {})
      pruneOutputBuffers(Object.keys(data || {}))
    })

    socket.on('terminal-output', (data: TerminalOutput) => {
      pushOutput(data.sessionId, data.data)
    })

    socket.on('status-change', (data: StatusChange) => {
      setSessions(prev => {
        if (!prev[data.sessionId]) return prev
        // No-op guard: identical status must not create a new sessions object
        // (a fresh object re-renders the whole App tree). Agents can emit
        // bursts of same-value events during rapid TUI transitions.
        if (prev[data.sessionId].status === data.status) return prev
        return { ...prev, [data.sessionId]: { ...prev[data.sessionId], status: data.status as any } }
      })
      statusChangeCbs.current.forEach(cb => cb(data))
    })

    socket.on('branch-change', (data: BranchChange) => {
      setSessions(prev => {
        if (!prev[data.sessionId]) return prev
        if (prev[data.sessionId].branch === data.branch) return prev
        return { ...prev, [data.sessionId]: { ...prev[data.sessionId], branch: data.branch } }
      })
      branchChangeCbs.current.forEach(cb => cb(data))
    })

    socket.on('workspace-changed', (data: WorkspaceChange) => {
      setActiveWorkspace(data.workspace)
      setSessions(data.sessions || {})
      pruneOutputBuffers(Object.keys(data.sessions || {}))
      workspaceChangedCbs.current.forEach(cb => cb(data))
    })

    socket.on('workspaces-list', (data: WorkspaceInfo[]) => {
      setWorkspaces(data)
    })

    socket.on('task-groups-changed', (data: { workspaceId: string }) => {
      taskGroupsChangedCbs.current.forEach(cb => cb(data))
    })

    socket.on('session-created', ({ sessionId, sessions: newSessions }: { sessionId: string, sessions: Record<string, SessionState> }) => {
      setSessions(prev => {
        // Backend sends ALL session states — only merge the new session
        // to avoid replacing existing session object references, which
        // would cause TerminalPane to re-render with new props.
        const session = newSessions[sessionId]
        if (!session || prev[sessionId]) return prev
        return { ...prev, [sessionId]: session }
      })
    })

    socket.on('session-exited', ({ sessionId }: { sessionId: string }) => {
      setSessions(prev => {
        if (!prev[sessionId]) return prev
        return { ...prev, [sessionId]: { ...prev[sessionId], status: 'exited' } }
      })
    })

    socket.on('session-resumed', ({ sessionId, sessions: newSessions }: { sessionId: string, sessions: Record<string, SessionState> }) => {
      setSessions(prev => {
        const session = newSessions[sessionId]
        if (!session) return prev
        return { ...prev, [sessionId]: session }
      })
      // Notify subscribers (e.g. the workspace panel) that this session was
      // resumed, so they can discard the replayed-history burst.
      for (const cb of sessionResumedCbs.current) {
        try { cb({ sessionId }) } catch {}
      }
    })

    socket.on('agent-status', (data: { entry: AgentStatusEntry }) => {
      for (const cb of agentStatusCbs.current) {
        try { cb({ entry: data.entry }) } catch {}
      }
    })

    socket.on('error', (err: any) => {
      console.error('[socket error]', err?.message || err)
    })

    socket.on('backlog', (data: Record<string, string>) => {
      for (const [sessionId, buffered] of Object.entries(data)) {
        if (buffered) pushOutput(sessionId, buffered)
      }
    })

    socket.on('session-closed', ({ sessionId }: { sessionId: string }) => {
      setSessions(prev => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      delete outputBuffer.current[sessionId]
      setSessionCompressionModes(prev => {
        if (!(sessionId in prev)) return prev
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
    })

    socket.on('session-unhealthy', (data: { sessionId: string, reason: string, usage?: any }) => {
    sessionUnhealthyCbs.current.forEach(cb => cb(data))
  })

  socket.on('filter-event', (event: FilterEvent) => {
    filterEventBuf.current.push(event)
    filterDeltaBuf.current = {
      ob: (filterDeltaBuf.current?.ob ?? 0) + event.originalBytes,
      fb: (filterDeltaBuf.current?.fb ?? 0) + event.filteredBytes,
      ot: (filterDeltaBuf.current?.ot ?? 0) + event.originalTokens,
      ft: (filterDeltaBuf.current?.ft ?? 0) + event.filteredTokens,
    }
    scheduleEventBatch()
    filterEventCbs.current.forEach(cb => cb(event))
  })

  socket.on('command-filter-event', (event: CommandEvent) => {
    const isSearch = event.command.startsWith('agntspce-search')
    cmdEventBuf.current.push(event)
    if (isSearch) searchEventBuf.current.push(event)
    // Throttle the stats refetch — a burst of commands used to trigger a
    // round trip (and a server-side history rescan) per event.
    const now = Date.now()
    if (now - lastStatsFetchAt.current >= 1000) {
      lastStatsFetchAt.current = now
      socket.emit('get-cumulative-stats', {})
    }
    scheduleEventBatch()
  })

  socket.on('execution-event', (event: ExecutionEvent) => {
    execEventBuf.current.push(event)
    scheduleEventBatch()
  })

  socket.on('prompt-compress-event', (event: PromptCompressEvent) => {
    promptEventBuf.current.push(event)
    scheduleEventBatch()
  })

  socket.on('session-compression-modes', (modes: Record<string, CompressionMode>) => {
    if (!modes || typeof modes !== 'object') return
    const valid: Record<string, CompressionMode> = {}
    for (const [id, mode] of Object.entries(modes)) {
      if (mode === 'lite' || mode === 'medium' || mode === 'extreme') valid[id] = mode
    }
    setSessionCompressionModes(valid)
  })

  socket.on('session-compression-mode-changed', ({ sessionId, mode }: { sessionId: string, mode: CompressionMode }) => {
    if (!sessionId || (mode !== 'lite' && mode !== 'medium' && mode !== 'extreme')) return
    setSessionCompressionModes(prev => (prev[sessionId] === mode ? prev : { ...prev, [sessionId]: mode }))
    queueMicrotask(() => { sessionCompressionCbs.current.forEach(cb => cb(sessionId, mode)) })
  })

  socket.on('filter-stats', (data: { stats: FilterStats; history: FilterEvent[]; commandHistory: CommandEvent[]; promptHistory?: PromptCompressEvent[] }) => {
    setFilterStats(data.stats)
    setFilterHistory(data.history || [])
    const all = data.commandHistory || []
    // Newest first to match live command-filter-event ordering
    setCommandHistory([...all].reverse())
    setSearchEvents(all.filter(e => e.command.startsWith('agntspce-search')).reverse())
    // Prompt compressions newest first to match live prompt-compress-event ordering
    setPromptHistory([...(data.promptHistory || [])].sort((a, b) => b.timestamp - a.timestamp))
  })

  })()

  return () => {
      disposed = true
      if (outputTimer.current) {
        clearTimeout(outputTimer.current)
        flushOutput()
      }
      if (eventBatchTimer.current) {
        clearTimeout(eventBatchTimer.current)
        eventBatchTimer.current = null
      }
      socketRef.current?.disconnect()
    }
    // pushOutput / pruneOutputBuffers / flushOutput are stable useCallbacks
  }, [flushOutput, pushOutput, pruneOutputBuffers])

  const onTerminalOutput = useCallback((cb: (data: TerminalOutput) => void) => {
    terminalOutputCbs.current.push(cb)
    return () => {
      terminalOutputCbs.current = terminalOutputCbs.current.filter(c => c !== cb)
    }
  }, [])

  const onSessionResumed = useCallback((cb: (data: { sessionId: string }) => void) => {
    sessionResumedCbs.current.push(cb)
    return () => {
      sessionResumedCbs.current = sessionResumedCbs.current.filter(c => c !== cb)
    }
  }, [])

  const onAgentStatus = useCallback((cb: (data: { entry: AgentStatusEntry }) => void) => {
    agentStatusCbs.current.push(cb)
    return () => {
      agentStatusCbs.current = agentStatusCbs.current.filter(c => c !== cb)
    }
  }, [])

  const onStatusChange = useCallback((cb: (data: StatusChange) => void) => {
    statusChangeCbs.current.push(cb)
    return () => {
      statusChangeCbs.current = statusChangeCbs.current.filter(c => c !== cb)
    }
  }, [])

  const onBranchChange = useCallback((cb: (data: BranchChange) => void) => {
    branchChangeCbs.current.push(cb)
    return () => {
      branchChangeCbs.current = branchChangeCbs.current.filter(c => c !== cb)
    }
  }, [])

  const onWorkspaceChanged = useCallback((cb: (data: WorkspaceChange) => void) => {
    workspaceChangedCbs.current.push(cb)
    return () => {
      workspaceChangedCbs.current = workspaceChangedCbs.current.filter(c => c !== cb)
    }
  }, [])

  // Ack-based request with a bounded wait. Resolves null instead of hanging
  // forever when the socket is missing or the server never answers.
  const emitAck = useCallback((event: string, payload: unknown, timeoutMs = 120000): Promise<any> => {
    return new Promise((resolve) => {
      const socket = socketRef.current
      if (!socket) {
        resolve(null)
        return
      }
      let settled = false
      const finish = (res: any) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      socket.emit(event, payload, (res: any) => finish(res))
    })
  }, [])

  const sendTerminalInput = useCallback((sessionId: string, data: string) => {
    socketRef.current?.emit('terminal-input', { sessionId, data })
  }, [])

  const sendTerminalResize = useCallback((sessionId: string, cols: number, rows: number) => {
    socketRef.current?.emit('terminal-resize', { sessionId, cols, rows })
  }, [])

  const restartSession = useCallback((sessionId: string) => {
    socketRef.current?.emit('restart-session', { sessionId })
  }, [])

  const resumeSession = useCallback((sessionId: string) => {
    socketRef.current?.emit('resume-session', { sessionId })
  }, [])

  const switchWorkspace = useCallback((workspaceId: string) => {
    socketRef.current?.emit('switch-workspace', { workspaceId })
  }, [])

  const createWorkspace = useCallback((data: any): Promise<any> => {
    return emitAck('create-workspace', data)
  }, [emitAck])

  const deleteWorkspace = useCallback((workspaceId: string) => {
    socketRef.current?.emit('delete-workspace', { workspaceId })
  }, [])

  const listDeletedWorkspaces = useCallback(async (): Promise<{ id: string; name: string; deletedAt: string }[]> => {
    const res = await emitAck('list-deleted-workspaces', {})
    return res || []
  }, [emitAck])

  const restoreWorkspace = useCallback(async (workspaceId: string): Promise<boolean> => {
    const res = await emitAck('restore-workspace', { workspaceId })
    return res?.ok ?? false
  }, [emitAck])

  const permanentDeleteWorkspace = useCallback(async (workspaceId: string): Promise<boolean> => {
    const res = await emitAck('permanent-delete-workspace', { workspaceId })
    return res?.ok ?? false
  }, [emitAck])

  const refreshWorkspaces = useCallback(() => {
    socketRef.current?.emit('list-workspaces')
  }, [])

  const closeTab = useCallback((sessionIds: string[]) => {
    socketRef.current?.emit('close-tab', { sessionIds })
  }, [])

  const startAgent = useCallback((sessionId: string, config: AgentStartConfig) => {
    socketRef.current?.emit('start-agent', { sessionId, config })
  }, [])

  const createRawSession = useCallback((type: string = 'shell', workspacePath?: string) => {
    socketRef.current?.emit('create-raw-session', { type, workspacePath })
  }, [])

  const createAgentSession = useCallback((type: string, config: any, workspacePath?: string, taskGroupId?: string | null) => {
    socketRef.current?.emit('create-agent-session', { type, workspacePath, config, taskGroupId: taskGroupId || undefined })
  }, [])

  const fetchAgentConfigs = useCallback(async (): Promise<AgentConfig[]> => {
    try {
      const res = await fetch(`${SERVER_URL}/api/agents`, { headers: await apiHeaders() })
      if (!res.ok) throw new Error('Failed to fetch agent configs')
      return await res.json()
    } catch {
      return []
    }
  }, [])

  const fetchInstalledAgents = useCallback(async (): Promise<Record<string, boolean>> => {
    try {
      const res = await fetch(`${SERVER_URL}/api/agents/installed`, { headers: await apiHeaders() })
      if (!res.ok) throw new Error('Failed to fetch installed agents')
      return await res.json()
    } catch {
      return {}
    }
  }, [])

  const addWorktree = useCallback((workspaceId: string): Promise<any> => {
    return emitAck('add-worktree', { workspaceId })
  }, [emitAck])

  const removeWorktree = useCallback((workspaceId: string, worktreeId: string): Promise<any> => {
    return emitAck('remove-worktree', { workspaceId, worktreeId })
  }, [emitAck])

  const listWorktrees = useCallback(async (workspaceId: string): Promise<any[]> => {
    const res = await emitAck('list-worktrees', { workspaceId })
    return res || []
  }, [emitAck])

  const startParallelTask = useCallback((config: any): Promise<any> => {
    // Clones + setup scripts can legitimately run for many minutes
    return emitAck('start-parallel-task', config, 600000)
  }, [emitAck])

  const createWorkspaceFromGit = useCallback((gitUrl: string, name?: string, scripts?: { setupScript?: string; teardownScript?: string }, basePath?: string): Promise<any> => {
    return emitAck('create-workspace-from-git', { gitUrl, name, setupScript: scripts?.setupScript, teardownScript: scripts?.teardownScript, basePath }, 600000)
  }, [emitAck])

  const updateWorkspaceConfig = useCallback((workspaceId: string, updates: any): Promise<any> => {
    return emitAck('update-workspace-config', { workspaceId, updates })
  }, [emitAck])

  const listTaskGroups = useCallback(async (workspaceId?: string): Promise<TaskGroupInfo[]> => {
    const res = await emitAck('list-task-groups', { workspaceId })
    if (res?.ok) {
      setTaskGroups(res.taskGroups || [])
      return res.taskGroups || []
    }
    return []
  }, [emitAck])

  const createTaskGroup = useCallback((input: CreateTaskGroupInput): Promise<{ ok: boolean; taskGroup?: TaskGroupInfo; error?: string }> => {
    return emitAck('create-task-group', input)
  }, [emitAck])

  const onTaskGroupsChanged = useCallback((cb: (data: { workspaceId: string }) => void) => {
    taskGroupsChangedCbs.current.push(cb)
    return () => {
      taskGroupsChangedCbs.current = taskGroupsChangedCbs.current.filter(c => c !== cb)
    }
  }, [])

  const getTaskDetail = useCallback((taskGroupId: string): Promise<any> => {
    return emitAck('get-task-detail', { taskGroupId })
  }, [emitAck])

  const launchTask = useCallback((taskGroupId: string): Promise<any> => {
    return emitAck('launch-task', { taskGroupId }, 600000)
  }, [emitAck])

  const closeTask = useCallback((taskGroupId: string, abandon?: boolean): Promise<any> => {
    return emitAck('close-task', { taskGroupId, abandon })
  }, [emitAck])

  const taskFollowup = useCallback((taskGroupId: string, message: string): Promise<any> => {
    return emitAck('task-followup', { taskGroupId, message }, 600000)
  }, [emitAck])

  const previewTaskMerge = useCallback((taskGroupId: string): Promise<any> => {
    return emitAck('preview-task-merge', { taskGroupId }, 300000)
  }, [emitAck])

  const mergeTask = useCallback((taskGroupId: string, autoResolve = true): Promise<any> => {
    return emitAck('merge-task', { taskGroupId, autoResolve }, 900000)
  }, [emitAck])

  const confirmTaskMerge = useCallback((taskGroupId: string): Promise<any> => {
    return emitAck('confirm-task-merge', { taskGroupId }, 300000)
  }, [emitAck])

  const mergeAllTasks = useCallback((taskGroupIds: string[]): Promise<any> => {
    return emitAck('merge-all-tasks', { taskGroupIds }, 1800000)
  }, [emitAck])

  const checkGitRepo = useCallback((workspaceId?: string, repoPath?: string): Promise<any> => {
    return emitAck('check-git-repo', { workspaceId, repoPath }, 30000)
  }, [emitAck])

  const initGitRepo = useCallback((workspaceId?: string, repoPath?: string): Promise<any> => {
    return emitAck('init-git-repo', { workspaceId, repoPath }, 180000)
  }, [emitAck])

  const syncTaskBranch = useCallback((taskGroupId: string): Promise<any> => {
    return emitAck('sync-task-branch', { taskGroupId }, 300000)
  }, [emitAck])

  // Fast-forward the user's checked-out branch onto the integration branch, so
  // merged task work lands in the folder they are looking at.
  const applyTaskBranch = useCallback((branchName?: string): Promise<any> => {
    return emitAck('apply-task-branch', { branchName }, 300000)
  }, [emitAck])

  const groupSessions = useCallback((sessionIds: string[], title?: string): Promise<any> => {
    return emitAck('group-sessions', { sessionIds, title }, 120000)
  }, [emitAck])

  const joinGroup = useCallback((taskGroupId: string, sessionId: string): Promise<any> => {
    return emitAck('join-group', { taskGroupId, sessionId })
  }, [emitAck])

  const ungroupSession = useCallback((taskGroupId: string, sessionId: string): Promise<any> => {
    return emitAck('ungroup-session', { taskGroupId, sessionId })
  }, [emitAck])

  const renameTaskGroup = useCallback((taskGroupId: string, title: string): Promise<any> => {
    return emitAck('rename-task-group', { taskGroupId, title })
  }, [emitAck])

  const setTaskPinned = useCallback((taskGroupId: string, pinned: boolean): Promise<any> => {
    return emitAck('set-task-pinned', { taskGroupId, pinned })
  }, [emitAck])

  const deleteTaskGroup = useCallback((taskGroupId: string): Promise<any> => {
    return emitAck('delete-task-group', { taskGroupId }, 120000)
  }, [emitAck])

  const emit = useCallback((event: string, ...args: any[]) => {
    socketRef.current?.emit(event, ...args)
  }, [])

  const onFilterEvent = useCallback((cb: (data: FilterEvent) => void) => {
    filterEventCbs.current.push(cb)
    return () => {
      filterEventCbs.current = filterEventCbs.current.filter(c => c !== cb)
    }
  }, [])

  const requestFilterStats = useCallback(() => {
    socketRef.current?.emit('get-filter-stats', {})
  }, [])

  const getOrchestratorStats = useCallback(async (): Promise<OrchestratorStats> => {
    const res = await emitAck('get-orchestrator-stats', {})
    if (res?.ok) return res
    return { concurrency: { active: 0, queued: 0, max: 6 }, sessionCount: 0, totalMemoryMB: 0, totalCpuPercent: 0, resourceUsage: [], orchestration: null }
  }, [emitAck])

  const getSessionUsage = useCallback((sessionId: string): Promise<any> => {
    return emitAck('get-session-usage', { sessionId })
  }, [emitAck])

  const getSessionHistory = useCallback(async (): Promise<any[]> => {
    const res = await emitAck('get-session-history', {})
    if (res?.ok) return res.history || []
    return []
  }, [emitAck])

  const getTokenUsage = useCallback(async (sessionId?: string): Promise<any> => {
    const res = await emitAck('get-token-usage', { sessionId })
    if (res?.ok) return res
    return { usage: null, totalTokens: 0, totalCost: 0 }
  }, [emitAck])

  const getGitLog = useCallback(async (worktreePath: string, maxCount?: number): Promise<any> => {
    const res = await emitAck('get-git-log', { worktreePath, maxCount }, 300000)
    if (res?.ok) return res.log
    return null
  }, [emitAck])

  const getGitDiff = useCallback(async (worktreePath: string, base?: string, head?: string): Promise<any> => {
    const res = await emitAck('get-git-diff', { worktreePath, base, head })
    if (res?.ok) return res.diff
    return null
  }, [emitAck])

  const getGitBranches = useCallback(async (worktreePath: string): Promise<any> => {
    const res = await emitAck('get-git-branches', { worktreePath })
    if (res?.ok) return res.branches
    return null
  }, [emitAck])

  const getGitWorkingTreeDiff = useCallback(async (worktreePath: string): Promise<any> => {
    const res = await emitAck('get-git-working-tree-diff', { worktreePath })
    if (res?.ok) return res.diff
    return null
  }, [emitAck])

  const getGitCommitFiles = useCallback(async (worktreePath: string, commitHash: string): Promise<any> => {
    const res = await emitAck('get-git-commit-files', { worktreePath, commitHash })
    if (res?.ok) return res.files
    return null
  }, [emitAck])

  const getGitWorkingTreeFiles = useCallback(async (worktreePath: string): Promise<any> => {
    const res = await emitAck('get-git-working-tree-files', { worktreePath })
    if (res?.ok) return res.files
    return null
  }, [emitAck])

  const getGitFileDiff = useCallback(async (worktreePath: string, filePath: string, base?: string, head?: string): Promise<any> => {
    const res = await emitAck('get-git-file-diff', { worktreePath, filePath, base, head })
    if (res?.ok) return res.diff
    return null
  }, [emitAck])

  const getGitFullStatus = useCallback(async (worktreePath: string): Promise<any> => {
    const res = await emitAck('get-git-full-status', { worktreePath })
    return res?.status ?? null
  }, [emitAck])

  const gitRevertFile = useCallback(async (worktreePath: string, filePath: string): Promise<boolean> => {
    const res = await emitAck('git-revert-file', { worktreePath, filePath })
    return res?.ok === true
  }, [emitAck])

  const gitStageFile = useCallback(async (worktreePath: string, filePath: string): Promise<boolean> => {
    const res = await emitAck('git-stage-file', { worktreePath, filePath })
    return res?.ok === true
  }, [emitAck])

  const gitUnstageFile = useCallback(async (worktreePath: string, filePath: string): Promise<boolean> => {
    const res = await emitAck('git-unstage-file', { worktreePath, filePath })
    return res?.ok === true
  }, [emitAck])

  const gitStageAll = useCallback(async (worktreePath: string): Promise<boolean> => {
    const res = await emitAck('git-stage-all', { worktreePath })
    return res?.ok === true
  }, [emitAck])

  const gitUnstageAll = useCallback(async (worktreePath: string): Promise<boolean> => {
    const res = await emitAck('git-unstage-all', { worktreePath })
    return res?.ok === true
  }, [emitAck])

  const gitCommit = useCallback(async (worktreePath: string, message: string): Promise<any> => {
    return await emitAck('git-commit', { worktreePath, message }, 300000) ?? { ok: false, error: 'no response' }
  }, [emitAck])

  const gitPull = useCallback(async (worktreePath: string): Promise<any> => {
    return await emitAck('git-pull', { worktreePath }, 300000) ?? { ok: false, error: 'no response' }
  }, [emitAck])

  const gitPush = useCallback(async (worktreePath: string): Promise<any> => {
    return await emitAck('git-push', { worktreePath }, 300000) ?? { ok: false, error: 'no response' }
  }, [emitAck])

  const gitFetch = useCallback(async (worktreePath: string): Promise<any> => {
    return await emitAck('git-fetch', { worktreePath }, 300000) ?? { ok: false, error: 'no response' }
  }, [emitAck])

  const gitDiscardAll = useCallback(async (worktreePath: string): Promise<boolean> => {
    const res = await emitAck('git-discard-all', { worktreePath })
    return res?.ok === true
  }, [emitAck])

  const onSessionUnhealthy = useCallback((cb: (data: { sessionId: string, reason: string, usage?: any }) => void) => {
    sessionUnhealthyCbs.current.push(cb)
    return () => {
      sessionUnhealthyCbs.current = sessionUnhealthyCbs.current.filter(c => c !== cb)
    }
  }, [])

  const setUserSettings = useCallback((settings: { autoRestartSessions?: boolean }) => {
    socketRef.current?.emit('set-user-settings', settings)
  }, [])

  const setSessionCompressionMode = useCallback((sessionId: string, mode: CompressionMode) => {
    if (!sessionId || (mode !== 'lite' && mode !== 'medium' && mode !== 'extreme')) return
    setSessionCompressionModes(prev => (prev[sessionId] === mode ? prev : { ...prev, [sessionId]: mode }))
    socketRef.current?.emit('set-session-compression-mode', { sessionId, mode })
  }, [])

  const onSessionCompressionModeChange = useCallback((cb: (sessionId: string, mode: CompressionMode) => void) => {
    sessionCompressionCbs.current.push(cb)
    return () => {
      sessionCompressionCbs.current = sessionCompressionCbs.current.filter(c => c !== cb)
    }
  }, [])

  const getWorkspaceTree = useCallback((worktreePath: string): Promise<any> => {
    return emitAck('get-workspace-tree', { worktreePath })
  }, [emitAck])

  const readFile = useCallback((absolutePath: string): Promise<any> => {
    return emitAck('read-file', { absolutePath })
  }, [emitAck])

  const getFileInfo = useCallback((absolutePath: string): Promise<any> => {
    return emitAck('get-file-info', { absolutePath })
  }, [emitAck])

  const writeFile = useCallback((absolutePath: string, content: string): Promise<any> => {
    return emitAck('write-file', { absolutePath, content })
  }, [emitAck])

  const createFile = useCallback((absolutePath: string): Promise<any> => {
    return emitAck('create-file', { absolutePath })
  }, [emitAck])

  const createFolder = useCallback((absolutePath: string): Promise<any> => {
    return emitAck('create-folder', { absolutePath })
  }, [emitAck])

  const renameFile = useCallback((oldPath: string, newPath: string): Promise<any> => {
    return emitAck('rename-file', { oldPath, newPath })
  }, [emitAck])

  const deleteFile = useCallback((absolutePath: string): Promise<any> => {
    return emitAck('delete-file', { absolutePath })
  }, [emitAck])

  const trashList = useCallback((workspaceId: string): Promise<any> => {
    return emitAck('trash-list', { workspaceId })
  }, [emitAck])

  const trashRestore = useCallback((workspaceId: string, id: string): Promise<any> => {
    return emitAck('trash-restore', { workspaceId, id })
  }, [emitAck])

  const trashDelete = useCallback((workspaceId: string, id: string): Promise<any> => {
    return emitAck('trash-delete', { workspaceId, id })
  }, [emitAck])

  const trashEmpty = useCallback((workspaceId: string): Promise<any> => {
    return emitAck('trash-empty', { workspaceId })
  }, [emitAck])

  // Chat functions
  const chatReqId = useRef(0)

  const registerOneShot = useCallback((event: string, id: number, timeoutMs: number): Promise<any> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socketRef.current?.off(event, handler)
        resolve(null)
      }, timeoutMs)
      const handler = (data: any) => {
        if (data._reqId === id) {
          clearTimeout(timer)
          socketRef.current?.off(event, handler)
          resolve(data)
        }
      }
      socketRef.current?.on(event, handler)
    })
  }, [])

  const chatGetModels = useCallback((): Promise<ChatModelInfo[]> => {
    return new Promise((resolve) => {
      const id = ++chatReqId.current
      registerOneShot('chat-models', id, 10000).then(data => {
        resolve(data?.models ?? [])
      })
      socketRef.current?.emit('chat-get-models', { _reqId: id })
    })
  }, [registerOneShot])

  const chatSend = useCallback((threadId: string, providerId: string, content: string, model?: string): Promise<any> => {
    return new Promise((resolve) => {
      const id = ++chatReqId.current
      registerOneShot('chat-response', id, 60000).then(data => {
        resolve(data ?? null)
      })
      socketRef.current?.emit('chat-send', { _reqId: id, threadId, providerId, content, model })
    })
  }, [registerOneShot])

  const chatSendStream = useCallback((threadId: string, providerId: string, content: string, model?: string, attachments?: ChatAttachment[]) => {
    socketRef.current?.emit('chat-send-stream', { threadId, providerId, content, model, attachments })
  }, [])

  const chatStopStream = useCallback((threadId: string) => {
    socketRef.current?.emit('chat-stop-stream', { threadId })
  }, [])

  const chatGetHistory = useCallback((threadId: string): Promise<any> => {
    return new Promise((resolve) => {
      const id = ++chatReqId.current
      registerOneShot('chat-history', id, 10000).then(data => {
        resolve(data ?? null)
      })
      socketRef.current?.emit('chat-get-history', { _reqId: id, threadId })
    })
  }, [registerOneShot])

  const chatListThreads = useCallback((): Promise<ChatThread[]> => {
    return new Promise((resolve) => {
      const id = ++chatReqId.current
      registerOneShot('chat-threads', id, 10000).then(data => {
        resolve(data?.threads ?? [])
      })
      socketRef.current?.emit('chat-list-threads', { _reqId: id })
    })
  }, [registerOneShot])

  const chatCreateThread = useCallback((providerId: string, model: string): Promise<ChatThread | null> => {
    return new Promise((resolve) => {
      const id = ++chatReqId.current
      registerOneShot('chat-thread-created', id, 10000).then(data => {
        resolve(data?.thread ?? null)
      })
      socketRef.current?.emit('chat-create-thread', { _reqId: id, providerId, model })
    })
  }, [registerOneShot])

  const chatRenameThread = useCallback((threadId: string, title: string) => {
    socketRef.current?.emit('chat-rename-thread', { threadId, title })
  }, [])

  const chatClearThread = useCallback((threadId: string) => {
    socketRef.current?.emit('chat-clear-thread', { threadId })
  }, [])

  const chatDeleteThread = useCallback((threadId: string) => {
    socketRef.current?.emit('chat-delete-thread', { threadId })
  }, [])

  const onChatStreamChunk = useCallback((cb: (data: any) => void) => {
    socketRef.current?.on('chat-stream-chunk', cb)
    return () => { socketRef.current?.off('chat-stream-chunk', cb) }
  }, [])

  const onChatResponse = useCallback((cb: (data: any) => void) => {
    socketRef.current?.on('chat-response', cb)
    return () => { socketRef.current?.off('chat-response', cb) }
  }, [])

  const onChatError = useCallback((cb: (data: any) => void) => {
    socketRef.current?.on('chat-error', cb)
    return () => { socketRef.current?.off('chat-error', cb) }
  }, [])

  const onChatModels = useCallback((cb: (data: any[]) => void) => {
    socketRef.current?.on('chat-models', cb)
    return () => { socketRef.current?.off('chat-models', cb) }
  }, [])

  const onChatHistory = useCallback((cb: (data: any) => void) => {
    socketRef.current?.on('chat-history', cb)
    return () => { socketRef.current?.off('chat-history', cb) }
  }, [])

  const onChatThreads = useCallback((cb: (data: any) => void) => {
    socketRef.current?.on('chat-threads', cb)
    return () => { socketRef.current?.off('chat-threads', cb) }
  }, [])

  return {
    connected,
    sessions,
    workspaces,
    activeWorkspace,
    onTerminalOutput,
    onSessionResumed,
    onAgentStatus,
    onStatusChange,
    onBranchChange,
    onWorkspaceChanged,
    sendTerminalInput,
    sendTerminalResize,
    restartSession,
    resumeSession,
    switchWorkspace,
    createWorkspace,
    deleteWorkspace,
    listDeletedWorkspaces,
    restoreWorkspace,
    permanentDeleteWorkspace,
    refreshWorkspaces,
    taskGroups,
    listTaskGroups,
    createTaskGroup,
    onTaskGroupsChanged,
    getTaskDetail,
    launchTask,
    closeTask,
    taskFollowup,
    previewTaskMerge,
    mergeTask,
    confirmTaskMerge,
    mergeAllTasks,
    checkGitRepo,
    initGitRepo,
    syncTaskBranch,
    applyTaskBranch,
    groupSessions,
    joinGroup,
    ungroupSession,
    renameTaskGroup,
    setTaskPinned,
    deleteTaskGroup,
    closeTab,
    startAgent,
    fetchAgentConfigs,
    fetchInstalledAgents,
    createRawSession,
    createAgentSession,
    createWorkspaceFromGit,
    updateWorkspaceConfig,
    addWorktree,
    removeWorktree,
    listWorktrees,
    startParallelTask,
    emit,
    onFilterEvent,
    filterStats,
    filterHistory,
    commandHistory,
    searchEvents,
    promptHistory,
    requestFilterStats,
    executionHistory,
    sessionStartedAt,
    sessionCompressionModes,
    setSessionCompressionMode,
    onSessionCompressionModeChange,
    getOrchestratorStats,
    getSessionUsage,
    getSessionHistory,
    getTokenUsage,
    getGitLog,
    getGitDiff,
    getGitBranches,
    getGitWorkingTreeDiff,
    getGitCommitFiles,
    getGitWorkingTreeFiles,
    getGitFileDiff,
    getGitFullStatus,
    gitRevertFile,
    gitStageFile,
    gitUnstageFile,
    gitStageAll,
    gitUnstageAll,
    gitCommit,
    gitPull,
    gitPush,
    gitFetch,
    gitDiscardAll,
    onSessionUnhealthy,
    setUserSettings,
    getWorkspaceTree,
    readFile,
    getFileInfo,
    writeFile,
    createFile,
    createFolder,
    renameFile,
    deleteFile,
    trashList,
    trashRestore,
    trashDelete,
    trashEmpty,
    chatGetModels,
    chatSend,
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
    onChatModels,
    onChatHistory,
    onChatThreads,
  }
}
