# Task Regroup Roadmap (Orca-style)

Workspace owns agents; a task is a named group of agent sessions sharing one
worktree. Between-task orchestration (groups, branches, merge gate, TaskChat)
is untouched. Assignment auto-plan/auto-spawn stays parked (see
`docs/assignment_agent_logic.md`).

## Steps

### Step 1 — CLI flags for live sessions (done when: `bin/agntspce-collab.mjs` accepts `--task/--subtask`)
Grouped sessions were spawned before any task existed, so they lack
`AGNTSPCE_TASK_ID/SUBTASK_ID` env. The CLI must accept explicit flags as
fallback. Env still wins when present.

### Step 2 — Group backend (done when: group/join/ungroup socket events work)
- `group-sessions {sessionIds, title?}` → TaskGroup (`active`) + one SubTask
  per session (status `running`, sessionId linked) + shared worktree/branch
  (created once, reused on re-group) + COLLAB.md seed + `.task.json` with
  advisory (possibly overlapping) scopes + shared-context preamble injected
  into each PTY.
- `join-group {taskGroupId, sessionId}` → subtask row, preamble injection.
- `ungroup-session {taskGroupId, sessionId}` → subtask parked
  (`pending`, sessionId cleared); group → `paused` when nothing running left.
- New `orchestration/groupSync.ts`: `buildGroupPreamble` (members, advisory
  scopes, conventions, open claims, CLI usage) + `injectGroupContext`
  (renders COLLAB.md, writes preamble via `writeToSession`).
- No overlap check for grouped agents (scopes advisory by design).

### Step 3 — Sidebar rows + drag (done when: rows render, drag-onto-row groups)
Compact rows under the workspace card: logo + agent name, click focuses the
pane. No prompts, no status dots. Drag row onto row → `group-sessions` with
both ids. Drop onto a task row → `join-group`. No other sidebar changes.

### Step 4 — App group view (done when: open group filters agents, add joins)
- `openGroupId` state: TerminalArea shows only the group's sessions; banner
  with group name + exit-to-all + close-group.
- `Add a Task` → `create-task-group` + set `openGroupId` (empty group, fresh
  agents page). New sessions created while a group is open auto-join it.
- Close group → existing `closeTask` kill graph (pause); abandon retires.

### Step 5 — Verify (done when: tsc + tests green, no commit)
Unit tests for preamble builder + group handler flow (fake spawner). Full
suite via `npm run test:node`. No commit.

## Completion log

Append one entry per finished step: date + what changed (files) +
verification + deviations.

## 2026-09-19 — Step 1: CLI flags
- `bin/agntspce-collab.mjs`: `--task/--subtask` flags parsed out of argv
  before the command; env still wins. Needed because drag-grouped sessions
  were spawned before any task existed and lack the env vars.
- Test: CLI `post` with empty env + flags succeeds and writes the event.
- Verification: covered in the Step 5 suite run below.

## 2026-09-19 — Step 2: group backend
- New `orchestration/groupSync.ts`: `buildGroupPreamble` (members, shared
  path/branch, conventions, per-member flag-form CLI lines, claim/post rules;
  deliberately no trailing newline so nothing auto-submits into a live TUI)
  + `injectGroupContext` (refreshes COLLAB.md, writes preamble to every
  running member PTY, returns injected count).
- `server/handlers/tasks.ts`: `group-sessions` (link sessions → active group
  + best-effort shared worktree + `.task.json` with advisory scopes + seed +
  preamble), `join-group` (idempotent link + re-inject), `ungroup-session`
  (park subtask, pause group when nothing running). No planner, no overlap
  check — scopes advisory by design.
- Verification: `groupSync.test.ts` (preamble content/ids, inject count,
  COLLAB.md refresh, no-trailing-newline).

## 2026-09-19 — Steps 3–4: sidebar rows + app group view
- `WorkspaceSidebar`: Agents section (logo + type, click focuses, HTML5 drag;
  drop row-on-row groups, drop on task row joins), `+` stays off the Tasks
  header. New props threaded through outer `Props`.
- `useSocket`: `groupSessions`/`joinGroup`/`ungroupSession`.
- `App.tsx`: `openGroupId` (per-window sessionStorage) filters TerminalArea;
  new sessions while open auto-join; task click opens chat + filter; group
  banner (name, count, All agents, Close group via existing kill graph);
  wizard launch also opens the group. `App.css`: banner + row styles.
- Verification: `tsc -b --force` exit 0; oxlint error-free; full suite via
  `npm run test:node`: 153/171 with only the 18 pre-existing
  `sessionManager` failures (identical on stashed HEAD).

