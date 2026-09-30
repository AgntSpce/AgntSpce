import { useCallback, useEffect, useState } from 'react'

export interface TaskMergeApi {
  previewTaskMerge: (taskGroupId: string) => Promise<any>
  mergeTask: (taskGroupId: string, autoResolve?: boolean, preferSide?: 'ours' | 'theirs') => Promise<any>
  confirmTaskMerge: (taskGroupId: string) => Promise<any>
  mergeAllTasks?: (taskGroupIds: string[]) => Promise<any>
  syncTaskBranch?: (taskGroupId: string) => Promise<any>
  /** Fast-forward the user's checked-out branch onto the integration branch. */
  applyTaskBranch?: (branchName?: string) => Promise<any>
}

export interface TaskMergePreviewInfo {
  taskGroupId: string
  branchName: string
  diffSummary: string
  actualFiles: string[]
  conflictFiles: string[]
  scopeOverlapFiles: string[]
  integrationBranch?: string
  behindCount?: number
  behindFiles?: string[]
  pendingCandidate?: { ref: string; diff: string } | null
  /** Uncommitted work the merge will commit on the agent's behalf. */
  pendingFiles?: string[]
  /** Files the merge actually committed for the agent. */
  autoCommittedFiles?: string[]
  error?: string
}

type Stage = 'previewing' | 'ready' | 'merging' | 'review' | 'done' | 'failed'

interface Props {
  taskGroupId: string
  taskTitle: string
  api: TaskMergeApi
  onClose: () => void
  onMerged?: () => void
  /** Hand off to the full conflict solver instead of calling a provider. */
  onOpenSolver?: (conflictFiles: string[]) => void
}

/** Merge a task's worktree branch into the integration branch.
 *
 *  Always previews first: the preview comes from a real trial merge, so the
 *  file list and the conflict list are measured, not guessed. Nothing mutates
 *  until the user confirms. When the AI resolves conflicts, the resolved diff
 *  is shown and a second explicit confirm is required to land it. */
