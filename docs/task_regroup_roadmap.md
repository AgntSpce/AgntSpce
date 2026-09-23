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
