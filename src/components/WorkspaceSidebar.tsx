import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
import type { WorkspaceInfo, SessionState, ExecutionEvent, AgentConfig, CommandEvent, TaskGroupInfo, TerminalOutput } from '../types'
import { FileExplorer } from './FileExplorer'
import { AGENT_TYPE_SET } from '../utils/agentTypes'
import { getAgentColorImage } from '../agentImages'
import useSocketEvent from '../hooks/useSocketEvent'
import TaskAgentRow, { type TaskMember } from './TaskAgentRow'
import './WorkspaceSidebar.css'

interface PromptHistoryEntry {
  sessionId: string
  originalPrompt: string
  timestamp: number
  source?: string // 'typed' (user submitted) | 'agent-start' (launch prompt)
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
  /** Task whose agents page is currently open. */
  openTaskId?: string | null
  /** Called when a task row is clicked. */
  onSelectTask?: (id: string) => void
  /** Quick-create an empty task group (title only), then open it. */
  onCreateTask?: (title: string) => void
  /** Member sessions of a group for the task's agent rows. */
  onFetchMembers?: (taskGroupId: string) => Promise<TaskMember[]>
  /**
   * Subscribe to the live `terminal-output` stream. Passed down from App (the
   * single useSocket owner) for the per-agent live feed. The panel must NOT call
   * useSocket() itself — each call opens a new connection.
   */
  onTerminalOutput?: (cb: (data: TerminalOutput) => void) => () => void
  /**
   * Fires when a session is resumed. Resuming replays the entire prior
   * conversation into the terminal, which would otherwise flood the agent feed
   * with old prompts/history and light the working spinner. The panel uses this
   * to reset that session's buffer + working state.
   */
  onSessionResumed?: (cb: (data: { sessionId: string }) => void) => () => void
  /** Pull token usage for a session (output/total/estimated cost). */
  getTokenUsage?: (sessionId?: string) => Promise<any>
  /** Rename a task group. */
  onRenameTask?: (taskGroupId: string, title: string) => void
  /** Pin or unpin a task group (pinned tasks sort to the top of the list). */
  onSetTaskPinned?: (taskGroupId: string, pinned: boolean) => void
  /** Open the merge flow for a task (preview, then confirm). */
  onMergeTask?: (taskGroupId: string) => void
  /** Merge every task in the workspace, oldest first. */
  onMergeAllTasks?: () => void
  /** Delete a task group (closes members, retires worktree). */
  onDeleteTask?: (taskGroupId: string) => void
  /** Open the details popup for a task group. */
  onOpenTaskDetails?: (taskGroupId: string) => void
}

// ── Workspace helpers ────────────────────────────────────────────────────