## 2026-09-19 — Follow-up: no-PTY pollution, fast create, banner out, explorer tasks
- `groupSync.injectGroupContext` deleted as a PTY writer (kept as deprecated
  no-op for one turn, then call sites moved to `syncGroupFiles`, which writes
  only `COLLAB.md` + new `AGENTS-TASK.md` briefing). Agent transcripts stay
  clean; ids are discoverable from files.
- `create-task-group` and `group-sessions` ack immediately; worktree/meta/seed
  run in `setImmediate` after. `handleSelectAgent` spawns first, ensures the
  unnamed group in the background (restores old snappy agent startup).
- Top `group-banner` removed. Task rows toggle filter on click; `Details`,
  `Rename`, `Delete` live in the row ⋮ menu. Exit-to-all by re-clicking the
  open task. `closeTask`/`exitGroupView` remnants removed from App.
- Tasks render VS Code-explorer style: chevron expander, member rows (logo +
  name, click focuses pane), ⋮ menu per task. New backend: `rename-task-group`
  (`updateTaskGroup` gained title/userGoal), `delete-task-group`
  (`TaskOrchestrator.deleteTask`: close PTYs, merged-only worktree retire,
  drop rows), `get-group-members` via existing detail endpoint.
- Verification: `tsc` exit 0; oxlint error-free; full suite 158/176, only the
  18 pre-existing failures.

## 2026-09-19 — Follow-up: explorer-style tasks, visible ⋮, no outside agents
- Root causes found: (1) task-row ⋮ was `opacity: 0` with no `.task-row:hover`
  rule — rendered but invisible; added the hover rule. (2) Standalone Agents
  section removed — agents now live only under their tasks.
- Each task row: chevron + status dot, name on top, member logo strip
  underneath (from `members` now attached by `list-task-groups`, zero extra
  roundtrips), ⋮ menu (Details/Rename/Delete), click expands to named member
  rows (logo + name, click focuses pane).
- Member rows drag between tasks (ungroup from source + join target);
  ungrouped sessions get an `Ungrouped` fallback section (rendered only when
  non-empty) with drag-to-join. Drop row-on-row grouping UI removed with the
  old section; `group-sessions` endpoint stays for API use.
- Backend `updateTaskGroup` gained title/userGoal; new `deleteTaskGroup`
  (drops subtasks/events/groups); `TaskOrchestrator.deleteTask` closes member
  PTYs, retires the worktree merged-only, drops rows; `rename-task-group` /
  `delete-task-group` endpoints (+ client fns, App handlers, sidebar menu).
- Verification: `tsc` exit 0; oxlint error-free; full suite 158/176, only the
  18 pre-existing failures.

## 2026-09-19 — Follow-up: quick-create replaces wizard on Add a Task
- `Add a Task` no longer opens the multi-input wizard: it prompts for the
  title only (`showModal`), quick-creates an empty `planning` group, and
  opens its fresh agents page (filtered view, +Agent/shell empty state).
  Running sessions are untouched; agents added while open auto-join.
- Backend `create-task-group` accepts zero agents (subtasks join later).
- Sidebar: in-card `No tasks here` block removed; single `Add a Task` button
  sits directly under the Agents list; Tasks header+list render only when
  groups exist. Dead `onOpenCreateTaskModal` threading removed from the panel.
- Verification: `tsc` exit 0; full suite 153/171, only pre-existing failures.

## 2026-09-19 — Follow-up: quiet git, deterministic membership, header +
- Terminal spam fixed at the source: `execGit` in worktreeLifecycle/mergeGate/
  taskMerger pipes stderr (folded into thrown errors) and rejects empty
  revision args — the `fatal: ... use --force` and `fatal: Needed a single
  revision` lines came from best-effort probes inheriting the host terminal.
- Membership is now authoritative, never guessed: `create-agent-session`
  accepts `taskGroupId` and links via shared `linkSessionToGroup`
  (groupSync.ts; join-group reuses it). The client auto-join guesser and its
  seed refs are deleted — this was the "wrong agents on revisit" bug: stale
  snapshots mass-joined backlog sessions into whatever group was open.
- `refreshOpenGroup` drops ghost rows (sessionId with no live session).
- First +Agent with no open group reuses an empty `Untitled task` instead of
  piling up duplicates (the "tasks renamed to unnamed" sightings).
- Header `+` (Workspace, top-right) prompts for a task name and opens its
  fresh agents page — same flow as Add a Task.
- Verification: `tsc` exit 0; oxlint error-free; full suite 158/176, only the
  18 pre-existing failures.
