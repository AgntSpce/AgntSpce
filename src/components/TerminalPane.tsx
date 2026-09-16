import { useEffect, useRef, useState, memo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { SessionState, AgentConfig, AgentStartConfig } from '../types'
import StatusDot from './StatusDot'
import { getAgentColorImage, getAgentTextImage } from '../agentImages'
import StartupUI from './StartupUI'
import { copyToClipboard, readFromClipboard } from '../utils/clipboard'
import { isAgentTypeId } from '../utils/agentTypes'
import { createTerminalWriteScheduler, type TerminalWriteScheduler } from '../utils/terminalWriteScheduler'
import { queuePanePtyResizeIfHeld, PANE_PTY_RESIZE_HOLD_FLUSH_EVENT } from '../utils/pane-manager/panePtyResizeHold'

interface Props {
  session: SessionState
  onInput: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onRestart: (sessionId: string) => void
  onResumeSession?: (sessionId: string) => void
  onStartAgent: (sessionId: string, config: AgentStartConfig) => void
  onShowAgentModal: (sessionId: string) => void
  onClose?: (sessionId: string) => void
  writeData: string
  agentConfigs?: AgentConfig[]
  style?: React.CSSProperties
  dimmed?: boolean
  onTerminalOutput?: (cb: (event: { sessionId: string, data: string }) => void) => () => void
  layoutMode?: 'grid' | 'focus' | 'side-left' | 'side-right'
  onLayoutChange?: (mode: 'grid' | 'focus' | 'side-left' | 'side-right') => void
  sessionCompressionMode?: 'lite' | 'medium' | 'extreme'
  onSessionCompressionModeChange?: (sessionId: string, mode: 'lite' | 'medium' | 'extreme') => void
  onResizeStart?: (sessionId: string, edge: 'left' | 'right' | 'top' | 'bottom', x: number, y: number) => void
  onResizeMove?: (sessionId: string, edge: 'left' | 'right' | 'top' | 'bottom', x: number, y: number) => void
  onResizeEnd?: () => void
  edgeHandles?: ('left' | 'right' | 'top' | 'bottom')[]
  isResizing?: boolean
  fontSize?: number
  fontFamily?: string
  confirmClose?: boolean
  onCloseConfirmResponse?: (sessionId: string, confirmed: boolean) => void
}

// WebGL hygiene latch (Orca pattern): once an attach fails (GPU process dead,
// WebGL blocked), stop retrying for every pane/mount — each attempt burns a
// canvas and a failed getContext. The latch clears when the window becomes
// visible again (the designated retry boundary).
let webglAttachFailedGlobally = false

// ── Terminal instance parking (Superset v1-terminal-cache / VS Code model) ──
// Layout and focus switches used to UNMOUNT and REBUILD the whole xterm +
// WebGL stack per pane (each layout branch renders a different tree position),
// which made agent switching take seconds. Instead, on unmount the live
// terminal element is parked (detached from the DOM but fully functional —
// subscriptions keep writing into it) and the next mount for the same session
// reparents it instantly. WebGL is released while parked (Orca
// suspendPaneRendering); scrollback is 200 lines so parked memory is tiny.
interface ParkedTerminal {
  el: HTMLDivElement
  term: Terminal
  fitAddon: FitAddon
  scheduler: TerminalWriteScheduler | null
      unsub: (() => void) | undefined
      themeObserver: MutationObserver
      onVisibilityChange: () => void
      releaseWebgl: () => void
      attachWebgl: () => void
  alive: boolean
  mounted: boolean
  lastUsed: number
}
const parkedTerminals = new Map<string, ParkedTerminal>()
const PARKED_TERMINAL_LIMIT = 6

function disposeParkedEntry(id: string, entry: ParkedTerminal): void {
  entry.alive = false
  try { entry.el.remove() } catch { }
  try { entry.unsub?.() } catch { }
  try { entry.themeObserver.disconnect() } catch { }
  document.removeEventListener('visibilitychange', entry.onVisibilityChange)
  entry.releaseWebgl()
  try { entry.scheduler?.dispose() } catch { }
  try { entry.term.dispose() } catch { }
  parkedTerminals.delete(id)
}

function evictParkedTerminals(): void {
  if (parkedTerminals.size <= PARKED_TERMINAL_LIMIT) return
  const candidates = [...parkedTerminals.entries()]
    .filter(([, e]) => !e.mounted)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [id, entry] of candidates) {
    if (parkedTerminals.size <= PARKED_TERMINAL_LIMIT) break
    disposeParkedEntry(id, entry)
  }
}

