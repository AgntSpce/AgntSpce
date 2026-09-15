// Prompt compression history (agntspce-prompter).
//
// Records every prompt a user submits to a session — typed into the terminal
// (submitted with Enter) or supplied as the agent-start prompt — compressed
// with the internal agntspce-prompter. The Dashboard "Prompts" tab renders
// these before/after pairs per session, newest first.
//
// Conventions mirror OutputFilterService (electron/services/outputFilter.ts):
// per-session caps, a global cap, JSON persistence in the user data dir, and
// history is kept after a session closes so the dashboard survives restarts.

import fs from 'fs'
import path from 'path'
import { estimateTokens, getPrompter } from './prompter'

export type PromptSource = 'typed' | 'agent-start'

export interface PromptCompressEvent {
  sessionId: string
  source: PromptSource
  originalPrompt: string
  compressedPrompt: string
  originalTokens: number
  compressedTokens: number
  reduction: number
  timestamp: number
}

const MAX_PER_SESSION_EVENTS = 200
const MAX_TOTAL_EVENTS = 1200
const MAX_PERSISTED_EVENTS = 600
// Full prompt bodies are stored verbatim — the Dashboard "Prompts" tab must
// show the complete before/after text. Per-session/global/persisted caps above
// keep total size bounded; no per-prompt character truncation is applied.
// Large pastes (multi-KB design-system prompts) arrive via terminal input,
// so the keystroke buffer is generous.
const MAX_INPUT_BUFFER_CHARS = 512 * 1024
// Single-key confirmations (y/n) and empty submits are not prompts.
const MIN_PROMPT_CHARS = 2
// Prompts this short carry too few tokens for percentile-threshold
// compression to be meaningful — even lite rates drop content words
// (e.g. "please fix the login bug" lost "fix"/"bug"). Stored verbatim.
const MIN_TOKENS_FOR_COMPRESSION = 10

