import { useCallback, useEffect, useState } from 'react'

export interface TaskMergeApi {
  previewTaskMerge: (taskGroupId: string) => Promise<any>
  mergeTask: (taskGroupId: string, autoResolve?: boolean) => Promise<any>
  confirmTaskMerge: (taskGroupId: string) => Promise<any>
  mergeAllTasks?: (taskGroupIds: string[]) => Promise<any>
}

export interface TaskMergePreviewInfo {
  taskGroupId: string
  branchName: string
  diffSummary: string
  actualFiles: string[]
  conflictFiles: string[]
  scopeOverlapFiles: string[]
  pendingCandidate?: { ref: string; diff: string } | null
  error?: string
}

type Stage = 'previewing' | 'ready' | 'merging' | 'review' | 'done' | 'failed'

interface Props {
  taskGroupId: string
  taskTitle: string
  api: TaskMergeApi
  onClose: () => void
  onMerged?: () => void
}

/** Merge a task's worktree branch into the integration branch.
 *
 *  Always previews first: the preview comes from a real trial merge, so the
 *  file list and the conflict list are measured, not guessed. Nothing mutates
 *  until the user confirms. When the AI resolves conflicts, the resolved diff
 *  is shown and a second explicit confirm is required to land it. */
export default function TaskMergeDialog({ taskGroupId, taskTitle, api, onClose, onMerged }: Props) {
  const [stage, setStage] = useState<Stage>('previewing')
  const [preview, setPreview] = useState<TaskMergePreviewInfo | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ summary: string; files: string[] } | null>(null)
  const [review, setReview] = useState<{ conflictFiles: string[]; diff: string } | null>(null)
  const [retryTick, setRetryTick] = useState(0)

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
          setError(res?.error || 'Could not read the merge preview')
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
    })()
    return () => { cancelled = true }
  }, [api, taskGroupId, retryTick])

  const reloadPreview = useCallback(() => setRetryTick(t => t + 1), [])

  async function runMerge() {
    setStage('merging')
    setError('')
    try {
      const res = await api.mergeTask(taskGroupId)
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
      setResult({ summary: res?.diffSummary || 'Merged', files: res?.actualFiles || [] })
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

  const noChanges = stage === 'ready' && (preview?.actualFiles.length ?? 0) === 0

  // Only a merge in flight is uninterruptible — a preview does nothing until
  // it is confirmed, so the user must never be trapped waiting for one.
  const busy = stage === 'merging'

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
            {noChanges ? (
              <p className="task-merge-note">This task has no changes to merge.</p>
            ) : (
              <>
                <div className="task-merge-row">
                  <span className="task-merge-label">Files changed</span>
                  <span className="task-merge-value">{preview.actualFiles.length}</span>
                </div>
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
            <p className="task-merge-ok">Merged into the integration branch.</p>
            {result.files.length > 0 && (
              <div className="task-merge-files">
                {result.files.slice(0, 40).map(f => <span key={f} className="task-merge-file">{f}</span>)}
                {result.files.length > 40 && <span className="task-merge-file">+{result.files.length - 40} more</span>}
              </div>
            )}
          </>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="task-chat-actions">
          {stage === 'ready' && !noChanges && (
            <button className="modal-btn modal-btn-ok" disabled={busy} onClick={runMerge}>Merge changes</button>
          )}
          {stage === 'review' && (
            <button className="modal-btn modal-btn-ok" disabled={busy} onClick={runConfirm}>Confirm &amp; land</button>
          )}
          {(stage === 'ready' || stage === 'review' || stage === 'failed') && (
            <button className="modal-btn modal-btn-cancel" disabled={busy} onClick={onClose}>
              {stage === 'review' ? 'Review later' : 'Close'}
            </button>
          )}
          {stage === 'failed' && (
            <button className="modal-btn" disabled={busy} onClick={reloadPreview}>Try again</button>
          )}
          {stage === 'done' && (
            <button className="modal-btn modal-btn-ok" onClick={onClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  )
}
