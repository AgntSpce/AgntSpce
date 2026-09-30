# Merge Solver — roadmap

Status: design agreed, not started. Nothing here is built or committed.

## The problem

Task work lands on `<workspace>_agntspce` and the user's checkout only moves when
they ask. That part works. What does not work is everything around it:

- **Merged work looks lost.** Real case: `demotest2` had `index.html` on the
  integration branch, `main` matched it, and the folder showed the file — but
  nothing in the UI said which branch you were on or how the two related. The
  user's read was "the app lost my file".
- **Reviewing is per-task.** N tasks means N dialogs, each with its own diff,
  each needing its own confirm. There is no single place to see "everything
  that is about to land on main".
- **Conflicts are resolved one task at a time**, against whatever the
  integration branch happened to be at that moment.

## The agreed model

**The user lives on the integration branch.** It is the working branch, not a
staging area they have to go find.

```
open workspace  →  ensure git repo (init once, logged)
                →  ensure <workspace>_agntspce exists
                →  check it out, and say so
create task     →  worktree branched from the integration branch
                →  agent works, commits
merge task/all  →  merges land on the integration branch
                →  the folder the user is looking at updates immediately
review          →  one page: integration vs main, every commit and file
apply to main   →  one deliberate, guarded action
```

Two user actions, and a folder that always shows current merged work. This
replaces "merge onto a branch you're not on, then hunt for it".

### Why this is not mostly new code

Already built and reused as-is: per-workspace branch naming, task worktrees
branching from the integration branch (`sourceRef()`), per-task merge with
preview, scratch worktrees for merging, LLM conflict resolution with a
confirm-pending candidate, apply-to-branch as a fast-forward with guardrails.

New: the checkout on workspace open, the review page, and the solver session.

## What is deliberately cut

- **The two-step git consent dialog.** Do it once on workspace open, silently,
  with a one-line log: *"initialized git, created `demo_agntspce`, checked it
  out."* The dialog was solving a problem the user cannot hit once the app does
  it for them.
- **The fresh-repo / auto-mode selection.** Once there is a repo with a commit,
  always a worktree. That branch of logic was a band-aid for the empty-repo case
  that the checkout-on-open flow makes moot.
- **Per-task "you must click merge".** It is a checklist that rots, and *Merge
  all* does the identical thing in one click. What matters is that nothing lands
  silently — one explicit merge satisfies that.
- **The per-task merge dialog as the normal path.** Keep it for conflicts and for
  inspecting one task. The normal path is *Merge all → review → apply*.

## The Merge Solver page

Layout: the repo's existing `SplitPane`.

**Left — every task.** For each: title, agent avatars, file count, and its diff
against the integration branch. States are explicit: `up to date`, `behind N`,
`N files to merge`, `will conflict (N)`, `blocked — uncommitted`, `merged`.

**Right (50%) — the solver agent.** A real agent session, chosen in Settings
(per workspace, with a fallback if that agent is not installed), running in a
**scratch worktree** — never in the user's checkout, so it cannot touch the files
they have open. It works the conflicts as one job and reports per file.

**Bottom — the cumulative review.** `integration vs main`: every commit, every
file, per-file accept/skip, and the button that applies.

The solver opens automatically when *Merge all* finds conflicts, and is reachable
on demand otherwise. It is not a modal: you can keep working while it runs.

## Rules that keep this safe

1. **Sync before solving.** A task must be synced onto the integration branch
   before its conflicts are resolved. Two tasks branching from the same base and
   editing the same file, merged in sequence, means the second resolution happens
   against work the first agent never saw — the output can be semantically wrong
   and look perfectly clean. This is a precondition, not an option.
2. **Per-conflict human review, always.** Eight files resolved unreviewed is how
   you get plausible-but-wrong code. The existing confirm-pending candidate is
   the right pattern; the solver produces candidates, a human lands them.
3. **The solver never merges into the user's checkout.** Its output lands on the
   integration branch. Apply-to-main remains a separate, explicit act.
4. **Never silently discard.** Switching branches with a dirty tree must offer
   "commit my folder changes to the review branch" or "stash", and refuse
   otherwise. Already true of apply-to-branch; the checkout-on-open path needs
   the same policy.
5. **Show the branch, always.** The status bar must state which branch is checked
   out and whether it contains work not yet on main. Most of the confusion in
   this area is the user not knowing where they are.

## Known costs, stated up front

- The editor and any tooling now run against the review branch, not `main`. If
  the user pushes, they push the review branch. Mitigated by rule 5, not removed.
- Switching to the review branch fails on a dirty tree — the same `M index.html`
  case already seen. Mitigated by rule 4.
- A task worktree can never check out the integration branch (git forbids one
  branch in two worktrees). Task worktrees branch *from* it, which is fine, but
  nothing may check it out elsewhere — the merge scratch worktree must keep
  working from a detached ref, as it does now.
- After apply-to-main the branches are equal again, so the next merge needs
  another apply. Expected, but it must be visible.

## Build order

1. **Always-visible branch state** — status bar shows the checked-out branch and
   whether it is ahead of main. Cheapest fix for the largest share of confusion.
2. **Workspace open → ensure repo + checkout review branch**, once, logged, with
   the dirty-tree policy from rule 4.
3. **Review page** (`integration vs main`): commits, files, per-file view, apply.
   The cumulative view is the thing that is genuinely missing.
4. **Solver session** — Settings-configured agent, scratch worktree, sync-first
   precondition, per-conflict candidates, 50% split pane.
5. **Auto-open the solver** when Merge all finds conflicts.
6. Then delete the cut list above, once the replacements are proven.

## Already fixed along the way

Retired tasks used to haunt the merge flow, and merge-all stopped at the first
failure. Both are fixed and covered by tests:

- An orphan task directory (worktree removed, generated files left behind inside
  the repo) made `git status` report the **main** repo's changes, so a task was
  blamed for the user's own uncommitted `index.html`. The dirty check now
  requires a real worktree before it reads git state.
- A task with nothing to merge was marked done but its branch and directory were
  never retired, leaking both.
- A failure *after* the integration ref moved reported "merge failed" and reset
  the task to active, for work that had in fact landed — retrying would have
  applied it twice. Success is now reported once the ref has moved.
- `done` tasks were treated as mergeable, so finished work was re-offered and
  re-merged.
- Merge-all attempted every task instead of halting at the first failure.