// Full CSI grammar incl. private prefixes (< > = ?) so SGR mouse reports
// (ESC [ < Cb ; Cx ; Cy m/M), focus events, and bracketed-paste markers
// (ESC [ 200 ~) are removed instead of leaving "[<35;33;17M" remnants.
const ANSI_CSI_RE = /\x1b\[[><=?]*[0-9;]*[ -/]*[@-~]/g
const ANSI_OSC_RE = /\x1b\][\s\S]*?(?:\x1b\\|\x07)/g
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
// Remnants of terminal protocol noise that survived as plain text (e.g. a
// mouse sequence split across input chunks, leaving "[<35;33" behind).
const MOUSE_JUNK_RE = /\[<[0-9]|\[M/

// A real prompt carries human text. Mouse drags, focus events, lone escape
// keys, and stray control bytes don't — require at least two letters
// (unicode-aware so non-English prompts pass).
function hasHumanText(text: string): boolean {
  const letters = text.match(/\p{L}/gu)
  return !!letters && letters.length >= 2
}

// Returns the prompt text, or null when the submitted line is terminal
// protocol noise rather than something the user typed.
function extractPromptText(text: string): string | null {
  const clean = String(text || '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(CONTROL_RE, '')
    .trim()
  if (clean.length < MIN_PROMPT_CHARS) return null
  if (MOUSE_JUNK_RE.test(clean)) return null
  if (!hasHumanText(clean)) return null
  return clean
}

function capStoredText(text: string): string {
  // Store the full prompt — no truncation. Previously capped at ~8KB per
  // side, which cut off large prompts in the Dashboard before/after view.
  // Kept as an identity helper so existing call sites stay unchanged.
  return text
}

export class PromptHistoryService {
  private history = new Map<string, PromptCompressEvent[]>()
  // Raw keystroke accumulation per session. A submitted prompt is complete
  // when the user presses Enter (\r or \n) — same convention as the
  // terminal Enter handling noted in CLAUDE.md.
  private inputBuffers = new Map<string, string>()
  private onPromptEvent: ((event: PromptCompressEvent) => void) | null = null
  private historyFilePath = ''
  // Default compression mode for sessions without a per-session override.
  // Lite keeps detail (0.85), medium is balanced (0.65), extreme maxes
  // savings (0.4). Lite is the default for all agents.
  private compressionMode: 'lite' | 'medium' | 'extreme' = 'lite'
  // Per-session (per-agent) overrides set from the agent tab dropdown.
  private sessionModes = new Map<string, 'lite' | 'medium' | 'extreme'>()

  constructor(dataDir?: string, compressionMode: 'lite' | 'medium' | 'extreme' = 'lite') {
    if (dataDir) {
      this.historyFilePath = path.join(dataDir, 'prompt-history.json')
      this.load()
    }
    this.setCompressionMode(compressionMode)
  }

  private static rateForMode(mode: 'lite' | 'medium' | 'extreme'): number {
    switch (mode) {
      case 'lite':
        return 0.85
      case 'medium':
        return 0.65
      case 'extreme':
        return 0.4
    }
  }

  private static isMode(mode: unknown): mode is 'lite' | 'medium' | 'extreme' {
    return mode === 'lite' || mode === 'medium' || mode === 'extreme'
  }

  /** Update the default compression mode (lite, medium, extreme). */
  setCompressionMode(mode: 'lite' | 'medium' | 'extreme'): void {
    if (!PromptHistoryService.isMode(mode)) return
    this.compressionMode = mode
  }

  getCompressionMode(): 'lite' | 'medium' | 'extreme' {
    return this.compressionMode
  }

  /** Override the compression mode for one session (agent tab dropdown). */
  setSessionCompressionMode(sessionId: string, mode: 'lite' | 'medium' | 'extreme'): void {
    if (!sessionId || !PromptHistoryService.isMode(mode)) return
    this.sessionModes.set(sessionId, mode)
  }

  getSessionCompressionMode(sessionId: string): 'lite' | 'medium' | 'extreme' {
    return this.sessionModes.get(sessionId) ?? this.compressionMode
  }

  getAllSessionModes(): Record<string, 'lite' | 'medium' | 'extreme'> {
    return Object.fromEntries(this.sessionModes)
  }

  setOnPromptEvent(cb: (event: PromptCompressEvent) => void) {
    this.onPromptEvent = cb
  }

  // Feed raw terminal input (user keystrokes). Returns the last recorded
  // event when one or more lines were submitted, otherwise null.
  handleTerminalInput(sessionId: string, data: string): PromptCompressEvent | null {
    if (!sessionId || !data) return null
    let buf = (this.inputBuffers.get(sessionId) || '') + data
    if (buf.length > MAX_INPUT_BUFFER_CHARS) buf = buf.slice(-MAX_INPUT_BUFFER_CHARS)
    const parts = buf.split(/\r\n|\r|\n/)
    this.inputBuffers.set(sessionId, parts[parts.length - 1])
    let last: PromptCompressEvent | null = null
    for (let i = 0; i < parts.length - 1; i++) {
      const event = this.record(sessionId, parts[i], 'typed')
      if (event) last = event
    }
    return last
  }

  // Compress and store one prompt. Returns null for empty/tiny input and
  // for terminal protocol noise (mouse reports, focus events, escape keys).
  // Never-worse guarantee: the compressed side is never empty and never
  // reports more tokens than the original.
  record(sessionId: string, text: string, source: PromptSource): PromptCompressEvent | null {
    if (!sessionId) return null
    const clean = extractPromptText(text)
    if (!clean) return null
    const original = capStoredText(clean)

    let compressed = original
    let originalTokens = 0
    let compressedTokens = 0
    try {
      originalTokens = estimateTokens(original)
      if (originalTokens <= MIN_TOKENS_FOR_COMPRESSION) {
        compressedTokens = originalTokens
      } else {
        const rate = PromptHistoryService.rateForMode(this.getSessionCompressionMode(sessionId))
        const res = getPrompter().compressPrompt(original, '', '', { rate })
        originalTokens = res.origin_tokens
        compressedTokens = res.compressed_tokens
        const candidate = (res.compressed_prompt || '').trim()
        if (candidate && compressedTokens <= originalTokens) {
          compressed = candidate
        } else {
          compressed = original
          compressedTokens = originalTokens
        }
      }
    } catch {
      originalTokens = Math.max(1, Math.ceil(original.length / 4))
      compressedTokens = originalTokens
    }

    const reduction = originalTokens > 0
      ? Math.round((1 - compressedTokens / originalTokens) * 10000) / 100
      : 0
    const event: PromptCompressEvent = {
      sessionId,
      source,
      originalPrompt: original,
      compressedPrompt: compressed,
      originalTokens,
      compressedTokens,
      reduction,
      timestamp: Date.now(),
    }
    const hist = this.history.get(sessionId) || []
    hist.push(event)
    if (hist.length > MAX_PER_SESSION_EVENTS) hist.shift()
    this.history.set(sessionId, hist)
    this.enforceGlobalCap()
    this.save()
    try {
      this.onPromptEvent?.(event)
    } catch {}
    return event
  }

  getHistory(sessionId: string): PromptCompressEvent[] {
    return [...(this.history.get(sessionId) || [])]
  }

  // Oldest-first (insertion order); the renderer sorts newest-first.
  getAllHistory(): PromptCompressEvent[] {
    const all: PromptCompressEvent[] = []
    for (const [, hist] of this.history) all.push(...hist)
    all.sort((a, b) => a.timestamp - b.timestamp)
    return all
  }

  cleanup(sessionId: string) {
    // Keep history so per-session prompts survive session close and app
    // restarts. Only clear the transient keystroke buffer and the
    // per-session compression override (a new session starts at default).
    this.inputBuffers.delete(sessionId)
    this.sessionModes.delete(sessionId)
  }

  reset() {
    this.history.clear()
    this.inputBuffers.clear()
    this.sessionModes.clear()
    this.save()
  }

  private enforceGlobalCap(): void {
    let total = 0
    for (const h of this.history.values()) total += h.length
    if (total <= MAX_TOTAL_EVENTS) return
    const flat: { sid: string; ts: number }[] = []
    for (const [sid, h] of this.history) {
      for (const e of h) flat.push({ sid, ts: e.timestamp })
    }
    flat.sort((a, b) => a.ts - b.ts)
    const toRemove = total - MAX_TOTAL_EVENTS
    const counts = new Map<string, number>()
    for (let i = 0; i < toRemove; i++) {
      const r = flat[i]
      counts.set(r.sid, (counts.get(r.sid) || 0) + 1)
    }
    for (const [sid, n] of counts) {
      const h = this.history.get(sid)
      if (h && n > 0) h.splice(0, Math.min(n, h.length))
    }
  }

  private load() {
    if (!this.historyFilePath) return
    try {
      const data = fs.readFileSync(this.historyFilePath, 'utf-8')
      const parsed = JSON.parse(data) as PromptCompressEvent[]
      if (!Array.isArray(parsed)) return
      const events = parsed.length > MAX_PERSISTED_EVENTS ? parsed.slice(-MAX_PERSISTED_EVENTS) : parsed
      this.history.clear()
      for (const e of events) {
        if (!e || typeof e.sessionId !== 'string' || typeof e.originalPrompt !== 'string') continue
        // Purge terminal protocol noise saved before noise filtering existed
        // (e.g. SGR mouse-report blobs) so old junk disappears on upgrade.
        if (!extractPromptText(e.originalPrompt)) continue
        const hist = this.history.get(e.sessionId) || []
        hist.push({
          sessionId: e.sessionId,
          source: e.source === 'agent-start' ? 'agent-start' : 'typed',
          originalPrompt: capStoredText(e.originalPrompt),
          compressedPrompt: capStoredText(String(e.compressedPrompt || '')),
          originalTokens: Number(e.originalTokens) || 0,
          compressedTokens: Number(e.compressedTokens) || 0,
          reduction: Number(e.reduction) || 0,
          timestamp: Number(e.timestamp) || Date.now(),
        })
        if (hist.length > MAX_PER_SESSION_EVENTS) hist.shift()
        this.history.set(e.sessionId, hist)
      }
    } catch {}
  }

  private save() {
    if (!this.historyFilePath) return
    try {
      const all = this.getAllHistory()
      const capped = all.length > MAX_PERSISTED_EVENTS ? all.slice(-MAX_PERSISTED_EVENTS) : all
      fs.mkdirSync(path.dirname(this.historyFilePath), { recursive: true })
      fs.writeFileSync(this.historyFilePath, JSON.stringify(capped), 'utf-8')
    } catch {}
  }
}