// Agent logo with a letter fallback. Some agent image assets are missing
// (e.g. claude) — without this the <img> hides itself onError and the row
// shows a blank gap.
function AgentLogo({ agentId, size = 16 }: { agentId: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        className="task-logo-fallback"
        style={{ width: size, height: size, fontSize: Math.max(9, size - 6) }}
        title={agentId}
      >
        {agentId.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="task-logo-img"
      style={{ width: size, height: size }}
      src={getAgentColorImage(agentId)}
      alt={agentId}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
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

// VS Code-style inline task rename: the title becomes an input in place.
// Enter or blur commits; Escape cancels. Mirrors the file explorer's rename
// input (selects the whole title — task names have no extension to preserve).
function TaskRenameInput({
  initialName,
  onCommit,
  onCancel,
}: {
  initialName: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialName)
  const committedRef = useRef(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try { inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select() } catch {}
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCommit(inputRef.current?.value ?? value)
  }

  return (
    <input
      ref={inputRef}
      autoFocus
      className="file-tree-inline-input"
      value={value}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit() }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); committedRef.current = true; onCancel() }
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}

// Keep the floating menu on-screen (mirrors FileExplorer's helper).
function clampContextMenuPos(x: number, y: number, estW = 230, estH = 340) {
  return {
    x: Math.max(4, Math.min(x, Math.max(4, window.innerWidth - estW))),
    y: Math.max(4, Math.min(y, Math.max(4, window.innerHeight - estH))),
  }
}

// ── Agent live-output buffer (workspace panel) ──────────────────────────
// One panel-level subscription to the existing `onTerminalOutput` fan-out keeps
// a small, capped tail of each task-agent's live terminal output. `useSocket`
// opens a NEW connection per call, so the panel never calls it — App passes its
// single instance's `onTerminalOutput` down instead (many subscribers are free).
// Chunks append into a ref and commit to React state on a throttle, so a busy
// agent never triggers a setState per chunk.

const AGENT_FEED_CAP = 8192 // ~8 KB tail per session
const AGENT_FEED_FLUSH_MS = 100

type AgentOutEntry = {
  text: string
  lastLine: string
  /** Last time ANY bytes arrived (drives the "5s" relative-time label). */
  ts: number
  /** Running length of cleaned text, immune to the tail cap. */
  cleanLen: number
  /** Last time the agent's RESPONSE CONTENT actually changed. Agent TUIs
   *  redraw constantly (spinner frames, cursor moves); those are pure ANSI and
   *  vanish after stripping, so they must not count as the agent still
   *  responding. This timestamp is what the working-spinner keys off. */
  contentTs: number
  /** True once the agent has produced at least one line of real (non-chrome)
   *  output — used to show the green "done" dot. */
  hasOutput: boolean
}

// Strip ANSI/control sequences (keeps \t and \n; folds \r\n → \n) so the feed
// renders clean text.
function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')            // CSI
    .replace(/\x1B[@-Z\\-_]/g, '')                       // misc escapes
    .replace(/\r/g, '')                                  // CR
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')     // remaining control chars
}

// Agent CLIs (opencode, codex, …) render a TUI "loading bar" / spinner using
// real glyphs — block elements (█ ░ ▒ ▓ ▀ ▄), box-drawing, and braille spinner
// frames. Those are ordinary text, so after ANSI-stripping they survive and
// would otherwise (a) be shown as the agent's "current line" instead of its
// thinking/output, and (b) refresh the content timestamp on every frame, keeping
// the working spinner alive forever. We classify such chrome-only lines as
// noise and ignore them, so only the agent's genuine thinking/output counts.
const NOISE_RE = /[▀-▟⠀-⣿─-╿■-◿⎰-⏿⬛-⬟]/g

function isChromeOnlyLine(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  const compact = t.replace(/\s+/g, '')
  if (!compact) return true
  const noiseCount = (compact.match(NOISE_RE) || []).length
  // A line that is mostly bar/border glyphs is chrome, not content.
  if (noiseCount / compact.length > 0.3) return true
  // A line that is *only* spinner/border glyphs (e.g. "⠋", "────") is chrome.
  const meaningful = t.replace(NOISE_RE, '').replace(/\s+/g, '')
  if (meaningful.length === 0) return true
  return false
}

// The last line that is real agent content (thinking/output), skipping any
// trailing TUI chrome lines.
function lastMeaningfulLine(s: string): string {
  const lines = s.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t && !isChromeOnlyLine(t)) return t.length > 160 ? t.slice(0, 160) : t
  }
  return ''
}

