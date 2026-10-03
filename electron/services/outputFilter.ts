import { filterCommandOutput, hasSpecificFilter, estimateTokens, stripAllControl } from './rtk'
import { formatCommand } from './rtk/formatter'
import fs from 'fs'
import path from 'path'

const LOG_FILE = path.join(process.env.TMPDIR || process.env.TMP || '/tmp', 'agntspce-filter.log')
const DEBUG_ENABLED = process.env.AGNTSPCE_FILTER_DEBUG === '1'
function debugLog(msg: string) {
  if (!DEBUG_ENABLED) return
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.appendFile(LOG_FILE, line, () => {})
  } catch {}
}

interface CumulativeStats {
  totalOriginalBytes: number
  totalFilteredBytes: number
  totalOriginalTokens: number
  totalFilteredTokens: number
  eventsProcessed: number
}

export interface CommandEvent {
  sessionId: string
  command: string
  args: string[]
  formatted: string
  rawOutput: string
  filteredOutput: string
  originalTokens: number
  filteredTokens: number
  reduction: number
  exitCode: number | null
  duration: number
  timestamp: number
  filterName?: string
}

const AGNTSPCE_CMD_RE = /^agntspce\s+\$\s+(.+)$/
const AGNTSPCE_STATS_RE = /^AGNTSPCE_STATS raw=(\d+) filtered=(\d+)$/
const SHELL_CMD_RE = /[$#%❯➜]\s+(.+)$/
const SHELL_ECHO_RE = /^\$\s+agntspce\s+run\s+/
// Wrapper system lines (marker, token stats, diagnostics) that must be
// consumed for RTK tracking but hidden from the terminal screen.
const AGNTSPCE_DIAG_RE = /^\[agntspce\]/
// Shell echo (or tool header) of an invocation through the wrapper BY PATH,
// e.g. "$ /Users/me/app/bin/agntspce git show". The wrapper prints its own
// "agntspce $ <cmd>" marker right after, so showing both reads as a double
// execution. These lines are normalized in the display to the marker form.
// Must NOT match bare commands ($ git show), the marker itself, or the
// agntspce-search binary (requires bin/ before the name and whitespace/.cmd after).
const WRAPPER_ECHO_RE = /(?:^|[#$%❯➜>]\s)\S*bin[/\\]agntspce(?:\.cmd)?\s+(.+?)\s*$/
const toPlainLine = (raw: string) => raw
  .replace(/\x1b\[[\d;]*[A-Za-z]/g, '')
  .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, '')
  .replace(/[\x00-\x08\x0b\x0c\r\x0e-\x1f\x7f]/g, '')

// Memory bounds. Agent TUIs emit full-screen redraw frames as very long
// "lines"; without caps those flow into command history (200/session,
// persisted up to 5000 total) and are loaded back at startup.
const MAX_ACCUM_LINE_CHARS = 8 * 1024
// Partial-line buffer cap (Superset 64KB-FIFO pattern): agent TUIs emit
// full-screen redraw frames as very long "lines" with no newline, so the
// buffered trailing partial would otherwise grow without bound for the whole
// session. The cap keeps only the tail — enough to reassemble split lines —
// and display/error detection only needs recent bytes (markers are short).
const MAX_LINE_BUFFER_CHARS = 32 * 1024
// Retained body size per event. 256KB × 2 (raw + filtered) × up to 200 events
// per session previously let the in-memory + persisted command history grow to
// ~100–250MB for a single long agent run. 32KB is more than enough for the
// dashboard's token/preview display and bounds per-event memory.
const MAX_EVENT_OUTPUT_BYTES = 32 * 1024
const EVENT_HEAD_BYTES = 24 * 1024
const WIRE_PREVIEW_BYTES = 2 * 1024
// Global ceiling on retained command events (across ALL sessions). The
// per-session 200-cap alone does not stop unbounded growth when many sessions
// run over time, and history is deliberately kept after a session closes — so
// without a global cap the main-process heap grows for the whole app lifetime.
const MAX_TOTAL_COMMAND_EVENTS = 1200
const MAX_PERSISTED_COMMAND_EVENTS = 600

// Keep head + tail of oversized text so token accounting and previews stay useful.
function capStoredOutput(text: string): string {
  if (Buffer.byteLength(text) <= MAX_EVENT_OUTPUT_BYTES) return text
  let head = text.slice(0, EVENT_HEAD_BYTES)
  while (Buffer.byteLength(head) > EVENT_HEAD_BYTES) head = head.slice(0, -1024)
  const tailBudget = MAX_EVENT_OUTPUT_BYTES - Buffer.byteLength(head)
  let tail = tailBudget > 0 ? text.slice(-tailBudget) : ''
  while (tail && Buffer.byteLength(head) + Buffer.byteLength(tail) > MAX_EVENT_OUTPUT_BYTES) {
    tail = tail.slice(1024)
  }
  return `${head}\n…[${Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes omitted]…\n${tail}`
}

// Wire copies keep only a small preview — the renderer never displays output
// bodies (only token counts), and shipping full text made the renderer retain
// hundreds of large strings plus forced huge JSON serializations on connect.
export function toWireEvent(event: CommandEvent): CommandEvent {
  if (event.rawOutput.length <= WIRE_PREVIEW_BYTES && event.filteredOutput.length <= WIRE_PREVIEW_BYTES) return event
  return {
    ...event,
    rawOutput: event.rawOutput.length > WIRE_PREVIEW_BYTES ? event.rawOutput.slice(0, WIRE_PREVIEW_BYTES) : event.rawOutput,
    filteredOutput: event.filteredOutput.length > WIRE_PREVIEW_BYTES ? event.filteredOutput.slice(0, WIRE_PREVIEW_BYTES) : event.filteredOutput,
  }
}

const isSystemLine = (plain: string) =>
  AGNTSPCE_CMD_RE.test(plain) || AGNTSPCE_STATS_RE.test(plain) || AGNTSPCE_DIAG_RE.test(plain)

export class OutputFilterService {
  private commandBuffers = new Map<string, {
    command: string
    args: string[]
    rawOutput: string
    startTime: number
    exitCode: number | null
  }>()
  private lineBuffer = new Map<string, string>()
  // True when the buffered partial line is the start of a wrapper system line
  // (marker/stats/diag) that must be hidden from the terminal display.
  private _systemPartial = new Map<string, boolean>()
  private outputAccum = new Map<string, string[]>()
  private insideCommand = new Map<string, boolean>()
  private finalizeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private onCommandEvent: ((event: CommandEvent) => void) | null = null
  private _commandHistory = new Map<string, CommandEvent[]>()
  private _pendingStats = new Map<string, { rawTokens: number; filteredTokens: number }>()
  private _recentTokenReports = new Map<string, number>() // key: "raw-filtered" → timestamp
  private _cumulativeStats: CumulativeStats = { totalOriginalBytes: 0, totalFilteredBytes: 0, totalOriginalTokens: 0, totalFilteredTokens: 0, eventsProcessed: 0 }
  private _statsFilePath: string = ''
  private _historyFilePath: string = ''
  private _historySaveTimer: ReturnType<typeof setTimeout> | null = null
  private _statsCache: { stats: { totalOriginalBytes: number; totalFilteredBytes: number; totalOriginalTokens: number; totalFilteredTokens: number; eventsProcessed: number } } | null = null

  constructor(dataDir?: string) {
    if (dataDir) {
      this._statsFilePath = path.join(dataDir, 'filter-stats.json')
      this._historyFilePath = path.join(dataDir, 'filter-history.json')
      this._loadCumulativeStats()
      this._loadHistory()
    }
  }

  private _loadCumulativeStats() {
    if (!this._statsFilePath) return
    try {
      const data = fs.readFileSync(this._statsFilePath, 'utf-8')
      const parsed = JSON.parse(data)
      this._cumulativeStats = {
        totalOriginalBytes: parsed.totalOriginalBytes || 0,
        totalFilteredBytes: parsed.totalFilteredBytes || 0,
        totalOriginalTokens: parsed.totalOriginalTokens || 0,
        totalFilteredTokens: parsed.totalFilteredTokens || 0,
        eventsProcessed: parsed.eventsProcessed || 0,
      }
    } catch {}
  }

  private _saveCumulativeStats() {
    if (!this._statsFilePath) return
    try {
      fs.mkdirSync(path.dirname(this._statsFilePath), { recursive: true })
      fs.writeFileSync(this._statsFilePath, JSON.stringify(this._cumulativeStats), 'utf-8')
    } catch {}
  }

  private _loadHistory() {
    if (!this._historyFilePath) return
    try {
      const data = fs.readFileSync(this._historyFilePath, 'utf-8')
      const parsed = JSON.parse(data) as CommandEvent[]
      if (!Array.isArray(parsed)) return
      // Keep the most recent slice if the file somehow grew beyond the cap.
      const events = parsed.length > MAX_PERSISTED_COMMAND_EVENTS ? parsed.slice(-MAX_PERSISTED_COMMAND_EVENTS) : parsed
      this._commandHistory.clear()
      for (const e of events) {
        if (!e || typeof e.sessionId !== 'string') continue
        // Cap bodies of pre-existing persisted events so old oversized files
        // don't get re-loaded into memory wholesale on every startup.
        e.rawOutput = capStoredOutput(String(e.rawOutput || ''))
        e.filteredOutput = capStoredOutput(String(e.filteredOutput || ''))
        const hist = this._commandHistory.get(e.sessionId) || []
        hist.push(e)
        if (hist.length > 200) hist.shift()
        this._commandHistory.set(e.sessionId, hist)
      }
      this._statsCache = null
    } catch {}
  }

  private _saveHistory() {
    if (!this._historyFilePath) return
    try {
      const all: CommandEvent[] = []
      for (const [, hist] of this._commandHistory) all.push(...hist)
      // Most-recent-first ordering matches the in-memory view; cap what we
      // persist so the on-disk JSON (and the reload on next startup) stays
      // bounded instead of growing without limit.
      all.sort((a, b) => b.timestamp - a.timestamp)
      if (all.length > MAX_PERSISTED_COMMAND_EVENTS) all.length = MAX_PERSISTED_COMMAND_EVENTS
      fs.mkdirSync(path.dirname(this._historyFilePath), { recursive: true })
      fs.writeFileSync(this._historyFilePath, JSON.stringify(all), 'utf-8')
    } catch {}
  }

  private _scheduleHistorySave() {
    if (!this._historyFilePath) return
    if (this._historySaveTimer) clearTimeout(this._historySaveTimer)
    this._historySaveTimer = setTimeout(() => {
      this._historySaveTimer = null
      this._saveHistory()
    }, 1000)
  }

  setOnCommandEvent(cb: (event: CommandEvent) => void) {
    this.onCommandEvent = cb
  }

  hasPendingTimer(sessionId: string): boolean {
    return this.finalizeTimers.has(sessionId)
  }

  private emit(event: CommandEvent) {
    const hist = this._commandHistory.get(event.sessionId) || []
    hist.push(event)
    if (hist.length > 200) hist.shift()
    this._commandHistory.set(event.sessionId, hist)
    this._statsCache = null
    this.onCommandEvent?.(event)
    this._scheduleHistorySave()
    this._enforceGlobalEventCap()
  }

  // Keep total retained events bounded across all sessions. Oldest events
  // (by timestamp) are dropped first, trimming from the front of each affected
  // per-session array. Runs only when the cap is exceeded, so steady-state cost
  // is a single O(total) scan per finalized command — fine at this volume.
  private _enforceGlobalEventCap(): void {
    let total = 0
    for (const h of this._commandHistory.values()) total += h.length
    if (total <= MAX_TOTAL_COMMAND_EVENTS) return
    const flat: { sid: string; ts: number }[] = []
    for (const [sid, h] of this._commandHistory) {
      for (const e of h) flat.push({ sid, ts: e.timestamp })
    }
    flat.sort((a, b) => a.ts - b.ts)
    const toRemove = total - MAX_TOTAL_COMMAND_EVENTS
    const counts = new Map<string, number>()
    for (let i = 0; i < toRemove; i++) {
      const r = flat[i]
      counts.set(r.sid, (counts.get(r.sid) || 0) + 1)
    }
    for (const [sid, n] of counts) {
      const h = this._commandHistory.get(sid)
      if (h && n > 0) h.splice(0, Math.min(n, h.length))
    }
  }

  private clearTimer(sessionId: string) {
    const t = this.finalizeTimers.get(sessionId)
    if (t) { clearTimeout(t); this.finalizeTimers.delete(sessionId) }
  }

  // Process incoming PTY data. Returns data for the frontend.
  // VT sequences MUST pass through unmodified — xterm.js's parser depends on
  // receiving the exact stream. Marker detection and command accumulation
  // happen independently. Wrapper system lines (marker, stats, diag) are
  // stripped from the display stream but still consumed for RTK tracking.
  processOutput(sessionId: string, data: string): string {
    debugLog(`DATA CHUNK session=${sessionId.slice(0,8)} len=${data.length} preview="${data.slice(0,100).replace(/\n/g,'\\n').replace(/\r/g,'\\r')}"`)
    // Buffer partial lines across chunks (PTY data can split lines)
    const prevPartial = this.lineBuffer.get(sessionId) || ''
    const full = prevPartial + data
    const parts = full.split(/\r?\n/)
    // Last element may be incomplete — save for next chunk, bounded so a
    // newline-less TUI frame can't accumulate for the session lifetime.
    let trailing = parts[parts.length - 1]
    if (trailing.length > MAX_LINE_BUFFER_CHARS) trailing = trailing.slice(-MAX_LINE_BUFFER_CHARS)
    this.lineBuffer.set(sessionId, trailing)

    // Split keeping separators so we can rebuild the display byte-for-byte
    // (only emitting the portion of `full` that belongs to this chunk).
    const segs = full.split(/(\r?\n)/)
    const emitFrom = prevPartial.length
    let displayOut = ''
    let dropping = this._systemPartial.get(sessionId) || false
    let consumed = 0

    for (let i = 0; i + 1 < segs.length; i += 2) {
      const rawLine = segs[i]
      const sep = segs[i + 1]
      const segStart = consumed
      consumed += rawLine.length + sep.length
      // Strip ANSI for command detection (line itself goes to terminal raw)
      const plain = toPlainLine(rawLine)

      // Display: exclude wrapper system lines (marker/stats/diag) and any
      // continuation of a system line started in a previous chunk. Detection
      // below still runs on every line regardless of display exclusion.
      const showLine = !dropping && !isSystemLine(plain)
      if (dropping) dropping = false

      if (showLine) {
        // Echoed wrapper-by-path invocations are shown as the compact marker
        // form instead — the real marker line right after is hidden, so the
        // command appears exactly once ("agntspce $ git show").
        const echoMatch = plain.match(WRAPPER_ECHO_RE)
        if (echoMatch) {
          displayOut += `agntspce $ ${echoMatch[1].trim()}${sep}`
        } else {
          // Emit only the bytes of this line+sep that belong to `data` (not the
          // buffered partial from the previous chunk, which was never displayed).
          const emitStart = Math.max(segStart, emitFrom)
          const emitEnd = segStart + rawLine.length + sep.length
          if (emitEnd > emitStart) {
            displayOut += full.slice(emitStart, emitEnd)
          }
        }
      }

      // Detect wrapper markers: "agntspce $ <command>"
      const tagMatch = plain.match(AGNTSPCE_CMD_RE)
      if (tagMatch) {
        const cmdStr = tagMatch[1].trim()
        debugLog(`MARKER DETECTED session=${sessionId.slice(0,8)} cmd="${cmdStr}" plain="${plain.slice(0,120)}"`)
        this.clearTimer(sessionId)
        this.finalizeCommand(sessionId)
        const detected = this._detectCommand(cmdStr)
        if (detected) {
          this.commandBuffers.set(sessionId, {
            command: detected.command,
            args: detected.args,
            rawOutput: '',
            startTime: Date.now(),
            exitCode: null,
          })
          this.insideCommand.set(sessionId, true)
          this.outputAccum.set(sessionId, [])
        }
      }

      // Detect shell prompt + command (e.g. "$ git status", "❯ git diff")
      // Agents echo commands with a shell prompt before running them.
      // Only track commands that have a specific RTK filter (avoids noise from
      // commands like `cd`, `echo`, `ls` that produce no filtered savings).
      if (!tagMatch) {
        const shellCmdMatch = plain.match(SHELL_CMD_RE)
        if (shellCmdMatch) {
          const cmdStr = shellCmdMatch[1].trim()
          // Strip "agntspce " prefix — the RTK filter patterns match the
          // underlying command (e.g. "git show"), not "agntspce git show".
          const strippedCmd = cmdStr.replace(/^agntspce\s+/, '')
          debugLog(`SHELL CMD session=${sessionId.slice(0,8)} cmd="${cmdStr}" stripped="${strippedCmd}" hasFilter=${hasSpecificFilter(strippedCmd)} isEcho=${SHELL_ECHO_RE.test(plain)}`)
          if (strippedCmd && hasSpecificFilter(strippedCmd) && !SHELL_ECHO_RE.test(plain)) {
            const detected = this._detectCommand(strippedCmd)
            if (detected) {
              this.clearTimer(sessionId)
              this.finalizeCommand(sessionId)
              this.commandBuffers.set(sessionId, {
                command: detected.command,
                args: detected.args,
                rawOutput: '',
                startTime: Date.now(),
                exitCode: null,
              })
              this.insideCommand.set(sessionId, true)
              this.outputAccum.set(sessionId, [])
            }
          }
        }
      }

      // Detect token stats from wrapper (AGNTSPCE_STATS raw=N filtered=N).
      // The wrapper emits this line before the filtered output with the real
      // raw vs filtered token counts from spawnSync. Don't accumulate this line.
      if (this.insideCommand.get(sessionId)) {
        const statsMatch = plain.match(AGNTSPCE_STATS_RE)
        if (statsMatch) {
          const r = parseInt(statsMatch[1], 10)
          const f = parseInt(statsMatch[2], 10)
          debugLog(`STATS DETECTED session=${sessionId.slice(0,8)} raw=${r} filtered=${f} plain="${plain.slice(0,120)}"`)
          this._pendingStats.set(sessionId, { rawTokens: r, filteredTokens: f })
          continue
        }
      }
      if (plain.includes('AGNTSPCE_STATS') && !this.insideCommand.get(sessionId)) {
        debugLog(`STATS SEEN BUT insideCommand FALSE plain="${plain.slice(0,120)}"`)
      }

      // Always accumulate output for fallback events (200-line sliding window).
      // When shell command detection works, this feeds accurate per-command data.
      // When it doesn't (status transitions without markers), the fallback in
      // finalizeCommand creates events from the recent accumulator.
      const accum = this.outputAccum.get(sessionId) || []
      accum.push(rawLine.length > MAX_ACCUM_LINE_CHARS ? rawLine.slice(0, MAX_ACCUM_LINE_CHARS) + '…' : rawLine)
      if (accum.length > 200) accum.shift()
      this.outputAccum.set(sessionId, accum)
      if (this.insideCommand.get(sessionId)) {
        if (/[$#%❯➜]\s*$/.test(plain.trim()) || /^PS\s+.*>\s*$/.test(plain.trim()) || /^[A-Z]:\\.*>/.test(plain.trim()) || plain.trim() === '') {
          this.scheduleFinalize(sessionId)
        }
      }
    }

    // Safety net: ensure a finalize timer is pending if we're mid-command
    // but no prompt or status change has triggered one yet. The timer acts as
    // a fallback when the wrapper's output doesn't end with a clear prompt.
    if (this.insideCommand.get(sessionId) && !this.finalizeTimers.has(sessionId) && this.commandBuffers.has(sessionId)) {
      this.scheduleFinalize(sessionId)
    }

    // Trailing partial (buffered for next chunk). Determine whether it is the
    // start of a system line that must be hidden from the display.
    const partial = parts[parts.length - 1]
    const partialPlain = toPlainLine(partial)
    const partialIsSystem = isSystemLine(partialPlain)
    this._systemPartial.set(sessionId, dropping || partialIsSystem)
    if (!dropping && !partialIsSystem) {
      const emitStart = Math.max(consumed, emitFrom)
      displayOut += full.slice(emitStart)
    }

    return displayOut
  }

  private _detectCommand(cmdStr: string): { command: string; args: string[] } | null {
    const trimmed = cmdStr.trim()
    if (!trimmed) return null
    const parts = trimmed.split(/\s+/)
    if (parts.length === 0) return null
    return { command: parts[0], args: parts.slice(1) }
  }

  private _detectCommandFromOutput(lines: string[]): { command: string; args: string[] } | null {
    for (const rawLine of lines) {
      const plain = rawLine.replace(/\x1b\[[\d;]*[A-Za-z]/g, '').replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, '').replace(/[\x00-\x08\x0b\x0c\r\x0e-\x1f\x7f]/g, '')
      const tagMatch = plain.match(AGNTSPCE_CMD_RE)
      if (tagMatch) {
        const d = this._detectCommand(tagMatch[1])
        if (d) return d
      }
      const shellMatch = plain.match(SHELL_CMD_RE)
      if (shellMatch) {
        const strippedCmd = shellMatch[1].trim().replace(/^agntspce\s+/, '')
        if (strippedCmd && hasSpecificFilter(strippedCmd)) {
          const d = this._detectCommand(strippedCmd)
          if (d) return d
        }
      }
    }
    return null
  }

  private scheduleFinalize(sessionId: string) {
    this.clearTimer(sessionId)
    const timer = setTimeout(() => {
      this.finalizeCommand(sessionId)
    }, 1500)
    this.finalizeTimers.set(sessionId, timer)
  }

  // General-purpose compression for output with no detected command.
  // Applies safe reductions that work on any terminal output: collapses
  // blank lines, truncates long lines, limits total lines, strips tail space.
  private compressOutput(text: string): string {
    let lines = text.split('\n')
    // Collapse 3+ consecutive blank lines into one blank line
    lines = lines.reduce((acc: string[], line: string) => {
      const isBlank = line.trim() === ''
      if (isBlank && acc.length > 0 && acc[acc.length - 1] === '') return acc
      acc.push(isBlank ? '' : line)
      return acc
    }, [] as string[])
    // Truncate lines > 2000 chars
    lines = lines.map(l => l.length > 2000 ? l.slice(0, 1997) + '...' : l)
    // Strip trailing whitespace per line
    lines = lines.map(l => l.trimEnd())
    // Limit to head 200 + tail 100
    const head = 200, tail = 100
    if (lines.length > head + tail) {
      lines = [
        ...lines.slice(0, head),
        `... (${lines.length - head - tail} lines omitted)`,
        ...lines.slice(lines.length - tail),
      ]
    }
    return lines.join('\n')
  }

  finalizeCommand(sessionId: string, exitCode?: number): CommandEvent | null {
    debugLog(`finalizeCommand called session=${sessionId.slice(0,8)} exitCode=${exitCode ?? 'none'} hasPendingStats=${this._pendingStats.has(sessionId)} hasBuf=${this.commandBuffers.has(sessionId)} insideCmd=${this.insideCommand.get(sessionId)}`)
    let cmdBuf = this.commandBuffers.get(sessionId)
    const accum = this.outputAccum.get(sessionId) || []
    const rawOutput = accum.join('\n').trim()

    // Fallback: if no shell command was detected but there's accumulated output,
    // scan the output for command patterns to apply the right filter.
    if (!cmdBuf) {
      if (!rawOutput) return null
      const detectedCmd = this._detectCommandFromOutput(accum)
      cmdBuf = {
        command: detectedCmd?.command || 'output',
        args: detectedCmd?.args || [],
        rawOutput,
        startTime: Date.now(),
        exitCode: exitCode ?? 0,
      }
      this.commandBuffers.set(sessionId, cmdBuf)
      if (detectedCmd) {
        debugLog(`FALLBACK cmd detected from output: "${cmdBuf.command}"`)
      } else {
        debugLog(`FALLBACK no cmd detected, using "output"`)
      }
    }

    // Guard: if the command just started and the wrapper's stats haven't
    // arrived, don't finalize yet. The marker line alone triggers an idle
    // status transition in detectStatus (buffer < 100 chars → idle) which
    // calls finalizeCommand before the stats line and filtered output arrive.
    if (!this._pendingStats.has(sessionId) && Date.now() - cmdBuf.startTime < 500 && rawOutput.length < 50) {
      debugLog(`GUARD FIRED session=${sessionId.slice(0,8)} cmd="${cmdBuf.command}" elapsed=${Date.now()-cmdBuf.startTime} rawLen=${rawOutput.length}`)
      return null
    }

    this.clearTimer(sessionId)
    this.insideCommand.set(sessionId, false)

    cmdBuf.exitCode = exitCode ?? 0
    cmdBuf.rawOutput = rawOutput

    const cmdStr = `${cmdBuf.command} ${cmdBuf.args.join(' ')}`.trim()
    const cleanedOutput = stripAllControl(rawOutput)

    // Use wrapper-reported stats if available (real raw vs filtered from
    // spawnSync in bin/agntspce.mjs). Otherwise fall back to RTK filter.
    const pending = this._pendingStats.get(sessionId)
    let originalTokens: number
    let filteredTokens: number
    let reduction: number
    let filtered: string
    let filterName: string | undefined
    if (pending) {
      debugLog(`USING PENDING STATS session=${sessionId.slice(0,8)} raw=${pending.rawTokens} filtered=${pending.filteredTokens}`)
      const dedupKey = `${pending.rawTokens}-${pending.filteredTokens}`
      // If the wrapper's HTTP POST (reportTokenSavings) already recorded this
      // exact token pair within the last 5s, skip emitting — otherwise the same
      // spawnSync gets double-counted (PTY path + HTTP path).
      const lastReported = this._recentTokenReports.get(dedupKey)
      const now = Date.now()
      if (lastReported && now - lastReported < 5000) {
        debugLog(`SKIP finalize (already reported via HTTP) session=${sessionId.slice(0,8)} key=${dedupKey}`)
        this._pendingStats.delete(sessionId)
        this.clearTimer(sessionId)
        this.insideCommand.set(sessionId, false)
        this.commandBuffers.delete(sessionId)
        this.outputAccum.delete(sessionId)
        return null
      }
      originalTokens = pending.rawTokens
      filteredTokens = pending.filteredTokens
      reduction = originalTokens > 0
        ? Math.round((1 - filteredTokens / originalTokens) * 10000) / 100
        : 0
      filtered = stripAllControl(cleanedOutput)
      // Mark as recently reported so the wrapper's HTTP POST (reportTokenSavings)
      // for the SAME command is skipped — otherwise raw/filtered tokens from the
      // same spawnSync get double-counted in the cumulative stats.
      this._recentTokenReports.set(dedupKey, now)
      this._pendingStats.delete(sessionId)
    } else {
      debugLog(`FALLBACK no pending stats session=${sessionId.slice(0,8)} cmd="${cmdBuf.command}" rawLen=${cleanedOutput.length}`)

      // Apply RTK filter if we detected a specific command (e.g. git status
      // via shell prompt). The filter strips matching lines and truncates.
      const rtkResult = filterCommandOutput(cmdStr, cleanedOutput)
      filtered = rtkResult.filtered
      filterName = rtkResult.filterName || undefined

      // If no specific filter matched or command is 'output' (no command
      // detected, e.g. agent session output), apply general-purpose
      // compression that always reduces tokens: collapse blank lines,
      // truncate long lines, limit total lines.
      if (!rtkResult.filterName || cmdBuf.command === 'output') {
        const compressed = this.compressOutput(filtered)
        if (estimateTokens(compressed) < estimateTokens(filtered)) {
          debugLog(`COMPRESS: applied general compression cmd="${cmdBuf.command}" before=${filtered.length} after=${compressed.length}`)
          filtered = compressed
        }
        filterName = undefined
      }

      // neverWorse: if filtered is larger than raw, use raw instead
      if (estimateTokens(filtered) > estimateTokens(cleanedOutput)) {
        debugLog(`NEVER WORSE: filtered larger than raw cmd="${cmdBuf.command}"`)
        filtered = cleanedOutput
        filterName = undefined
      }

      originalTokens = estimateTokens(cleanedOutput)
      filteredTokens = estimateTokens(filtered)
      reduction = originalTokens > 0
        ? Math.round((1 - filteredTokens / originalTokens) * 10000) / 100
        : 0
    }

    const brandedCmd = formatCommand(cmdBuf.command, cmdBuf.args, 'agntspce')
    // Token counts above are computed on the full text; only the RETAINED
    // copies are capped so history (memory + persisted JSON) stays bounded.
    const event: CommandEvent = {
      sessionId,
      command: cmdBuf.command,
      args: cmdBuf.args,
      formatted: brandedCmd,
      rawOutput: capStoredOutput(cleanedOutput),
      filteredOutput: capStoredOutput(filtered),
      originalTokens,
      filteredTokens,
      reduction,
      exitCode: cmdBuf.exitCode,
      duration: Date.now() - cmdBuf.startTime,
      timestamp: Date.now(),
      filterName,
    }

    debugLog(`EMIT EVENT session=${sessionId.slice(0,8)} cmd="${brandedCmd}" reduction=${reduction}% orig=${originalTokens} filt=${filteredTokens}`)

    this.commandBuffers.delete(sessionId)
    this.outputAccum.delete(sessionId)
    this.emit(event)
    return event
  }

  getCommandHistory(sessionId: string): CommandEvent[] {
    return this._commandHistory.get(sessionId) || []
  }

  // Byte lengths are memoized per event object: getAllStats() runs after every
  // emitted command, and re-encoding every retained output each time (the old
  // behavior) turned into an allocation storm as history grew.
  private _byteLenCache = new WeakMap<CommandEvent, { raw: number; filtered: number }>()
  private eventByteLengths(event: CommandEvent): { raw: number; filtered: number } {
    let lengths = this._byteLenCache.get(event)
    if (!lengths) {
      lengths = { raw: Buffer.byteLength(event.rawOutput), filtered: Buffer.byteLength(event.filteredOutput) }
      this._byteLenCache.set(event, lengths)
    }
    return lengths
  }

  getAllCommandHistory(): CommandEvent[] {
    const all: CommandEvent[] = []
    for (const [, hist] of this._commandHistory) all.push(...hist)
    return all
  }

  getAllStats(): { stats: { totalOriginalBytes: number; totalFilteredBytes: number; totalOriginalTokens: number; totalFilteredTokens: number; eventsProcessed: number } }[] {
    if (this._statsCache) return [{ stats: this._statsCache.stats }]
    // Command history (persisted + live) is the single source of truth for
    // totals. Avoids double counting between _cumulativeStats and history.
    const sessionEvents = this.getAllCommandHistory().filter(e => !e.command.startsWith('agntspce-search'))
    let totalOriginalBytes = 0
    let totalFilteredBytes = 0
    for (const e of sessionEvents) {
      const lens = this.eventByteLengths(e)
      totalOriginalBytes += lens.raw
      totalFilteredBytes += lens.filtered
    }
    const stats = {
      totalOriginalBytes,
      totalFilteredBytes,
      totalOriginalTokens: sessionEvents.reduce((s, e) => s + e.originalTokens, 0),
      totalFilteredTokens: sessionEvents.reduce((s, e) => s + e.filteredTokens, 0),
      eventsProcessed: sessionEvents.length,
    }
    this._statsCache = { stats }
    return [{ stats }]
  }

  getCumulativeStats(): CumulativeStats {
    return this.getAllStats()[0].stats
  }

  getAllHistory(): any[] {
    const allEvents = this.getAllCommandHistory()
    return allEvents.map(e => {
      const lens = this.eventByteLengths(e)
      return {
        sessionId: e.sessionId,
        original: e.rawOutput,
        filtered: e.filteredOutput,
        originalBytes: lens.raw,
        filteredBytes: lens.filtered,
        originalTokens: e.originalTokens,
        filteredTokens: e.filteredTokens,
        reduction: e.reduction,
        rulesApplied: e.filterName ? [e.filterName] : [],
      }
    })
  }

  reportTokenSavings(originalTokens: number, filteredTokens: number, toolName?: string, sessionId?: string) {
    // Dedup: if any active session has pending stats with the same token
    // values, the PTY-based detection already captured this command.
    // The HTTP POST (from bin/agntspce.mjs reportStats) is redundant.
    for (const [, pending] of this._pendingStats) {
      if (pending.rawTokens === originalTokens && pending.filteredTokens === filteredTokens) {
        return null
      }
    }
    // Secondary dedup: same token pair reported within the last 5 seconds
    const dedupKey = `${originalTokens}-${filteredTokens}`
    const lastReported = this._recentTokenReports.get(dedupKey)
    const now = Date.now()
    if (lastReported && now - lastReported < 5000) {
      debugLog(`DEDUP reportTokenSavings key=${dedupKey} age=${now - lastReported}ms`)
      return null
    }
    this._recentTokenReports.set(dedupKey, now)
    // Prune entries older than 30s
    if (this._recentTokenReports.size > 100) {
      for (const [k, t] of this._recentTokenReports) {
        if (now - t > 30000) this._recentTokenReports.delete(k)
      }
    }
    const event: CommandEvent = {
      sessionId: sessionId || 'system',
      command: toolName || 'tool',
      args: [],
      formatted: `agntspce $ ${toolName || 'tool'}`,
      rawOutput: '',
      filteredOutput: '',
      originalTokens,
      filteredTokens,
      reduction: originalTokens > 0 ? Math.round((1 - filteredTokens / originalTokens) * 10000) / 100 : 0,
      exitCode: 0,
      duration: 0,
      timestamp: Date.now(),
    }
    this.emit(event)
    return event
  }

  cleanup(sessionId: string) {
    // Keep command history so per-session breakdowns survive session close
    // and app restarts. Only clear transient per-session state.
    this.commandBuffers.delete(sessionId)
    this.outputAccum.delete(sessionId)
    this.lineBuffer.delete(sessionId)
    this._systemPartial.delete(sessionId)
    this.insideCommand.delete(sessionId)
    this.clearTimer(sessionId)
    this._pendingStats.delete(sessionId)
    this._scheduleHistorySave()
  }

  reset() {
    this.commandBuffers.clear()
    this.outputAccum.clear()
    this.lineBuffer.clear()
    this._systemPartial.clear()
    this.insideCommand.clear()
    this._commandHistory.clear()
    this._pendingStats.clear()
    for (const [, t] of this.finalizeTimers) clearTimeout(t)
    this.finalizeTimers.clear()
    if (this._historySaveTimer) {
      clearTimeout(this._historySaveTimer)
      this._historySaveTimer = null
    }
    this._saveHistory()
  }

  resetCumulativeStats() {
    this._cumulativeStats = { totalOriginalBytes: 0, totalFilteredBytes: 0, totalOriginalTokens: 0, totalFilteredTokens: 0, eventsProcessed: 0 }
    this._saveCumulativeStats()
    this.reset()
  }

  persistCumulativeStats() {
    // Command history is the source of truth; flush any pending history save.
    if (this._historySaveTimer) {
      clearTimeout(this._historySaveTimer)
      this._historySaveTimer = null
      this._saveHistory()
    }
  }
}
