# Parallel work without git — roadmap

Status: in progress. Uncommitted. Nothing here is pushed.

## The problem this solves

A workspace folder with no git repo silently degraded every task into a
**plain directory fallback**: `mkdirSync` an empty folder, write three metadata
files into it, and hand the agent an empty cwd with no source code, no branch
and nothing to merge. Verified on a real workspace:

```
.agntspce/tasks/<id>/   →  .task.json, AGENTS-TASK.md, COLLAB.md      (no source)
.task.json              →  "baseSha": null
```

So two agents given the same file clobbered each other, and "merge" was an
illusion. The empty-dir fallback is not a degraded mode — it is a broken one, and
worse than a hard error.

Three gaps follow from that, and this roadmap covers all three:

1. **No consent.** We never asked whether to initialize git; we just degraded.
2. **The integration branch is anonymous and stranded.** Merges land on a
   fixed-name `agntspce-integration` branch that the user has no reason to know
   exists, and nothing ever moves it into their own branch.
3. **Task branches go stale.** A task branch is created once and never
   re-integrated, so conflicts pile up at merge time instead of being handled
   while the work is still in progress.

## Design decisions (agreed)

- **Two-step consent**, per workspace, remembered so we never nag twice:
  1. "Git initialization not found. Initialize now?" → **Yes** / **No**
  2. On No: "Isolated git worktrees may not work without initializing git. Want
     to continue without it?" → **"Yes, I accept"** / **"No, initialize git"**
- **"Yes, I accept"** → app runs normally, agents *and* tasks are allowed, but
  tasks get **no worktree and no isolation**: agents run directly in the
  workspace folder. This is a new, honest mode rather than the empty-dir
  pretence.
- **Yes on init** → `git init`, keep `.agntspce/` ignored, and make the initial
  commit that git worktrees require (a worktree cannot branch from an empty
  repo). We commit what is there, respecting the existing `.gitignore`, and log
  the file count. Nothing is ever pushed anywhere.
  - ⚠️ Known caveat: a `.env` in the folder would land in that first commit.
    Mitigated by "local only, never pushed", but a pre-seeded ignore list is a
    reasonable follow-up.
- **Integration branch becomes `{workspace}_agntspce`** (sanitized, de-duped) so
  the user can see and merge it themselves. **Existing workspaces keep the
  branch they already have** — never rename out from under merged work.
- **Task branch deletion is already safe**: `deleteTaskBranchIfMerged` only runs
  `git branch -D` when `git merge-base --is-ancestor` proves the task branch is
  already contained in the integration branch. Unmerged branches are kept so
  work cannot be lost. No change needed.

## Phase 1 — Git consent + an honest non-isolated mode

- [ ] `worktreeMode` gains `'none'`: no git, no worktree, agents run in the
      workspace folder. No schema change needed (the column is already TEXT).
- [ ] Backend honours `'none'` in `create-task-group` and `launchTask`:
      `worktreePath = null`, `branchName = null`, `baseSha = null`, and the
      agent cwd resolves to the repo path.
- [ ] Socket probe so the renderer can ask "is this folder a git repo?"
      without shelling out itself, plus an action to initialize it.
- [ ] Renderer: consent dialog + per-workspace memory; task creation passes the
      mode implied by the answer.
- [ ] Task rows and `TaskChat` say plainly when a task has no isolation and no
      merge, instead of silently offering nothing.
- [ ] Retire the empty-plain-dir fallback from the git path. Keep it only for
      the genuine "git repo but worktree creation failed" case, where at least
      the folder is a real checkout.

## Phase 2 — `{workspace}_agntspce`

- [ ] Derive the branch name from the workspace/repo name, sanitized to a valid
      git ref and de-duped on collision.
- [ ] Only used when `workspace_config.integration_branch` is unset, so existing
      repos keep `agntspce-integration`.
- [ ] Surface the branch name in the UI so it is discoverable.

## Phase 3 — Keep task branches fresh

- [ ] After a successful merge, flag other active tasks whose changed files
      intersect the merged ones.
- [ ] "Sync onto integration" per task: merge the integration branch **inside
      that task's own worktree** (never touches the user's checkout).
- [ ] Fast-forward the integration branch from the user's source branch after
      they land it, so the next task starts from current code instead of
      stacking on an old snapshot. Fast-forward only — never a rewrite.

## Explicitly not doing

- No remote, no push, no PR. Local-only by design.
- No automatic merge into the user's branch — that stays an explicit action.
- No rewriting published history.

## Open items

- Should the initial commit show a file picker so secrets can be excluded, or is
  committing the folder as-is acceptable? (Currently: as-is, logged.)
- Should a non-isolated task be allowed at all, or only loose agents? (Currently:
  allowed, with a clear warning on the task row.)

## Files in scope

Backend: `orchestration/stateManager.ts`, `orchestration/taskOrchestrator.ts`,
`server/handlers/tasks.ts`, `server/handlers/git.ts` (new probe/init handlers)
Frontend: `hooks/useSocket.ts`, `types/index.ts`, `App.tsx`,
`components/WorkspaceSidebar.tsx`, `components/TaskChat.tsx`,
`components/CreateTaskModal.tsx`, `App.css`

Note: `stateManager.ts`, `useSocket.ts`, `WorkspaceSidebar.tsx`, `App.tsx` and
`types/index.ts` also carry another agent's uncommitted work. Edits there are
additive and surgical.
