# Task collaboration and file visibility — roadmap

Status: fixes 1–4 implemented and uncommitted. Nothing here is pushed.

## What triggered this

A real run in a brand-new folder (`demotest2`), one task, one agent, goal
"create a simple html page". The agent's report:

```
∴ The collab CLI isn't on PATH, so I'll just create the file directly.
⏺ Write(index.html)  →  83 lines
- The agntspce-collab CLI isn't on PATH in this shell (command not found),
  so I couldn't claim — I created it directly.
```

And the user could not see the file in the workspace folder.

## Root causes (all verified on disk)

### 1. `agntspce-collab` does not exist as a command — BLOCKING

`bin/agntspce-collab.mjs` exists. Its own header says agents "invoke this as an
ordinary shell command (bin/ is on their PATH)". But no launcher was ever
created:

```
bin/agntspce-collab.mjs   8.9K
bin/agntspce-collab       (missing)
bin/agntspce-collab.cmd   (missing)
```

Every other tool has a launcher (`bin/agntspce`, `bin/claude`, `bin/codex`, …).
`bin/` *is* prepended to the agent PATH (`sessionManager.ts:688`), so PATH was
never the problem — the file simply is not there.

Our tests missed it because they invoke the `.mjs` by absolute path
(`collabShim.test.ts:76`, `taskE2e.test.ts:26`) instead of resolving the command
an agent would run.

Consequences, all silent:
- **No file claims** → two agents in one task edit the same file and clobber
  each other. This is the exact failure class the whole collab CLI exists to
  prevent.
- **No progress** → `COLLAB.md` never updates, so peers cannot see each other's
  work.
- **Subtasks never reach `done`** → tasks never look complete.

### 2. Task output is invisible in the workspace folder

The agent's cwd is the task worktree, so its files land there:

```
demotest2/.agntspce/tasks/<id>/index.html     1.7K
git status → ?? index.html
demotest2/  →  .agntspce/  .git/  .gitignore  .mcp.json
```

Worktree isolation is working **correctly** — that is the design. But the file
only reaches the folder via *commit → Merge changes → lands on
`demotest2_agntspce` → user merges that into `main`*, and the user has no reason
to know any of that. In a brand-new folder the worktree contains almost nothing
(the initial commit only had `.gitignore` and `.mcp.json`), so isolation buys
nothing and just hides the work.

### 3. The agent never committed

`?? index.html` — uncommitted. The merge correctly refuses uncommitted work, but
the refusal reads as "the app is broken" rather than "ask the agent to commit".
Nothing in the prompt tells the agent that committing is what makes its work
landable.

## Fixes, in priority order

### Fix 1 — make `agntspce-collab` resolvable (BLOCKING) — DONE

- Added `bin/agntspce-collab` (POSIX) and `bin/agntspce-collab.cmd` (Windows)
  following the existing `bin/agntspce` launcher pattern.
- The CLI needs `node:sqlite` (Node ≥ 22.5), so it prefers the **system** node
  the agent already runs under; `AGNTSPCE_NODE_PATH` (Electron's binary, with
  `ELECTRON_RUN_AS_NODE=1`) is only a fallback.
- Guards against resolving `node` from `bin/` itself, which is on PATH — a
  future `bin/node` wrapper would otherwise recurse.
- Added a test that resolves the command **through PATH**, which is what the old
  absolute-path tests could never catch. This was the actual reason the bug
  shipped: every existing test called the `.mjs` directly.

**Verified:** 4 new tests — launcher exists and is executable, progress posts
and regenerates `COLLAB.md`, claims serialise across invocations, `done` marks a
subtask complete. A shell-level check confirms the command resolves and runs.

### Fix 2 — require commits, and explain refusals — DONE

- The task prompt now has a `VERSION CONTROL (mandatory)` section: commit in
  worktree mode (uncommitted work cannot be merged and will not appear in the
  folder), commit anyway in shared-folder mode, never merge or `git checkout` —
  AgntSpce does that.
- The dirty-worktree refusal explains *why* ("there is nothing to merge yet"),
  separates new files from modified ones, and gives the exact command. It no
  longer blames AgntSpce's own scaffolding.
- Sync has its own framing, since "nothing to merge" is not the problem there —
  the risk is clobbering the agent's uncommitted work.

### Fix 3 — auto-select isolation: fresh repo first, worktrees after — DONE

- `inspectGitFolder` now reports `isFresh`: a repo whose tracked files are all
  dotfiles (exactly what our own init leaves behind) has nothing to protect.
- Mode selection: repo + commit + **not fresh** → worktree; otherwise run in the
  folder, so the first task's output is visible immediately.
- Re-probed at task-creation time, because a cached value would keep sending
  every later task to the shared folder — the first task's commit is exactly
  what makes the second worth isolating.
- The create-task dialog reports the mode the server actually chose, not the one
  it guessed.

### Fix 4 — make merged work land where the user is looking — DONE

- `applyIntegrationToBranch()` fast-forwards the user's checked-out branch onto
  the integration branch, offered as **"Apply to my branch"** right after a
  successful merge.
- Fast-forward only, and it refuses rather than improvising: dirty tree,
  detached HEAD, sitting on a `task/` branch, a branch that is not checked out,
  or a branch that has diverged. It never creates a merge commit in someone's
  checkout and never pushes.
- Verified end-to-end in tests: after merging a task, `main:README.md` does not
  contain the task's work until apply, and does afterwards.

## Follow-ups (not done)

- **Per-task mode override.** Fix 3 picks the mode automatically; letting the
  user force worktree isolation (or force shared-folder) on a single task is
  still open.
- **Merge button discoverability.** The row button is `opacity: 0` until hover,
  so the task list reads as having no affordance. The right-click menu works,
  but the button should probably be persistently visible.
- **Cross-task file claims are still advisory.** `scopeOverlapFiles` warns at
  merge time; there is no repo-wide claim that stops two *different* tasks
  editing the same file while both are running.

## Explicitly not doing

- No auto-push, no PRs, no remote writes.
- No silent mode switching: Fix 3 shows the chosen mode in the create-task
  dialog and reports the mode the server actually used.
- No dropping the commit requirement to make merges "just work" — an
  uncommitted worktree genuinely has nothing to merge.
- No merge commits created in the user's checkout: "apply" is a fast-forward or
  a refusal, never an implicit `git merge`.

## Test plan for the whole roadmap

1. Fresh empty folder → consent dialog → init → first task writes a file →
   **it appears in the folder** (Fix 3) and the agent's `agntspce-collab claim`
   succeeds (Fix 1).
2. Same folder, second task → gets a worktree; its file is hidden until merge.
3. Agent does not commit → merge dialog names the blocking files (Fix 2).
4. Agent commits → Merge changes → lands on `<workspace>_agntspce` → **Apply to
   `main`** → file is in the folder (Fix 4).
5. Two tasks editing the same file → claims serialise them; merge surfaces the
   conflict and AI resolution.
