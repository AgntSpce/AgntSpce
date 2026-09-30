import { useState } from 'react'

export interface SyncConflictState {
  taskGroupId: string
  taskTitle: string
  integrationBranch: string
  conflictFiles: string[]
}

interface Props {
  state: SyncConflictState
  busy: boolean
  error: string
  onCancel: () => void
  onResolve: (choice: { preferSide?: 'task' | 'integration'; autoResolve?: boolean }) => void
  onOpenSolver?: () => void
}

/** Shown when a task's Update cannot merge a peer's changes cleanly.
 *
 *  Update used to abort and print the conflicting file names, which was a dead
 *  end: the task could never pull in a peer's work on a file both had touched,
 *  no matter how many times it was retried. There is always a way through here
 *  — ask the AI, or pick a side explicitly. Nothing is resolved without the
 *  user choosing, so a conflict never lands as a silent guess. */
export function TaskSyncDialog({ state, busy, error, onCancel, onResolve, onOpenSolver }: Props) {
  const [showFiles, setShowFiles] = useState(false)
  const label = state.taskTitle || 'this task'

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal task-merge-modal" onClick={e => e.stopPropagation()}>
        <div className="task-merge-header">
          <div>
            <h3 className="modal-title">Update conflicts</h3>
            <p className="modal-subtitle">{label} · {state.integrationBranch}</p>
          </div>
          <button className="task-chat-close" onClick={onCancel} disabled={busy} title="Close">×</button>
        </div>

        <div className="modal-body">
          <p>
            <strong>{label}</strong> and <code>{state.integrationBranch}</code> both changed the same
            lines, so git will not merge them on its own.
          </p>

          <ul className="sync-conflict-files">
            {state.conflictFiles.slice(0, 12).map(f => <li key={f}><code>{f}</code></li>)}
            {state.conflictFiles.length > 12 && (
              <li className="sync-conflict-more">and {state.conflictFiles.length - 12} more…</li>
            )}
          </ul>

          <button className="modal-btn" onClick={() => setShowFiles(v => !v)} disabled={busy}>
            {showFiles ? 'Hide' : 'Show'} where each version lives
          </button>
          {showFiles && (
            <p className="sync-conflict-where">
              <strong>Keep this task's version</strong> — what the agents in {label} wrote.
              <br />
              <strong>Keep the merged version</strong> — what other tasks already merged into{' '}
              <code>{state.integrationBranch}</code>.
              <br />
              <strong>Let the AI resolve it</strong> — merges both, and you review the result.
            </p>
          )}

          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="task-chat-actions">
          <button className="modal-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="modal-btn" onClick={() => onResolve({ preferSide: 'task' })} disabled={busy}>
            {busy ? 'Working…' : "Keep this task's version"}
          </button>
          <button className="modal-btn" onClick={() => onResolve({ preferSide: 'integration' })} disabled={busy}>
            Keep the merged version
          </button>
          {onOpenSolver
            ? <button className="modal-btn modal-btn-ok" onClick={onOpenSolver} disabled={busy}>Open Conflict solver</button>
            : <button className="modal-btn modal-btn-ok" onClick={() => onResolve({ autoResolve: true })} disabled={busy}>
                Let the AI resolve it
              </button>}
        </div>
      </div>
    </div>
  )
}
