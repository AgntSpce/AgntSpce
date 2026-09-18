import { useState, useEffect, useMemo, useRef, memo, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { SessionState, AgentConfig, AgentStartConfig } from '../types'
import TerminalPane from './TerminalPane'
import AgentPicker from './AgentPicker'
import { getAgentColorImage } from '../agentImages'
import { copyToClipboard, readFromClipboard } from '../utils/clipboard'
import { createTerminalWriteScheduler, type TerminalWriteScheduler } from '../utils/terminalWriteScheduler'
import type { LayoutNode } from '../utils/pane-manager/types'
import { buildInitialTree, updateRatioAtPath, collectLeafIds, areLeafSetsEqual } from '../utils/pane-manager/paneTreeOps'
import { holdPtyResizesForPaneSubtrees } from '../utils/pane-manager/panePtyResizeHold'

export interface PageView {
  id: string
  label: string
  icon: string
  render: () => ReactNode
}

interface Props {
  sessions: SessionState[]
  shellSessions: SessionState[]
  onInput: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onRestart: (sessionId: string) => void
  onResumeSession: (sessionId: string) => void
  onStartAgent: (sessionId: string, config: AgentStartConfig) => void
  onShowAgentModal: (sessionId: string) => void
  onNewAgent: () => void
  onSelectAgent: (agentId: string) => void
  onNewShell: () => void
  onCloseTab: (sessionId: string) => void
  onActiveSessionChange: (id: string | null) => void
  activeSessionId: string | null
  writeBuffersRef: { current: Record<string, string> }
  agentConfigs: AgentConfig[]
  layoutPreset?: 'auto' | '1x1' | '2x2' | '1+2' | '3x3'
  focusMode: boolean
  agentsList?: { id: string; name: string; icon: string }[]
  bottomShellOpen: boolean
  onToggleShell: () => void
  chatSidebarOpen: boolean
  onToggleChatSidebar: () => void
  onTerminalOutput: (cb: (data: any) => void) => () => void
  sessionCompressionModes?: Record<string, 'lite' | 'medium' | 'extreme'>
  onSessionCompressionModeChange?: (sessionId: string, mode: 'lite' | 'medium' | 'extreme') => void
  pageViews?: PageView[]
  activeView: string | null
  onViewChange: (view: string | null) => void
  shellOnly?: boolean
  onTerminalResizerMouseDown?: (e: React.MouseEvent) => void
  terminalHeight?: number
  terminalDrag?: boolean
  agentPickerTrigger?: number
  fontSize?: number
  fontFamily?: string
  pendingCloseSessionId?: string | null
  onCloseConfirm?: (sessionId: string, confirmed: boolean) => void
}

const AGENT_TYPES = [
  { id: 'claude', label: 'Claude Code', icon: '🤖' },
  { id: 'opencode', label: 'Opencode', icon: '🔧' },
  { id: 'codex', label: 'Codex', icon: '⚡' },
  { id: 'gemini', label: 'Gemini CLI', icon: '✨' },
]

const ShellTerminal = memo(function ShellTerminal({ session, onInput, onResize, writeData, hidden, onTerminalOutput, fontSize = 16, fontFamily = "'JetBrains Mono', 'Fira Code', Menlo, monospace" }: {
  session: SessionState
  onInput: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  writeData: string
  hidden: boolean
  onTerminalOutput?: (cb: (data: any) => void) => () => void
  fontSize?: number
  fontFamily?: string
}) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termInstance = useRef<Terminal | null>(null)

  const fitAddonRef = useRef<FitAddon | null>(null)
  const shellSchedulerRef = useRef<TerminalWriteScheduler | null>(null)
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
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize,
      fontFamily,
      theme: buildTheme(),
      allowTransparency: false,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    fitAddonRef.current = fitAddon
    term.open(terminalRef.current)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { try { webgl.dispose() } catch {} })
      term.loadAddon(webgl)
    } catch {}

    let shellScheduler: ReturnType<typeof createTerminalWriteScheduler> | null = null
    try {
      shellScheduler = createTerminalWriteScheduler(term, true)
      shellSchedulerRef.current = shellScheduler
    } catch { shellScheduler = null }
    function doFit() { try { fitAddon.fit() } catch {} }
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
    term.onData((data) => { onInput(session.id, data) })
    term.onResize(({ cols, rows }) => { onResize(session.id, cols, rows) })
    termInstance.current = term

    term.focus()

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

    const themeObserver = new MutationObserver(() => { try { term.options.theme = buildTheme() } catch {} })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    if (writeData) term.write(writeData)

    const unsub = onTerminalOutput?.(({ sessionId: sid, data }: { sessionId: string, data: string }) => {
      if (sid === session.id) {
        if (shellScheduler) shellScheduler.write(data)
        else termInstance.current?.write(data)
      }
    })

    return () => {
      cancelAnimationFrame(fitRaf)
      shellScheduler?.dispose()
      if (shellSchedulerRef.current === shellScheduler) shellSchedulerRef.current = null
      unsub?.()
      themeObserver.disconnect()
      term.dispose()
      termInstance.current = null
    }
  }, [session.id, onTerminalOutput])

  useEffect(() => {
    if (terminalRef.current && !hidden && termInstance.current && fitAddonRef.current) {
      try { fitAddonRef.current.fit() } catch {}
    }
  }, [hidden])

  // Apply font size/family changes live (settings) without rebuilding.
  useEffect(() => {
    const term = termInstance.current
    if (!term) return
    try {
      if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
      if (term.options.fontFamily !== fontFamily) term.options.fontFamily = fontFamily
      fitAddonRef.current?.fit()
    } catch {}
  }, [fontSize, fontFamily])

  useEffect(() => {
    const el = terminalRef.current
    if (!el || hidden) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (fitAddonRef.current) try { fitAddonRef.current.fit() } catch {}
      })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [hidden])

  return (
    <div className="shell-terminal-wrap" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, ...(hidden ? { display: 'none' } : {}) }}>
      <div className="shell-terminal-header">
        <span className="shell-terminal-title">{session.id.slice(-8)}</span>
      </div>
      <div ref={terminalRef} className="shell-terminal-instance" />
    </div>
  )
})