function useAgentOutputBuffer(
  onTerminalOutput: ((cb: (d: TerminalOutput) => void) => () => void) | undefined,
  onSessionResumed: ((cb: (d: { sessionId: string }) => void) => () => void) | undefined,
  trackedIds: string[],
) {
  const bufRef = useRef<Record<string, AgentOutEntry>>({})
  const trackedRef = useRef<Set<string>>(new Set())
  trackedRef.current = useMemo(() => new Set(trackedIds), [trackedIds])
  const [, forceRender] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useSocketEvent<TerminalOutput>(
    onTerminalOutput || (() => () => {}),
    (d) => {
      if (!trackedRef.current.has(d.sessionId)) return
      const clean = stripAnsi(d.data || '')
      if (!clean) return
      const prev = bufRef.current[d.sessionId]
      const text = (prev?.text || '') + clean
      // The "current line" and the content timestamp both key off REAL agent
      // output only. A chunk that is pure TUI chrome (loading bar / spinner)
      // leaves lastLine and contentTs untouched, so a spinning loader can't
      // masquerade as a live response or pin the working spinner on.
      const nextLine = lastMeaningfulLine(clean) || prev?.lastLine || ''
      const contentChanged = nextLine !== (prev?.lastLine || '')
      bufRef.current[d.sessionId] = {
        text: text.length > AGENT_FEED_CAP ? text.slice(-AGENT_FEED_CAP) : text,
        lastLine: nextLine,
        ts: Date.now(),
        cleanLen: (prev?.cleanLen || 0) + clean.length,
        contentTs: contentChanged ? Date.now() : (prev?.contentTs || Date.now()),
        hasOutput: (prev?.hasOutput || false) || contentChanged,
      }
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          forceRender(v => v + 1)
        }, AGENT_FEED_FLUSH_MS)
      }
    },
    [onTerminalOutput],
  )

  // Resuming a session replays its entire prior conversation into the terminal.
  // Drop any buffer we already hold for it so the replayed history (old prompts,
  // past answers) never shows as the "current" line or lights the spinner.
  useSocketEvent<{ sessionId: string }>(
    onSessionResumed || (() => () => {}),
    ({ sessionId }) => {
      delete bufRef.current[sessionId]
      forceRender(v => v + 1)
    },
    [onSessionResumed],
  )

  // Drop buffers for sessions no longer tracked (task/agent gone).
  useEffect(() => {
    for (const id of Object.keys(bufRef.current)) {
      if (!trackedRef.current.has(id)) delete bufRef.current[id]
    }
  }, [trackedIds])

  // Cancel a pending flush on unmount so we never setState after teardown.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return bufRef
}

// How long the agent may go without producing new response CONTENT before we
// stop showing the working spinner. Agent TUIs keep repainting (spinner frames,
// cursor moves) long after they stop responding; those bytes strip to nothing,
// so we time the spinner off real content instead. Kept short so the spinner
// drops as soon as the response ends, with enough slack to ride over the brief
// pauses between tool calls.
const AGENT_CONTENT_LIVE_MS = 5000

// ── Agent run/working state ──────────────────────────────────────────
// Tracks, per session:
//   working      — a user-submitted prompt is being responded to right now
//                  (prompt-gated + recent real content, so typing echo and
//                   lingering `busy` never spin it).
//   completedRun — the agent was given a prompt AND finished that run. This is
//                  the ONLY thing that shows the check mark, so merely opening
//                  or resuming an agent (no prompt) stays grey/idle.
// Resuming a session resets both, treating it as a fresh start.
type RunState = {
  lastPromptTs: number
  outstanding: boolean
  prevStatus?: string
  prevIsWorking: boolean
  hasRun: boolean
  completedRun: boolean
}