// Orca safeFit — skip FitAddon.clear()/refresh() when drag hasn't crossed a cell
const MIN_PANE_FIT_WIDTH_PX = 48
const MIN_PANE_FIT_COLS = 8
const MIN_PANE_FIT_ROWS = 4
function getProposedDimensions(fitAddon: FitAddon): { cols: number; rows: number } | null {
  try {
    return fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}
function canMeasurePaneForFit(paneEl: HTMLElement | null, fitAddon: FitAddon): boolean {
  if (paneEl) {
    const rect = paneEl.getBoundingClientRect()
    if (rect.width < MIN_PANE_FIT_WIDTH_PX) return false
  }
  const dims = getProposedDimensions(fitAddon)
  if (!dims) return false
  return dims.cols >= MIN_PANE_FIT_COLS && dims.rows >= MIN_PANE_FIT_ROWS
}
function safeFit(fitAddon: FitAddon, term: Terminal, paneEl: HTMLElement | null, force: boolean = false): boolean {
  if (!canMeasurePaneForFit(paneEl, fitAddon)) return false
  const dims = getProposedDimensions(fitAddon)
  if (!force && dims && dims.cols === term.cols && dims.rows === term.rows) return false
  try {
    fitAddon.fit()
    return true
  } catch {
    return false
  }
}



export default memo(function TerminalPane(props: Props) {
  const { session, onInput, onResize, onResumeSession, onStartAgent, onShowAgentModal, onClose, writeData, agentConfigs, style, dimmed, onTerminalOutput, layoutMode = 'grid', onLayoutChange, sessionCompressionMode = 'lite', onSessionCompressionModeChange, onResizeStart, onResizeMove, onResizeEnd, edgeHandles, isResizing, fontSize = 16, fontFamily = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace", confirmClose = false, onCloseConfirmResponse } = props
  const isResizingRef = useRef(isResizing)
  useEffect(() => { isResizingRef.current = isResizing }, [isResizing])
  const terminalRef = useRef<HTMLDivElement>(null)
  const termInstance = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const schedulerRef = useRef<TerminalWriteScheduler | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const [showStartup, setShowStartup] = useState(false)
  const onTerminalOutputRef = useRef(onTerminalOutput)
  useEffect(() => { onTerminalOutputRef.current = onTerminalOutput })
  const onCloseConfirmRef = useRef(onCloseConfirmResponse)
  useEffect(() => { onCloseConfirmRef.current = onCloseConfirmResponse })
  // Close-confirm dialog state (Cmd/Ctrl+R): Yes is the default choice.
  const [confirmChoice, setConfirmChoice] = useState<'yes' | 'no'>('yes')
  const confirmChoiceRef = useRef<'yes' | 'no'>('yes')
  useEffect(() => { confirmChoiceRef.current = confirmChoice })
  const respondedRef = useRef(false)
  const prevConfirmCloseRef = useRef(confirmClose)
  const confirmBoxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (confirmClose) {
      respondedRef.current = false
      setConfirmChoice('yes')
      // autoFocus is unreliable on plain divs: focus explicitly (rAF so the
      // node exists) or arrows/enter fall through to the terminal behind.
      const raf = requestAnimationFrame(() => {
        try { confirmBoxRef.current?.focus({ preventScroll: true }) } catch {}
      })
      prevConfirmCloseRef.current = confirmClose
      return () => cancelAnimationFrame(raf)
    } else if (prevConfirmCloseRef.current) {
      // Dialog dismissed without closing → hand focus back to the terminal.
      try { termInstance.current?.focus() } catch {}
    }
    prevConfirmCloseRef.current = confirmClose
  }, [confirmClose])

  function respondCloseConfirm(confirmed: boolean) {
    if (respondedRef.current) return
    respondedRef.current = true
    onCloseConfirmRef.current?.(session.id, confirmed)
  }

  // Dialog keys work no matter where DOM focus actually landed (terminal,
  // sidebar, another pane): capture globally while this dialog is open.
  // The box's own onKeyDown below stays as the focused-path handler; both
  // funnel through respondCloseConfirm's once-guard.
  useEffect(() => {
    if (!confirmClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'ArrowLeft') setConfirmChoice('yes')
      else if (e.key === 'ArrowRight') setConfirmChoice('no')
      else if (e.key === 'Escape') respondCloseConfirm(false)
      else respondCloseConfirm(confirmChoiceRef.current === 'yes')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [confirmClose])
  // Active edge-drag listeners — removed if the pane unmounts mid-drag.
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  const isAgentType = isAgentTypeId(session.type)
  const shouldShowStartup = isAgentType && session.status === 'waiting' && showStartup
  const groupColor = session.sessionGroupId
    ? ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f97316'][
        session.sessionGroupId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 7
      ]
    : undefined

  useEffect(() => {
    if (session.status === 'waiting' && isAgentType) {
      setShowStartup(true)
    } else {
      setShowStartup(false)
    }
  }, [session.status, session.id])

  function buildTheme() {
    function v(name: string): string {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    }
    return {
      background: v('--terminal-bg'),
      foreground: v('--terminal-fg'),
      cursor: v('--terminal-cursor'),
      selectionBackground: v('--terminal-selection'),
      black: v('--terminal-black'),
      red: v('--terminal-red'),
      green: v('--terminal-green'),
      yellow: v('--terminal-yellow'),
      blue: v('--terminal-blue'),
      magenta: v('--terminal-magenta'),
      cyan: v('--terminal-cyan'),
      white: v('--terminal-white'),
      brightBlack: v('--terminal-bright-black'),
      brightRed: v('--terminal-bright-red'),
      brightGreen: v('--terminal-bright-green'),
      brightYellow: v('--terminal-bright-yellow'),
      brightBlue: v('--terminal-bright-blue'),
      brightMagenta: v('--terminal-bright-magenta'),
      brightCyan: v('--terminal-bright-cyan'),
      brightWhite: v('--terminal-bright-white'),
    }
  }

  useEffect(() => {
    if (!terminalRef.current) return
    // Restorable placeholders have no PTY — skip creating an xterm instance
    // (saves GPU/memory for many saved-but-not-running sessions).
    if (session.restorable) return

    const container = terminalRef.current

    // ── Reuse path: a parked instance for this session exists ───────────
    // `cached.el` is our OWN host div (never a React-owned node), so moving it
    // between containers is always safe.
    const cached = parkedTerminals.get(session.id)
    if (cached && cached.alive) {
      if (cached.el.parentElement !== container) container.appendChild(cached.el)
      cached.mounted = true
      cached.lastUsed = Date.now()
      termInstance.current = cached.term
      fitAddonRef.current = cached.fitAddon
      schedulerRef.current = cached.scheduler
      // Re-attach GPU rendering: park() releases the WebGL context, so every
      // remount must re-arm it or the pane silently stays on canvas forever.
      requestAnimationFrame(() => { if (cached.alive && cached.mounted) cached.attachWebgl() })
      try { cached.fitAddon.fit() } catch { }
      requestAnimationFrame(() => {
        if (cached.alive && cached.mounted) { try { cached.fitAddon.fit() } catch { } }
      })
      cached.term.focus()
      return () => {
        cached.mounted = false
        try { cached.el.remove() } catch { }
        cached.releaseWebgl()
        evictParkedTerminals()
        if (termInstance.current === cached.term) termInstance.current = null
        if (fitAddonRef.current === cached.fitAddon) fitAddonRef.current = null
        if (schedulerRef.current === cached.scheduler) schedulerRef.current = null
      }
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize,
      fontFamily,
      theme: buildTheme(),
      allowTransparency: false,
      scrollback: 200,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    fitAddonRef.current = fitAddon

    // xterm renders into OUR host div, not the React-owned ref div. Parking
    // detaches only the host — React's node is never moved or removed, which
    // keeps React reconciliation safe (StrictMode double-mounts included).
    const host = document.createElement('div')
    host.className = 'terminal-instance-host'
    container.appendChild(host)

    term.open(host)

    // ── WebGL renderer with hygiene (Orca/Superset pattern) ────────
    // GPU-accelerated rendering keeps full-screen agent-TUI redraws cheap;
    // the canvas fallback repaints the whole grid on CPU and is what made
    // terminals feel sluggish under flood. Leak modes are handled explicitly:
    // - context loss → fall back to canvas for this pane (no retry loops)
    // - attach failure once → module latch stops further attempts
    // - release → force WEBGL_lose_context + zero the canvas so the driver
    //   context cannot outlive disposal (Chromium context-budget protection)
    // - window hidden → context released; visible → re-attached
    let webgl: WebglAddon | null = null
    let webglContextLost = false

    // Live-view guard reads the registry (single source of truth), NOT a
    // closure flag — a parked instance must be able to re-attach WebGL when
    // it is reused later, long after this effect's cleanup ran.
    function isViewLive(): boolean {
      const e = parkedTerminals.get(session.id)
      return !e || (e.alive && e.mounted)
    }

    function releaseWebgl(): void {
      if (!webgl) return
      try {
        const renderer = (webgl as unknown as { _renderer?: { _gl?: WebGLRenderingContext; _canvas?: HTMLCanvasElement } })._renderer
        renderer?._gl?.getExtension('WEBGL_lose_context')?.loseContext()
        const canvas = renderer?._canvas
        if (canvas) { canvas.width = 0; canvas.height = 0 }
      } catch { }
      try { webgl.dispose() } catch { }
      webgl = null
    }

    function attachWebgl(): void {
      if (!isViewLive() || webgl || webglContextLost || webglAttachFailedGlobally || document.hidden) return
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          // Chromium reclaims contexts under GPU pressure; recreating here can
          // loop. Stay on canvas until the next visibility resume.
          webglContextLost = true
          releaseWebgl()
          try { term.refresh(0, term.rows - 1) } catch { }
        })
        term.loadAddon(addon)
        webgl = addon
      } catch {
        webglAttachFailedGlobally = true
        try { term.refresh(0, term.rows - 1) } catch { }
      }
    }

    // Defer past xterm's post-open viewport sync (attach during open races it).
    const webglAttachRaf = requestAnimationFrame(() => attachWebgl())

    const onVisibilityChange = () => {
      if (document.hidden) {
        releaseWebgl()
      } else {
        // Retry boundary: clear latches, re-arm GPU rendering.
        webglAttachFailedGlobally = false
        webglContextLost = false
        requestAnimationFrame(() => attachWebgl())
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    function doFit() {
      safeFit(fitAddon, term, paneRef.current)
    }
    let fitRaf = 0
    let fitAttempts = 0
    function retryFit() {
      doFit()
      const container = terminalRef.current
      const hasSize = !!container && container.clientWidth > 0 && container.clientHeight > 0
      if ((!hasSize || term.cols < 2 || term.rows < 2) && fitAttempts < 30) {
        fitAttempts++
        fitRaf = requestAnimationFrame(retryFit)
      }
    }
    fitRaf = requestAnimationFrame(retryFit)

    term.onData((data) => {
      onInput(session.id, data)
    })

    term.onResize(({ cols, rows }) => {
      const paneEl = paneRef.current
      if (paneEl && queuePanePtyResizeIfHeld(paneEl, cols, rows)) return
      onResize(session.id, cols, rows)
    })

    termInstance.current = term

    term.focus()

    // ── Output write scheduling ─────────────────────────────────────
    // Flood output goes through a per-pane scheduler (parse-paced, priority-
    // classed, hard-capped) instead of straight into xterm, so one flooding
    // agent can't starve the main thread and lag every pane. Dimmed/background
    // panes drain slowly; the focused pane gets parse-clocked fast drains.
    let scheduler: TerminalWriteScheduler | null = null
    try {
      scheduler = createTerminalWriteScheduler(term, !dimmed)
      schedulerRef.current = scheduler
    } catch { scheduler = null }

    // Windows: handle Ctrl+C/V manually since menu roles with accelerators
    // would intercept the key events before xterm.js's textarea can handle them.
    if (navigator.platform?.startsWith('Win')) {
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        const ctrl = e.ctrlKey || e.metaKey
        if (!ctrl) return true
        const key = e.key.toLowerCase()
        if (key === 'c') {
          if (e.shiftKey || term.hasSelection()) {
            e.preventDefault()
            const sel = term.getSelection()
            if (sel) copyToClipboard(sel)
            return false
          }
          return true
        }
        if (key === 'v') {
          e.preventDefault()
          readFromClipboard().then(text => { if (text) term.paste(text) })
          return false
        }
        return true
      })
    }

    // Live output arriving while the saved backlog is still being replayed
    // must be held back, otherwise it gets queued into xterm before older
    // backlog chunks (reordering) or dropped entirely (subscription race).
    const pendingLive: string[] = []
    let backlogDone = true

    if (writeData) {
      backlogDone = false
      // Clear scrollback before loading saved buffer
      term.write('\x1b[3J')
      // Chunk large buffers to avoid blocking the renderer thread
      const chunkSize = 4096
      let offset = 0
      function loadChunk() {
        const chunk = writeData.slice(offset, offset + chunkSize)
        if (chunk) term.write(chunk)
        offset += chunkSize
        if (offset < writeData.length) {
          requestAnimationFrame(loadChunk)
        } else {
          backlogDone = true
          // Enqueue held-back live data through the scheduler (order preserved).
          for (const d of pendingLive.splice(0)) scheduler?.write(d)
        }
      }
      loadChunk()
    }

    const unsub = onTerminalOutputRef.current?.(({ sessionId: sid, data }: { sessionId: string, data: string }) => {
      // NOTE: must not depend on termInstance.current — it is nulled while
      // this pane is parked, and parked terminals MUST keep receiving live
      // output so a remount never needs a backlog replay.
      if (sid !== session.id) return
      if (!backlogDone) {
        pendingLive.push(data)
        return
      }
      if (scheduler) scheduler.write(data)
      else term.write(data)
    })

    const themeObserver = new MutationObserver(() => {
      try { term.options.theme = buildTheme() } catch { }
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // Register for parking: on unmount the instance is kept alive (detached
    // from the DOM) so the next layout/focus switch for this session reuses it
    // instead of rebuilding xterm + WebGL from scratch. Subscription and theme
    // observer stay active while parked — the terminal keeps receiving live
    // output, so remounts are seamless with no backlog replay needed.
    parkedTerminals.set(session.id, {
      el: host,
      term,
      fitAddon,
      scheduler,
      unsub,
      themeObserver,
      onVisibilityChange,
      releaseWebgl,
      attachWebgl,
      alive: true,
      mounted: true,
      lastUsed: Date.now(),
    })

    return () => {
      cancelAnimationFrame(fitRaf)
      cancelAnimationFrame(webglAttachRaf)
      const entry = parkedTerminals.get(session.id)
      if (entry && entry.term === term) {
        // Park: detach ONLY our host div (React's container stays intact),
        // release GPU context, keep everything else alive.
        entry.mounted = false
        try { host.remove() } catch { }
        releaseWebgl()
        evictParkedTerminals()
      } else {
        // Entry was replaced meanwhile (should not happen) — full teardown.
        document.removeEventListener('visibilitychange', onVisibilityChange)
        unsub?.()
        themeObserver.disconnect()
        releaseWebgl()
        scheduler?.dispose()
        term.dispose()
      }
      if (schedulerRef.current === scheduler) schedulerRef.current = null
      termInstance.current = null
      fitAddonRef.current = null
    }
  }, [session.id, session.restorable])

  // Apply font size/family changes live (settings) without rebuilding the
  // terminal: xterm picks up option changes, then refit to the new cell size
  // (which reflows cols/rows and notifies the PTY via the normal path).
  useEffect(() => {
    const applyFont = (term: Terminal, fit: FitAddon | null) => {
      try {
        if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
        if (term.options.fontFamily !== fontFamily) term.options.fontFamily = fontFamily
        if (fit) fit.fit()
      } catch {}
    }
    if (termInstance.current && fitAddonRef.current) {
      applyFont(termInstance.current, fitAddonRef.current)
    } else {
      // Pane is parked (alive but unmounted): update the parked instance so
      // the next remount already uses the new font.
      const parked = parkedTerminals.get(session.id)
      if (parked?.alive) applyFont(parked.term, parked.fitAddon)
    }
  }, [fontSize, fontFamily, session.id])

  // Hold flush → only final cols/rows reach backend after drag
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ cols: number; rows: number }>).detail
      if (detail) onResize(session.id, detail.cols, detail.rows)
    }
    el.addEventListener(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT, handler as EventListener)
    return () => el.removeEventListener(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT, handler as EventListener)
  }, [session.id, onResize])

  // Keep the scheduler's priority class in sync with focus state (dimmed =
  // background pane → slow drain; focused → parse-clocked fast drain).
  useEffect(() => {
    schedulerRef.current?.setForeground(!dimmed)
  }, [dimmed])

  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const fitAddon = fitAddonRef.current
        const term = termInstance.current
        if (fitAddon && term) safeFit(fitAddon, term, el, !!isResizingRef.current)
      })
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  // After a resize drag ends, fit once to match the final container size.
  // Uses safeFit to avoid blink when drag didn't cross a cell boundary.
  useEffect(() => {
    if (!isResizing) {
      const id = requestAnimationFrame(() => {
        const fitAddon = fitAddonRef.current
        const term = termInstance.current
        const el = paneRef.current
        if (fitAddon && term) safeFit(fitAddon, term, el)
      })
      return () => cancelAnimationFrame(id)
    }
  }, [isResizing])

