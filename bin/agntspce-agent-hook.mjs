#!/usr/bin/env node
/**
 * Agent lifecycle hook → agntspce main process.
 *
 * Registered into `claude` via a per-invocation `--settings` file written by
 * bin/claude, so the user's own ~/.claude/settings.json is never modified.
 * One command serves every event: the event name arrives inside the JSON the
 * agent writes to stdin.
 *
 * This is a TRANSPORT ONLY. The assistant's reply text is deliberately NOT
 * extracted here — that parsing lives in electron/services/agentStatus.ts
 * where it can be unit-tested. We only forward the event and the transcript
 * path the agent gives us.
 *
 * CRITICAL: hooks run inside the agent's turn. This script must be fast and must
 * never fail the turn — every error path exits 0.
 */
import http from 'http'
import { URL } from 'url'

const TIMEOUT_MS = 2000
// Cap the payload: a huge tool_input (e.g. a pasted file) would be pointless on
// the row and slow to ship. The server re-reads whatever it actually needs.
const MAX_BODY_BYTES = 256 * 1024

const sessionId = process.env.AGNTSPCE_SESSION_ID || ''
const hookUrl = process.env.AGNTSPCE_HOOK_URL || ''

if (!sessionId || !hookUrl) process.exit(0)

function readStdin() {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    process.stdin.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        process.stdin.destroy()
        resolve(Buffer.concat(chunks).toString('utf8'))
        return
      }
      chunks.push(c)
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function post(body) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(hookUrl)
    } catch {
      resolve()
      return
    }
    const payload = Buffer.from(body)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      },
      (res) => {
        // Drain so the socket can close cleanly.
        res.resume()
        res.on('end', () => resolve())
        res.on('error', () => resolve())
      },
    )
    req.on('timeout', () => { req.destroy(); resolve() })
    req.on('error', () => resolve())
    req.end(payload)
  })
}

const text = await readStdin()

let parsed
try {
  parsed = JSON.parse(text)
} catch {
  process.exit(0)
}
if (typeof parsed !== 'object' || parsed === null) process.exit(0)

// Our own session id is authoritative: the agent's `session_id` is Claude's id,
// not ours, and the server keys on ours.
const body = JSON.stringify({ ...parsed, sessionId })
await post(body)
process.exit(0)
