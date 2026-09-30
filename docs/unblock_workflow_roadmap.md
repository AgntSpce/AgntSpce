# Unblock Workflow Roadmap

Goal: task → integration → main, where nothing an agent wrote is ever lost, and
every dead end has a visible way out.

## Workflow (the contract)

1. **Task** — each task gets a real git worktree, its own branch off
   `<workspace>_agntspce`, and N agents sharing it. The planner is gone: every
   agent gets the whole goal and coordinates through `agntspce-collab`.
2. **Merge changes** — commits pending agent work, merges the task into the
   integration branch, then shows the result for review before it lands.
3. **Apply to main** — fast-forwards the user's branch onto integration.
4. **Update** — pulls what other tasks merged into this task's branch.

A merge never retires a task: it keeps its worktree, branch, agents and session
IDs so work continues and merges again.

## Done

- [x] Worktree isolation, integration branch, drift detection
- [x] Merge changes / Merge all / Apply to main
- [x] Auto-commit pending agent work on merge and update
- [x] Generated scaffolds (`.task.json`, `AGENTS-TASK.md`, `COLLAB.md`) never committed
- [x] Planner removed; whole goal to every agent
- [x] Merge conflict recovery: real provider errors surfaced, plus
      "Keep this task's version" / "Keep the merged version"
- [x] Fixed `git checkout --theirs` silently keeping the wrong side (merge was
      aborted, so there were no conflict stages to read)
- [x] Dead PTY / EIO handling, stale restored cwd, live-session reassignment
- [x] File explorer refresh after Apply; Git Review fetch/pull/push
- [x] Merge/Update stop the task's running agents, then proceed
- [x] Update conflict resolver: ask the AI, or keep either side
- [x] Apply to main: only the files the merge actually touches can block it
- [x] Per-file "discard my local edit" so an apply can be unblocked deliberately
- [x] A conflicted sync never leaves a half-merged worktree behind

## Bugs found and fixed (root causes, not symptoms)

### "Working" showed permanently
Subtask status `running` only means "has a live session" — set on spawn, never
cleared. Every launched task read as busy forever, so Merge/Update were withheld
permanently. **Fix:** derive from live session status.

### "Working" lingered ~30s after the agent finished
`ASSUME_BUSY_SINCE_OUTPUT_CLAUDE_MS = 30000`. That padding stops a status dot
flickering during a slow turn; it is wrong for gating, which only needs to know
if work is happening now. **Fix:** gate on `lastActivity` within 6s, and keep the
padded label for the status dot where it belongs.

### "Working" flashed on add/resume/switch
A new or restored session inherits a stale status label before producing output.
**Fix:** recent-output signal (a session with no output is not working) plus a
task-list refresh on `session-resumed`.

### Two agents appeared to edit the same file
They were not sharing anything — worktrees had distinct inodes and correct PTY
cwds. A task branch had been advanced onto the integration tip, which **reset
the task worktree** to the integration commit holding the *other* task's merged
content. The agent wrote, the branch moved, and it read the peer's content back.
Hence "something outside this session is rewriting the file". **Fix:** never move
a branch under a live agent (gating + server guard).

### "Already up to date" when it was not
`rev-list task..integration` counts 0 when the branches are the same commit —
correct, because the task genuinely had nothing of its own left. The real fault
was upstream: the task branch had been moved onto the integration tip.

## Done since (the two resolvers)

### Update conflict resolver
`syncTaskOntoIntegration` used to abort on conflict and print the file names —
a hard dead end, because the same task could never again pull in a peer's work
on a file both had touched. It now takes a choice and finishes the merge.

- [x] Reuses the live conflicted merge in the task worktree, so `--ours` really
      is the task and `--theirs` really is what peers merged
- [x] `preferSide: 'task' | 'integration'` — named by meaning, not ours/theirs,
      because the merge dialog has the opposite arrangement
- [x] AI path reuses `resolveWithLlm`, generalised to take both sides by ref
      *and* label (the roles invert between merge and sync)
- [x] Reports the real provider error instead of "empty resolution"
- [x] `abortSync` guarantees no worktree is left mid-merge with conflict
      markers in it
- [x] `TaskSyncDialog` with the three explicit choices
- [x] 8 tests, including that the chosen side is the one that wins

### Apply to main
The blanket "your working tree is dirty" refusal was true of every unrelated
edit, which is why it read as broken. `git merge --ff-only` only fails when the
incoming commits touch a dirty file.

- [x] Dirt in files nothing merged no longer blocks; the edit rides along
- [x] Genuinely overlapping files are named individually
- [x] `discardLocalEdits` reverts only the named files, with a path-escape guard
- [x] The UI confirms with the exact file list and says it cannot be undone
- [x] 7 tests, including that unrelated dirt survives byte-for-byte

## To do

### demotest4
- [ ] Stale `demo.txt` edit on main (`-==============demo2`, dated Sep 28) still
      blocks a clean apply — needs the user's call: commit or revert
- [ ] Both task branches (`task/unnamed-task-f9e4d1ad`, `task/ddsfds-641a2303`)
      have **zero** commits not on the integration branch. The agents' divergent
      work was overwritten, not stashed, so there is nothing to recover. Retest
      with new tasks.

### Later / parked
- [ ] PR idea (explicitly deferred)
- [ ] Orca/Superset ideas: `--no-track`, `push.autoSetupRemote`, one porcelain
      parser, dirty-worktree deletion guards, boot-time prune. Do **not** adopt a
      PR-only egress model.

### Still worth deciding
- [ ] Apply to main still refuses when the user branch has *diverged* (has its
      own commits). That protects their commits, but the only way out today is a
      manual `git merge` / `rebase`.
- [ ] Stopping agents mid-turn can lose a write in flight. Pending work on disk
      is committed first, but a half-written file can survive. The alternative is
      waiting for the agent, which was rejected.

## Verification

`npx tsc -b --force` · `npm run lint` · `npm run build` · `npm run test:node` ·
`git diff --check`

Last green: 20 files, 313 tests.