function ShellTabList({ shells, activeShellId, onSelect, onClose, header }: {
  shells: SessionState[]
  activeShellId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  header?: ReactNode
}) {
  return (
    <div className="shell-tab-list">
      {header}
      {shells.map(s => (
        <div
          key={s.id}
          className={`shell-tab-item ${s.id === activeShellId ? 'active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <span className="shell-tab-item-icon">▸</span>
          <span className="shell-tab-item-label">{s.id.slice(-8)}</span>
          <button className="shell-tab-item-close" onClick={(e) => { e.stopPropagation(); onClose(s.id) }} title="Close terminal">✕</button>
        </div>
      ))}
    </div>
  )
}

// ── Orca flex-tree divider (binary tree, rAF 1 flex write/frame) ──
function ResizeHandle({
  direction,
  path,
  onRatioChange,
  setDragging,
}: {
  direction: 'horizontal' | 'vertical'
  path: number[]
  onRatioChange: (path: number[], ratio: number) => void
  setDragging: (v: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const holdRef = useRef<{ flush: () => void; cancel: () => void } | null>(null)
  const rafRef = useRef<number>(0)
  const pendingRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)
  const isHoriz = direction === 'horizontal'

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const divider = ref.current
    if (!divider) return
    const splitEl = divider.parentElement as HTMLElement | null
    if (!splitEl) return
    containerRef.current = splitEl
    const firstChild = divider.previousElementSibling as HTMLElement | null
    const secondChild = divider.nextElementSibling as HTMLElement | null
    holdRef.current = holdPtyResizesForPaneSubtrees([firstChild, secondChild])
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    setDragging(true)
    divider.classList.add('dragging')
    document.body.style.cursor = isHoriz ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: PointerEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const raw = isHoriz
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height
      const clamped = Math.max(0.15, Math.min(0.85, raw))
      pendingRef.current = clamped
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        if (pendingRef.current !== null) onRatioChange(path, pendingRef.current)
      })
    }
    const cleanup = (doFlush: boolean) => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      if (doFlush && pendingRef.current !== null) onRatioChange(path, pendingRef.current)
      pendingRef.current = null
      if (doFlush) holdRef.current?.flush()
      else holdRef.current?.cancel()
      holdRef.current = null
      setDragging(false)
      divider.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      containerRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onBlur)
    }
    const onUp = () => cleanup(true)
    const onCancel = () => cleanup(false)
    const onBlur = () => cleanup(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onBlur)
  }

  return (
    <div
      ref={ref}
      className={`pane-divider ${direction}`}
      onPointerDown={handlePointerDown}
    />
  )
}

function FlexSplitNode({
  node,
  path,
  renderLeaf,
  onRatioChange,
  setDragging,
}: {
  node: LayoutNode
  path: number[]
  renderLeaf: (sessionId: string) => ReactNode
  onRatioChange: (path: number[], ratio: number) => void
  setDragging: (v: boolean) => void
}) {
  if (node.type === 'leaf') {
    return (
      <div className="pane-split-child" style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, display: 'flex' }}>
        {renderLeaf(node.sessionId)}
      </div>
    )
  }
  return (
    <div className={`pane-split ${node.direction}`} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <div className="pane-split-child" style={{ flex: `${node.ratio} 1 0%`, minWidth: 0, minHeight: 0, display: 'flex' }}>
        <FlexSplitNode node={node.first} path={[...path, 0]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} setDragging={setDragging} />
      </div>
      <ResizeHandle direction={node.direction} path={path} onRatioChange={onRatioChange} setDragging={setDragging} />
      <div className="pane-split-child" style={{ flex: `${1 - node.ratio} 1 0%`, minWidth: 0, minHeight: 0, display: 'flex' }}>
        <FlexSplitNode node={node.second} path={[...path, 1]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} setDragging={setDragging} />
      </div>
    </div>
  )
}

export default memo(function TerminalArea({
  sessions, shellSessions, onInput, onResize, onRestart, onResumeSession,
  onStartAgent, onShowAgentModal, onSelectAgent, onNewShell, onCloseTab, onActiveSessionChange,
  activeSessionId, writeBuffersRef, agentConfigs,
  focusMode, agentsList, bottomShellOpen, onToggleShell,
  onTerminalOutput,
  sessionCompressionModes = {},
  onSessionCompressionModeChange,
  pageViews, activeView, onViewChange, shellOnly,
  onTerminalResizerMouseDown, terminalHeight = 40, terminalDrag,
  fontSize = 16,
  fontFamily = "'JetBrains Mono', 'Fira Code', Menlo, monospace",
  pendingCloseSessionId = null,
  onCloseConfirm,
}: Props) {
  const [activeGroupTab, setActiveGroupTab] = useState<string>('all')
  const [showAgentDropdown, setShowAgentDropdown] = useState(false)
  const [activeShellId, setActiveShellId] = useState<string | null>(null)
  const [terminalFullscreen, setTerminalFullscreen] = useState(false)
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null)
  const [splitLayout, setSplitLayout] = useState<'grid' | 'side-left' | 'side-right'>('grid')
  const prevShellCount = useRef(shellSessions.length)
  const [isFlexDragging, setIsFlexDragging] = useState(false)
  const [layoutTree, setLayoutTree] = useState<LayoutNode | null>(null)

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of sessions) {
      counts[s.type] = (counts[s.type] || 0) + 1
    }
    return counts
  }, [sessions])

  const filteredSessions = useMemo(() => {
    if (activeGroupTab === 'all') return sessions
    return sessions.filter(s => s.type === activeGroupTab)
  }, [sessions, activeGroupTab])

  useEffect(() => {
    if (activeGroupTab !== 'all' && activeSessionId) {
      const session = sessions.find(s => s.id === activeSessionId)
      if (session && session.type !== activeGroupTab) {
        const firstInGroup = filteredSessions[0]
        if (firstInGroup) onActiveSessionChange(firstInGroup.id)
      }
    }
  }, [activeGroupTab])

  useEffect(() => {
    if (!activeSessionId || filteredSessions.some(s => s.id === activeSessionId)) return
    const session = sessions.find(s => s.id === activeSessionId)
    if (session) setActiveGroupTab('all')
  }, [activeSessionId])

  useEffect(() => {
    if (!activeShellId && shellSessions.length > 0) {
      setActiveShellId(shellSessions[shellSessions.length - 1].id)
    }
  }, [shellSessions])

  useEffect(() => {
    if (shellSessions.length > prevShellCount.current) {
      setActiveShellId(shellSessions[shellSessions.length - 1].id)
    }
    prevShellCount.current = shellSessions.length
  }, [shellSessions])

  // Binary flex-tree layout — derive initial tree from ids, preserve ratios when leaf set unchanged
  useEffect(() => {
    const ids = filteredSessions.map(s => s.id)
    if (ids.length === 0) {
      setLayoutTree(null)
      return
    }
    setLayoutTree(prev => {
      if (!prev) return buildInitialTree(ids)
      const prevIds = collectLeafIds(prev)
      if (areLeafSetsEqual(prevIds, ids)) return prev
      // Leaf set changed (add/remove) — rebuild fresh with 0.5 defaults
      return buildInitialTree(ids)
    })
  }, [filteredSessions])

  const handleFlexRatioChange = (path: number[], ratio: number) => {
    setLayoutTree(prev => {
      if (!prev) return prev
      const next = updateRatioAtPath(prev, path, ratio)
      return next ?? prev
    })
  }

  // Exit full screen (and side splits) if the focused session is closed.
  useEffect(() => {
    if (focusSessionId && !filteredSessions.some(s => s.id === focusSessionId)) {
      setFocusSessionId(null)
      setSplitLayout('grid')
    }
  }, [filteredSessions, focusSessionId])

  const showAgents = !(terminalFullscreen && bottomShellOpen)

  const activePage = activeView && pageViews?.find(p => p.id === activeView)

  const groupTabs = [
    { id: 'all', label: 'All', icon: '⊞', count: sessions.length },
    ...AGENT_TYPES
      .filter(t => typeCounts[t.id] > 0)
      .map(t => ({ id: t.id, label: t.label, icon: t.icon, count: typeCounts[t.id] })),
  ]

  const areaRef = useRef<HTMLDivElement>(null)
  // Track the pane the user is actually interacting with: clicking or typing
  // in a grid pane doesn't change tab selection, so without this the app's
  // activeSessionId lags behind and actions like Cmd+R target the wrong
  // agent. Pane roots carry data-pane-id (shell terminals don't, ignored).
  useEffect(() => {
    const root = areaRef.current
    if (!root) return
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null
      const id = t?.closest?.('[data-pane-id]')?.getAttribute('data-pane-id')
      if (id) onActiveSessionChange(id)
    }
    root.addEventListener('focusin', onFocusIn)
    return () => root.removeEventListener('focusin', onFocusIn)
  }, [onActiveSessionChange])

  // Ctrl+Tab / Ctrl+Shift+Tab: move keyboard focus across agent panes in
  // visual order (left-to-right, top-to-bottom = DOM order) on both macOS
  // and Windows. Cmd+Tab never reaches the renderer on macOS (the OS steals
  // it for app switching), so Ctrl is the cross-platform modifier. Capture
  // phase + stopPropagation so the focused xterm doesn't also see the Tab.
  useEffect(() => {
    const root = areaRef.current
    if (!root) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return
      const panes = [...root.querySelectorAll('[data-pane-id]')].filter(el => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }) as HTMLElement[]
      if (panes.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const ids = panes.map(p => p.getAttribute('data-pane-id')!)
      let idx = panes.findIndex(p => p.contains(document.activeElement))
      if (idx < 0) idx = activeSessionId ? ids.indexOf(activeSessionId) : -1
      const dir = e.shiftKey ? -1 : 1
      const next = (idx + dir + panes.length) % panes.length
      const target = panes[next]
      const id = ids[next]
      if (id) onActiveSessionChange(id)
      const focusEl = (target.querySelector('textarea') ?? target.querySelector('button')) as HTMLElement | null
      try { focusEl?.focus({ preventScroll: true }) } catch { try { focusEl?.focus() } catch {} }
    }
    root.addEventListener('keydown', onKeyDown, true)
    return () => root.removeEventListener('keydown', onKeyDown, true)
  }, [onActiveSessionChange, activeSessionId])

  function handleShellClose(sessionId: string) {
    const isLast = shellSessions.length <= 1
    const remainingShells = shellSessions.filter(s => s.id !== sessionId)
    onCloseTab(sessionId)
    if (isLast) {
      onToggleShell()
    } else if (remainingShells.length > 0) {
      const nextShell = remainingShells[remainingShells.length - 1] || remainingShells[0]
      if (nextShell) setActiveShellId(nextShell.id)
    }
  }

  const useHorizontalScroll = bottomShellOpen && filteredSessions.length >= 3
  const isFullScreen = focusSessionId !== null && splitLayout === 'grid'

  const sessionMap = useMemo(() => {
    const m = new Map<string, SessionState>()
    for (const s of filteredSessions) m.set(s.id, s)
    return m
  }, [filteredSessions])

  const renderLeafPane = (sessionId: string) => {
    const session = sessionMap.get(sessionId)
    if (!session) return null
    return (
      <TerminalPane
        key={session.id}
        session={session}
        onInput={onInput}
        onResize={onResize}
        onRestart={onRestart}
        onResumeSession={onResumeSession}
        onStartAgent={onStartAgent}
        onShowAgentModal={onShowAgentModal}
        writeData={writeBuffersRef.current[session.id] || ''}
        agentConfigs={agentConfigs}
        layoutMode={isFullScreen && session.id === focusSessionId ? 'focus' : 'grid'}
        onLayoutChange={(mode) => {
          if (mode === 'focus') { setFocusSessionId(session.id); setSplitLayout('grid') }
          else if (mode === 'side-left' || mode === 'side-right') { setFocusSessionId(session.id); setSplitLayout(mode) }
          else { setFocusSessionId(null); setSplitLayout('grid') }
        }}
        style={{ flex: 1, minWidth: 0, minHeight: 0 }}
        onClose={onCloseTab}
        dimmed={focusMode && session.id !== activeSessionId && !isFullScreen}
        onTerminalOutput={onTerminalOutput}
        isResizing={isFlexDragging}
        sessionCompressionMode={sessionCompressionModes[session.id] ?? 'lite'}
        onSessionCompressionModeChange={onSessionCompressionModeChange}
        fontSize={fontSize}
        fontFamily={fontFamily}
        confirmClose={pendingCloseSessionId === session.id}
        onCloseConfirmResponse={onCloseConfirm}
      />
    )
  }

  if (shellOnly) {
    return (
      <div
        className="terminal-area-wrapper"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 5,
          height: activePage || terminalFullscreen ? '100%' : bottomShellOpen ? `${terminalHeight}%` : 0,
          overflow: 'hidden',
        }}
      >
        <div className="bottom-shell" style={{ flex: 1, height: '100%' }}>
          {onTerminalResizerMouseDown && bottomShellOpen && (
            <div className="terminal-resizer" onMouseDown={onTerminalResizerMouseDown} />
          )}
          <div className="bottom-shell-body" style={{ display: bottomShellOpen ? 'flex' : 'none' }}>
            <div className="bottom-shell-terminal-area">
              {shellSessions.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                  No shell terminals
                </div>
              ) : (
                shellSessions.map(s => (
                  <ShellTerminal
                    key={s.id}
                    session={s}
                    onInput={onInput}
                    onResize={onResize}
                    writeData={writeBuffersRef.current[s.id] || ''}
                    hidden={s.id !== activeShellId}
                    onTerminalOutput={onTerminalOutput}
                    fontSize={fontSize}
                    fontFamily={fontFamily}
                  />
                ))
              )}
            </div>
            <ShellTabList
              shells={shellSessions}
              activeShellId={activeShellId}
              onSelect={setActiveShellId}
              onClose={handleShellClose}
              header={
                <div className="shell-tab-list-header">
                  <div className="shell-tab-list-header-actions">
                    <button className="shell-header-btn" onClick={() => onNewShell()} title="New terminal">+</button>
                    <button className={`shell-header-btn ${terminalFullscreen ? 'active' : ''}`} onClick={() => setTerminalFullscreen(o => !o)} title={terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                      {terminalFullscreen ? '⊠' : '⊡'}
                    </button>
                    <button className="shell-header-btn" onClick={onToggleShell} title="Close terminal panel">✕</button>
                  </div>
                </div>
              }
            />
          </div>
        </div>
        {activePage && (
          <div className="terminal-area-page-content" style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            background: 'var(--bg-primary)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {activePage.render()}
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={areaRef} className={`terminal-area-wrapper${terminalFullscreen ? ' fullscreen' : ''}`} style={{ position: 'relative' }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        pointerEvents: activePage ? 'none' : 'auto',
      }}>
        {!shellOnly && !activePage && (
          <div className="tab-bar">
            <div className="tab-bar-tabs">
              {groupTabs.map(tab => {
                const isActive = tab.id === activeGroupTab && !activeView
                return (
                  <div
                    key={tab.id}
                    className={`tab-item ${isActive ? 'active' : ''}`}
                    onClick={() => { onViewChange(null); setActiveGroupTab(tab.id); if (terminalFullscreen) setTerminalFullscreen(false) }}
                  >
                    {tab.icon === '⊞' ? (
                      <span className="tab-icon">{tab.icon}</span>
                    ) : (
                      <img className="tab-icon-img" src={getAgentColorImage(tab.id)} alt={tab.label} />
                    )}
                    {tab.icon === '⊞' && <span className="tab-label">{tab.label}</span>}
                    <span className="tab-count">{tab.count}</span>
                  </div>
                )
              })}
            </div>
            {focusMode && (
              <div className="tab-bar-actions" style={{ position: 'relative' }}>
                <span className="focus-indicator" title="Focus mode active (Cmd+Shift+F)">Focus</span>
              </div>
            )}
          </div>
        )}

        {sessions.length === 0 ? (
          <>
            <div className="terminal-area-empty" style={!showAgents ? { display: 'none' } : {}}>
              <div className="empty-state">
                <p>No agent terminals</p>
                <p className="empty-hint">Add an AI coding agent or open a terminal</p>
                <div className="empty-actions" style={{ position: 'relative' }}>
                  <button className="new-terminal-btn" onMouseDown={e => e.nativeEvent.stopPropagation()} onClick={() => {
                    if (agentsList && agentsList.length > 0) {
                      setShowAgentDropdown(o => !o)
                    }
                  }}>+ Agent</button>
                  <button className="shell-btn" onClick={onNewShell} title="Open shell terminal">
                    <i className="codicon codicon-terminal" style={{ fontSize: 16 }}></i>
                  </button>
                  {showAgentDropdown && agentsList && (
                    <AgentPicker
                      agents={agentsList}
                      onSelect={(agentId) => { setShowAgentDropdown(false); onSelectAgent(agentId) }}
                      onClose={() => setShowAgentDropdown(false)}
                    />
                  )}
                </div>
              </div>
            </div>
            {bottomShellOpen && (
              <div className="bottom-shell" style={{ flex: terminalFullscreen ? '1' : `0 0 ${terminalHeight}%` }}>
                {onTerminalResizerMouseDown && (
                  <div className="terminal-resizer" onMouseDown={onTerminalResizerMouseDown} />
                )}
                <div className="bottom-shell-body">
                  <div className="bottom-shell-terminal-area">
                    {shellSessions.length === 0 ? (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                        No shell terminals
                      </div>
                    ) : (
                      shellSessions.map(s => (
                        <ShellTerminal
                          key={s.id}
                          session={s}
                          onInput={onInput}
                          onResize={onResize}
                        writeData={writeBuffersRef.current[s.id] || ''}
                        hidden={s.id !== activeShellId}
                        onTerminalOutput={onTerminalOutput}
                        fontSize={fontSize}
                        fontFamily={fontFamily}
                        />
                      ))
                    )}
                  </div>
                  <ShellTabList
                    shells={shellSessions}
                    activeShellId={activeShellId}
                    onSelect={setActiveShellId}
                    onClose={handleShellClose}
                    header={
                      <div className="shell-tab-list-header">
                        <div className="shell-tab-list-header-actions">
                          <button className="shell-header-btn" onClick={() => onNewShell()} title="New terminal">+</button>
                          <button className={`shell-header-btn ${terminalFullscreen ? 'active' : ''}`} onClick={() => setTerminalFullscreen(o => !o)} title={terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                            {terminalFullscreen ? '⊠' : '⊡'}
                          </button>
                          <button className="shell-header-btn" onClick={onToggleShell} title="Close terminal panel">✕</button>
                        </div>
                      </div>
                    }
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {showAgents && (
              splitLayout !== 'grid' && focusSessionId ? (
                <div className={`terminal-area${isFlexDragging ? ' no-transition' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, gap: 4, padding: '0 4px 4px' }}>
                  {splitLayout === 'side-left' ? (
                    <>
                      {filteredSessions.filter(s => s.id === focusSessionId).map(session => (
                        <TerminalPane key={session.id} session={session} onInput={onInput} onResize={onResize} onRestart={onRestart} onResumeSession={onResumeSession} onStartAgent={onStartAgent} onShowAgentModal={onShowAgentModal} writeData={writeBuffersRef.current[session.id] || ''} agentConfigs={agentConfigs} layoutMode="side-left" onLayoutChange={(m) => { if (m === 'grid') { setFocusSessionId(null); setSplitLayout('grid') } else if (m === 'focus') setFocusSessionId(null); else { setFocusSessionId(session.id); setSplitLayout(m) } }} style={{ flex: 1, minWidth: 0 }} onClose={onCloseTab} dimmed={false} onTerminalOutput={onTerminalOutput} isResizing={isFlexDragging} sessionCompressionMode={sessionCompressionModes[session.id] ?? 'lite'} onSessionCompressionModeChange={onSessionCompressionModeChange} fontSize={fontSize} fontFamily={fontFamily} confirmClose={pendingCloseSessionId === session.id} onCloseConfirmResponse={onCloseConfirm} />
                      ))}
                      <div className="terminal-area" style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4, gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', alignContent: 'start' }}>
                        {filteredSessions.filter(s => s.id !== focusSessionId).map(session => (
                          <TerminalPane key={session.id} session={session} onInput={onInput} onResize={onResize} onRestart={onRestart} onResumeSession={onResumeSession} onStartAgent={onStartAgent} onShowAgentModal={onShowAgentModal} writeData={writeBuffersRef.current[session.id] || ''} agentConfigs={agentConfigs} layoutMode="grid" onLayoutChange={(m) => { if (m === 'grid') { setFocusSessionId(null); setSplitLayout('grid') } else if (m === 'focus') { setFocusSessionId(session.id); setSplitLayout('grid') } else { setFocusSessionId(session.id); setSplitLayout(m) } }} style={{}} onClose={onCloseTab} dimmed={focusMode && session.id !== activeSessionId} onTerminalOutput={onTerminalOutput} isResizing={isFlexDragging} sessionCompressionMode={sessionCompressionModes[session.id] ?? 'lite'} onSessionCompressionModeChange={onSessionCompressionModeChange} fontSize={fontSize} fontFamily={fontFamily} confirmClose={pendingCloseSessionId === session.id} onCloseConfirmResponse={onCloseConfirm} />
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="terminal-area" style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4, gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', alignContent: 'start' }}>
                        {filteredSessions.filter(s => s.id !== focusSessionId).map(session => (
                          <TerminalPane key={session.id} session={session} onInput={onInput} onResize={onResize} onRestart={onRestart} onResumeSession={onResumeSession} onStartAgent={onStartAgent} onShowAgentModal={onShowAgentModal} writeData={writeBuffersRef.current[session.id] || ''} agentConfigs={agentConfigs} layoutMode="grid" onLayoutChange={(m) => { if (m === 'grid') { setFocusSessionId(null); setSplitLayout('grid') } else if (m === 'focus') { setFocusSessionId(session.id); setSplitLayout('grid') } else { setFocusSessionId(session.id); setSplitLayout(m) } }} style={{}} onClose={onCloseTab} dimmed={focusMode && session.id !== activeSessionId} onTerminalOutput={onTerminalOutput} isResizing={isFlexDragging} sessionCompressionMode={sessionCompressionModes[session.id] ?? 'lite'} onSessionCompressionModeChange={onSessionCompressionModeChange} fontSize={fontSize} fontFamily={fontFamily} confirmClose={pendingCloseSessionId === session.id} onCloseConfirmResponse={onCloseConfirm} />
                        ))}
                      </div>
                      {filteredSessions.filter(s => s.id === focusSessionId).map(session => (
                        <TerminalPane key={session.id} session={session} onInput={onInput} onResize={onResize} onRestart={onRestart} onResumeSession={onResumeSession} onStartAgent={onStartAgent} onShowAgentModal={onShowAgentModal} writeData={writeBuffersRef.current[session.id] || ''} agentConfigs={agentConfigs} layoutMode="side-right" onLayoutChange={(m) => { if (m === 'grid') { setFocusSessionId(null); setSplitLayout('grid') } else if (m === 'focus') setFocusSessionId(null); else { setFocusSessionId(session.id); setSplitLayout(m) } }} style={{ flex: 1, minWidth: 0 }} onClose={onCloseTab} dimmed={false} onTerminalOutput={onTerminalOutput} isResizing={isFlexDragging} sessionCompressionMode={sessionCompressionModes[session.id] ?? 'lite'} onSessionCompressionModeChange={onSessionCompressionModeChange} fontSize={fontSize} fontFamily={fontFamily} confirmClose={pendingCloseSessionId === session.id} onCloseConfirmResponse={onCloseConfirm} />
                      ))}
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="agent-fullscreen-bar" style={{ display: isFullScreen ? 'flex' : 'none' }}>
                    <div className="agent-fullscreen-tabs">
                      {filteredSessions.map(s => (
                        <div
                          key={s.id}
                          className={`agent-fullscreen-tab ${s.id === focusSessionId ? 'active' : ''}`}
                          onClick={() => { setFocusSessionId(s.id); onActiveSessionChange(s.id) }}
                          title={s.id.slice(-8)}
                        >
                          <img className="tab-icon-img" src={getAgentColorImage(s.type)} alt={s.type} />
                          <span className="agent-fullscreen-tab-label">{s.type.toUpperCase()}</span>
                        </div>
                      ))}
                    </div>
                    <div className="agent-fullscreen-actions">
                      <button className="agent-fullscreen-btn" onClick={() => { setFocusSessionId(null); setSplitLayout('grid') }} title="Restore the tiled layout">
                        <i className="codicon codicon-split-horizontal" style={{ fontSize: 14 }}></i>
                        Split Agents
                      </button>
                    </div>
                  </div>
                  {isFullScreen ? (
                    filteredSessions.filter(s => s.id === focusSessionId).map(session => (
                      <div key={session.id} style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 4px 4px' }}>
                        <TerminalPane
                          session={session}
                          onInput={onInput}
                          onResize={onResize}
                          onRestart={onRestart}
                          onResumeSession={onResumeSession}
                          onStartAgent={onStartAgent}
                          onShowAgentModal={onShowAgentModal}
                          writeData={writeBuffersRef.current[session.id] || ''}
                          agentConfigs={agentConfigs}
                          layoutMode="focus"
                          onLayoutChange={(mode) => {
                            if (mode === 'focus') { setFocusSessionId(session.id); setSplitLayout('grid') }
                            else if (mode === 'side-left' || mode === 'side-right') { setFocusSessionId(session.id); setSplitLayout(mode) }
                            else { setFocusSessionId(null); setSplitLayout('grid') }
                          }}
                          style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                          onClose={onCloseTab}
                          dimmed={false}
                          onTerminalOutput={onTerminalOutput}
                          isResizing={isFlexDragging}
                          fontSize={fontSize}
                          fontFamily={fontFamily}
                          confirmClose={pendingCloseSessionId === session.id}
                          onCloseConfirmResponse={onCloseConfirm}
                        />
                      </div>
                    ))
                  ) : useHorizontalScroll ? (
                    <div className={`terminal-area-hscroll${isFlexDragging ? ' no-transition' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, gap: 4, padding: '0 4px 4px', overflowX: 'auto' }}>
                      {filteredSessions.map(session => (
                        <TerminalPane
                          key={session.id}
                          session={session}
                          onInput={onInput}
                          onResize={onResize}
                          onRestart={onRestart}
                          onResumeSession={onResumeSession}
                          onStartAgent={onStartAgent}
                          onShowAgentModal={onShowAgentModal}
                          writeData={writeBuffersRef.current[session.id] || ''}
                          agentConfigs={agentConfigs}
                          layoutMode="grid"
                          onLayoutChange={(mode) => {
                            if (mode === 'focus') { setFocusSessionId(session.id); setSplitLayout('grid') }
                            else if (mode === 'side-left' || mode === 'side-right') { setFocusSessionId(session.id); setSplitLayout(mode) }
                            else { setFocusSessionId(null); setSplitLayout('grid') }
                          }}
                          style={{ flex: '1 0 50%', minWidth: 0, height: '100%' }}
                          onClose={onCloseTab}
                          dimmed={focusMode && session.id !== activeSessionId && !isFullScreen}
                          onTerminalOutput={onTerminalOutput}
                          isResizing={isFlexDragging}
                          fontSize={fontSize}
                          fontFamily={fontFamily}
                          confirmClose={pendingCloseSessionId === session.id}
                          onCloseConfirmResponse={onCloseConfirm}
                        />
                      ))}
                    </div>
                  ) : layoutTree ? (
                    <div className={`terminal-area${isFlexDragging ? ' no-transition' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, padding: '0 4px 4px', overflow: 'hidden' }}>
                      <FlexSplitNode
                        node={layoutTree}
                        path={[]}
                        renderLeaf={renderLeafPane}
                        onRatioChange={handleFlexRatioChange}
                        setDragging={setIsFlexDragging}
                      />
                    </div>
                  ) : (
                    <div className="terminal-area" style={{ display: 'flex', flex: 1, minHeight: 0, gap: 4, padding: '0 4px 4px' }}>
                      {filteredSessions.map(session => (
                        <TerminalPane
                          key={session.id}
                          session={session}
                          onInput={onInput}
                          onResize={onResize}
                          onRestart={onRestart}
                          onResumeSession={onResumeSession}
                          onStartAgent={onStartAgent}
                          onShowAgentModal={onShowAgentModal}
                          writeData={writeBuffersRef.current[session.id] || ''}
                          agentConfigs={agentConfigs}
                          layoutMode="grid"
                          onLayoutChange={(mode) => {
                            if (mode === 'focus') { setFocusSessionId(session.id); setSplitLayout('grid') }
                            else if (mode === 'side-left' || mode === 'side-right') { setFocusSessionId(session.id); setSplitLayout(mode) }
                            else { setFocusSessionId(null); setSplitLayout('grid') }
                          }}
                          style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                          onClose={onCloseTab}
                          dimmed={focusMode && session.id !== activeSessionId && !isFullScreen}
                          onTerminalOutput={onTerminalOutput}
                          isResizing={isFlexDragging}
                          fontSize={fontSize}
                          fontFamily={fontFamily}
                          confirmClose={pendingCloseSessionId === session.id}
                          onCloseConfirmResponse={onCloseConfirm}
                        />
                      ))}
                    </div>
                  )}
                </>
              )
            )}

            <div className={`bottom-shell${terminalDrag ? ' no-transition' : ''}`} style={{ flex: bottomShellOpen ? (terminalFullscreen ? '1' : `0 0 ${terminalHeight}%`) : '0 0 0', overflow: 'hidden', minHeight: bottomShellOpen ? 80 : 0 }}>
              {onTerminalResizerMouseDown && (
                <div className="terminal-resizer" onMouseDown={onTerminalResizerMouseDown} />
              )}
              <div className="bottom-shell-body" style={{ display: bottomShellOpen ? 'flex' : 'none' }}>
                <div className="bottom-shell-terminal-area">
                  {shellSessions.length === 0 ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                      No shell terminals
                    </div>
                  ) : (
                    shellSessions.map(s => (
                      <ShellTerminal
                        key={s.id}
                        session={s}
                        onInput={onInput}
                        onResize={onResize}
                      writeData={writeBuffersRef.current[s.id] || ''}
                      hidden={s.id !== activeShellId}
                      onTerminalOutput={onTerminalOutput}
                      fontSize={fontSize}
                      fontFamily={fontFamily}
                      />
                    ))
                  )}
                </div>
                <ShellTabList
                  shells={shellSessions}
                  activeShellId={activeShellId}
                  onSelect={setActiveShellId}
                  onClose={handleShellClose}
                  header={
                    <div className="shell-tab-list-header">
                      <div className="shell-tab-list-header-actions">
                        <button className="shell-header-btn" onClick={() => onNewShell()} title="New terminal">+</button>
                        <button className={`shell-header-btn ${terminalFullscreen ? 'active' : ''}`} onClick={() => setTerminalFullscreen(o => !o)} title={terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                          {terminalFullscreen ? '⊠' : '⊡'}
                        </button>
                        <button className="shell-header-btn" onClick={onToggleShell} title="Close terminal panel">✕</button>
                      </div>
                    </div>
                  }
                />
              </div>
            </div>
          </>
        )}
      </div>

      {activePage && (
        <div className="terminal-area-page-content" style={{
          position: 'absolute',
          inset: 0,
          zIndex: 10,
          background: 'var(--bg-primary)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {activePage.render()}
        </div>
      )}
    </div>
  )
})
