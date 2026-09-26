import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  AgentStatusService,
  parseAgentHookPayload,
  extractAssistantTextFromLine,
  readLastAssistantFromTranscript,
  summarizeToolInput,
  getStatusPreview,
  isMislabeledUserPrompt,
} from '../agentStatus'

describe('parseAgentHookPayload', () => {
  it('rejects payloads with no agntspce session id', () => {
    // A hook launched outside the app, or before AGNTSPCE_SESSION_ID existed.
    expect(parseAgentHookPayload({ hook_event_name: 'Stop' })).toBeNull()
  })

  it('rejects events we do not model', () => {
    expect(parseAgentHookPayload({ sessionId: 's1', hook_event_name: 'PreCompact' })).toBeNull()
  })

  it('rejects non-objects and junk', () => {
    expect(parseAgentHookPayload(null)).toBeNull()
    expect(parseAgentHookPayload('nope')).toBeNull()
    expect(parseAgentHookPayload(undefined)).toBeNull()
  })

  it('accepts the snake_case wire shape Claude Code actually sends', () => {
    const parsed = parseAgentHookPayload({
      session_id: 'claude-native-id',
      sessionId: 'agntspce-s1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/a/b.ts' },
      transcript_path: '/tmp/t.jsonl',
    })
    expect(parsed).toEqual({
      sessionId: 'agntspce-s1',
      hookEventName: 'PreToolUse',
      transcriptPath: '/tmp/t.jsonl',
      prompt: undefined,
      toolName: 'Read',
      toolInput: { file_path: '/a/b.ts' },
    })
  })
})

describe('extractAssistantTextFromLine', () => {
  it('reads the shape Claude Code writes', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
    })
    expect(extractAssistantTextFromLine(line)).toBe('Hello there')
  })

  it('reads the assistant.message envelope shape', () => {
    const line = JSON.stringify({
      type: 'assistant.message',
      data: { content: [{ type: 'text', text: 'Enveloped reply' }] },
    })
    expect(extractAssistantTextFromLine(line)).toBe('Enveloped reply')
  })

  it('accepts a plain string content', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Plain' } })
    expect(extractAssistantTextFromLine(line)).toBe('Plain')
  })

  it('returns nothing for user turns', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })
    expect(extractAssistantTextFromLine(line)).toBeUndefined()
  })

  it('returns nothing for a tool_use-only assistant turn (no prose)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    })
    expect(extractAssistantTextFromLine(line)).toBeUndefined()
  })

  it('returns nothing for unparseable lines', () => {
    expect(extractAssistantTextFromLine('{not json')).toBeUndefined()
    expect(extractAssistantTextFromLine('')).toBeUndefined()
  })
})

describe('readLastAssistantFromTranscript', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-status-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function write(name: string, lines: string[]): string {
    const p = path.join(dir, name)
    fs.writeFileSync(p, lines.join('\n') + '\n')
    return p
  }

  it('returns the MOST RECENT assistant text, not the first', () => {
    const p = write('a.jsonl', [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'first answer' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'follow up' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'second answer' } }),
    ])
    expect(readLastAssistantFromTranscript(p)).toBe('second answer')
  })

  it('skips a trailing assistant turn that carries only a tool call', () => {
    const p = write('b.jsonl', [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'the real answer' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } }),
    ])
    expect(readLastAssistantFromTranscript(p)).toBe('the real answer')
  })

  it('returns undefined for a missing, empty, or absent path', () => {
    expect(readLastAssistantFromTranscript(path.join(dir, 'nope.jsonl'))).toBeUndefined()
    expect(readLastAssistantFromTranscript(undefined)).toBeUndefined()
    fs.writeFileSync(path.join(dir, 'empty.jsonl'), '')
    expect(readLastAssistantFromTranscript(path.join(dir, 'empty.jsonl'))).toBeUndefined()
  })

  it('reads a bounded tail and still finds the answer in a large file', () => {
    // 300KB of noise ahead of the answer, so the answer sits past the 256KB
    // scan window and can only be found by walking the tail.
    const filler = Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `filler ${i} ` + 'x'.repeat(80) } }),
    )
    const p = write('big.jsonl', [
      ...filler,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'THE ANSWER' } }),
    ])
    expect(readLastAssistantFromTranscript(p)).toBe('THE ANSWER')
  })
})

