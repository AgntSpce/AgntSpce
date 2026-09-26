# Agent Row Status — roadmap & working log

Replaces the terminal-scraped "answer" line under each agent row in the left
sidebar's **Tasks** section with real structured agent data.

**Status:** in progress. Started 2026-09-26.

---

## 1. The original problem

The task agent rows show a two-line layout:

- **line 1** — the last prompt the user submitted (the "question")
- **line 2** — meant to be the agent's live output while it works, and the
  agent's last generated text once it is done

Two bugs were reported:

1. **Scrolling back through old messages in the terminal hijacks line 2.**
   The row starts showing text from earlier in the conversation.
2. **Line 2 shows arbitrary text off the agent's screen** (TUI chrome, tool
   noise, half-drawn frames) rather than the agent's actual output.

---

## 2. What the references actually do

Both reference apps were read in full before starting
(`/Users/prashik/Aniket/CodingAgents/references/orca-main` and
`.../superset-main`). **Neither one scrapes terminal bytes for this**, which is
why neither has these bugs.

### Orca — shows the output text, from hooks + transcript

`orca-main/src/renderer/src/lib/activity-thread-display.ts:155`

```ts
if (state === 'working') {
  // shows the TOOL STEP, not thinking, not prose
  if (toolName && toolInput) return `${toolName}: ${toolInput}`
  if (toolName) return toolName
}
const assistant = entry.lastAssistantMessage?.trim() ?? ''
if (assistant && !isMislabeledUserPrompt(assistant, entry)) return assistant
return ''
```

| State     | Row line 2 shows              |
| --------- | ----------------------------- |
| working   | the current tool call         |
| done      | the assistant's reply text    |
| thinking  | never shown                   |

The data is **structured**, from two sources:

- **Hook lifecycle events** — `orca-main/src/shared/agent-hook-listener.ts`
  (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, …).
- **A JSONL transcript tail scan** for the assistant's text —
  `agent-hook-listener.ts:887` `extractAssistantTextFromLine`, read via
  `readLastAssistantFromTranscript` (`:1332`).

Two guards worth keeping:

- `isMislabeledUserPrompt` (`:138`) — some hooks echo the live user prompt into
  the assistant field; never render that as the agent's reply.
- `resolveActivityThreadStatusPreview` (`:184`) — only bridge a prior preview
  across a *terse follow-up* turn; a substantive new prompt clears stale text.

### Superset — sidebar shows no text at all

- For its own agents it has structured message parts and branches on type:
  `part.type === 'thinking'` vs `'text'`
  (`AssistantMessage.tsx:154`) — but these render in the **chat pane**, not a row.
- For **CLI agents in a terminal, the Superset sidebar row shows no text** —
  only a status dot: `PaneStatus = 'idle' | 'working' | 'permission' | 'review'`
  (`deriveTerminalAgentStatus.ts`).