function handleResizeDown(edge: 'left' | 'right' | 'top' | 'bottom', e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!onResizeStart || !onResizeMove) return
    const startX = e.clientX
    const startY = e.clientY
    onResizeStart(session.id, edge, startX, startY)
    document.body.style.cursor = edge === 'left' || edge === 'right' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    function onMove(ev: MouseEvent) {
      onResizeMove?.(session.id, edge, ev.clientX, ev.clientY)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      dragCleanupRef.current = null
      onResizeEnd?.()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    dragCleanupRef.current = onUp
  }

  const handles = edgeHandles ?? ['left', 'right', 'top', 'bottom']
  const showHandle = (edge: 'left' | 'right' | 'top' | 'bottom') =>
    handles.includes(edge) && onResizeStart && onResizeMove

  return (
    <div data-pane-id={session.id} className={`terminal-pane${dimmed ? ' dimmed' : ''}${session.sessionGroupId ? ' grouped' : ''}${isResizing ? ' is-dragging' : ''}`} ref={paneRef} style={session.sessionGroupId ? { ...style, borderLeftColor: groupColor } : style}>
      {showHandle('left') && <div className="pane-resize-handle pane-resize-left" onMouseDown={(e) => handleResizeDown('left', e)} />}
      {showHandle('right') && <div className="pane-resize-handle pane-resize-right" onMouseDown={(e) => handleResizeDown('right', e)} />}
      {showHandle('top') && <div className="pane-resize-handle pane-resize-top" onMouseDown={(e) => handleResizeDown('top', e)} />}
      {showHandle('bottom') && <div className="pane-resize-handle pane-resize-bottom" onMouseDown={(e) => handleResizeDown('bottom', e)} />}
      <div className="terminal-header">
        <StatusDot status={session.status} />
        {isAgentType ? (
          <span className="terminal-agent-badge">
            <img className="terminal-color-img" src={getAgentColorImage(session.type)} alt={session.type} />
            <img className="terminal-title-img" src={getAgentTextImage(session.type)} alt={session.type} />
          </span>
        ) : (
          <span className="terminal-title">{session.type.toUpperCase()}</span>
        )}
        {session.branch && session.branch !== 'unknown' && (
          <span className="terminal-branch">{session.branch}</span>
        )}
        <span className="terminal-layout-btns">
          {isAgentType && (
            <label
              className="terminal-compression-picker"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="terminal-compression-label">agntspce-pc</span>
              <span
                className="terminal-compression-help"
                data-tip="Prompt compression for this agent. Lite keeps ~85% of tokens (most detail). Medium keeps ~65% (balanced). Extreme keeps ~40% (maximum savings, least detail). Applies to prompts sent after switching."
              >?</span>
              <select
                className="terminal-compression-select"
                value={sessionCompressionMode}
                onChange={(e) => {
                  e.stopPropagation()
                  onSessionCompressionModeChange?.(session.id, e.target.value as 'lite' | 'medium' | 'extreme')
                }}
              >
                <option value="lite">Lite</option>
                <option value="medium">Medium</option>
                <option value="extreme">Extreme</option>
              </select>
            </label>
          )}
          <button
            className={`terminal-layout-btn ${layoutMode === 'focus' ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onLayoutChange?.(layoutMode === 'focus' ? 'grid' : 'focus') }}
            title="Full screen"
          >⊞</button>
        </span>
        {onClose && (
          <button className="terminal-close-btn" onClick={() => onClose(session.id)} title="Close">✕</button>
        )}
      </div>
      <div className="terminal-body">
        <div ref={terminalRef} className="terminal-instance" />
        {session.restorable && (
          <div className="terminal-resume-overlay">
            <div className="terminal-resume-content">
              <div className="terminal-resume-icon">
                <i className="codicon codicon-history" style={{ fontSize: 28 }}></i>
              </div>
              <div className="terminal-resume-title">Session saved — not running</div>
              <div className="terminal-resume-desc">Start this agent again to continue where it left off.</div>
              <button
                className="terminal-resume-btn"
                onClick={(e) => { e.stopPropagation(); onResumeSession?.(session.id) }}
              >
                <i className="codicon codicon-play" style={{ fontSize: 12 }}></i>
                Resume Session
              </button>
            </div>
          </div>
        )}
        {shouldShowStartup && (
          <div className="terminal-startup-overlay">
            <StartupUI
              sessionId={session.id}
              agentConfigs={agentConfigs ?? []}
              onStart={onStartAgent}
              onAdvanced={() => onShowAgentModal(session.id)}
              onDismiss={() => setShowStartup(false)}
            />
          </div>
        )}
        {confirmClose && (
          <div
            className="pane-confirm-overlay"
            onMouseDown={(e) => { if (e.target === e.currentTarget) respondCloseConfirm(false) }}
          >
            <div
              className="pane-confirm-box"
              tabIndex={-1}
              ref={confirmBoxRef}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); setConfirmChoice('yes') }
                else if (e.key === 'ArrowRight') { e.preventDefault(); setConfirmChoice('no') }
                else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); respondCloseConfirm(confirmChoice === 'yes') }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); respondCloseConfirm(false) }
              }}
            >
              <div className="pane-confirm-title">Remove this agent?</div>
              <div className="pane-confirm-sub">{session.type} · {session.id.slice(-8)}</div>
              <div className="pane-confirm-actions">
                <button
                  tabIndex={-1}
                  className={`pane-confirm-btn yes${confirmChoice === 'yes' ? ' selected' : ''}`}
                  onClick={() => respondCloseConfirm(true)}
                >Yes</button>
                <button
                  tabIndex={-1}
                  className={`pane-confirm-btn no${confirmChoice === 'no' ? ' selected' : ''}`}
                  onClick={() => respondCloseConfirm(false)}
                >No</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}, areTerminalPanePropsEqual)

// Custom memo comparator: volatile props (inline callbacks, fresh style objects,
// writeData strings) change on every parent render and would defeat memo,
// forcing ALL panes to re-render when any session updates. Only re-render when
// the things that actually affect this pane change.
function areTerminalPanePropsEqual(prev: Props, next: Props): boolean {
  if (prev.session !== next.session) return false
  if (prev.writeData !== next.writeData) return false
  if (prev.dimmed !== next.dimmed) return false
  if (prev.layoutMode !== next.layoutMode) return false
  if (prev.sessionCompressionMode !== next.sessionCompressionMode) return false
  if (prev.onSessionCompressionModeChange !== next.onSessionCompressionModeChange) return false
  if (prev.agentConfigs !== next.agentConfigs) return false
  if (prev.isResizing !== next.isResizing) return false
  if (prev.fontSize !== next.fontSize) return false
  if (prev.fontFamily !== next.fontFamily) return false
  if (prev.confirmClose !== next.confirmClose) return false
  const ps = prev.style
  const ns = next.style
  if (ps?.flex !== ns?.flex) return false
  if (ps?.gridColumn !== ns?.gridColumn) return false
  if (ps?.gridRow !== ns?.gridRow) return false
  if (ps?.display !== ns?.display) return false
  return true
}
