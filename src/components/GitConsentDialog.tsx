import { useState } from 'react'

export interface GitRepoState {
  isRepo: boolean
  hasCommits: boolean
  branch: string | null
}

interface Props {
  /** Folder name, for a friendlier message. */
  workspaceName: string
  /** Initialize git and make the first commit (required before worktrees). */
  onInitialize: () => Promise<void>
  /** Continue with no isolation: tasks run in the folder, no worktree, no merge. */
  onAcceptNoGit: () => void
  onClose: () => void
  busy?: boolean
  error?: string
}

/** Two-step consent for a workspace folder that cannot host git worktrees.
 *
 *  Step 1 asks whether to initialize. Step 2 is the explicit warning, so
 *  "continue without git" is always a deliberate, informed choice rather than a
 *  silent downgrade into a mode that cannot isolate anything. */
export default function GitConsentDialog({ workspaceName, onInitialize, onAcceptNoGit, onClose, busy, error }: Props) {
  const [step, setStep] = useState<'ask' | 'warn'>('ask')

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal git-consent-modal" onClick={e => e.stopPropagation()}>
        <div className="task-merge-header">
          <div>
            <h3 className="modal-title">
              {step === 'ask' ? 'Git initialization not found' : 'Continue without isolation?'}
            </h3>
            <p className="modal-subtitle">{workspaceName}</p>
          </div>
          <button className="task-chat-close" onClick={onClose} disabled={busy} title="Close">×</button>
        </div>

        {step === 'ask' ? (
          <>
            <p className="git-consent-body">
              This folder is not a git repository. AgntSpce uses git worktrees to give every task its
              own isolated copy of the code, so that parallel tasks never overwrite each other and
              can be merged afterwards.
            </p>
            <p className="git-consent-body">
              Initializing git creates a local repository and an initial commit. Nothing is ever
              pushed anywhere.
            </p>
          </>
        ) : (
          <>
            <p className="git-consent-body">
              Isolated git worktrees may not work without initializing git.
            </p>
            <p className="git-consent-warn">
              Tasks will have <strong>no isolation</strong>: every agent works directly in this
              folder, so two tasks editing the same file will overwrite each other, and there is
              no branch to merge.
            </p>
          </>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="task-chat-actions">
          {step === 'ask' ? (
            <>
              <button className="modal-btn modal-btn-ok" disabled={busy} onClick={onInitialize}>
                {busy ? 'Initializing…' : 'Yes, initialize git'}
              </button>
              <button className="modal-btn modal-btn-cancel" disabled={busy} onClick={() => setStep('warn')}>
                No
              </button>
            </>
          ) : (
            <>
              <button className="modal-btn" disabled={busy} onClick={onAcceptNoGit}>Yes, I accept</button>
              <button className="modal-btn modal-btn-ok" disabled={busy} onClick={onInitialize}>
                {busy ? 'Initializing…' : 'No, initialize git'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
