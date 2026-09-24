import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
import { AGENT_TYPES, type Session, type SessionConfig, type SavedSessionData, type Worktree, type Workspace } from './types'
import { StatusDetector } from './statusDetector'
import { GitHelper } from './gitHelper'
import { WorktreeHelper } from './worktreeHelper'
import { OutputFilterService } from './outputFilter'
import { PromptHistoryService } from './promptHistory'
import { WorkspaceManager } from './workspaceManager'
import { AgentOrchestrator } from './agentOrchestrator'
import { TokenUsageTracker } from './outputCompressor'
import { CavemanService } from './cavemanService'
import { RingBuffer } from './ringBuffer'
import { toWireEvent } from './outputFilter'
import { ContextWriter } from './orchestration/contextWriter'
import * as rtkManager from './rtkManager'
import { getActiveSearchPath, generateSessionToken } from './searchManager'
import { resolveAgent, getLoginPath, getAllAgentBinaryDirs } from './agentResolver'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
let AGNTSPCE_BIN_DIR = ''
// Check unpacked paths FIRST — they work with shell exec (not inside asar)
for (const dir of [
  path.join(process.resourcesPath || '', 'app.asar.unpacked', 'bin'),
  path.resolve(process.resourcesPath || '', 'bin'),
  // Dev: bundle lives at dist-electron/main.js, so __dirname = dist-electron.
  // One level up is the project root, then bin/. (../.. would resolve to the
  // parent of the project root and miss the repo's bin directory.)
  path.resolve(__dirname, '..', 'bin'),
  path.resolve(__dirname, '..', '..', 'bin'),
]) {
  if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'agntspce'))) {
    AGNTSPCE_BIN_DIR = dir
    break
  }
}
// Fallback: try asar path if no unpacked path found
if (!AGNTSPCE_BIN_DIR) {
  const asarPath = path.resolve(__dirname, '..', '..', 'bin')
  if (fs.existsSync(asarPath)) {
    AGNTSPCE_BIN_DIR = asarPath
  }
}

// Ensure spawn-helper has execute permission (npm install can produce 644)
try {
  const ptyPkgPath = path.resolve(_require.resolve('node-pty/package.json'), '..')
  const helperPath = path.join(ptyPkgPath, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  if (fs.existsSync(helperPath)) {
    const stat = fs.statSync(helperPath)
    if (stat && !(stat.mode & 0o111)) {
      fs.chmodSync(helperPath, 0o755)
      console.log('[sessionManager] Restored execute permission on spawn-helper')
    }
  }
} catch {}

let pty: any = null
try {
  pty = _require('node-pty')
  // Quick smoke-test to confirm node-pty actually works in this environment.
  // The native module can load but still fail at spawn time due to macOS
  // sandbox/permissions or Electron version ABI mismatches with the prebuild.
  try {
    const testShell = getDefaultShell()
    if (fs.existsSync(testShell)) {
      const testPty = pty.spawn(testShell, ['-c', 'echo ok'], {
        name: 'xterm-color',
        cols: 40,
        rows: 10,
        cwd: os.tmpdir(),
        env: { TERM: 'xterm-color', PATH: process.env.PATH || '/usr/bin:/bin' },
      })
      testPty.on('data', () => {})
      testPty.on('exit', () => {})
      testPty.kill()
      console.log('[sessionManager] node-pty smoke-test passed')
    }
  } catch (smokeErr: any) {
    console.warn('[sessionManager] node-pty smoke-test FAILED — spawns will likely fail:', {
      shell: getDefaultShell(),
      shellExists: fs.existsSync(getDefaultShell()),
      error: smokeErr.message,
      code: (smokeErr as any).code,
      errno: (smokeErr as any).errno,
    })
  }
} catch (e) {
  console.error('node-pty failed to load:', e)
}

function getDefaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const shell = process.env.SHELL || '/bin/bash'
  // Validate shell exists; this is a common gotcha when Electron's environment
  // differs from the terminal's (e.g. SHELL unset by sandbox or build tooling).
  if (!fs.existsSync(shell)) {
    console.warn(`[sessionManager] SHELL="${shell}" not found, falling back to /bin/bash`)
    return '/bin/bash'
  }
  return shell
}

function getShellName(): string {
  const shell = getDefaultShell()
  return shell.split('/').pop() || 'bash'
}

function buildShellArgs(commands: string | string[]): string[] {
  if (process.platform === 'win32') {
    let cmds = Array.isArray(commands) ? commands : [commands]
    cmds = cmds.filter(c => !c.startsWith('cd '))
    const joined = cmds.join('; ').replace(/2>\/dev\/null/g, '2>$null').replace(/\|\| echo unknown/g, '')
    if (!joined.trim()) return ['-NoExit', '-NoProfile']
    return ['-NoExit', '-NoProfile', '-Command', joined]
  }
  const shellName = getShellName()
  const joined = Array.isArray(commands) ? commands.join(' && ') : commands
  const keepOpen = joined && joined.trim() ? `${joined} && exec ${shellName}` : `exec ${shellName}`
  return ['-c', keepOpen]
}

// Single-quote a value for safe interpolation into the POSIX shell command
// string that buildShellArgs hands to `sh -c`. Prevents paths containing
// quotes, `$`, backticks or `;` from executing as shell syntax. (On win32,
// buildShellArgs drops cd commands entirely, so this only ever feeds sh.)
function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