function useAgentWorkingFlags(
  promptHistory: PromptHistoryEntry[],
  sessions: Record<string, SessionState>,
  outRef: React.MutableRefObject<Record<string, AgentOutEntry>>,
  onSessionResumed: ((cb: (d: { sessionId: string }) => void) => () => void) | undefined,
): { working: Record<string, boolean>; completed: Record<string, boolean> } {
  const stateRef = useRef<Record<string, RunState>>({})
  const [now, setNow] = useState(() => Date.now())

  // Resuming replays old history, which would look like a burst of "response"
  // and could look "done". Treat it as a fresh start: nothing running, no run.
  useSocketEvent<{ sessionId: string }>(
    onSessionResumed || (() => () => {}),
    ({ sessionId }) => {
      const st = stateRef.current[sessionId]
      if (st) {
        st.outstanding = false
        st.hasRun = false
        st.completedRun = false
        st.prevIsWorking = false
      }
      setNow(Date.now())
    },
    [onSessionResumed],
  )

  // Newest USER-submitted (source 'typed') prompt timestamp per session.
  const latestTyped = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of promptHistory) {
      if (p.source !== 'typed') continue
      if (!m[p.sessionId] || p.timestamp > m[p.sessionId]) m[p.sessionId] = p.timestamp
    }
    return m
  }, [promptHistory])

  // Advance the run state machine. Runs on sessions/prompt changes and on the
  // `now` tick so the working→idle transition (completion) is detected even
  // without further socket events.
  useEffect(() => {
    for (const [sid, s] of Object.entries(sessions)) {
      let st = stateRef.current[sid]
      if (!st) {
        // First sight: assume any existing prompt history is already handled, so
        // opening (or resuming) an agent never spins or shows a check.
        stateRef.current[sid] = {
          lastPromptTs: latestTyped[sid] || 0,
          outstanding: false,
          prevStatus: s.status,
          prevIsWorking: false,
          hasRun: false,
          completedRun: false,
        }
        continue
      }
      // A new user prompt starts a run.
      const maxTyped = latestTyped[sid] || 0
      if (maxTyped > st.lastPromptTs) {
        st.lastPromptTs = maxTyped
        st.outstanding = true
        st.hasRun = true
        st.completedRun = false
      }
      // Live "working" for this instant: prompted + recent real content.
      const entry = outRef.current[sid]
      const contentLive = !!entry && now - entry.contentTs < AGENT_CONTENT_LIVE_MS
      const isWorking = st.outstanding && s.status !== 'exited' && contentLive
      // working → not-working while a run is outstanding means it finished.
      if (st.prevIsWorking && !isWorking && st.outstanding) st.completedRun = true
      st.prevIsWorking = isWorking
      // Settling after a run (busy → idle/waiting/exited) also completes it.
      if (st.prevStatus === 'busy' && (s.status === 'idle' || s.status === 'waiting' || s.status === 'exited')) {
        if (st.outstanding) st.completedRun = true
        st.outstanding = false
      }
      st.prevStatus = s.status
    }
  }, [sessions, latestTyped, now, outRef])

  // Tick while any run is in flight or awaiting completion detection, so the
  // spinner/completion update on their own.
  useEffect(() => {
    const needsTick = Object.values(stateRef.current).some(s => s.outstanding || (s.hasRun && !s.completedRun))
    if (!needsTick) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [sessions, latestTyped, now])

  const working: Record<string, boolean> = {}
  const completed: Record<string, boolean> = {}
  for (const sid of Object.keys(sessions)) {
    const st = stateRef.current[sid]
    if (!st) { working[sid] = false; completed[sid] = false; continue }
    // Recompute live for a responsive spinner (the effect above may lag a frame).
    const entry = outRef.current[sid]
    const contentLive = !!entry && now - entry.contentTs < AGENT_CONTENT_LIVE_MS
    working[sid] = st.outstanding && sessions[sid].status !== 'exited' && contentLive
    completed[sid] = st.completedRun
  }
  return { working, completed }
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
  openTaskId,
  onSelectTask,
  onOpenFolderDirect,
  onCloneDirect,
  onCreateTask,
  onFetchMembers,
  onTerminalOutput,
  onSessionResumed,
  getTokenUsage,
  promptHistory,
  onRenameTask,
  onSetTaskPinned,
  onMergeTask,
  onMergeAllTasks,
  onDeleteTask,
  onOpenTaskDetails,
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
  /** Task whose agents page is currently open. */
  openTaskId?: string | null
  /** Called when a task row is clicked. */
  onSelectTask?: (id: string) => void
  onOpenFolderDirect?: () => void
  onCloneDirect?: () => void
  /** Quick-create an empty task group (title only), then open it. */
  onCreateTask?: (title: string) => void
  /** Member sessions of a group for the task's agent rows. */
  onFetchMembers?: (taskGroupId: string) => Promise<TaskMember[]>
  /**
   * Subscribe to the live `terminal-output` stream. Passed down from App (the
   * single useSocket owner) for the per-agent live feed. The panel must NOT call
   * useSocket() itself — each call opens a new connection.
   */
  onTerminalOutput?: (cb: (data: TerminalOutput) => void) => () => void
  /**
   * Fires when a session is resumed. Resuming replays the entire prior
   * conversation into the terminal, which would otherwise flood the agent feed
   * with old prompts/history and light the working spinner. The panel uses this
   * to reset that session's buffer + working state.
   */
  onSessionResumed?: (cb: (data: { sessionId: string }) => void) => () => void
  /** Pull token usage for a session (output/total/estimated cost). */
  getTokenUsage?: (sessionId?: string) => Promise<any>
  /** Rename a task group. */
  onRenameTask?: (taskGroupId: string, title: string) => void
  /** Pin or unpin a task group (pinned tasks sort to the top of the list). */
  onSetTaskPinned?: (taskGroupId: string, pinned: boolean) => void
  /** Open the merge flow for a task (preview, then confirm). */
  onMergeTask?: (taskGroupId: string) => void
  /** Merge every task in the workspace, oldest first. */
  onMergeAllTasks?: () => void
  /** Delete a task group (closes members, retires worktree). */
  onDeleteTask?: (taskGroupId: string) => void
  /** Open the details popup for a task group. */
  onOpenTaskDetails?: (taskGroupId: string) => void
}) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [membersByTask, setMembersByTask] = useState<Record<string, TaskMember[]>>({})
  const [membersLoadedByTask, setMembersLoadedByTask] = useState<Record<string, boolean>>({})
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)
  // When the task menu is opened via right-click, pin it to the cursor. Null
  // when opened via the "⋮" button (menu anchors to the button as before).
  const [taskMenuPos, setTaskMenuPos] = useState<{ x: number; y: number } | null>(null)
  // Inline (VS Code-style) task rename: { id, name } while the title is being
  // edited in place, replacing the centered rename modal.
  const [renamingTask, setRenamingTask] = useState<{ id: string; name: string } | null>(null)
  // Which agent's stats popover is open (its row key). Kept here — not per-row —
  // so only ONE popover can ever be open: clicking a different agent/task
  // switches it instantly instead of leaving the previous agent's stats on
  // screen while the view navigates.
  const [openDetailsKey, setOpenDetailsKey] = useState<string | null>(null)
  useEffect(() => {
    if (!menuOpenId && !taskMenuId) return
    const handler = () => { setMenuOpenId(null); setTaskMenuId(null) }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [menuOpenId, taskMenuId])

  function handleTaskRowClick(id: string, event?: React.MouseEvent) {
    if (event && event.detail > 1) return
    // The open agent-stats window is persistent — navigating to another task
    // (or agent) does NOT close it; it only closes when you click that same
    // agent again. So we deliberately don't touch openDetailsKey here.
    if (openTaskId !== id) onSelectTask?.(id)
  }

  // Agent rows are always visible, so fetch members for EVERY task (not just the
  // expanded one). Re-runs when the task list changes (new agents auto-attach).
  // Already-loaded tasks keep their rows while refreshing in the background so
  // the list never flashes back to "Loading agents…".
  useEffect(() => {
    if (!onFetchMembers || !taskGroups) return
    let cancelled = false
    const ids = taskGroups.map(t => t.id)
    setMembersLoadedByTask(prev => {
      let changed = false
      const next = { ...prev }
      for (const id of ids) {
        if (!(id in next)) { next[id] = false; changed = true }
      }
      return changed ? next : prev
    })
    for (const id of ids) {
      onFetchMembers(id)
        .then(members => {
          if (cancelled) return
          setMembersByTask(prev => ({ ...prev, [id]: members }))
          setMembersLoadedByTask(prev => ({ ...prev, [id]: true }))
        })
        .catch(() => {
          if (cancelled) return
          setMembersByTask(prev => ({ ...prev, [id]: [] }))
          setMembersLoadedByTask(prev => ({ ...prev, [id]: true }))
        })
    }
    return () => { cancelled = true }
  }, [onFetchMembers, taskGroups])

  // Every task-agent's sessionId — the panel tracks live output for all of them
  // (rows are always visible). Sorted union so the set reference is stable.
  const trackedIds = useMemo(() => {
    const set = new Set<string>()
    for (const list of Object.values(membersByTask)) {
      for (const m of list) if (m.sessionId) set.add(m.sessionId)
    }
    return [...set].sort()
  }, [membersByTask])
  const agentOutRef = useAgentOutputBuffer(onTerminalOutput, onSessionResumed, trackedIds)
  const { working: workingFlags, completed: completedFlags } = useAgentWorkingFlags(promptHistory || [], sessions, agentOutRef, onSessionResumed)

  // The "question" line for each agent row: the last message the USER submitted
  // to that session. Slash commands (e.g. "/clear", "/compact") are the agent's
  // own system commands, not a real prompt, so they're skipped. Rendered as a
  // single truncated line (the row's CSS ellipsizes it), with the agent's live
  // output shown underneath as the "answer".
  const lastPromptBySession = useMemo(() => {
    const m: Record<string, string> = {}
    const list = [...(promptHistory || [])].sort((a, b) => a.timestamp - b.timestamp)
    for (const p of list) {
      if (p.source !== 'typed') continue
      const text = (p.originalPrompt || '').trim()
      if (!text || text.startsWith('/')) continue
      m[p.sessionId] = text
    }
    return m
  }, [promptHistory])

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

  // Pinned tasks float to the top, most recently pinned first; the rest keep
  // their backend order (creation order). Re-sorted here too so the grouping
  // holds even against a stale main process.
  const orderedTasks = useMemo(() => {
    return [...(taskGroups || [])].sort((a, b) => {
      const ap = a.pinnedAt != null
      const bp = b.pinnedAt != null
      if (ap !== bp) return ap ? -1 : 1
      if (ap && bp) return b.pinnedAt! - a.pinnedAt!
      return a.createdAt - b.createdAt
    })
  }, [taskGroups])
  const pinnedTaskCount = useMemo(
    () => orderedTasks.filter(t => t.pinnedAt != null).length,
    [orderedTasks]
  )
  // A task can merge once it has a branch and is live or already done. A task
  // holding a prepared conflict resolution counts too — otherwise the "Confirm
  // & land" step would be unreachable from the sidebar.
  const canMergeTask = (t: TaskGroupInfo) =>
    !!t.branchName && (t.status === 'active' || t.status === 'done' || !!t.mergeCandidateRef)
  const mergeableTasks = useMemo(
    () => (taskGroups || []).filter(canMergeTask),
    [taskGroups]
  )

  return (
    <aside className="sidebar orca-workspace-sidebar">
      <div className="sidebar-top">
        <div className="sidebar-header">
          <h2>Workspace</h2>
          <div className="sidebar-header-buttons">
            <button
              className="add-btn"
              onClick={() => showModal('Task name:', (name) => {
                if (name.trim()) onCreateTask?.(name.trim())
              })}
              title="New task"
            >+</button>
          </div>
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

        {/* ── Tasks live directly under the workspace card. Each row shows the
            task name on top with member agent logos underneath; click expands
            to the named member list. Ungrouped agents get their own section. */}
        {activeWorkspace && (
          <div className="workspace-tasks-top">
            <div className="sidebar-header tasks-header">
              <h2>Tasks</h2>
              {onMergeAllTasks && mergeableTasks.length > 0 && (
                <button
                  className="tasks-merge-all"
                  onClick={onMergeAllTasks}
                  title={`Merge ${mergeableTasks.length} task${mergeableTasks.length === 1 ? '' : 's'} into the integration branch, oldest first`}
                >
                  <i className="codicon codicon-git-merge" /> Merge all
                </button>
              )}
            </div>
            <div className="task-list">
              {orderedTasks.map((t, taskIndex) => {
                 const isPinned = t.pinnedAt != null
                 const members = membersByTask[t.id] || []
                 const isLiveMember = (member: { sessionId: string | null }) => {
                   if (!member.sessionId) return false
                   const session = sessions[member.sessionId]
                   // Drop members whose session is gone (closed) or has exited —
                   // a dead agent shouldn't keep showing from its DB record.
                   return !!session && session.status !== 'exited' && (!session.taskGroupId || session.taskGroupId === t.id)
                 }
                 const liveMembers = (t.members || []).filter(isLiveMember)
                 // Rows show only agents with a LIVE session. Closing a task
                 // agent resets its subtask to `pending` with a null sessionId
                 // (so it can be relaunched) — keeping such members would make a
                 // closed agent linger in the panel. Filtering to live sessions
                 // removes it; it reappears only if relaunched.
                 const rowMembers = members.filter(isLiveMember)
                return (
                  <div key={t.id}>
                    {pinnedTaskCount > 0 && taskIndex === pinnedTaskCount && (
                      <div className="task-list-divider" role="separator" />
                    )}
                    <div
                       className={`task-row task-row-card${openTaskId === t.id || selectedTaskId === t.id ? ' active' : ''}`}
                       onClick={(e) => handleTaskRowClick(t.id, e)}
                       onDoubleClick={(e) => { e.stopPropagation(); onSelectTask?.(t.id) }}
                       onContextMenu={(e) => {
                         // Right-click opens the same task menu at the cursor.
                         e.preventDefault()
                         e.stopPropagation()
                         if (taskMenuId === t.id && taskMenuPos) {
                           setTaskMenuId(null)
                           setTaskMenuPos(null)
                         } else {
                           setTaskMenuId(t.id)
                           setTaskMenuPos({ x: e.clientX, y: e.clientY })
                         }
                       }}
                       title={t.userGoal || t.title}
                    >
                      <div className="task-row-main">
                        <span className="task-row-title-line">
                          {isPinned && (
                            <i className="codicon codicon-pinned task-row-pin" title="Pinned" />
                          )}
                          {renamingTask?.id === t.id ? (
                            <TaskRenameInput
                              initialName={t.title}
                              onCommit={(name) => {
                                setRenamingTask(null)
                                const trimmed = name.trim()
                                if (trimmed && trimmed !== t.title) onRenameTask?.(t.id, trimmed)
                              }}
                              onCancel={() => setRenamingTask(null)}
                            />
                          ) : (
                            <span className="task-row-title">{t.title}</span>
                          )}
                        </span>
                        {openTaskId !== t.id && liveMembers.length > 0 && (
                          <span className="task-row-logos" title={liveMembers.map(m => m.agentId).join(', ')}>
                            {liveMembers.map(m => (
                              <span key={m.sessionId} title={m.agentId}>
                                <AgentLogo agentId={m.agentId} size={16} />
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      {onMergeTask && canMergeTask(t) && (
                        <button
                          className="task-row-merge"
                          onClick={(e) => { e.stopPropagation(); onMergeTask(t.id) }}
                          title={`Merge ${t.title}'s changes into the integration branch`}
                        >
                          <i className="codicon codicon-git-merge" /> Merge changes
                        </button>
                      )}
                    </div>
                    {taskMenuId === t.id && (
                      <div
                        className="workspace-tree-menu"
                        onClick={e => e.stopPropagation()}
                        style={taskMenuPos ? {
                          position: 'fixed',
                          left: Math.min(taskMenuPos.x, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 160),
                          top: Math.min(taskMenuPos.y, (typeof window !== 'undefined' ? window.innerHeight : 1080) - 120),
                          right: 'auto',
                        } : undefined}
                      >
                        <button
                          className="workspace-tree-menu-item"
                          onClick={() => {
                            setTaskMenuId(null)
                            setTaskMenuPos(null)
                            onSetTaskPinned?.(t.id, !isPinned)
                          }}
                        >{isPinned ? 'Unpin task' : 'Pin task'}</button>
                        <button
                          className="workspace-tree-menu-item"
                          onClick={() => {
                            setTaskMenuId(null)
                            setTaskMenuPos(null)
                            setRenamingTask({ id: t.id, name: t.title })
                          }}
                        >Rename</button>
                        <button
                          className="workspace-tree-menu-item"
                          onClick={() => {
                            setTaskMenuId(null)
                            setTaskMenuPos(null)
                            onOpenTaskDetails?.(t.id)
                          }}
                        >Details</button>
                        {onMergeTask && canMergeTask(t) && (
                          <button
                            className="workspace-tree-menu-item"
                            onClick={() => {
                              setTaskMenuId(null)
                              setTaskMenuPos(null)
                              onMergeTask(t.id)
                            }}
                          >Merge changes</button>
                        )}
                        <button
                          className="workspace-tree-menu-item danger"
                          onClick={() => {
                            setTaskMenuId(null)
                            setTaskMenuPos(null)
                            if (confirm(`Delete task "${t.title}"? Its agents will be stopped.`)) onDeleteTask?.(t.id)
                          }}
                        >Delete</button>
                      </div>
                    )}
                    <div className="task-member-list" role="group" aria-label={`Agents in ${t.title}`}>
                      {!membersLoadedByTask[t.id] ? (
                        <div className="task-member-empty">Loading agents…</div>
                      ) : rowMembers.length === 0 ? (
                        <div className="task-member-empty">No agents yet</div>
                      ) : null}
                      {membersLoadedByTask[t.id] && rowMembers.map(m => {
                        const buf = m.sessionId ? agentOutRef.current[m.sessionId] : undefined
                        const rowKey = `${m.agentId}-${m.sessionId || m.subtaskId || m.title}`
                        return (
                          <TaskAgentRow
                            key={rowKey}
                            member={m}
                            sessionStatus={m.sessionId ? sessions[m.sessionId]?.status : undefined}
                            isWorking={!!(m.sessionId && workingFlags[m.sessionId])}
                            hasCompletedRun={!!(m.sessionId && completedFlags[m.sessionId])}
                            active={!!(activeSessionId && m.sessionId === activeSessionId)}
                            previewLine={buf?.lastLine || ''}
                            lastPrompt={m.sessionId ? lastPromptBySession[m.sessionId] || '' : ''}
                            lastLineTs={buf?.ts || 0}
                            isInOpenTask={openTaskId === t.id}
                            onOpenTask={() => onSelectTask?.(t.id)}
                            detailsOpen={openDetailsKey === rowKey}
                            onToggleDetails={() => setOpenDetailsKey(prev => prev === rowKey ? null : rowKey)}
                            getTokenUsage={getTokenUsage}
                            onSelectSession={onSelectSession}
                          />
                        )
                      })}
                    </div>
                  </div>
                )
              })}
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
  taskGroups, selectedTaskId, openTaskId, onSelectTask,
  onOpenFolderDirect, onCloneDirect,
  activeSessionId, onSelectSession,
  onCreateTask, onFetchMembers, onTerminalOutput, onSessionResumed, getTokenUsage, promptHistory,
  onRenameTask, onSetTaskPinned, onMergeTask, onMergeAllTasks, onDeleteTask, onOpenTaskDetails,
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
         openTaskId={openTaskId}
         onSelectTask={onSelectTask}
        onOpenFolderDirect={onOpenFolderDirect}
        onCloneDirect={onCloneDirect}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCreateTask={onCreateTask}
        onFetchMembers={onFetchMembers}
        onTerminalOutput={onTerminalOutput}
        onSessionResumed={onSessionResumed}
        getTokenUsage={getTokenUsage}
        promptHistory={promptHistory}
        onRenameTask={onRenameTask}
        onSetTaskPinned={onSetTaskPinned}
        onMergeTask={onMergeTask}
        onMergeAllTasks={onMergeAllTasks}
        onDeleteTask={onDeleteTask}
        onOpenTaskDetails={onOpenTaskDetails}
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
