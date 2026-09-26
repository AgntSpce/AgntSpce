/**
 * Structured agent status, sourced from agent lifecycle hooks rather than from
 * terminal bytes.
 *
 * Why this exists: the sidebar's agent rows used to scrape the PTY stream for
 * "the agent's latest line". A TUI repaint re-emits text that is already on
 * screen, so scrolling back through a conversation replaced the row's answer
 * with old text, and the row could freeze on chrome instead of the agent's
 * real output. Orca and Superset both solved this the same way — by never
 * reading the terminal for this value. Orca's row shows the current TOOL CALL
 * while an agent works and the last ASSISTANT MESSAGE once it is done
 * (`orca-main/src/renderer/src/lib/activity-thread-display.ts:155`); Superset
 * goes further and shows only a status dot in the terminal sidebar.
 *
 * Invariant: no terminal byte may ever reach the row's status line. Anything
 * that reintroduces stream-scraped text here regresses the whole point.
 */
import * as fs from 'fs'

/** What the row's glyph should be. Mirrors Orca's AgentStatusState. */
export type AgentStatusState = 'idle' | 'working' | 'permission' | 'done'

/**
 * One hook event, normalized. The wire shape is Claude Code's hook JSON on
 * stdin; we accept it already-parsed and validate defensively because a hook
 * script is a subprocess we do not control end to end.
 */
export interface AgentHookPayload {
  /** agntspce session id, injected via AGNTSPCE_SESSION_ID in the launch env. */
  sessionId: string
  /** Claude Code's own transcript path — the cheapest way to the reply text. */
  transcriptPath?: string
  hookEventName: string
  prompt?: string
  toolName?: string
  toolInput?: unknown
}

export interface AgentStatusEntry {
  sessionId: string
  state: AgentStatusState
  /** The last prompt the user submitted (the "question" line). */
  prompt: string
  /** The tool the agent is calling right now, if any. */
  toolName: string
  /** A short, human-readable summary of the tool's input. */
  toolInput: string
  /** The last text the agent actually generated. Never thinking text. */
  lastAssistantMessage: string
  updatedAt: number
}

const HOOK_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
  'SessionStart',
  'SessionEnd',
])

/** Parse and validate a raw hook payload. Returns null if it can't be trusted. */
export function parseAgentHookPayload(raw: unknown): AgentHookPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  // A hook launched outside our app (or before AGNTSPCE_SESSION_ID existed)
  // has no session to attribute to — dropping it is correct, not lossy.
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : typeof r.session_id === 'string' ? r.session_id : ''
  if (!sessionId) return null

  const hookEventName = typeof r.hookEventName === 'string' ? r.hookEventName : typeof r.hook_event_name === 'string' ? r.hook_event_name : ''
  if (!HOOK_EVENTS.has(hookEventName)) return null

  return {
    sessionId,
    hookEventName,
    transcriptPath: typeof r.transcriptPath === 'string' ? r.transcriptPath : typeof r.transcript_path === 'string' ? r.transcript_path : undefined,
    prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    toolName: typeof r.toolName === 'string' ? r.toolName : typeof r.tool_name === 'string' ? r.tool_name : undefined,
    toolInput: r.toolInput ?? r.tool_input,
  }
}

// ── Tool input summarization ───────────────────────────────────────────
// The row has one line of space. tool_input is a whole JSON object, so pull
// the single field that actually identifies the call rather than dumping
// braces into the sidebar.
const TOOL_INPUT_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'] as const

export function summarizeToolInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const rec = input as Record<string, unknown>
  for (const key of TOOL_INPUT_KEYS) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

const MAX_TOOL_SUMMARY = 80

function clamp(s: string): string {
  return s.length > MAX_TOOL_SUMMARY ? `${s.slice(0, MAX_TOOL_SUMMARY - 1)}…` : s
}

// ── Transcript: last assistant text ────────────────────────────────────
// Port of Orca's `extractAssistantTextFromLine`
// (orca-main/src/shared/agent-hook-listener.ts:887) plus its backwards tail
// scan (`readLastAssistantFromTranscript`, :1332). We only need the tail, so
// we read a bounded window and walk backwards for the last record that carries
// real assistant prose.

const TRANSCRIPT_MAX_SCAN_BYTES = 256 * 1024

function extractAssistantContentText(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim().length > 0) return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      // Skip tool_use / tool_result blocks — only prose counts as the answer.
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim().length > 0) return text
    }
  }
  return undefined
}

/** Pull assistant prose out of one transcript line, or undefined. */
export function extractAssistantTextFromLine(line: string): string | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>

  // Newer envelope shape.
  if (record.type === 'assistant.message') {
    const data = record.data
    if (typeof data === 'object' && data !== null) {
      const text = extractAssistantContentText((data as Record<string, unknown>).content)
      if (text) return text
    }
  }

  // The shape Claude Code actually writes: {type:'assistant', message:{role,content}}.
  const nestedMessage = record.message as Record<string, unknown> | undefined
  const role = record.role ?? nestedMessage?.role ?? (record.type === 'assistant' ? 'assistant' : undefined)
  if (role !== 'assistant') return undefined
  return extractAssistantContentText(nestedMessage?.content ?? record.content)
}