// Strip shell-active characters from display-only labels (repo names,
// worktree ids) before they are interpolated into echo commands.
function sanitizeLabel(value: unknown): string {
  return String(value ?? '').replace(/['"`$\\;(){}]/g, '')
}

// ─── RTK Integration ────────────────────────────────────────────
// Token generation, path resolution, and hook management are delegated
// to electron/services/rtkManager.ts. rtkManager.initialize() is called
// in the main process before any sessions are created.

const OUTBOUND_BUFFER_CAP = 8 * 1024 * 1024

// Terminal output is coalesced per session before hitting Socket.IO. Agent
// TUIs redraw many times per second with multi-KB frames; one packet per PTY
// chunk floods both processes with allocations. A 16ms window matches one
// display frame (the renderer already coalesces at 30ms, so perceived latency
// is unchanged).
const OUTPUT_FLUSH_MS = 2
// 64KB frames instead of 512KB: giant frames mean giant string joins and
// socket writes on both sides (GC churn → renderer main-thread stalls during
// multi-agent floods). 64KB still amortizes packet overhead; the renderer
// scheduler re-slices to 16KB parse-sized chunks anyway. Same pattern as
// Orca's daemon batcher (16–64KB slices).
//
// Why the batch window is 2ms, not 16ms: every coalescing hop charges its
// half-window to keystroke echo latency. Orca measured ~8ms of end-to-end
// typing lag from two 8ms hops and cut both to 2ms; flood coalescing stays
// effective because size-triggered flushes (OUTPUT_FLUSH_BYTES) dominate
// under real load. Keystroke echo additionally bypasses this timer entirely
// via the interactive fast path below.
const OUTPUT_FLUSH_BYTES = 64 * 1024

// ── Interactive output fast path (Orca pty.ts pattern) ────────────────────
// After a user keystroke, agent TUIs redraw small prompt regions. Waiting for
// even a 2ms batch timer is fine, but echo must never queue BEHIND bulk
// output already pending for the same session — it jumps straight out.
const INTERACTIVE_OUTPUT_WINDOW_MS = 100        // ≤100ms since last keystroke
const INTERACTIVE_OUTPUT_MAX_CHARS = 1024       // ≤1KB always counts
const INTERACTIVE_REDRAW_MAX_CHARS = 16 * 1024  // bigger ANSI redraws count too
const INTERACTIVE_OUTPUT_BUDGET_CHARS = 32 * 1024 // rolling cap per input episode

// Hard ceiling on a single session's pending (pre-flush) output. Coalescing
// normally keeps this well under OUTPUT_FLUSH_BYTES, but if the renderer ever
// stalls (e.g. a past re-render storm) Socket.IO backpressure pauses the
// socket while the PTY keeps producing data. Capping here guarantees the main
// process can never accumulate unbounded terminal-output buffers regardless
// of client health — oldest bytes are dropped instead of growing without limit.
const OUTPUT_PENDING_HARD_CAP = 4 * 1024 * 1024

// True when EVERY connected renderer is congested enough that another emit
// would only pile into an unbounded engine.io send buffer.
//
// Why drop instead of pause: Socket.IO's socket.pause() gates INBOUND reads,
// not outbound writes — while "paused", every io.emit still queues packets in
// the transport's send buffer, which is how the main process previously grew
// to multi-GB under a stalled renderer. Terminal output is lossy-tolerable
// (agent TUIs repaint full screens continuously), so once all consumers are
// past OUTBOUND_BUFFER_CAP we simply skip the chunk; flushTerminalOutput
// leaves a skip notice that self-heals on the next healthy flush.
function isOutboundCongested(io: any): boolean {
  try {
    let measured = 0
    for (const [, socket] of io.sockets.sockets) {
      const transport = (socket as any)?.conn?.transport
      if (transport?.name !== 'websocket') continue // can't measure — treat as healthy
      const ws = transport.socket as any
      if (!ws || typeof ws.bufferedAmount !== 'number') continue
      measured++
      if (ws.bufferedAmount <= OUTBOUND_BUFFER_CAP) return false // one healthy consumer is enough
    }
    return measured > 0
  } catch {
    return false
  }
}

export class SessionManager extends EventEmitter {
  sessions = new Map<string, Session>()
  workspace: Workspace | null = null
  worktrees: Worktree[] = []
  workspaceSessionMaps = new Map<string, Map<string, Session>>()
  private statusDetector: StatusDetector | null = null
  private gitHelper: GitHelper | null = null
  private worktreeHelper = new WorktreeHelper()
  private io: any
  private branchRefreshInterval: NodeJS.Timeout | null = null
  private isWorkspaceSwitching = false
  autoRestartSessions = false
  private agentManager: any = null
  orchestrator: AgentOrchestrator | null = null
  sessionHistory: { id: string, type: string, worktreeId: string, branch: string, status: string, lastActivity: number, closedAt: number, agentId?: string }[] = []
  tokenUsageTracker = new TokenUsageTracker()
  outputFilter: OutputFilterService
  promptHistory: PromptHistoryService
  cavemanService = new CavemanService()
  private contextWriter: ContextWriter | null = null
  private lastStatusRefresh = new Map<string, number>()
  private lastStatusBytes = new Map<string, number>()
  private pendingOutput = new Map<string, { chunks: string[]; bytes: number; timer: ReturnType<typeof setTimeout> | null }>()
  private compressionMode: 'lite' | 'medium' | 'extreme' = 'lite'
  private nativeSessionLookups = new Map<string, Promise<void>>()
  private resumeFailureProbes = new Map<string, { output: string; timer: ReturnType<typeof setTimeout> | null }>()
  private sessionStateSaveQueue: Promise<void> = Promise.resolve()

  constructor(io: any, agentManager?: any, dataDir?: string) {
    super()
    this.io = io
    this.outputFilter = new OutputFilterService(dataDir)
    this.promptHistory = new PromptHistoryService(dataDir, this.compressionMode)
    // Cumulative token savings persist across app restarts (filter-history.json
    // + filter-stats.json in the user data dir). Do NOT reset on startup.
    if (agentManager) this.agentManager = agentManager
    if (dataDir) this.cavemanService.setDataDir(dataDir)
    this.outputFilter.setOnCommandEvent((event) => {
      try {
        // Wire copies carry only a small output preview — the renderer only
        // renders token counts, and full bodies accumulated in client state.
        this.io.emit('command-filter-event', toWireEvent(event))
      } catch {}
    })
    this.promptHistory.setOnPromptEvent((event) => {
      try {
        this.io.emit('prompt-compress-event', event)
      } catch {}
    })
    this.cavemanService.onRunComplete((sessionId, run) => {
      try {
        this.io.emit('caveman-run-complete', { sessionId, run })
      } catch {}
    })
      // Listen for compression mode changes from the renderer
      this.io.on('connection', (socket: any) => {
        // Send the current mode to the newly connected renderer
        socket.emit('compression-mode-changed', this.compressionMode)
        socket.on('set-compression-mode', (mode: 'lite' | 'medium' | 'extreme') => {
          if (mode !== 'lite' && mode !== 'medium' && mode !== 'extreme') return
          this.setCompressionMode(mode)
        })
        // Per-session (per-agent) modes for the tab dropdowns
        socket.emit('session-compression-modes', this.promptHistory.getAllSessionModes())
        socket.on('set-session-compression-mode', (payload: { sessionId?: string, mode?: 'lite' | 'medium' | 'extreme' }) => {
          const sessionId = payload?.sessionId
          const mode = payload?.mode
          if (!sessionId || (mode !== 'lite' && mode !== 'medium' && mode !== 'extreme')) return
          this.setSessionCompressionMode(sessionId, mode)
        })
      })
  }

  setAgentManager(am: any) { this.agentManager = am }

  setCompressionMode(mode: 'lite' | 'medium' | 'extreme') {
    if (mode !== 'lite' && mode !== 'medium' && mode !== 'extreme') return
    if (this.compressionMode === mode) return
    this.compressionMode = mode
    this.promptHistory.setCompressionMode(mode)
    this.io.emit('compression-mode-changed', mode)
  }

  getCompressionMode(): 'lite' | 'medium' | 'extreme' {
    return this.compressionMode
  }

  setSessionCompressionMode(sessionId: string, mode: 'lite' | 'medium' | 'extreme') {
    if (!sessionId || (mode !== 'lite' && mode !== 'medium' && mode !== 'extreme')) return
    this.promptHistory.setSessionCompressionMode(sessionId, mode)
    this.io.emit('session-compression-mode-changed', { sessionId, mode })
  }

  getSessionCompressionMode(sessionId: string): 'lite' | 'medium' | 'extreme' {
    return this.promptHistory.getSessionCompressionMode(sessionId)
  }

  setStatusDetector(d: StatusDetector) { this.statusDetector = d }
  setGitHelper(g: GitHelper) { this.gitHelper = g }

  getWorkspace(): Workspace | null {
    return this.workspace
  }

  private ensureContextWriter(): ContextWriter | null {
    const repoPath = this.workspace?.repository?.path
    if (!repoPath) {
      this.contextWriter = null
      return null
    }
    if (!this.contextWriter) {
      this.contextWriter = new ContextWriter(repoPath, this.orchestrator?.getStateManager() ?? null)
    } else {
      this.contextWriter.setStateManager(this.orchestrator?.getStateManager() ?? null)
    }
    return this.contextWriter
  }

  setWorkspace(workspace: Workspace | null) {
    this.workspace = workspace
    this.worktrees = []
    if (!workspace) return
    this.buildWorktreesFromWorkspace()
    if (workspace.id && !this.workspaceSessionMaps.has(workspace.id)) {
      this.workspaceSessionMaps.set(workspace.id, new Map())
    }
  }

  private buildWorktreesFromWorkspace() {
    if (!this.workspace) return
    this.worktrees = []
    const { repository, worktrees: wtConfig, terminals } = this.workspace

    if (Array.isArray(terminals)) {
      const seen = new Set<string>()
      for (const t of terminals) {
        const key = `${t.repository?.name}-${t.worktree}`
        if (seen.has(key)) continue
        seen.add(key)
        this.worktrees.push({
          id: key,
          worktreeId: t.worktree,
          repositoryName: t.repository?.name,
          repositoryPath: t.repository?.path,
          path: t.worktreePath || path.join(t.repository?.path || '', t.worktree || ''),
        })
      }
    } else if (repository && wtConfig?.enabled) {
      const pairs = terminals?.pairs || 1
      for (let i = 1; i <= pairs; i++) {
        const wtId = wtConfig.namingPattern.replace('{n}', String(i))
        this.worktrees.push({ id: wtId, path: path.join(repository.path, wtId) })
      }
    }
  }

  async switchWorkspacePreservingSessions(workspace: Workspace) {
    if (!workspace?.id) throw new Error('Workspace missing id')
    const prevId = this.workspace?.id || null
    if (prevId === workspace.id) {
      this.setWorkspace(workspace)
      this.workspaceSessionMaps.set(workspace.id, this.sessions)
      return { sessions: this.getSessionStates(), backlog: {} }
    }
    if (prevId && prevId !== workspace.id) {
      this.workspaceSessionMaps.set(prevId, this.sessions)
    }
    this.setWorkspace(workspace)
    const restored = this.workspaceSessionMaps.get(workspace.id)
    this.sessions = restored || new Map()
    this.workspaceSessionMaps.set(workspace.id, this.sessions)
    // When sessions were restored from the session map, DO NOT re-create
    // sessions from workspace.terminals — that data is stale and can have
    // wrong agent types (e.g. 'claude' instead of 'opencode'), causing
    // duplicate or incorrect sessions. Only restore from the live map.
    if (!restored || restored.size === 0) {
      await this.initializeSessions({ preserveExisting: true })
    }
    return { sessions: this.getSessionStates(), backlog: this.getUndeliveredOutputAndMarkDelivered() }
  }

  async initializeSessions(options: { preserveExisting?: boolean } = {}) {
    this.isWorkspaceSwitching = true
    if (!options.preserveExisting) {
      this.cleanupAllSessions()
    }
    if (!this.workspace) {
      this.isWorkspaceSwitching = false
      return
    }
    if (!this.autoRestartSessions) {
      this.isWorkspaceSwitching = false
      return
    }

    // Ensure worktree directories exist
    for (const wt of this.worktrees) {
      try {
        await fs.promises.access(wt.path)
      } catch {
        try {
          await fs.promises.mkdir(wt.path, { recursive: true })
        } catch { }
      }
    }

    const promises: Promise<void>[] = []

    if (Array.isArray(this.workspace.terminals)) {
      for (const terminal of this.workspace.terminals) {
        const wtKey = `${terminal.repository?.name}-${terminal.worktree}`
        const wt = this.worktrees.find(w => w.id === wtKey)
        if (!wt) continue
        const sessionId = terminal.id
        if (this.sessions.has(sessionId)) continue

        let args: string[]
        if (terminal.terminalType === 'claude') {
          args = buildShellArgs(`cd ${shq(wt.path)}`)
        } else {
          args = buildShellArgs([
            `cd ${shq(wt.path)}`,
            `echo "=== ${sanitizeLabel(terminal.repository?.name)}/${sanitizeLabel(terminal.worktree)} ==="`,
            `echo "Directory: ${sanitizeLabel(wt.path)}"`,
            `echo "Branch: $(git branch --show-current 2>/dev/null || echo unknown)"`,
            `echo ""`,
          ])
        }

        promises.push(
          Promise.resolve().then(() =>
            this.createSession(sessionId, {
              command: getDefaultShell(),
              args,
              cwd: wt.path,
              type: terminal.terminalType,
              worktreeId: terminal.worktree,
              repositoryName: terminal.repository?.name,
              repositoryType: terminal.repository?.type,
            })
          )
        )
      }
    } else {
      for (const wt of this.worktrees) {
        const claudeId = `${wt.id}-claude`
        if (!this.sessions.has(claudeId)) {
          promises.push(
            Promise.resolve().then(() =>
              this.createSession(claudeId, {
                command: getDefaultShell(),
                args: buildShellArgs(`cd ${shq(wt.path)}`),
                cwd: wt.path,
                type: 'claude',
                worktreeId: wt.id,
              })
            )
          )
        }
        const serverId = `${wt.id}-server`
        if (!this.sessions.has(serverId)) {
          promises.push(
            Promise.resolve().then(() =>
              this.createSession(serverId, {
                command: getDefaultShell(),
                args: buildShellArgs([
                  `cd ${shq(wt.path)}`,
                  `echo "=== Server Terminal for ${sanitizeLabel(wt.id)} ==="`,
                  `echo "Directory: ${sanitizeLabel(wt.path)}"`,
                  `echo "Branch: $(git branch --show-current 2>/dev/null || echo unknown)"`,
                  `echo ""`,
                ]),
                cwd: wt.path,
                type: 'server',
                worktreeId: wt.id,
              })
            )
          )
        }
        if (this.gitHelper) {
          promises.push(
            Promise.resolve().then(() => this.updateGitBranch(wt.id, wt.path))
          )
        }
      }
    }
    await Promise.all(promises)

    if (this.workspace?.id) {
      this.workspaceSessionMaps.set(this.workspace.id, this.sessions)
    }
    this.isWorkspaceSwitching = false
    this.startBranchRefresh()
  }

  private scheduleTerminalOutput(sessionId: string, data: string): void {
    // Interactive fast path: output shortly after a keystroke (echo / TUI
    // prompt redraw) flushes immediately instead of waiting out the batch
    // window, and never sits behind previously queued bulk output.
    // IMPORTANT: the chunk is ALWAYS stored first — flushing before storing
    // would drop it whenever no buffer exists yet (first chunk of a burst).
    const immediate = this.shouldFlushInteractive(sessionId, data)
    let entry = this.pendingOutput.get(sessionId)
    if (!entry) {
      entry = { chunks: [], bytes: 0, timer: null }
      this.pendingOutput.set(sessionId, entry)
    }
    entry.chunks.push(data)
    entry.bytes += data.length
    // Enforce the hard ceiling: drop oldest chunks if we somehow exceed it
    // (defends against a stalled client under Socket.IO backpressure).
    if (entry.bytes > OUTPUT_PENDING_HARD_CAP) {
      let dropped = 0
      let i = 0
      while (i < entry.chunks.length && dropped < entry.bytes - OUTPUT_PENDING_HARD_CAP) {
        dropped += entry.chunks[i].length
        i++
      }
      entry.chunks = entry.chunks.slice(i)
      entry.bytes -= dropped
    }
    // Immediate flush for interactive output; large bursts flush immediately;
    // everything else waits out the coalescing window.
    if (immediate || entry.bytes >= OUTPUT_FLUSH_BYTES) {
      this.flushTerminalOutput(sessionId)
      return
    }
    if (!entry.timer) {
      const e = entry
      e.timer = setTimeout(() => {
        e.timer = null
        this.flushTerminalOutput(sessionId)
      }, OUTPUT_FLUSH_MS)
      e.timer.unref?.()
    }
  }

  private lastInputAt = new Map<string, number>()
  private interactiveBudgetChars = new Map<string, number>()

  private shouldFlushInteractive(sessionId: string, data: string): boolean {
    const lastInputAt = this.lastInputAt.get(sessionId)
    if (lastInputAt === undefined) return false
    const now = Date.now()
    if (now - lastInputAt > INTERACTIVE_OUTPUT_WINDOW_MS) {
      this.interactiveBudgetChars.delete(sessionId)
      return false
    }
    // ≤1KB always latency-sensitive; bigger chunks only if they look like an
    // ANSI redraw (agent TUIs repaint >1KB per keypress) — plain command
    // output stays on the throughput path.
    const isRedraw = data.length <= INTERACTIVE_OUTPUT_MAX_CHARS ||
      (data.length <= INTERACTIVE_REDRAW_MAX_CHARS && data.includes('\x1b['))
    if (!isRedraw) {
      this.interactiveBudgetChars.delete(sessionId)
      return false
    }
    const used = this.interactiveBudgetChars.get(sessionId) ?? 0
    if (used + data.length > INTERACTIVE_OUTPUT_BUDGET_CHARS) return false
    this.interactiveBudgetChars.set(sessionId, used + data.length)
    return true
  }

  private flushTerminalOutput(sessionId: string, force = false): void {
    const entry = this.pendingOutput.get(sessionId)
    if (!entry) return
    this.pendingOutput.delete(sessionId)
    if (entry.timer) clearTimeout(entry.timer)
    const data = entry.chunks.join('')
    if (!data) return
    // Only deliver for the live session object; after a workspace switch the
    // data is still in the ring buffer and reaches the client via backlog.
    const session = this.sessions.get(sessionId)
    if (!session || session.pty === null) return
    // Drop-based congestion control: if every renderer is >8MB behind, queueing
    // more bytes would grow engine.io's send buffer without bound. Drop instead
    // (TUIs repaint constantly so frames self-heal) and remember how much was
    // skipped — the next healthy flush announces it, and deliveredBufferLength
    // is left stale so a workspace switch resends the ring-buffer tail.
    if (!force && isOutboundCongested(this.io)) {
      session.pendingSkipNotice = (session.pendingSkipNotice || 0) + data.length
      return
    }
    try {
      if (session.pendingSkipNotice && session.pendingSkipNotice > 0) {
        const skipped = session.pendingSkipNotice
        session.pendingSkipNotice = 0
        const kb = Math.max(1, Math.round(skipped / 1024))
        this.io.emit('terminal-output', { sessionId, data: `\r\n[agntspce: skipped ~${kb} KB of output while the view was busy]\r\n` })
      }
      this.io.emit('terminal-output', { sessionId, data })
    } catch { }
    session.deliveredBufferLength = session.buffer.totalBytes
  }

  async createSession(sessionId: string, config: SessionConfig) {
    if (!pty) throw new Error('node-pty unavailable')
    const env: any = { ...process.env, TERM: 'xterm-color' }

    // Windows: normalize PATH casing — env blocks are case-insensitive with unique keys.
    // Spreading process.env gives us "Path" (Windows canonical), then setting "PATH" later
    // creates duplicate keys. node-pty / ConPTY silently drops one — likely the prepended value.
    if (process.platform === 'win32') {
      // Find the existing PATH-like key in process.env
      const existingPathKey = Object.keys(process.env).find(k => /^path$/i.test(k)) || 'Path'
      const existingPath = env[existingPathKey] || ''
      // Delete any other casing variant to prevent duplicates
      for (const k of Object.keys(env)) {
        if (/^path$/i.test(k) && k !== existingPathKey) delete env[k]
      }
      // Build PATH fresh below — just preserve the original value
      env.__WIN32_ORIGINAL_PATH = existingPath
    }

    const isAgent = (AGENT_TYPES as readonly string[]).includes(config.type)
    const binDir = AGNTSPCE_BIN_DIR

    if (isAgent) {
      // Build PATH: bundled wrappers → resolved agent binary dirs → login shell PATH → inherited PATH
      const loginPath = getLoginPath()
      const agentDirs = getAllAgentBinaryDirs()
      const pathParts: string[] = []
      if (fs.existsSync(binDir)) pathParts.push(binDir)
      for (const d of agentDirs) {
        if (!pathParts.includes(d)) pathParts.push(d)
      }
      const envPath = process.platform === 'win32'
        ? (env.__WIN32_ORIGINAL_PATH || '')
        : (env.PATH || env.Path || '')
      if (loginPath) pathParts.push(loginPath)
      if (envPath) pathParts.push(envPath)

      // Set the canonical key
      const pathKey = process.platform === 'win32'
        ? (Object.keys(process.env).find(k => /^path$/i.test(k)) || 'Path')
        : 'PATH'
      env.AGNTSPCE_ORIGINAL_PATH = loginPath || envPath
      env[pathKey] = pathParts.join(path.delimiter)
    } else {
      // For shell terminals, prepend the bin dir to PATH so wrapper
      // commands (bin/git, bin/ls, etc.) resolve before system bins.
      if (fs.existsSync(binDir)) {
        const pathKey = process.platform === 'win32'
          ? (Object.keys(process.env).find(k => /^path$/i.test(k)) || 'Path')
          : 'PATH'
        // Save the ORIGINAL PATH (without binDir) so bin/agntspce.mjs's
        // resolveBinary() can find the real system binary (e.g. real git)
        // instead of the hook script (bin/git), which would cause recursion.
        const currentPath = env[pathKey] || ''
        env.AGNTSPCE_ORIGINAL_PATH = currentPath
        env[pathKey] = binDir + path.delimiter + currentPath
      }
    }

    env.AGNTSPCE_ENABLED = '1'
    env.AGNTSPCE_NODE_PATH = process.execPath
    // Expose the session id so bin/agntspce.mjs can attribute wrapper token
    // stats to the real session instead of a catch-all "system" bucket.
    env.AGNTSPCE_SESSION_ID = sessionId
    // v2 Tasks: task/subtask identity for agntspce-collab (inherited by the
    // agent CLI and every child process of this PTY).
    if (config.taskGroupId) env.AGNTSPCE_TASK_ID = config.taskGroupId
    if (config.subtaskId) env.AGNTSPCE_SUBTASK_ID = config.subtaskId

    // Inject RTK session token and binary path.
    // AGNTSPCE_RTK_SESSION is verified by the RTK binary's activation gate.
    // AGNTSPCE_RTK_BINARY tells hook scripts where to find the binary.
    env.AGNTSPCE_RTK_SESSION = rtkManager.generateRtkToken()
    const activeRtkPath = rtkManager.getActiveRtkPath()
    if (activeRtkPath) {
      env.AGNTSPCE_RTK_BINARY = activeRtkPath
    } else {
      env.AGNTSPCE_RTK_BINARY = path.join(process.resourcesPath || '', 'rtk', process.platform === 'win32' ? 'rtk.exe' : 'rtk')
    }

    // AGNTSPCE_WRAPPER_PATH tells the RTK plugin where to find the agntspce
    // wrapper. Prefer the .cmd shim (Windows) or the script (macOS/Linux),
    // then fall back to the RTK install directory.
    // On Windows, also set AGNTSPCE_JS so PowerShell hook functions can
    // resolve agntspce.mjs without PATH lookup.
    let wrapperPath = ''
    if (AGNTSPCE_BIN_DIR) {
      if (process.platform === 'win32') {
        const cmdPath = path.join(AGNTSPCE_BIN_DIR, 'agntspce.cmd')
        if (fs.existsSync(cmdPath)) {
          wrapperPath = cmdPath
        } else {
          wrapperPath = path.join(AGNTSPCE_BIN_DIR, 'agntspce')
        }
      } else if (fs.existsSync(path.join(AGNTSPCE_BIN_DIR, 'agntspce'))) {
        wrapperPath = path.join(AGNTSPCE_BIN_DIR, 'agntspce')
      }
    }
    if (!wrapperPath) {
      const rtkDir = activeRtkPath ? path.dirname(activeRtkPath) : path.join(process.resourcesPath || '', 'rtk')
      const rtkWrapper = fs.existsSync(path.join(rtkDir, 'agntspce.cmd'))
        ? path.join(rtkDir, 'agntspce.cmd')
        : fs.existsSync(path.join(rtkDir, 'agntspce'))
          ? path.join(rtkDir, 'agntspce')
          : ''
      if (rtkWrapper) wrapperPath = rtkWrapper
    }
    if (wrapperPath) env.AGNTSPCE_WRAPPER_PATH = wrapperPath

    // On Windows, set AGNTSPCE_JS so hook scripts can find agntspce.mjs
    // without relying on PATH, PATHEXT, or stale exe files.
    if (process.platform === 'win32') {
      const jsPath = wrapperPath
        ? path.resolve(path.dirname(wrapperPath), 'agntspce.mjs')
        : path.join(binDir, 'agntspce.mjs')
      if (fs.existsSync(jsPath)) env.AGNTSPCE_JS = jsPath
    }
    const searchPath = getActiveSearchPath()
    if (searchPath) {
      env.AGNTSPCE_SEARCH_SESSION = generateSessionToken()
      env.AGNTSPCE_SEARCH_BINARY = searchPath
    }

    // TEMPORARY DIAGNOSTIC: log the exact env passed to the Windows PTY
    if (process.platform === 'win32') {
      const diagPathKey = Object.keys(env).find(k => /^path$/i.test(k)) || 'PATH'
      console.log(`[sessionManager][win32] PTY env PATH key="${diagPathKey}" value="${(env[diagPathKey] || '').slice(0, 500)}"`)
      console.log(`[sessionManager][win32] PTY env AGNTSPCE_NODE_PATH="${env.AGNTSPCE_NODE_PATH}"`)
      console.log(`[sessionManager][win32] PTY env AGNTSPCE_JS="${env.AGNTSPCE_JS}"`)
      console.log(`[sessionManager][win32] PTY env AGNTSPCE_WRAPPER_PATH="${env.AGNTSPCE_WRAPPER_PATH}"`)
      console.log(`[sessionManager][win32] PTY shell="${config.command}" args="${JSON.stringify(config.args)}"`)
    }

    // Schedule a diagnostic echo into the PTY after spawn
    const diagnosticCmds = process.platform === 'win32'
      ? [
          'echo [agntspce-diag] BEGIN',
          `echo [agntspce-diag] PATH=$env:PATH`,
          `echo [agntspce-diag] AGNTSPCE_JS=$env:AGNTSPCE_JS`,
          `echo [agntspce-diag] AGNTSPCE_NODE_PATH=$env:AGNTSPCE_NODE_PATH`,
          `echo [agntspce-diag] AGNTSPCE_WRAPPER_PATH=$env:AGNTSPCE_WRAPPER_PATH`,
          'echo [agntspce-diag] END',
        ]
      : []
    if (diagnosticCmds.length > 0) {
      const sid = sessionId
      setImmediate(() => {
        const s = this.sessions.get(sid)
        if (s?.pty) {
          for (const cmd of diagnosticCmds) {
            s.pty.write(cmd + '\r\n')
          }
        }
      })
    }

    if (this.workspace?.envVars) {
      for (const [key, val] of Object.entries(this.workspace.envVars)) {
        env[key] = val
      }
    }
    let slotRelease: (() => void) | null = null
    if (isAgent && this.orchestrator) {
      try {
        slotRelease = await this.orchestrator.acquireSlot()
      } catch (err: any) {
        console.error('[sessionManager] slot acquire failed, skipping session:', sessionId, err?.message || err)
        return
      }
    }
    let ptyProcess
    try {
      ptyProcess = pty.spawn(config.command, config.args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: config.cwd,
        env,
      })
    } catch (spawnErr: any) {
      slotRelease?.()
      const shellPath = config.command || ''
      const shellExists = fs.existsSync(shellPath)
      let shellMode = '?'
      try { if (shellExists) shellMode = fs.statSync(shellPath).mode.toString(8) } catch {}
      console.error('[sessionManager] pty.spawn failed:', {
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        cwdExists: fs.existsSync(config.cwd || ''),
        shellExists,
        shellMode,
        envKeys: Object.keys(env).filter(k => !k.startsWith('AGNTSPCE_')),
        error: spawnErr.message,
        code: (spawnErr as any).code,
        errno: (spawnErr as any).errno,
      })
      throw spawnErr
    }

    // Windows PATH sync: Node.js preserves the ORIGINAL casing of env var
    // names (e.g. "Path" not "PATH") when spreading process.env. If we set
    // env.PATH but env.Path still has the old value, child processes see the
    // stale env.Path. Set both to be safe.
    if (process.platform === 'win32') {
      const winPath = env.PATH || env.Path
      if (winPath) {
        env.PATH = winPath
        env.Path = winPath
      }
    }

    const session: Session = {
      id: sessionId,
      pty: ptyProcess,
      type: config.type as any,
      worktreeId: config.worktreeId,
      repositoryName: config.repositoryName,
      repositoryType: config.repositoryType,
      status: 'idle',
      branch: 'unknown',
      buffer: new RingBuffer(),
      deliveredBufferLength: 0,
      lastActivity: Date.now(),
      tokenUsage: 0,
      config,
      statusChangedAt: Date.now(),
      pendingStatus: null,
      pendingStatusTimer: null,
      cwdState: { current: config.cwd, previous: null, stack: [] },
      autoStarted: false,
      claudeLaunchState: null,
      slotRelease: slotRelease
        ? () => {
            if (slotRelease) {
              slotRelease()
              slotRelease = null
            }
          }
        : null,
    }

    ptyProcess.onData((data: string) => {
      session.buffer.write(data)
      this.maybeRecoverFailedAgentResume(sessionId, data)
      session.lastActivity = Date.now()
      this.orchestrator?.markHealthCheck(sessionId)

      // Process through output filter (detects agntspce $ markers, compresses output, returns modified data for the frontend display)
      const modifiedData = this.outputFilter.processOutput(sessionId, data)

      session.tokenUsage = this.tokenUsageTracker.getUsage(sessionId)?.totalTokens || 0
      this.tokenUsageTracker.trackOutput(sessionId, data)
      const isActive = this.sessions.get(sessionId) === session
      if (isActive) {
        // Send modified data to frontend (with compression applied by
        // outputFilter), coalesced into one packet per flush window.
        this.scheduleTerminalOutput(sessionId, modifiedData)
      }
      // Status detection joins the full buffer and runs regexes — throttle it
      // on the hot output path (processMonitor still refreshes every 5s).
      const lastRefresh = this.lastStatusRefresh.get(sessionId) || 0
      const now = Date.now()
      if (now - lastRefresh >= 500) {
        this.lastStatusRefresh.set(sessionId, now)
        this.refreshSessionStatus(sessionId)
      }
      this.updateSessionContext(sessionId, data)
    })

    ptyProcess.onExit(({ exitCode, signal }: any) => {
      // Deliver any coalesced output before the exit event so the renderer
      // sees the final output in order. Forced: exit summaries are small and
      // there is no later flush to announce a skip for this session.
      this.flushTerminalOutput(sessionId, true)
      session.slotRelease?.()
      this.clearResumeFailureProbe(sessionId)
      clearInterval(session.processMonitor!)
      session.status = 'exited'
      this.outputFilter.finalizeCommand(sessionId, exitCode ?? 1)
      this.persistSessionBuffer(sessionId)
      const isActive = this.sessions.get(sessionId) === session && session.pty === ptyProcess
      if (isActive) {
        try {
          this.io.emit('session-exited', { sessionId, exitCode, signal })
        } catch { }
      }
      if (!isActive) return
      const canRestart = !this.orchestrator || this.orchestrator.canRestart(sessionId)
      if (isActive && config.type === 'claude' && this.autoRestartSessions && !this.isWorkspaceSwitching && canRestart) {
        this.cleanupSessionBuffer(sessionId)
        this.sessions.delete(sessionId)
        this.orchestrator?.recordRestart(sessionId)
        setTimeout(() => {
          this.createSession(sessionId, {
            ...config,
            args: buildShellArgs(`cd ${shq(config.cwd)} && echo "Claude session ended. Type 'claude' to start a new session." && echo ""`),
          })
        }, 500)
      } else {
        this.cleanupSessionBuffer(sessionId)
        this.sessions.delete(sessionId)
      }
    })

    session.workspace = this.workspace?.id || null
    this.sessions.set(sessionId, session)

    if (this.orchestrator) {
      this.orchestrator.registerSession(sessionId, ptyProcess.pid, config.worktreeId, config.type, config.taskGroupId ?? null, config.subtaskId ?? null)
    }

    session.processMonitor = setInterval(() => {
      this.refreshSessionStatus(session.id)
    }, 5000)
  }

  writeToSession(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session?.pty) return false
    try {
      // Stamp the keystroke time — arms the interactive echo fast path so the
      // agent's redraw comes straight back instead of waiting out the batcher.
      this.lastInputAt.set(sessionId, Date.now())
      this.interactiveBudgetChars.delete(sessionId)
      const clean = data.replace(/\n$/, '').trim()
      if (clean && !/^(claude|opencode|gemini|codex)\b/i.test(clean) && !/^--/.test(clean)) {
        this.cavemanService.setPendingPrompt(sessionId, clean)
      }
      if (session.type === 'opencode' && !session.agentStartConfig?.nativeSessionId && !this.nativeSessionLookups.has(sessionId)) {
        this.scheduleOpenCodeSessionLookup(sessionId, session.config.cwd, Date.now())
      }
      session.pty.write(data)
      return true
    } catch { return false }
  }

  resizeSession(sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId)
    if (!session?.pty) return
    try { session.pty.resize(cols, rows) } catch { }
  }

  // 2.2 per-agent context files: update `.agntspce/context/<agentId>.md` on
  // output activity (throttled inside ContextWriter). Session type is the
  // agent id (claude/codex/...) which matches the preamble naming.
  private updateSessionContext(sessionId: string, tailOutput?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (!(AGENT_TYPES as readonly string[]).includes(session.type)) return
    const cw = this.ensureContextWriter()
    if (!cw) return
    const sm = this.orchestrator?.getStateManager()
    const taskId = sm?.getSession(sessionId)?.taskId ?? null
    cw.updateContext(session.type, {
      tailOutput,
      taskId,
      branch: session.branch || null,
      status: session.status,
    })
  }

  // Final context flush on close: bypass throttle, write the full buffer tail,
  // and mark the session exited so the file reflects the end state.
  private finalizeSessionContext(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (!(AGENT_TYPES as readonly string[]).includes(session.type)) return
    const cw = this.ensureContextWriter()
    if (!cw) return
    const sm = this.orchestrator?.getStateManager()
    const taskId = sm?.getSession(sessionId)?.taskId ?? null
    const tail = session.buffer?.snapshot?.() || ''
    cw.updateContext(session.type, {
      tailOutput: tail,
      taskId,
      branch: session.branch || null,
      status: 'exited',
      minIntervalMs: 0,
    })
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.clearResumeFailureProbe(sessionId)
    this.flushTerminalOutput(sessionId)
    session.slotRelease?.()
    this.sessionHistory.push({
      id: sessionId,
      type: session.type,
      worktreeId: session.worktreeId,
      branch: session.branch,
      status: session.status,
      lastActivity: session.lastActivity,
      closedAt: Date.now(),
      agentId: session.agentStartConfig?.agentId,
    })
    if (this.sessionHistory.length > 200) this.sessionHistory = this.sessionHistory.slice(-200)
    this.persistSessionBuffer(sessionId)
    try {
      clearInterval(session.processMonitor!)
      const pty = session.pty
      session.pty = null
      if (pty) {
        try { pty.kill() } catch { }
      }
    } catch { }
    this.outputFilter.finalizeCommand(sessionId)
    this.outputFilter.cleanup(sessionId)
    this.promptHistory.cleanup(sessionId)
    this.cavemanService.cleanup(sessionId)
    this.tokenUsageTracker.cleanup(sessionId)
    this.finalizeSessionContext(sessionId)
    this.sessions.delete(sessionId)
    this.cleanupSessionBuffer(sessionId)
    this.orchestrator?.unregisterSession(sessionId)
    this.statusDetector?.reset(sessionId)
    this.lastStatusRefresh.delete(sessionId)
    this.lastStatusBytes.delete(sessionId)
    this.lastInputAt.delete(sessionId)
    this.interactiveBudgetChars.delete(sessionId)
    return true
  }

  async createRawSession(type: string, workspacePath?: string, existingSessionId?: string, taskGroupId?: string | null, subtaskId?: string | null): Promise<{ sessionId: string } | null> {
    const sessionId = existingSessionId || `raw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const cwd = workspacePath || this.workspace?.repository?.path || process.env.HOME || os.homedir() || '/tmp'
    const args = type === 'shell'
      ? buildShellArgs([`cd ${shq(cwd)}`, `echo "Welcome to AgntSpce"`])
      : buildShellArgs(`cd ${shq(cwd)}`)

    try {
      await this.createSession(sessionId, {
        command: getDefaultShell(),
        args,
        cwd,
        type,
        worktreeId: taskGroupId || '',
        repositoryName: '',
        repositoryType: '',
        taskGroupId: taskGroupId || null,
        subtaskId: subtaskId || null,
      })
      const session = this.sessions.get(sessionId)
      if (!session) {
        console.error('createRawSession: session not registered (slot denied):', type, sessionId)
        return null
      }
      if (session && (AGENT_TYPES as readonly string[]).includes(type)) {
        session.status = 'waiting'
        this.io?.emit('status-change', { sessionId, status: 'waiting' })
      }
      return { sessionId }
    } catch (e: any) {
      console.error('createRawSession failed:', type, e?.message || e)
      return null
    }
  }

  setSessionTaskLink(sessionId: string, taskGroupId: string, subtaskId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || !taskGroupId || !subtaskId) return false
    session.config = {
      ...session.config,
      taskGroupId,
      subtaskId,
      worktreeId: session.config.worktreeId || taskGroupId,
    }
    session.sessionGroupId = `task-${taskGroupId}`
    try {
      const sm = this.orchestrator?.getStateManager()
      const existing = sm?.getSession(sessionId)
      if (sm) {
        sm.upsertSession({
          id: sessionId,
          workspaceId: this.workspace?.id ?? null,
          sessionType: session.type,
          agentId: session.type,
          taskId: existing?.taskId ?? null,
          taskGroupId,
          subtaskId,
          status: session.status,
          branch: session.branch,
          worktreeId: session.config.worktreeId || taskGroupId,
          lastActivity: session.lastActivity,
        })
      }
    } catch (e: any) {
      console.warn('[sessionManager] task link persistence failed:', sessionId, e?.message || e)
    }
    return true
  }

  restartSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const config = session.config
    this.closeSession(sessionId)
    setTimeout(() => this.createSession(sessionId, config), 300)
  }

  private persistSessionBuffer(sessionId: string) {
    if (!this.workspace?.id) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    const buf = session.buffer.snapshot()
    if (buf) WorkspaceManager.getInstance().saveSessionBuffer(this.workspace.id, sessionId, buf)
  }

  private cleanupSessionBuffer(sessionId: string) {
    if (!this.workspace?.id) return
    WorkspaceManager.getInstance().deleteSessionBuffer(this.workspace.id, sessionId)
  }

  async saveAllSessionBuffers() {
    if (!this.workspace?.id) return
    const snapshots = new Map<string, string>()
    for (const [id, s] of this.sessions) {
      if (!s.pty || s.restorable) continue
      const buf = s.buffer.snapshot()
      if (buf) snapshots.set(id, buf)
    }
    await WorkspaceManager.getInstance().saveAllSessionBuffers(this.workspace.id, snapshots)
  }

  saveAllSessionBuffersSync() {
    if (!this.workspace?.id) return
    const snapshots = new Map<string, string>()
    for (const [id, s] of this.sessions) {
      if (!s.pty || s.restorable) continue
      const buf = s.buffer.snapshot()
      if (buf) snapshots.set(id, buf)
    }
    WorkspaceManager.getInstance().saveAllSessionBuffersSync(this.workspace.id, snapshots)
  }

  async restoreSessionBuffer(sessionId: string) {
    if (!this.workspace?.id) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    const saved = await WorkspaceManager.getInstance().loadSessionBuffer(this.workspace.id, sessionId)
    if (saved) {
      session.buffer.write(saved)
      // Mark ALL restored buffer content as delivered so it isn't replayed
      // to the terminal as raw ANSI garbage. The buffer stays in memory for
      // status detection; the agent starts fresh via startAgentWithConfig.
      session.deliveredBufferLength = session.buffer.totalBytes
    }
  }

  getSessionHistory(): { id: string, type: string, worktreeId: string, branch: string, status: string, lastActivity: number, closedAt: number, agentId?: string }[] {
    return this.sessionHistory
  }

  getSessionSaveData(): SavedSessionData[] {
    const data: SavedSessionData[] = []
    const sm = this.orchestrator?.getStateManager()
    for (const [id, s] of this.sessions) {
      const config = s.agentStartConfig
      const persisted = sm?.getSession(id)
      const inferred = this.inferTaskLink(id)
      const taskGroupId = s.config?.taskGroupId ?? persisted?.taskGroupId ?? inferred?.taskGroupId ?? null
      const subtaskId = s.config?.subtaskId ?? persisted?.subtaskId ?? inferred?.subtaskId ?? null
      data.push({
        id,
        type: s.type,
        cwd: s.config?.cwd || '',
        taskGroupId,
        subtaskId,
        sessionGroupId: s.sessionGroupId ?? null,
        worktreeId: s.config?.worktreeId || undefined,
        agentConfig: config
          ? {
            agentId: config.agentId,
            mode: config.mode,
            flags: config.flags,
            model: config.model,
            reasoning: config.reasoning,
            verbosity: config.verbosity,
            resumeId: config.resumeId,
            nativeSessionId: config.nativeSessionId,
          }
          : undefined,
      })
    }
    return data
  }

  private inferTaskLink(sessionId: string): { taskGroupId: string; subtaskId: string } | null {
    try {
      const sm = this.orchestrator?.getStateManager()
      if (!sm) return null
      const persisted = sm.getSession(sessionId)
      if (persisted?.taskGroupId && persisted.subtaskId) {
        return { taskGroupId: persisted.taskGroupId, subtaskId: persisted.subtaskId }
      }
      for (const group of sm.listTaskGroups()) {
        const subtask = sm.listSubTasks(group.id).find(s => s.sessionId === sessionId)
        if (subtask) return { taskGroupId: group.id, subtaskId: subtask.id }
      }
    } catch {}
    return null
  }

  async restoreSessions(sessions: SavedSessionData[]): Promise<void> {
    let isFirstAgent = true
    for (const saved of sessions) {
      if (this.sessions.has(saved.id)) continue
      const inferred = this.inferTaskLink(saved.id)
      const restored = inferred && !saved.taskGroupId
        ? { ...saved, taskGroupId: inferred.taskGroupId, subtaskId: inferred.subtaskId }
        : saved
      this.registerRestorableSession(restored)
      const restoredSubtaskId = this.restoreTaskSessionLink(restored)
      if (restored.taskGroupId && restoredSubtaskId) this.setSessionTaskLink(restored.id, restored.taskGroupId, restoredSubtaskId)
      if (restored.taskGroupId) continue
      if (restored.type === 'shell' || isFirstAgent) {
        if ((AGENT_TYPES as readonly string[]).includes(restored.type)) isFirstAgent = false
        await this.resumeSession(restored.id)
      }
    }
  }

  private restoreTaskSessionLink(saved: SavedSessionData): string | null {
    if (!saved.taskGroupId) return null
    try {
      const sm = this.orchestrator?.getStateManager()
      const group = sm?.getTaskGroup(saved.taskGroupId)
      if (!sm || !group) return null
      const linked = sm.listSubTasks(group.id).find(s => s.sessionId === saved.id)
      const byId = saved.subtaskId ? sm.getSubTask(saved.subtaskId) : null
      const subtask = linked || (byId?.taskGroupId === group.id ? byId : null) || sm.addSubTask({
        taskGroupId: group.id,
        agentId: saved.type,
        title: saved.type,
      })
      if (subtask.sessionId !== saved.id) sm.updateSubTaskStatus(subtask.id, 'running', saved.id)
      if (group.status === 'planning' || group.status === 'paused') sm.updateTaskGroup(group.id, { status: 'active' })
      return subtask.id
    } catch (e: any) {
      console.warn('[sessionManager] task session restoration failed:', saved.id, e?.message || e)
      return null
    }
  }

  private registerRestorableSession(saved: SavedSessionData): void {
    const cwd = saved.cwd || this.workspace?.repository?.path || process.env.HOME || '/tmp'
    const defaultConfig = (AGENT_TYPES as readonly string[]).includes(saved.type as any)
      ? this.agentManager?.getDefaultConfig(saved.type)
      : null
    const session: Session = {
      id: saved.id,
      pty: null,
      type: saved.type as any,
      worktreeId: saved.worktreeId || saved.taskGroupId || '',
      repositoryName: '',
      repositoryType: '',
      status: 'idle',
      branch: 'unknown',
      buffer: new RingBuffer(),
      deliveredBufferLength: 0,
      lastActivity: Date.now(),
      tokenUsage: 0,
      config: {
        command: getDefaultShell(),
        args: buildShellArgs(`cd ${shq(cwd)}`),
        cwd,
        type: saved.type,
        worktreeId: saved.worktreeId || saved.taskGroupId || '',
        repositoryName: '',
        repositoryType: '',
        taskGroupId: saved.taskGroupId ?? null,
        subtaskId: saved.subtaskId ?? null,
      },
      statusChangedAt: Date.now(),
      pendingStatus: null,
      pendingStatusTimer: null,
      cwdState: { current: cwd, previous: null, stack: [] },
      autoStarted: false,
      claudeLaunchState: null,
      restorable: true,
      sessionGroupId: saved.sessionGroupId ?? (saved.taskGroupId ? `task-${saved.taskGroupId}` : undefined),
      agentStartConfig: saved.agentConfig || defaultConfig || undefined,
      workspace: this.workspace?.id || null,
    }
    this.sessions.set(saved.id, session)
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.pty || !session.restorable) return false

    const savedType = session.type
    const savedCwd = session.config?.cwd || this.workspace?.repository?.path || process.env.HOME || '/tmp'
    const savedAgentConfig = session.agentStartConfig
    const resumeConfig = savedAgentConfig ? { ...savedAgentConfig } : null
    if (resumeConfig?.agentId === 'opencode' && !resumeConfig.nativeSessionId) {
      const discoveredSessionId = await this.findLatestOpenCodeSessionId(savedCwd)
      if (discoveredSessionId) resumeConfig.nativeSessionId = discoveredSessionId
    }
    if (resumeConfig?.agentId === 'pi' && !resumeConfig.nativeSessionId) {
      const discoveredSessionId = this.findLatestPiSessionId(savedCwd)
      if (discoveredSessionId) resumeConfig.nativeSessionId = discoveredSessionId
    }
    if (resumeConfig) {
      const nativeSessionId = typeof resumeConfig.nativeSessionId === 'string' ? resumeConfig.nativeSessionId.trim() : ''
      if (nativeSessionId) resumeConfig.resumeId = resumeConfig.resumeId || nativeSessionId
      const agent = this.agentManager?.getAgent?.(resumeConfig.agentId)
      if (resumeConfig.agentId === 'claude') {
        resumeConfig.mode = nativeSessionId ? 'resume' : 'fresh'
      } else if (resumeConfig.agentId === 'opencode') {
        resumeConfig.mode = 'continue'
      } else if (resumeConfig.agentId === 'pi') {
        resumeConfig.mode = nativeSessionId ? 'resume' : 'continue'
      } else if (nativeSessionId && agent?.modes.resume) {
        resumeConfig.mode = 'resume'
      } else if (agent?.modes.continue) {
        resumeConfig.mode = 'continue'
      } else if (resumeConfig.mode === 'resume' && !nativeSessionId) {
        resumeConfig.mode = 'fresh'
      }
    }
    const taskGroupId = session.config.taskGroupId || null
    const subtaskId = session.config.subtaskId || null

    const result = await this.createRawSession(savedType, savedCwd, sessionId, taskGroupId, subtaskId)
    if (!result) return false

    const resumed = this.sessions.get(sessionId)
    if (!resumed) return false
    resumed.restorable = false
    const restoredSubtaskId = this.restoreTaskSessionLink({
      id: sessionId,
      type: savedType,
      cwd: savedCwd,
      taskGroupId,
      subtaskId,
    })
    if (taskGroupId && restoredSubtaskId) this.setSessionTaskLink(sessionId, taskGroupId, restoredSubtaskId)

    if (resumeConfig) {
      try {
        this.startAgentWithConfig(sessionId, resumeConfig)
      } catch (e: any) {
        console.error('resumeSession: agent start failed:', sessionId, e?.message || e)
      }
    }
    await this.restoreSessionBuffer(sessionId)
    return true
  }

  async createParallelTask(config: { agentId: string, mode: string, flags: string[], prompt: string, worktreeCount: number, model?: string, reasoning?: string, verbosity?: string, declaredFiles?: string[] }): Promise<{ sessionIds: string[], groupId: string }> {
    const groupId = `parallel-${Date.now()}`
    const agentCfg = this.agentManager?.getAgent(config.agentId)
    const supportsWorktree = agentCfg?.capabilities?.supportsWorktree !== false
    const sessionIds: string[] = []
    const prompt = config.prompt || ''
    const declaredFiles = Array.isArray(config.declaredFiles) ? config.declaredFiles : []

    let count: number
    let usedWorktrees: any[]

    if (supportsWorktree) {
      const availableWts = this.worktrees.filter(wt => {
        const existingType = [...this.sessions.values()].find(s => s.worktreeId === wt.id && s.type === config.agentId)
        return !existingType
      })
      count = Math.min(config.worktreeCount, availableWts.length || 1)
      usedWorktrees = availableWts
    } else {
      count = 1
      usedWorktrees = []
    }

    for (let i = 0; i < count; i++) {
      const cwd = supportsWorktree && usedWorktrees[i]
        ? usedWorktrees[i].path
        : (this.workspace?.repository?.path || process.env.HOME || '/tmp')
      const worktreeId = supportsWorktree && usedWorktrees[i]
        ? usedWorktrees[i].id
        : (this.workspace?.id || 'default')
      const sessionId = `${groupId}-${i}`
      await this.createSession(sessionId, {
        command: getDefaultShell(),
        args: buildShellArgs(`cd ${shq(cwd)}`),
        cwd,
        type: config.agentId,
        worktreeId,
      })
      const session = this.sessions.get(sessionId)
      if (session) {
        session.sessionGroupId = groupId
        session.status = 'waiting'
        try { this.io.emit('status-change', { sessionId, status: 'waiting' }) } catch {}
      }
      sessionIds.push(sessionId)
    }

    if (sessionIds.length > 0) {
      // 1.5 claim enforcement: each group member's declared scope is claimed
      // before any agent launches. Siblings in the group share isolated
      // worktrees, so they are excluded from blocking each other — but they
      // still block against non-group active tasks.
      for (const sid of sessionIds) {
        if (declaredFiles.length === 0) continue
        const groupExclusion = sessionIds.filter(other => other !== sid)
        const enforced = this.orchestrator?.enforceSessionClaims(sid, config.agentId, declaredFiles, groupExclusion)
        if (enforced === false) {
          for (const rollbackId of sessionIds) this.closeSession(rollbackId)
          throw new Error(`Parallel task blocked: declared files overlap another active task for session ${sid}. Resolve the claim conflict and retry.`)
        }
      }

      setTimeout(() => {
        for (const sid of sessionIds) {
          try {
            this.startAgentWithConfig(sid, {
              agentId: config.agentId,
              mode: config.mode,
              flags: config.flags,
              model: config.model,
              reasoning: config.reasoning,
              verbosity: config.verbosity,
              declaredFiles,
              excludeSessionIds: sessionIds.filter(other => other !== sid),
              prompt,
            })
          } catch {}
        }
      }, 500)
    }

    return { sessionIds, groupId }
  }

  // ── v2 Tasks: one subtask agent sharing the task's worktree ──
  // Mirrors createParallelTask's shell-settle delay and sibling exclusion so
  // subtasks never trip the legacy flat-task claim check against each other.
  async spawnTaskSubtask(input: {
    taskGroupId: string
    subtaskId: string
    agentId: string
    model?: string
    reasoning?: string
    verbosity?: string
    prompt: string
    cwd: string
    worktreeId?: string
    scopeFiles?: string[]
    siblingSessionIds?: string[]
  }): Promise<string> {
    const sessionId = `task-${input.taskGroupId.replace(/-/g, '').slice(0, 8)}-${input.subtaskId.replace(/-/g, '').slice(0, 8)}-${Date.now().toString(36)}`
    await this.createSession(sessionId, {
      command: getDefaultShell(),
      args: buildShellArgs(`cd ${shq(input.cwd)}`),
      cwd: input.cwd,
      type: input.agentId,
      worktreeId: input.worktreeId ?? input.taskGroupId,
      taskGroupId: input.taskGroupId,
      subtaskId: input.subtaskId,
    })
    const session = this.sessions.get(sessionId)
    if (session) {
      session.sessionGroupId = `task-${input.taskGroupId}`
      session.status = 'waiting'
      try { this.io.emit('status-change', { sessionId, status: 'waiting' }) } catch {}
    }
    const scopeFiles = Array.isArray(input.scopeFiles) ? input.scopeFiles : []
    const siblings = Array.isArray(input.siblingSessionIds) ? input.siblingSessionIds : []
    setTimeout(() => {
      try {
        this.startAgentWithConfig(sessionId, {
          agentId: input.agentId,
          mode: 'fresh',
          flags: [],
          model: input.model,
          reasoning: input.reasoning,
          verbosity: input.verbosity,
          declaredFiles: scopeFiles,
          excludeSessionIds: siblings,
          prompt: input.prompt,
        })
      } catch {}
    }, 500)
    return sessionId
  }

  /** Kill graph for a finished/abandoned task: closes every subtask PTY.
   *  Unknown ids are skipped; returns the number actually closed. */
  closeTaskSessions(sessionIds: string[]): number {
    let closed = 0
    for (const id of sessionIds) {
      try {
        if (this.closeSession(id)) closed++
      } catch {}
    }
    return closed
  }

  private persistSessionState(): Promise<void> {
    const workspaceId = this.workspace?.id
    if (!workspaceId) return Promise.resolve()
    const save = async () => {
      const sessions = this.getSessionSaveData()
      await WorkspaceManager.getInstance().saveSessionState(workspaceId, sessions)
    }
    const result = this.sessionStateSaveQueue.then(save, save)
    this.sessionStateSaveQueue = result.catch(() => {})
    return result
  }

  private findLatestPiSessionId(cwd: string): string | null {
    const configuredSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
    const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    const root = configuredSessionDir || path.join(configuredAgentDir || path.join(os.homedir(), '.pi', 'agent'), 'sessions')
    const target = path.resolve(cwd)
    let newest: { id: string; mtime: number } | null = null
    const visit = (dir: string) => {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          visit(filePath)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        try {
          const stat = fs.statSync(filePath)
          if (newest && stat.mtimeMs <= newest.mtime) continue
          const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]
          const row = JSON.parse(firstLine)
          if (row?.type !== 'session' || typeof row.id !== 'string' || typeof row.cwd !== 'string') continue
          if (path.resolve(row.cwd) !== target) continue
          newest = { id: row.id, mtime: stat.mtimeMs }
        } catch {}
      }
    }
    visit(root)
    return newest?.id || null
  }

  private async findLatestOpenCodeSessionId(cwd: string): Promise<string | null> {
    try {
      const command = resolveAgent('opencode') || 'opencode'
      const stdout = await runCommand(command, ['session', 'list', '--format', 'json', '-n', '100'], cwd)
      const start = stdout.indexOf('[')
      const end = stdout.lastIndexOf(']')
      const rows = JSON.parse(start >= 0 && end >= start ? stdout.slice(start, end + 1) : stdout) as any[]
      const target = path.resolve(cwd)
      const match = (Array.isArray(rows) ? rows : [])
        .filter(row => {
          const id = String(row?.id || '')
          const directory = String(row?.directory || '')
          return /^ses_[A-Za-z0-9_-]+$/.test(id) && directory && path.resolve(directory) === target
        })
        .sort((a, b) => Number(b?.updated ?? b?.created ?? 0) - Number(a?.updated ?? a?.created ?? 0))[0]
      return match?.id || null
    } catch {
      return null
    }
  }

  private async captureOpenCodeSessionId(sessionId: string, cwd: string, startedAt: number): Promise<void> {
    const command = resolveAgent('opencode') || 'opencode'
    for (const delay of [300, 900, 1800, 3500, 6000, 12000, 30000]) {
      await new Promise(resolve => setTimeout(resolve, delay))
      const session = this.sessions.get(sessionId)
      if (!session?.pty) return
      try {
        const stdout = await runCommand(command, ['session', 'list', '--format', 'json', '-n', '100'], cwd)
        const start = stdout.indexOf('[')
        const end = stdout.lastIndexOf(']')
        const rows = JSON.parse(start >= 0 && end >= start ? stdout.slice(start, end + 1) : stdout) as any[]
        const assigned = new Set(
          [...this.sessions.values()]
            .map(s => s.agentStartConfig?.nativeSessionId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        )
        const target = path.resolve(cwd)
        const candidates = (Array.isArray(rows) ? rows : [])
          .filter(row => {
             const id = String(row?.id || '')
             const timestamp = Number(row?.updated ?? row?.lastUpdated ?? row?.created ?? row?.time_created ?? 0)
             const directory = String(row?.directory || '')
             return /^ses_[A-Za-z0-9_-]+$/.test(id)
               && !assigned.has(id)
               && timestamp >= startedAt - 10000
               && directory
               && path.resolve(directory) === target
           })
           .sort((a, b) => Number(b?.updated ?? b?.lastUpdated ?? b?.created ?? b?.time_created ?? 0) - Number(a?.updated ?? a?.lastUpdated ?? a?.created ?? a?.time_created ?? 0))
        const nativeSessionId = candidates[0]?.id
        if (!nativeSessionId) continue
        session.agentStartConfig = { ...(session.agentStartConfig || {}), nativeSessionId }
        await this.persistSessionState()
        return
      } catch {}
    }
  }

  private scheduleOpenCodeSessionLookup(sessionId: string, cwd: string, startedAt: number): void {
    if (this.nativeSessionLookups.has(sessionId)) return
    const lookup = this.captureOpenCodeSessionId(sessionId, cwd, startedAt)
    this.nativeSessionLookups.set(sessionId, lookup)
    void lookup.then(
      () => { if (this.nativeSessionLookups.get(sessionId) === lookup) this.nativeSessionLookups.delete(sessionId) },
      () => { if (this.nativeSessionLookups.get(sessionId) === lookup) this.nativeSessionLookups.delete(sessionId) }
    )
  }

  private clearResumeFailureProbe(sessionId: string) {
    const probe = this.resumeFailureProbes.get(sessionId)
    if (probe?.timer) clearTimeout(probe.timer)
    this.resumeFailureProbes.delete(sessionId)
  }

  private beginResumeFailureProbe(sessionId: string) {
    this.clearResumeFailureProbe(sessionId)
    const probe: { output: string; timer: ReturnType<typeof setTimeout> | null } = { output: '', timer: null }
    probe.timer = setTimeout(() => {
      if (this.resumeFailureProbes.get(sessionId) === probe) this.clearResumeFailureProbe(sessionId)
    }, 60000)
    probe.timer.unref?.()
    this.resumeFailureProbes.set(sessionId, probe)
  }

  private maybeRecoverFailedAgentResume(sessionId: string, data: string) {
    const probe = this.resumeFailureProbes.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!probe || !session?.pty) return
    probe.output = `${probe.output}${data}`.slice(-8192)
    const config = session.agentStartConfig
    if (!config || (config.mode !== 'resume' && config.mode !== 'continue')) return
    if (!/(?:no conversation found|no (?:session|sessions|previous session) found|no session available|session\s+(?:id\s+)?[^\n]*(?:not found|does not exist|unavailable|not available|invalid)|unable to resume (?:session|conversation)|failed to resume (?:session|conversation)|could not find (?:session|conversation)|unknown session)/i.test(probe.output)) return

    this.clearResumeFailureProbe(sessionId)
    const fallbackSessionId = config.agentId === 'claude' || config.agentId === 'pi' ? randomUUID() : undefined
    setTimeout(() => {
      const current = this.sessions.get(sessionId)
      if (!current?.pty || current.agentStartConfig?.mode !== config.mode) return
      try {
        this.startAgentWithConfig(sessionId, {
          ...current.agentStartConfig,
          mode: 'fresh',
          resumeId: undefined,
          nativeSessionId: fallbackSessionId,
        })
      } catch (error: any) {
        console.error('resume fallback: fresh agent start failed:', error?.message || error)
      }
    }, 100)
  }

  startAgentWithConfig(sessionId: string, config: any) {
    const session = this.sessions.get(sessionId)
    if (!session || !this.agentManager) return
    const startedAt = Date.now()
    let startConfig: any = config
    const agentConfig = this.agentManager.getAgent?.(startConfig.agentId)
    const hasResumeId = !!(startConfig.resumeId || startConfig.nativeSessionId)
    if (startConfig.mode === 'resume' && !agentConfig?.modes.resume) {
      startConfig = { ...startConfig, mode: agentConfig?.modes.continue ? 'continue' : 'fresh' }
    }
    if (startConfig.mode === 'resume' && !hasResumeId) {
      startConfig = {
        ...startConfig,
        mode: startConfig.agentId === 'claude' || !agentConfig?.modes.continue ? 'fresh' : 'continue',
        resumeId: undefined,
        nativeSessionId: undefined,
      }
    }
    if ((startConfig.agentId === 'claude' || startConfig.agentId === 'pi') && startConfig.mode === 'fresh' && !startConfig.nativeSessionId) {
      startConfig = { ...startConfig, nativeSessionId: randomUUID() }
    }
    const isResumeAttempt = (startConfig.mode === 'resume' || startConfig.mode === 'continue') && (AGENT_TYPES as readonly string[]).includes(startConfig.agentId)
    if (isResumeAttempt) this.beginResumeFailureProbe(sessionId)
    else this.clearResumeFailureProbe(sessionId)
    const validation = this.agentManager.validateConfig(startConfig)
    if (!validation.valid) throw new Error(validation.error)

    // Capture the user-supplied agent prompt (if any) with its submission
    // timestamp so the Dashboard Prompts tab shows it before/after
    // agntspce-prompter compression for this session.
    if (typeof startConfig?.prompt === 'string' && startConfig.prompt.trim()) {
      try {
        this.promptHistory.record(sessionId, startConfig.prompt, 'agent-start')
      } catch {}
    }

    // 1.5 claim enforcement: the session's task must declare its file scope
    // before the agent starts, and it must not overlap another active task.
    if (this.orchestrator && (AGENT_TYPES as readonly string[]).includes(startConfig.agentId)) {
      const declared = Array.isArray(startConfig.declaredFiles) ? startConfig.declaredFiles : []
      const excluded = Array.isArray(startConfig.excludeSessionIds) ? startConfig.excludeSessionIds : []
      const enforced = this.orchestrator.enforceSessionClaims(sessionId, startConfig.agentId, declared, excluded)
      if (!enforced) {
        throw new Error('Session blocked: declared files overlap another active task. Resolve the claim conflict and retry.')
      }
    }

    if (this.cavemanService.isEnabled(sessionId) && this.workspace?.repository?.path) {
      this.cavemanService.writeSkillFiles(this.workspace.repository.path, startConfig.agentId)
    }

    const command = this.agentManager.buildCommand(startConfig.agentId, startConfig.mode, startConfig)
    const baseCmd = command.split(/\s+/)[0]
    const resolvedPath = resolveAgent(baseCmd)
    if (!resolvedPath) {
      console.warn(`[agntspce] Agent "${baseCmd}" not resolved — PATH may not include it: ${command}`)
    }
    const newline = process.platform === 'win32' ? '\r\n' : '\n'
    // Force-set session environment variables directly before launching agent,
    // ensuring the agent CLI (claude, opencode, etc.) and any subprocesses inherit them.
    const binDir = AGNTSPCE_BIN_DIR || path.resolve(__dirname, '..', '..', 'bin')
    const wrapperPathEnv = AGNTSPCE_BIN_DIR ? path.join(AGNTSPCE_BIN_DIR, 'agntspce') : (process.resourcesPath ? path.join(process.resourcesPath, 'rtk', 'agntspce') : path.resolve(__dirname, '..', '..', 'bin', 'agntspce'))
    const taskEnv = session.config.taskGroupId && session.config.subtaskId
      ? ` export AGNTSPCE_TASK_ID=${shq(session.config.taskGroupId)}; export AGNTSPCE_SUBTASK_ID=${shq(session.config.subtaskId)};`
      : ''
    const envPrefix = `export AGNTSPCE_ENABLED=1; export AGNTSPCE_WRAPPER_PATH="${wrapperPathEnv}"; export AGNTSPCE_RTK_SESSION="${rtkManager.generateRtkToken()}"; export PATH="${binDir}:$PATH";${taskEnv} `
    this.writeToSession(sessionId, envPrefix + command + newline)

    // 2.1 dispatch preamble: deliver the shared orchestration state as the
    // agent's first input after it boots (agents are interactive CLIs that
    // read stdin; a small delay lets the TUI finish starting). If a prompt is
    // supplied (parallel tasks), it follows the preamble in the same write so
    // the agent gets context then its task.
    const isFreshDispatch = startConfig.mode !== 'resume' && startConfig.mode !== 'continue' && !startConfig.resumeId
    const sm = this.orchestrator?.getStateManager()
    if (sm || startConfig.prompt) {
      try {
        let body = ''
        if (sm && isFreshDispatch) {
          const ownTaskId = sm.getSession(sessionId)?.taskId || undefined
          const preamble = sm.buildDispatchPreamble(startConfig.agentId, ownTaskId ? [ownTaskId] : [])
          if (preamble) body = preamble
        }
        if (startConfig.prompt) {
          body = body ? `${body}\n\nDispatch task:\n${startConfig.prompt}` : startConfig.prompt
        }
        if (body) {
          const sid = sessionId
          const payload = body
          setTimeout(() => {
            const s = this.sessions.get(sid)
            if (s?.pty && s.status !== 'exited') {
              this.writeToSession(sid, payload + newline)
            }
          }, 2200)
        }
      } catch (err: any) {
        console.warn('[agntspce] Dispatch preamble failed:', sessionId, err?.message || err)
      }
    }

    session.autoStarted = true
    session.claudeLaunchState = 'launched'
    session.agentStartConfig = startConfig
    if (startConfig.agentId === 'opencode' && (startConfig.mode === 'fresh' || startConfig.mode === 'continue')) {
      this.scheduleOpenCodeSessionLookup(sessionId, session.config.cwd, startedAt)
    }
    void this.persistSessionState()
    try {
      this.io.emit('agent-started', { sessionId, config: startConfig })
    } catch {}
  }

  toggleCaveman(sessionId: string, enabled: boolean, level?: string): void {
    this.cavemanService.setEnabled(sessionId, enabled, level)

    const session = this.sessions.get(sessionId)
    const agentId = session?.agentStartConfig?.agentId || 'claude'

    if (enabled && this.workspace?.repository?.path) {
      this.cavemanService.writeSkillFiles(this.workspace.repository.path, agentId)
    } else if (this.workspace?.repository?.path) {
      this.cavemanService.removeSkillFiles(this.workspace.repository.path, agentId)
    }
  }

  getCavemanState(sessionId: string) {
    return this.cavemanService.getState(sessionId)
  }

  getAllCavemanStates() {
    return this.cavemanService.getAllStates()
  }

  getCavemanAggregateStats() {
    return this.cavemanService.getAggregateStats()
  }

  getWorktrees(): Worktree[] {
    return this.worktrees
  }

  getSessionStates(): Record<string, any> {
    const states: Record<string, any> = {}
    for (const [id, s] of this.sessions) {
      states[id] = {
        id: s.id,
        type: s.type,
        worktreeId: s.worktreeId,
        repositoryName: s.repositoryName,
        repositoryType: s.repositoryType,
        status: s.status,
        branch: s.branch,
        lastActivity: s.lastActivity,
        sessionGroupId: s.sessionGroupId,
        taskGroupId: s.config.taskGroupId,
        subtaskId: s.config.subtaskId,
        restorable: !!s.restorable,
      }
    }
    return states
  }

  getUndeliveredOutputAndMarkDelivered(): Record<string, string> {
    const backlog: Record<string, string> = {}
    for (const [id, s] of this.sessions) {
      const totalWritten = s.buffer.totalBytes
      const deliveredTotal = s.deliveredBufferLength
      if (totalWritten <= deliveredTotal) continue
      const snapshot = s.buffer.snapshot()
      const undeliveredBytes = totalWritten - deliveredTotal
      const undelivered = snapshot.slice(-undeliveredBytes)
      if (undelivered) backlog[id] = undelivered
      s.deliveredBufferLength = totalWritten
    }
    return backlog
  }

cleanupAllSessions() {
  if (this.branchRefreshInterval) {
    clearInterval(this.branchRefreshInterval)
    this.branchRefreshInterval = null
  }
  for (const [id] of this.sessions) this.closeSession(id)
  this.sessions.clear()
  this.orchestrator?.shutdownAll()
}

  async updateGitBranch(worktreeId: string, cwd: string, force = false) {
    if (!this.gitHelper) return
    const branch = await this.gitHelper.getCurrentBranch(cwd, force)
    for (const [, s] of this.sessions) {
      if (s.worktreeId === worktreeId || s.config?.cwd === cwd) {
        if (s.branch === branch) continue
        s.branch = branch
        try {
          this.io.emit('branch-change', { sessionId: s.id, branch, worktreeId })
        } catch { }
      }
    }
  }

  private refreshSessionStatus(sessionId: string) {
    if (!this.statusDetector) return
    const session = this.sessions.get(sessionId)
    if (!session || session.status === 'exited') return

    // Idle guard: if no new output arrived since the last scan and the session
    // is already idle, the expensive buffer snapshot + detectStatus regex scan
    // cannot change anything — skip it entirely. New output (onData) forces a
    // refresh via lastStatusRefresh throttle, and processMonitor still runs the
    // full scan when buffer bytes changed (catches silent transitions).
    const bytes = session.buffer.totalBytes
    if (session.status === 'idle' && this.lastStatusBytes.get(sessionId) === bytes) return
    this.lastStatusBytes.set(sessionId, bytes)

    const oldStatus = session.status
    const isAgentType = (AGENT_TYPES as readonly string[]).includes(session.type)
    const status = this.statusDetector.detectStatus(sessionId, session.buffer.snapshot(), {
      agent: isAgentType ? session.type : null,
    })
    if (status !== session.status) {
      session.status = status as any
      session.statusChangedAt = Date.now()
      try {
        this.io.emit('status-change', { sessionId, status })
      } catch { }
    }

    if (status !== oldStatus) {
      if ((oldStatus === 'busy' || oldStatus === 'waiting') && (status === 'idle' || status === 'exited')) {
        this.cavemanService.endRun(sessionId)
        // Don't finalize if a safety net timer is pending — it will fire
        // when data stops arriving, preventing output fragmentation across
        // rapid status transitions (e.g. detectStatus → idle for small buffers).
        if (!this.outputFilter.hasPendingTimer(sessionId)) {
          this.outputFilter.finalizeCommand(sessionId)
        }
      } else if (oldStatus === 'idle' && status === 'busy') {
        this.cavemanService.startRun(sessionId)
      }
    }
  }

  private startBranchRefresh() {
    if (this.branchRefreshInterval) clearInterval(this.branchRefreshInterval)
    const refresh = () => {
      for (const wt of this.worktrees) {
        const wtId = wt.worktreeId || wt.id
        this.updateGitBranch(wtId, wt.path)
      }
    }
    refresh()
    this.branchRefreshInterval = setInterval(refresh, 30000)
  }
}