export default function TaskMergeDialog({ taskGroupId, taskTitle, api, onClose, onMerged, onOpenSolver }: Props) {
  const [stage, setStage] = useState<Stage>('previewing')
  const [preview, setPreview] = useState<TaskMergePreviewInfo | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ summary: string; files: string[]; autoCommittedFiles?: string[] } | null>(null)
  const [review, setReview] = useState<{ conflictFiles: string[]; diff: string } | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const [syncing, setSyncing] = useState(false)

  // Cancellation is scoped to the effect run, not to the component instance.
  // A `useRef` "am I mounted" flag does not work under StrictMode: React runs
  // effect → cleanup → effect, so the cleanup latches the flag false and every
  // later response is dropped — the dialog would hang on "Checking…" forever.
  useEffect(() => {
    let cancelled = false
    setStage('previewing')
    setError('')
    ;(async () => {
      try {
        const res = await api.previewTaskMerge(taskGroupId)
        if (cancelled) return
        if (!res || res.ok === false) {
          // The reason may live on the preview rather than at the top level.
          setError(res?.error || res?.preview?.error || 'Could not read the merge preview')
          setStage('failed')
          return
        }
        setPreview(res.preview || null)
        // A candidate prepared by an earlier attempt (possibly before a restart)
        // goes straight to the review step — that is the only way to land it.
        if (res.preview?.pendingCandidate) {
          setReview({ conflictFiles: res.preview.conflictFiles || [], diff: res.preview.pendingCandidate.diff })
          setStage('review')
          return
        }
        setStage('ready')
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message || 'Could not read the merge preview')
        setStage('failed')
      }
      // A preview that carries a reason should show it, not the generic line.
    })()
    return () => { cancelled = true }
  }, [api, taskGroupId, retryTick])

  // Merges land on the integration branch, not in the folder the user is
  // looking at. This is the step that actually makes the files appear there, so
  // it is offered right after a successful merge instead of leaving the user
  // to discover an unfamiliar branch and merge it by hand.
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<{ branch: string; files: string[]; upToDate: boolean } | null>(null)
  const runApply = useCallback(async () => {
    if (!api.applyTaskBranch) return
    setApplying(true)
    setError('')
    try {
      const res = await api.applyTaskBranch()
      if (res && res.ok === false) setError(res.error || 'Could not apply the integration branch')
      else setApplied({ branch: res?.branch || '', files: res?.files || [], upToDate: !!res?.upToDate })
    } catch (e: any) {
      setError(e?.message || 'Could not apply the integration branch')
    } finally {
      setApplying(false)
    }
  }, [api])

  const runSync = useCallback(async () => {
    if (!api.syncTaskBranch) return
    setSyncing(true)
    setError('')
    try {
      const res = await api.syncTaskBranch(taskGroupId)
      if (res && res.ok === false) setError(res.error || 'Could not sync this task')
    } catch (e: any) {
      setError(e?.message || 'Could not sync this task')
    } finally {
      setSyncing(false)
      // Re-read the preview: syncing changes both the drift and the conflicts.
      setRetryTick(t => t + 1)
    }
  }, [api, taskGroupId])

  // `withAi` is a parameter, not state: setting state and calling this in the
  // same handler would read the pre-update value, so the provider would never
  // actually be asked to resolve anything.
  async function runMerge(preferSide?: 'ours' | 'theirs', withAi = false) {
    try {
      // With a known conflict, do NOT call the provider automatically. An
      // exhausted account then produced a raw billing error before the user
      // ever saw the choices, so a solvable conflict looked like a hard
      // failure. Go straight to the choice stage; the retry button is where the
      // AI becomes an explicit option.
      const willConflict = (preview?.conflictFiles?.length ?? 0) > 0
      const res = await api.mergeTask(taskGroupId, !willConflict || !!preferSide || withAi, preferSide)
      if (res?.needsConfirm) {
        setReview({ conflictFiles: res.conflictFiles || [], diff: res.resolvedDiff || res.diffSummary || '' })
        setStage('review')
        return
      }
      if (res && res.ok === false) {
        setError(res.error || 'Merge failed')
        setStage('failed')
        return
      }
      setResult({ summary: res?.diffSummary || 'Merged', files: res?.actualFiles || [], autoCommittedFiles: res?.autoCommittedFiles })
      setStage('done')
      onMerged?.()
    } catch (e: any) {
      setError(e?.message || 'Merge failed')
      setStage('failed')
    }
  }

  async function runConfirm() {
    setStage('merging')
    setError('')
    try {
      const res = await api.confirmTaskMerge(taskGroupId)
      if (res && res.ok === false) {
        setError(res.error || 'Could not land the merge')
        setReview(null)
        setStage('failed')
        return
      }
      setReview(null)
      setResult({ summary: res?.diffSummary || 'Merged', files: [] })
      setStage('done')
      onMerged?.()
    } catch (e: any) {
      setError(e?.message || 'Could not land the merge')
      setStage('failed')
    }
  }

  // Uncommitted work counts: the merge commits it, so a task whose agent never
  // committed still has something to land. Keying this on committed changes
  // alone hid the Merge button in exactly the case the user hit.
  const pendingCount = preview?.pendingFiles?.length ?? 0
  const noChanges = stage === 'ready' && (preview?.actualFiles.length ?? 0) === 0 && pendingCount === 0
  const hasConflict = (preview?.conflictFiles.length ?? 0) > 0

  // Only a merge in flight is uninterruptible — a preview does nothing until
  // it is confirmed, so the user must never be trapped waiting for one.
  const busy = stage === 'merging'

  // A bare provider call either worked invisibly or failed with whatever the
  // provider felt like saying, leaving nothing to look at. The solver shows both
  // versions and puts a real agent on the problem in this task's worktree.
  const solverBtn = (preview?.conflictFiles?.length ?? 0) === 0 ? null
    : onOpenSolver
      ? <button className="modal-btn" disabled={busy} onClick={() => onOpenSolver(preview?.conflictFiles || [])}>Open Conflict solver</button>
      : <button className="modal-btn" disabled={busy} onClick={() => runMerge(undefined, true)}>Let the AI resolve it</button>

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal task-merge-modal" onClick={e => e.stopPropagation()}>
        <div className="task-merge-header">
          <div>
            <h3 className="modal-title">Merge changes</h3>
            <p className="modal-subtitle">
              {taskTitle}
              {preview?.branchName ? ` · ${preview.branchName}` : ''}
            </p>
          </div>
          <button className="task-chat-close" onClick={onClose} disabled={busy} title="Close">×</button>
        </div>

        {stage === 'previewing' && (
          <>
            <p className="task-merge-note">Checking what would land…</p>
            <div className="task-chat-actions">
              <button className="modal-btn modal-btn-cancel" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {stage === 'ready' && preview && (
          <>
            {pendingCount > 0 && (
              <>
                <div className="task-merge-row">
                  <span className="task-merge-label">Not committed yet</span>
                  <span className="task-merge-value">{pendingCount}</span>
                </div>
                <p className="task-merge-note">
                  The agent left this uncommitted. Merging commits it for them.
                </p>
                <div className="task-merge-files">
                  {pendingCount > 0 && preview!.pendingFiles!.slice(0, 40).map(f => <span key={f} className="task-merge-file">{f}</span>)}
                  {pendingCount > 40 && <span className="task-merge-file">+{pendingCount - 40} more</span>}
                </div>
              </>
            )}
            {noChanges ? (
              <p className="task-merge-note">
                This task has no changes of its own to merge.
                {(preview.behindCount ?? 0) > 0
                  ? ` ${preview.behindCount} commit${preview.behindCount === 1 ? '' : 's'} from peers are already on ${preview.integrationBranch} — sync to pull them into this task.`
                  : ''}
              </p>
            ) : (
              <>
                <div className="task-merge-row">
                  <span className="task-merge-label">Files changed</span>
                  <span className="task-merge-value">{preview.actualFiles.length}</span>
                </div>
                {preview.integrationBranch && (
                  <p className="task-merge-note">
                    Merges into <code>{preview.integrationBranch}</code>. Use <strong>Apply to main</strong>
                    to bring it into your folder. The task keeps its worktree and agents, so you can keep
                    working on it and merge again.
                  </p>
                )}
                <pre className="task-merge-stat">{preview.diffSummary}</pre>
                {preview.actualFiles.length > 0 && (
                  <div className="task-merge-files">
                    {preview.actualFiles.slice(0, 40).map(f => <span key={f} className="task-merge-file">{f}</span>)}
                    {preview.actualFiles.length > 40 && <span className="task-merge-file">+{preview.actualFiles.length - 40} more</span>}
                  </div>
                )}
                {preview.conflictFiles.length > 0 && (
                  <div className="task-merge-conflict">
                    <div className="task-merge-conflict-title">Will conflict ({preview.conflictFiles.length})</div>
                    <div className="task-merge-conflict-note">
                      The AI will try to resolve these. You still review the result before it lands.
                    </div>
                    <div className="task-merge-files">
                      {preview.conflictFiles.map(f => <span key={f} className="task-merge-file conflict">{f}</span>)}
                    </div>
                  </div>
                )}
                {preview.scopeOverlapFiles.length > 0 && (
                  <div className="task-merge-warn">
                    Also claimed by other unfinished tasks: {preview.scopeOverlapFiles.slice(0, 12).join(', ')}
                    {preview.scopeOverlapFiles.length > 12 ? ` +${preview.scopeOverlapFiles.length - 12} more` : ''}
                  </div>
                )}
                {(preview.behindCount ?? 0) > 0 && (
                  <div className="task-merge-warn">
                    This task is {preview.behindCount} commit{preview.behindCount === 1 ? '' : 's'} behind{' '}
                    <code>{preview.integrationBranch}</code>
                    {(preview.behindFiles?.length ?? 0) > 0 && (
                      <> — including {preview.behindFiles!.slice(0, 6).join(', ')}</>
                    )}
                    . Syncing pulls those changes into this task's worktree so the merge stays clean.
                  </div>
                )}
              </>
            )}
          </>
        )}

        {stage === 'merging' && <p className="task-merge-note">Merging, then building and testing the result…</p>}

        {stage === 'review' && review && (
          <>
            <div className="task-merge-conflict">
              <div className="task-merge-conflict-title">AI-resolved — review before it lands</div>
              {review.conflictFiles.length > 0 && (
                <div className="task-merge-files">
                  {review.conflictFiles.map(f => <span key={f} className="task-merge-file conflict">{f}</span>)}
                </div>
              )}
            </div>
            <pre className="task-merge-diff">{review.diff || '(no diff available)'}</pre>
          </>
        )}

        {stage === 'done' && result && (
          <>
            <p className="task-merge-ok">
              Merged into the integration branch.
            </p>
            <p className="task-merge-note">
              This task is now finished: its agents have been stopped and its worktree removed, so
              its terminal is gone. Use <strong>Apply to main</strong> to bring the work into your
              folder, or <strong>Update</strong> on another task to let it pull this in.
            </p>
            {result.files.length > 0 && (
              <div className="task-merge-files">
                {result.files.slice(0, 40).map(f => <span key={f} className="task-merge-file">{f}</span>)}
                {result.files.length > 40 && <span className="task-merge-file">+{result.files.length - 40} more</span>}
              </div>
            )}
            {(result?.autoCommittedFiles?.length ?? 0) > 0 && (
              <p className="task-merge-note">
                AgntSpce committed {result!.autoCommittedFiles!.length} uncommitted file(s) the task
                agent left behind: {result!.autoCommittedFiles!.slice(0, 5).join(', ')}
              </p>
            )}
            {applied && (
              <p className="task-merge-ok">
                {applied.upToDate
                  ? `${applied.branch} is already up to date.`
                  : `Applied to ${applied.branch} — ${applied.files.length} file${applied.files.length === 1 ? '' : 's'} now in your folder.`}
              </p>
            )}
          </>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="task-chat-actions">
          {/* Sync must stay available for a task with no changes of its own.
              Verified failure: a task created before a peer merged was empty
              and behind, so `noChanges` hid the only control that could pull
              the peer's work in — the agent then reported the file simply did
              not exist. Gating sync on having own changes made peers'
              committed work unreachable. */}
          {stage === 'ready' && api.syncTaskBranch && (preview?.behindCount ?? 0) > 0 && (
            <button className="modal-btn" disabled={busy || syncing} onClick={runSync} title={`Merge ${preview?.integrationBranch} into this task's worktree`}>
              {syncing ? 'Syncing…' : `Sync onto ${preview?.integrationBranch ?? 'integration'}`}
            </button>
          )}
          {stage === 'ready' && !noChanges && (
            <button className="modal-btn modal-btn-ok" disabled={busy} onClick={() => runMerge()}>
              {/* Name what it will do: the agent usually did not commit, and a
                  bare "Merge changes" used to dead-end on "nothing to merge". */}
              {(preview?.pendingFiles?.length ?? 0) > 0 ? 'Commit & merge' : 'Merge changes'}
            </button>
          )}
          {stage === 'review' && (
            <button className="modal-btn modal-btn-ok" disabled={busy} onClick={runConfirm}>Confirm &amp; land</button>
          )}
          {(stage === 'ready' || stage === 'review' || stage === 'failed') && (
            <button className="modal-btn modal-btn-cancel" disabled={busy} onClick={onClose}>
              {stage === 'review' ? 'Review later' : 'Close'}
            </button>
          )}
          {/* A bare provider call either worked invisibly or failed with
              whatever the provider felt like saying, and left the user with
              nothing to look at. Opening the solver shows the two versions and
              puts a real agent on the problem in this task's worktree. */}
          {stage === 'failed' && solverBtn}
          {/* When the AI cannot resolve a conflict, refusing and stopping is a
              dead end: the sync also refuses (it would clobber work) and every
              re-merge hits the same wall. Offer the two real outcomes so the
              merge can always be finished - as an explicit choice, never a
              silent guess. */}
          {stage === 'failed' && hasConflict && (preview?.conflictFiles.length ?? 0) > 0 && (
            <>
              <button
                className="modal-btn"
                disabled={busy}
                onClick={() => runMerge('theirs')}
                title={`Discard the ${preview?.integrationBranch} version of ${preview?.conflictFiles.join(', ')} and keep this task's version`}
              >
                Keep this task's version
              </button>
              <button
                className="modal-btn"
                disabled={busy}
                onClick={() => runMerge('ours')}
                title={`Keep what is already merged on ${preview?.integrationBranch} and discard this task's version of ${preview?.conflictFiles.join(', ')}`}
              >
                Keep the merged version
              </button>
            </>
          )}
          {stage === 'done' && (
            <>
              {api.applyTaskBranch && !applied && (
                <button className="modal-btn modal-btn-ok" disabled={applying} onClick={runApply}
                  title={`Fast-forward your checked-out branch onto ${preview?.integrationBranch ?? 'the integration branch'}`}>
                  {applying ? 'Applying…' : 'Apply to my branch'}
                </button>
              )}
              <button className="modal-btn" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