Superset's own conclusion, stated in `AGENTS_HANDOFF.md` and confirmed by a dead
code path: **"parse the rendered grid, not the byte stream."** They tried
(`commandBuffer.ts` reads xterm's buffer) and backed off in favour of hooks.

### Conclusion

The portable, correct design is the **state machine**, not the parser:

- a **live "in-flight" channel** shown only while the agent is working
- a **frozen "last assistant text"** shown once it is done
- fed by **structured agent data**, so a terminal repaint or scroll cannot
  possibly change what the row shows

---

## 3. Attempt 1 — improved terminal streaming (KEPT as fallback, did not fully work)

Shipped in `src/components/WorkspaceSidebar.tsx` and still in the tree:

- `extractWrittenLines` splits each PTY chunk on cursor-return/erase verbs
  (`A E F G H J K s u`) as well as newlines, so a TUI repaint yields segments
  that are already in the `seen` set and is correctly ignored.
- Two channels per session: `runLine` (live, reset per run) and `lastLine`
  (frozen at run end); the row shows `runLine` only while `isWorking`.
- `isEchoOfPrompt` and `isAgentChromeLine` filters.

**Why it did not fully work:** it is still fundamentally a screen scrape. Orca's
own notes on scraping warn it "survives Ctrl+C far better" via hooks, and our
verification run showed the row still picking up non-answer text. This path is
now the **fallback** for agents that have no structured instrumentation.

---

## 4. Plan

Scope agreed: **Claude Code first**, then decide on the others.

| # | Step | State |
| - | ---- | ----- |
| 1 | Roadmap/log doc (this file) | done |
| 2 | `AGNTSPCE_SESSION_ID` in the agent launch env so hooks can self-attribute | done |
| 3 | `electron/services/agentStatus.ts` — hook ingest + transcript tail scan | done |
| 4 | `POST /api/agent-status` endpoint + socket fan-out | done |
| 5 | `bin/claude` injects `--settings` with a hooks block; no mutation of the user's `~/.claude/settings.json` | done |
| 6 | Renderer consumes `agent-status`; rows prefer it over the streaming fallback | done |
| 7 | Unit tests for transcript extraction + hook payload parsing | done (27 passing) |

**Next: verify the row in the running app** (a real Claude run end to end), then
decide on step 8.

### Later agents (not started)

Each needs its own adapter; none share Claude Code's event system.

- **Codex** — has a `notify` hook, different payload.
- **OpenCode / Gemini** — different plugin/extension models, more work each.

---

## 5. Design notes for whoever picks this up

### Injection points already confirmed in this repo

- `claude --settings <file-or-json>` and hooks are supported
  (verified via `claude --help`; also `--include-hook-events`).
- `bin/claude` (`bin/claude:50`) already `exec`s the real binary with `"$@"` —
  the clean place to inject `--settings`. **Never mutate the user's global
  `~/.claude/settings.json`**; a per-invocation `--settings` is cleaner than
  what Orca does.
- `electron/services/sessionManager.ts:1912` builds the `envPrefix` that is
  written into the PTY before the agent launches. Anything exported there is
  inherited by the agent CLI and every hook subprocess. This is how a hook
  learns which agntspce session it belongs to.
- The Express + Socket.IO server already runs on port **9460**, so a hook
  script can just POST to it.
- `sessionManager.ts:1566-1627` already resolves the Claude project dir and
  discovers `.jsonl` transcripts — useful for the tail scan.

### Gotcha already hit

The hook payload's `transcript_path` is the cheapest source of the transcript
path — prefer it over rediscovering the project dir. Do the assistant-text
extraction in the **main process** (TypeScript, unit-testable), not in the hook
script, so the hook stays a thin transport.

### The core invariant

> No terminal byte may ever reach the row's status line.

That is what makes this correct rather than merely heuristic. Any future change
that reintroduces stream-scraped text into line 2 regresses the whole point.

---

## 6. Working log

- **2026-09-26** — Investigated orca-main and superset-main in full. Established
  that both use structured agent data (hooks / message parts), not terminal
  bytes, and that Orca shows the assistant's reply text on the row while
  Superset's terminal sidebar shows only a status dot.
- **2026-09-26** — Attempt 1 (streaming + two-channel state machine) shipped to
  `WorkspaceSidebar.tsx`; verified end-to-end by the user and found still
  showing non-answer text. Retained as the fallback path.
- **2026-09-26** — Agreed to build the Orca approach for Claude Code first.
  Wrote this roadmap. Implementation steps 2-7 pending.
- **2026-09-26** — Steps 2-7 implemented.
  - `sessionManager.ts` exports `AGNTSPCE_SESSION_ID` + `AGNTSPCE_HOOK_URL` in
    the same `envPrefix` the agent already inherits.
  - `bin/agntspce-agent-hook.mjs` — transport-only hook: reads stdin, stamps our
    session id, POSTs, always exits 0 (a hook must never fail the agent's turn).
  - `bin/claude` generates `${TMPDIR}/agntspce-claude-hooks.json` and injects
    `--settings`. Verified: injects, does not stack when the user passes their
    own `--settings`, and does nothing outside the app (no `AGNTSPCE_SESSION_ID`).
  - `electron/services/agentStatus.ts` — state machine + Orca's transcript tail
    scan. Working → tool call; done → last assistant text. Never thinking text.
  - `POST /api/agent-status` → `agent-status` socket event. Registered once at
    server construction, **not** in `registerAllHandlers` (that runs per socket
    connection and would stack a duplicate route).
  - Renderer: `useAgentHookStatus` in the panel; rows prefer hook data and fall
    back to the terminal feed for agents we can't instrument yet.
  - `package.json` extraResources now ships the hook script — in a packaged app
    `bin/` is inside `app.asar`, where `SCRIPT_DIR` can't be `cd`'d into, so the
    wrapper also looks next to the `agntspce` binary.

**Verification:** `tsc -b` clean; 27 new tests pass. 7 pre-existing test files
fail on a `better-sqlite3` native-module ABI mismatch in this environment —
confirmed pre-existing by re-running with the changes stashed.

**Not yet verified:** the row in a running app. That needs a real Claude run.

- **2026-09-26** — **Design change: the row no longer renders agent text at
  all.** Verified in the running app that the hook path still surfaced text that
  wasn't the agent's answer, and that scrolling still leaked old text. Rather
  than keep chasing which text is "the" answer, the row's second line is now a
  **state word**:

  | state | row line 2 |
  | ----- | ---------- |
  | working | `Thinking…` |
  | permission | `Waiting for input…` |
  | done | `Done` |
  | idle, no run | *(empty → "No output yet")* |

  This makes the whole class of bug unreachable: a state word cannot be a
  half-drawn frame, TUI chrome, or text from earlier in the conversation, and it
  cannot be hijacked by scrolling. The row's job is "is this agent busy, and
  did it finish?" — that is what it now answers.

  Implemented in `agentStatusWord` (WorkspaceSidebar.tsx). Hook state still wins
  where present; agents without hooks fall back to the stream-derived
  working/completed/permission flags that already drive the spinner and check
  mark. The hook pipeline and the streaming buffer are both retained — they now
  supply *state*, not text.

### Design decisions worth remembering

- **The hook does no parsing.** It only forwards the event and `transcript_path`;
  the assistant-text extraction lives in TypeScript where it's unit-tested. A
  hook that parses is a hook that can be slow, and hooks are on the agent's
  critical path.
- **The hook answers 202 for rejected payloads.** An untracked session or an
  unmodelled event is normal, not an error, and must never block the agent.
- **`--settings`, not `~/.claude/settings.json`.** Per-invocation injection means
  nothing leaks into the user's global config, and uninstalling removes it.
