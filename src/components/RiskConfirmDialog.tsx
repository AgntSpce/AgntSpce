interface Props {
  open: boolean
  title: string
  message: string
  detail?: string
  confirmLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** Two-button confirmation shown before an action that rewrites a task's
 *  worktree while its agents may still be running.
 *
 *  The app used to close those agents itself. That is destructive and it is
 *  not the app's call: an agent's session is the user's, and a stopped agent
 *  loses whatever it had in flight with no way back. So nothing is closed here
 *  — the user is told what could happen and decides.
 *
 *  Deliberately not styled as a blocking error. It is a heads-up with a real
 *  choice, not a wall. */
export function RiskConfirmDialog({ open, title, message, detail, confirmLabel, busy, onCancel, onConfirm }: Props) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal task-merge-modal" onClick={e => e.stopPropagation()}>
        <div className="task-merge-header">
          <div className="task-merge-title">
            <h3 className="modal-title">{title}</h3>
          </div>
          <button className="task-chat-close" onClick={onCancel} disabled={busy} title="Close">×</button>
        </div>

        <div>
          <p className="modal-subtitle">{message}</p>
          {detail && <p className="modal-subtitle">{detail}</p>}
        </div>

        <div className="task-chat-actions">
          <button className="modal-btn" onClick={onCancel} disabled={busy}>Continue</button>
          <button className="modal-btn modal-btn-ok" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
