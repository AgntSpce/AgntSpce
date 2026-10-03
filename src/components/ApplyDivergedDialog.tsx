interface Props {
  /** The user's own branch, e.g. "main". */
  branch: string
  /** AgntSpce's integration branch, e.g. "demotest4_agntspce". */
  integrationBranch: string
  /** Commits only the user's branch has. */
  ahead: number
  /** Merged task commits waiting on the integration branch. */
  behind: number
  /** Files the integration branch would bring in. */
  files?: string[]
  /** Non-blocking status text, shown under the explanation. */
  error?: string
  busy?: boolean
  onMerge: () => void
  onRebase: () => void
  onClose: () => void
}

/** What to do when the merged task work cannot be fast-forwarded onto the
 *  user's branch because both have moved on.
 *
 *  This replaces an `alert()` that only restated the problem and named a
 *  command. Both fixes are right here as buttons, because both write to the
 *  user's checkout and neither is something apply should do on its own.
 *
 *  The two are deliberately not ranked as good/bad. A merge keeps both sets of
 *  commits and is the safe default; a rebase gives linear history but replays
 *  the user's commits, so it can surface conflicts in a different place than a
 *  merge would. Which one is right depends on whether the branch gets pushed,
 *  which the app cannot know. */
export default function ApplyDivergedDialog({
  branch, integrationBranch, ahead, behind, files, error, busy,
  onMerge, onRebase, onClose,
}: Props) {
  const shown = (files || []).slice(0, 12)
  const extra = (files || []).length - shown.length

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal apply-diverged-modal" onClick={e => e.stopPropagation()}>
        <div className="task-merge-header">
          <div className="task-merge-title">
            <h3 className="modal-title">Apply needs a merge</h3>
            <p className="modal-subtitle">{branch} and {integrationBranch} have both moved on</p>
          </div>
          <button className="task-chat-close" onClick={onClose} disabled={busy} title="Close">×</button>
        </div>

        <p className="git-consent-body">
          <strong>{behind}</strong> merged commit{behind === 1 ? '' : 's'} on{' '}
          <code>{integrationBranch}</code> {behind === 1 ? 'is' : 'are'} waiting, and <strong>{ahead}</strong>{' '}
          commit{ahead === 1 ? '' : 's'} on <code>{branch}</code> are not on it. Because neither branch
          contains the other, AgntSpce cannot fast-forward and will not rewrite your branch
          without you choosing to.
        </p>

        {shown.length > 0 && (
          <div className="apply-diverged-files">
            <p className="apply-diverged-files-label">
              {files!.length} file{(files || []).length === 1 ? '' : 's'} waiting to come in
            </p>
            <ul>
              {shown.map(f => <li key={f}><code>{f}</code></li>)}
              {extra > 0 && <li className="apply-diverged-more">and {extra} more…</li>}
            </ul>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="apply-diverged-actions">
          <div className="apply-diverged-choice">
            <button className="modal-btn modal-btn-ok" disabled={busy} onClick={onMerge}>
              {busy ? 'Working…' : `Merge ${integrationBranch} into ${branch}`}
            </button>
            <p className="apply-diverged-hint">
              Keeps both sets of commits and adds a merge commit. Nothing is rewritten.
            </p>
          </div>
          <div className="apply-diverged-choice">
            <button className="modal-btn" disabled={busy} onClick={onRebase}>
              {busy ? 'Working…' : `Rebase ${branch} onto ${integrationBranch}`}
            </button>
            <p className="apply-diverged-hint">
              Replays your {ahead} commit{ahead === 1 ? '' : 's'} on top for a linear history. Rewrites
              them, so only pick this if you have not pushed {branch} anywhere.
            </p>
          </div>
        </div>

        <div className="task-chat-actions">
          <button className="modal-btn modal-btn-cancel" disabled={busy} onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}