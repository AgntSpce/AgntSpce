import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PromptHistoryService } from '../promptHistory'

const WORDY_PROMPT = 'Please carefully analyze the authentication module and explain in detail how the session refresh mechanism handles expired tokens when multiple concurrent requests arrive at the same time'

describe('PromptHistoryService', () => {
  let svc: PromptHistoryService
  let emitted: any[]

  beforeEach(() => {
    svc = new PromptHistoryService()
    emitted = []
    svc.setOnPromptEvent(e => emitted.push(e))
  })

  it('records a prompt with before/after compression and timestamp', () => {
    const before = Date.now()
    const event = svc.record('s1', WORDY_PROMPT, 'typed')
    expect(event).not.toBeNull()
    expect(event!.sessionId).toBe('s1')
    expect(event!.source).toBe('typed')
    expect(event!.originalPrompt).toBe(WORDY_PROMPT)
    expect(event!.compressedPrompt.length).toBeGreaterThan(0)
    expect(event!.compressedTokens).toBeLessThanOrEqual(event!.originalTokens)
    expect(event!.timestamp).toBeGreaterThanOrEqual(before)
    expect(emitted).toHaveLength(1)
  })

  it('ignores empty and single-char input', () => {
    expect(svc.record('s1', '', 'typed')).toBeNull()
    expect(svc.record('s1', '   ', 'typed')).toBeNull()
    expect(svc.record('s1', 'y', 'typed')).toBeNull()
    expect(emitted).toHaveLength(0)
  })

  it('ignores SGR mouse-report noise from agent TUIs', () => {
    const mouseBlob = '[<35;33;17M[<35;34;17M[<65;46;24M[<0;20;35m'.repeat(20)
    expect(svc.record('s1', `\x1b[${mouseBlob}`, 'typed')).toBeNull()
    expect(svc.record('s1', mouseBlob, 'typed')).toBeNull()
    expect(emitted).toHaveLength(0)
  })

  it('extracts the real prompt from mouse noise interleaved with typing', () => {
    svc.handleTerminalInput('s1', '\x1b[<35;33;17M\x1b[<35;34;17Mplease fix the login bug')
    const event = svc.handleTerminalInput('s1', '\r')
    expect(event).not.toBeNull()
    expect(event!.originalPrompt).toBe('please fix the login bug')
  })

  it('ignores lines without human text', () => {
    expect(svc.record('s1', '...', 'typed')).toBeNull()
    expect(svc.record('s1', '12345', 'typed')).toBeNull()
    expect(svc.record('s1', '\x1b', 'typed')).toBeNull()
    expect(emitted).toHaveLength(0)
  })

  it('buffers keystrokes until Enter, then records the full line', () => {
    expect(svc.handleTerminalInput('s1', 'hello ')).toBeNull()
    expect(svc.handleTerminalInput('s1', 'world')).toBeNull()
    expect(emitted).toHaveLength(0)
    const event = svc.handleTerminalInput('s1', '\r')
    expect(event).not.toBeNull()
    expect(event!.originalPrompt).toBe('hello world')
  })

  it('strips arrow-key escape sequences from submitted lines', () => {
    svc.handleTerminalInput('s1', 'hi\x1b[A\x1b[B')
    const event = svc.handleTerminalInput('s1', '\r')
    expect(event).not.toBeNull()
    expect(event!.originalPrompt).toBe('hi')
  })

  it('keeps per-session history and returns all oldest-first', () => {
    svc.record('s1', 'first prompt for session one here', 'typed')
    svc.record('s2', 'a completely different prompt for session two', 'agent-start')
    svc.record('s1', 'second prompt for session one today', 'typed')
    expect(svc.getHistory('s1')).toHaveLength(2)
    expect(svc.getHistory('s2')).toHaveLength(1)
    const all = svc.getAllHistory()
    expect(all).toHaveLength(3)
    for (let i = 1; i < all.length; i++) {
      expect(all[i].timestamp).toBeGreaterThanOrEqual(all[i - 1].timestamp)
    }
  })

  it('persists across instances via dataDir and keeps history on cleanup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-prompt-history-'))
    const a = new PromptHistoryService(dir)
    a.record('s9', WORDY_PROMPT, 'agent-start')
    const b = new PromptHistoryService(dir)
    const hist = b.getHistory('s9')
    expect(hist).toHaveLength(1)
    expect(hist[0].originalPrompt).toBe(WORDY_PROMPT)
    expect(hist[0].source).toBe('agent-start')
    b.cleanup('s9')
    expect(b.getHistory('s9')).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('applies per-session compression modes independently', () => {
    svc.setSessionCompressionMode('s-lite', 'lite')
    svc.setSessionCompressionMode('s-extreme', 'extreme')
    expect(svc.getSessionCompressionMode('s-lite')).toBe('lite')
    expect(svc.getSessionCompressionMode('s-extreme')).toBe('extreme')
    // Sessions without an override fall back to the lite default.
    expect(svc.getSessionCompressionMode('s-other')).toBe('lite')
    const lite = svc.record('s-lite', WORDY_PROMPT, 'typed')
    const extreme = svc.record('s-extreme', WORDY_PROMPT, 'typed')
    expect(lite).not.toBeNull()
    expect(extreme).not.toBeNull()
    // Lite keeps at least as many tokens as extreme for the same prompt.
    expect(lite!.compressedTokens).toBeGreaterThanOrEqual(extreme!.compressedTokens)
    // Invalid modes are ignored.
    svc.setSessionCompressionMode('s-lite', 'bogus' as any)
    expect(svc.getSessionCompressionMode('s-lite')).toBe('lite')
  })

  it('purges mouse-noise events saved before filtering existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-prompt-purge-'))
    const junk = {
      sessionId: 's1', source: 'typed',
      originalPrompt: '[<35;33;17M[<35;34;17M'.repeat(50),
      compressedPrompt: '35 33', originalTokens: 100, compressedTokens: 10,
      reduction: 90, timestamp: Date.now(),
    }
    const good = {
      sessionId: 's1', source: 'typed',
      originalPrompt: 'please fix the login bug',
      compressedPrompt: 'fix login bug', originalTokens: 10, compressedTokens: 6,
      reduction: 40, timestamp: Date.now(),
    }
    fs.writeFileSync(path.join(dir, 'prompt-history.json'), JSON.stringify([junk, good]), 'utf-8')
    const svc2 = new PromptHistoryService(dir)
    const hist = svc2.getHistory('s1')
    expect(hist).toHaveLength(1)
    expect(hist[0].originalPrompt).toBe('please fix the login bug')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
