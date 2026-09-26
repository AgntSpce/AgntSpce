# Task merge — reliability + "Merge changes" button

Status: **backend + UI done, uncommitted.** Verification green (see bottom).

## Context

Our merge model is **local-only** and stays that way: each task is one git worktree +
branch, and merges land on the synthetic `agntspce-integration` branch via
`git merge --no-commit --no-ff` in a throwaway scratch worktree, a build+test gate,
then an atomic `git update-ref` CAS promotion. No remote, no PR — deliberately.

This is a different (and for autonomous agents, better) model than Orca's PR-first
flow. Orca refuses to merge locally at all and delegates integration to the forge.
We keep ours and fix the holes.

## Problems found while reading the code

| # | Problem | Where |
|---|---|---|
| 1 | Merge candidate lives in an in-memory `Map`, but `buildMerger` builds a **new** `TaskMerger` per socket event → `confirm-task-merge` always starts empty and returns "No pending merge candidate". The LLM-resolved path is a dead end and leaks a scratch worktree. | `taskMerger.ts:42`, `tasks.ts:245` |
| 2 | LLM path commits with `git commit` on a tree where **no merge was ever performed** → single-parent commit → `git merge-base --is-ancestor` fails in `deleteTaskBranchIfMerged` → **task branch leaks forever**. Also makes the `diff --diff-filter=U` re-check a no-op. | `taskMerger.ts:151`, `255`, `worktreeLifecycle.ts:373` |
| 3 | `previewMerge` + `executeMerge` each create a scratch worktree and merge → every attempt merges **twice**, with a moving base between them. | `taskMerger.ts:92-100`, `:134,163` |
| 4 | `mergeLock` is a per-instance boolean, so it never fires on the socket path → users get raw `cannot lock ref` from git instead of a friendly message. | `taskMerger.ts:41`, `:112` |
| 5 | No-change shortcut is **dead code** (`diffSummary` is always truthy — it's `'(no changes)'`), so a no-op merge instead fails at `git commit` with "nothing to commit". | `taskMerger.ts:101`, `:128-131`, `:170` |
| 6 | `merge-all-tasks` uses client-supplied order, never stops on failure, has no rollback, and acks `{ ok: true }` even when every merge failed. | `tasks.ts:324-339` |
| 7 | v2 dropped the legacy `MergeGate` cross-task file-overlap gate, so nothing warns that two parallel tasks are about to touch the same files. | `mergeGate.ts:113-144` (not ported) |
| 8 | `previewTaskMerge` is fully implemented and fully tested but **called by no UI**. | `useSocket.ts:750` |
| 9 | `agntspce-integration` is a dead end — nothing syncs it back to the user's branch (`configureIntegrationBranch` has no callers). | `stateManager.ts:385` |

## Plan

### Backend

- [x] **P1 — Persist the merge candidate.** New nullable columns on `task_groups`:
      `merge_candidate_ref` (branch holding the candidate commit) and
      `merge_candidate_base` (the integration tip it was built on). Drop the
      in-memory `Map`; `confirmMerge` reads the DB so it works across socket
      events. Scratch worktree path is re-derived from the candidate branch via
      `git worktree list --porcelain`.
- [x] **P2 — Real 2-parent commit for AI-resolved merges.** After the AI patch is
      applied and staged: `git write-tree` → `git commit-tree <tree> -p <integrationRef>
      -p <taskBranchHead>` → point the scratch branch at it. Fixes the branch leak
      and makes the "conflicts remain" check meaningful.
- [x] **P3 — One scratch worktree per attempt.** Extract a `collect()` helper that
      computes diffstat/files/conflicts and leaves a clean merge staged; `previewMerge`
      aborts it, `executeMerge` continues from it. Removes the double merge.
- [x] **P4 — Real per-repo lock** (module-level, keyed by repoPath) so concurrent
      merges get "A merge is already in progress" instead of a git ref error.
- [x] **P5 — Fix the no-change path**: drop the dead condition and detect a
      no-op merge via `MERGE_HEAD` so it finishes as `done` instead of erroring.
- [x] **P6 — Cross-task scope-overlap warning** in the preview: intersect this
      task's `scope_files` with other unfinished tasks'. Advisory only — it warns
      before anything mutates.
- [x] **P7 — Honest merge-all**: deterministic order (oldest first), stop at the
      first failure, mark the rest skipped, ack `ok:false` if anything failed.

### Frontend

- [x] **P8 — "Merge changes" on the task**: a button on the task row plus a
      right-click menu entry, opening a merge dialog.
- [x] **P9 — `TaskMergeDialog`**: runs the preview first (files changed, conflict
      list, scope-overlap warning), then merges on confirm, then shows the
      AI-resolution review step for `needsConfirm` results. Closes the loop on
      `previewTaskMerge` being unused.
- [x] **P10 — "Merge all changes"** in the Tasks section header.

### Bugs found after first ship (fixed)

1. **Scaffolding blocked every merge.** The dirty-worktree gate counted
   `COLLAB.md` / `.task.json` / `AGENTS-TASK.md` as uncommitted work, but
   AgntSpce writes all three into every task worktree at launch — so no freshly
   launched task could merge, and "Merge all" stopped on the first one. Fixed
   with `TASK_SCAFFOLD_FILES` + `isTaskScaffoldStatusLine()` in
   `worktreeLifecycle.ts`; the gate now ignores only those, and still refuses on
   real edits. Covered by two tests.
2. **Task creation in a non-git folder was noisy and confusing.** A plain folder
   has no integration branch, so `getIntegrationBranchSha()` returned `''` (it
   *returns* empty rather than throwing, so the caller's `try/catch` did
   nothing), which reached `git rev-parse ''` and produced the meaningless
   `git rev-parse  failed: empty revision argument`. Four `fatal: not a git
   repository` lines leaked to the terminal because `StateManager`'s git calls
   didn't pipe stderr. Fixed by:
   - `WorktreeLifecycle.isGitRepository()` — a quiet capability probe; both
     creation paths (`create-task-group`, `group-sessions`) now skip git entirely
     for a non-repo folder and log one explanatory line,
   - a private `StateManager.gitOut()` that pipes stderr for every git call,
   - `initIntegrationBranch()` no longer *caches* a branch git never created —
     previously it persisted `agntspce-integration` into `workspace_config` even
     on failure, so a folder that was `git init`-ed later kept failing against a
     stale row.
3. **Merge was offered for tasks that can never merge.** A plain-dir task has
   `baseSha = null` and no branch, but it does get a `branchName` string, so the
   new "Merge changes" button and `TaskChat`'s "Merge task" both appeared and
   then failed with raw git errors. Both now require `baseSha`, and `TaskChat`
   says why.
4. **Merge dialog hung on "Checking what would land…".** `TaskMergeDialog` used
   a `useRef` "am I mounted" guard. Under `StrictMode` (`src/main.tsx` enables
   it) React runs effect → cleanup → effect, so the cleanup latched the flag
   `false` for the life of the instance and every response was dropped —
   `setStage` never ran, so the dialog sat there forever with no error. Fixed by
   scoping cancellation to the effect run (`let cancelled` + cleanup) instead of
   the instance. Also made a preview cancellable (only an in-flight merge locks
   the dialog), so a slow preview can never trap the user.

## Follow-ups found while shipping (not done)

1. **Scaffolding is untracked, not excluded.** `COLLAB.md` / `.task.json` /
   `AGENTS-TASK.md` are regenerated on every collab event. The merge gate now
   ignores them, but if an agent runs `git add -A` in its task worktree they get
   committed into the task branch, and every later rewrite becomes a dirty
   tracked file (blocking merges, and able to conflict). Proper fix: add the
   three names to the worktree's exclude file so `git status` and `git add -A`
   skip them. Left alone to keep this change set tight.
2. **Integration branch is still a dead end** — nothing syncs
   `agntspce-integration` back to the user's branch. Needs a decision: an
   explicit "Sync to \<branch\>" action, or leave it manual.
3. **`StrictMode` double-invokes the preview effect**, so opening the dialog
   runs the trial merge twice (~1s of git work each, on the main thread). Harmless
   but wasteful; a ref-guard would fix it at the cost of the bug in #2 above, so
   it needs a request-id guard rather than a mounted flag.
4. **No DOM test setup.** `vitest.config.ts` is node-only and includes just
   `electron/**/*.test.ts`, so the dialog has no automated coverage — bug #2 above
   shipped green. A `jsdom` + testing-library setup would close that gap.

## Verification

- [x] `npx tsc -b --force` — clean
- [x] `npm run lint` — exit 0, no new warnings
- [x] `npm run build` — clean
- [x] `npm run test:node` — 18 files / 216 tests green (was 182; +6 new merge
      tests here, +28 from the agent-status work in flight alongside)

### New tests (`electron/services/__tests__/taskMerger.test.ts`)

- candidate survives into a **fresh** `TaskMerger` (the real socket shape) and is
  discoverable via `previewMerge().pendingCandidate`
- AI-resolved merge lands as a **two-parent** commit and the task branch is
  reclaimed (the leak fix)
- scope-overlap warning fires, and stops firing once the other task is done
- a task with nothing to merge finishes as `done` instead of erroring
- a second merge is refused while one is mid AI-resolution

## Deliberately NOT doing

- **No remote / no PR / no push.** Local-merge-first stays.
- **No automatic sync of `agntspce-integration` back to the user's branch** (P9
  deferred / needs a decision). Landing work on the integration branch is safe;
  moving it onto a branch the user is standing on is not something to do silently.
- **No automatic conflict resolution without the human confirm step.** The AI may
  propose a resolution; a person still lands it.
- **No `rerere`, no `-X ours/theirs`, no `merge-tree` plumbing, no rebase.**

## Files in scope

Backend: `schema.ts`, `stateManager.ts`, `taskMerger.ts`, `server/handlers/tasks.ts`
Frontend: `hooks/useSocket.ts`, `components/TaskMergeDialog.tsx` (new),
`components/WorkspaceSidebar.tsx`, `App.tsx`, `App.css`

Note: `stateManager.ts`, `useSocket.ts`, `WorkspaceSidebar.tsx` and `App.tsx` also
carry another agent's uncommitted work. Edits there are additive and surgical.