/**
 * Read the tail of a transcript and return the most recent assistant text.
 * A missing, unreadable, or still-being-written transcript yields undefined —
 * the caller keeps whatever it already had rather than blanking the row.
 */
export function readLastAssistantFromTranscript(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined
  try {
    const stat = fs.statSync(transcriptPath)
    if (!stat.isFile() || stat.size === 0) return undefined
    const start = Math.max(0, stat.size - TRANSCRIPT_MAX_SCAN_BYTES)
    const length = stat.size - start
    if (length <= 0) return undefined
    const buf = Buffer.allocUnsafe(length)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      fs.readSync(fd, buf, 0, length, start)
    } finally {
      fs.closeSync(fd)
    }
    const lines = buf.toString('utf8').split('\n')
    // The first line is only whole if we read from byte 0; otherwise it is a
    // partial record and must be skipped.
    if (start > 0 && lines.length > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = extractAssistantTextFromLine(lines[i])
      if (text && text.trim()) return text.trim()
    }
    return undefined
  } catch {
    return undefined
  }
}

// ── Preview selection ──────────────────────────────────────────────────
// Port of Orca's `getActivityThreadStatusPreview` / `isMislabeledUserPrompt`
// (activity-thread-display.ts:138-181).

/**
 * Some agents echo the live user prompt back into the assistant field between
 * turns. Rendering that as the agent's reply makes the row show the question
 * twice, so never treat it as an answer.
 */
export function isMislabeledUserPrompt(text: string, prompt: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed === prompt.trim()) return true
  return false
}

/** The one line the row shows under the prompt. */
export function getStatusPreview(entry: AgentStatusEntry | undefined): string {
  if (!entry) return ''
  if (entry.state === 'working') {
    // Working: show the current tool step. This is the live channel — it is
    // only ever populated by a hook, never by the terminal.
    if (entry.toolName && entry.toolInput) return clamp(`${entry.toolName}: ${entry.toolInput}`)
    if (entry.toolName) return entry.toolName
  }
  const assistant = entry.lastAssistantMessage.trim()
  if (assistant && !isMislabeledUserPrompt(assistant, entry.prompt)) return clamp(assistant)
  return ''
}

export class AgentStatusService {
  private entries = new Map<string, AgentStatusEntry>()

  getEntry(sessionId: string): AgentStatusEntry | undefined {
    return this.entries.get(sessionId)
  }

  getPreview(sessionId: string): string {
    return getStatusPreview(this.entries.get(sessionId))
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  clearAll(): void {
    this.entries.clear()
  }

  private ensure(sessionId: string): AgentStatusEntry {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = {
        sessionId,
        state: 'idle',
        prompt: '',
        toolName: '',
        toolInput: '',
        lastAssistantMessage: '',
        updatedAt: Date.now(),
      }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  /**
   * Fold one hook event into the session's status. Returns the updated entry,
   * or null when the event was rejected. The entry is mutated in place and is
   * the same object the caller holds, so consumers can rely on identity.
   */
  async ingestHook(raw: unknown): Promise<AgentStatusEntry | null> {
    const payload = parseAgentHookPayload(raw)
    if (!payload) return null
    const entry = this.ensure(payload.sessionId)

    switch (payload.hookEventName) {
      case 'UserPromptSubmit': {
        // A new question is new work: clear the previous turn's tool step so a
        // stale tool call can never linger as this turn's live line.
        entry.prompt = (payload.prompt || '').trim()
        entry.state = 'working'
        entry.toolName = ''
        entry.toolInput = ''
        break
      }
      case 'PreToolUse': {
        entry.state = 'working'
        entry.toolName = (payload.toolName || '').trim()
        entry.toolInput = summarizeToolInput(payload.toolInput)
        break
      }
      case 'PostToolUse': {
        // Tool finished; still working, but the step is over. Clear it so the
        // row falls back to the last answer rather than a completed call.
        if (entry.toolName === (payload.toolName || '').trim()) {
          entry.toolName = ''
          entry.toolInput = ''
        }
        break
      }
      case 'Stop':
      case 'SubagentStop': {
        // The run is over — freeze whatever the agent said. Reading the
        // transcript is the only way to get the reply text; if it isn't
        // readable yet we keep the previous value rather than blanking the row.
        const text = readLastAssistantFromTranscript(payload.transcriptPath)
        if (text) entry.lastAssistantMessage = text
        entry.state = 'done'
        entry.toolName = ''
        entry.toolInput = ''
        break
      }
      case 'Notification': {
        // Claude Code raises this when it needs permission or input.
        if (entry.state !== 'done') entry.state = 'permission'
        break
      }
      case 'SessionStart': {
        this.clear(payload.sessionId)
        return this.ensure(payload.sessionId)
      }
      case 'SessionEnd': {
        this.clear(payload.sessionId)
        return null
      }
    }

    entry.updatedAt = Date.now()
    return entry
  }
}