describe('summarizeToolInput', () => {
  it('picks the field that identifies the call', () => {
    expect(summarizeToolInput({ file_path: '/a/b.ts', limit: 10 })).toBe('/a/b.ts')
    expect(summarizeToolInput({ command: 'git status' })).toBe('git status')
    expect(summarizeToolInput({ pattern: 'TODO' })).toBe('TODO')
  })

  it('falls back through string, empty, and unknown shapes', () => {
    expect(summarizeToolInput('raw string')).toBe('raw string')
    expect(summarizeToolInput(undefined)).toBe('')
    expect(summarizeToolInput({ nothingUseful: 1 })).toBe('')
  })
})

describe('preview selection (Orca parity)', () => {
  const base = {
    sessionId: 's1',
    prompt: 'do the thing',
    toolInput: '',
    updatedAt: 0,
  }

  it('shows the tool step while working', () => {
    const preview = getStatusPreview({ ...base, state: 'working', toolName: 'Read', lastAssistantMessage: 'old answer' })
    expect(preview).toBe('Read')
  })

  it('shows tool name and input together when both exist', () => {
    const preview = getStatusPreview({
      ...base,
      state: 'working',
      toolName: 'Bash',
      toolInput: 'npm test',
      lastAssistantMessage: 'old answer',
    })
    expect(preview).toBe('Bash: npm test')
  })

  it('shows the last assistant message once done, never the tool step', () => {
    const preview = getStatusPreview({ ...base, state: 'done', toolName: 'Read', lastAssistantMessage: 'the answer' })
    expect(preview).toBe('the answer')
  })

  it('never shows thinking text (there is no field for it)', () => {
    const entry = { ...base, state: 'done' as const, lastAssistantMessage: 'final answer' }
    expect(getStatusPreview(entry)).toBe('final answer')
  })

  it('refuses to render an echoed user prompt as the answer', () => {
    const entry = { ...base, state: 'done' as const, lastAssistantMessage: 'do the thing' }
    expect(isMislabeledUserPrompt('do the thing', 'do the thing')).toBe(true)
    expect(getStatusPreview(entry)).toBe('')
  })
})

describe('AgentStatusService state machine', () => {
  let svc: AgentStatusService

  beforeEach(() => {
    svc = new AgentStatusService()
  })

  it('rejects events with no session id', async () => {
    expect(await svc.ingestHook({ hook_event_name: 'Stop' })).toBeNull()
  })

  it('runs the full lifecycle and lands on the assistant text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-svc-'))
    const transcript = path.join(dir, 't.jsonl')

    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'add a test' })
    expect(svc.getEntry('s1')?.state).toBe('working')

    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/a.test.ts' } })
    expect(svc.getPreview('s1')).toBe('Write: /a.test.ts')

    // Tool finished: the row must fall back, not keep showing a completed call.
    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'PostToolUse', tool_name: 'Write' })
    expect(svc.getEntry('s1')?.toolName).toBe('')

    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Added the test.' }] },
    }) + '\n')
    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'Stop', transcript_path: transcript })

    const entry = svc.getEntry('s1')
    expect(entry?.state).toBe('done')
    expect(entry?.lastAssistantMessage).toBe('Added the test.')
    expect(svc.getPreview('s1')).toBe('Added the test.')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('clears a stale tool step when a new prompt starts a new run', async () => {
    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/old' } })
    expect(svc.getEntry('s1')?.toolName).toBe('Read')

    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'new question' })
    const entry = svc.getEntry('s1')
    expect(entry?.toolName).toBe('')
    expect(entry?.toolInput).toBe('')
    expect(entry?.prompt).toBe('new question')
  })

  it('keeps the previous answer when the transcript is not readable yet', async () => {
    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'Stop', transcript_path: '/definitely/not/here.jsonl' })
    // Stop still lands the run as done — it just can't invent an answer.
    expect(svc.getEntry('s1')?.state).toBe('done')
    expect(svc.getEntry('s1')?.lastAssistantMessage).toBe('')
  })

  it('flags permission and clears everything on session end', async () => {
    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    await svc.ingestHook({ sessionId: 's1', hook_event_name: 'Notification' })
    expect(svc.getEntry('s1')?.state).toBe('permission')

    expect(await svc.ingestHook({ sessionId: 's1', hook_event_name: 'SessionEnd' })).toBeNull()
    expect(svc.getEntry('s1')).toBeUndefined()
  })

  it('keeps sessions isolated from each other', async () => {
    await svc.ingestHook({ sessionId: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'qa' })
    await svc.ingestHook({ sessionId: 'b', hook_event_name: 'UserPromptSubmit', prompt: 'qb' })
    expect(svc.getEntry('a')?.prompt).toBe('qa')
    expect(svc.getEntry('b')?.prompt).toBe('qb')
  })
})
