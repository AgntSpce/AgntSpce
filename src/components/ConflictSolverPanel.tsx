import { useEffect, useState } from 'react'
import GitDiffViewer from './GitDiffViewer'

export interface ConflictFile {
  file: string
  taskSide: string
  mergedSide: string
  diff: string
}

export interface ConflictContext {
  taskId: string
  taskTitle: string
  userGoal: string
  branchName: string | null
  worktreePath: string | null
  integrationBranch: string
  conflictFiles: string[]
  details: ConflictFile[]
  brief: string
}

interface Props {
  context: ConflictContext
  theme: 'dark' | 'light'
  busy: boolean
  error: string
  onRefresh: () => void
  onKeepTask: () => void
  onKeepMerged: () => void
  onClose: () => void
}

/** Conflict solver: the conflict on the left, the selected file's diff on the right.
 *
 *  This used to host an agent that tried to resolve the conflict for you. It is
 *  gone: the agent never got a usable session (the create-session socket emits
 *  `session-created` but never answers the ack, so the caller's promise never
 *  resolved and the panel sat on "Starting…" forever), and a conflict is a
 *  decision about intent, not a mechanical merge. Both versions are now on
 *  screen side by side, and landing one is an explicit click. */
export function ConflictSolverPanel(props: Props) {
  const { context, theme, busy, error, onRefresh, onKeepTask, onKeepMerged, onClose } = props
  const [idx, setIdx] = useState(0)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    if (idx >= context.details.length) setIdx(0)
  }, [context.details.length, idx])

  // Escape closes, the way every other overlay in the app behaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const detail = context.details[idx]
  const currentFile = context.conflictFiles[idx]
  const hasConflict = context.conflictFiles.length > 0

  return (
    <div className="solver-overlay" role="dialog" aria-label="Conflict solver">
      <div className="solver-header">
        <div className="solver-headtext">
          <h2>Conflict solver</h2>
          <span className="solver-sub">
            {context.taskTitle} · {context.branchName} → {context.integrationBranch}
          </span>
        </div>
        <div className="solver-headbtns">
          <button className="modal-btn" onClick={onRefresh} disabled={busy}>Refresh</button>
          <button className="solver-x" onClick={onClose} disabled={busy} title="Close conflict solver" aria-label="Close">×</button>
        </div>
      </div>

      <div className="solver-body">
        {/* -------- left: what disagrees -------- */}
        <div className="solver-left">
          <div className="solver-block">
            <div className="solver-label">Task goal</div>
            <div className="solver-goal">{context.userGoal || '(none given)'}</div>
          </div>

          <div className="solver-block solver-filesblock">
            <div className="solver-label">
              Conflicting files
              <span className="solver-count">{context.conflictFiles.length}</span>
            </div>
            {!hasConflict && (
              <div className="solver-empty">
                Nothing conflicts any more. Close this and use Merge changes to land the work.
              </div>
            )}
            <div className="solver-files">
              {context.conflictFiles.map((f, i) => (
                <button
                  key={f}
                  className={`solver-file${i === idx ? ' is-active' : ''}`}
                  onClick={() => setIdx(i)}
                  title={f}
                >
                  <code>{f}</code>
                </button>
              ))}
            </div>
          </div>

          {detail && (
            <div className="solver-block solver-grow">
              <div className="solver-tabs">
                <button className={showRaw ? '' : 'is-active'} onClick={() => setShowRaw(false)}>Side by side</button>
                <button className={showRaw ? 'is-active' : ''} onClick={() => setShowRaw(true)}>Git format</button>
              </div>
              {showRaw ? (
                <pre className="solver-raw">{detail.diff || 'No textual diff — the two sides are identical here.'}</pre>
              ) : (
                <div className="solver-note">
                  Left is what <code>{context.integrationBranch}</code> already has. Right is what this task wrote.
                  Pick the side to keep below.
                </div>
              )}
            </div>
          )}

          {error && <div className="solver-error">{error}</div>}

          <div className="solver-actions">
            <button className="modal-btn modal-btn-ok" onClick={onKeepTask} disabled={busy || !hasConflict}>
              {busy ? 'Working…' : "Keep this task's version"}
            </button>
            <button className="modal-btn" onClick={onKeepMerged} disabled={busy || !hasConflict}>
              Keep the merged version
            </button>
            <button className="modal-btn modal-btn-cancel" onClick={onClose} disabled={busy}>Close</button>
          </div>
        </div>

        {/* -------- right: the selected file -------- */}
        <div className="solver-right">
          {detail && currentFile ? (
            <GitDiffViewer
              key={currentFile}
              diffContent={detail.diff}
              filePath={currentFile}
              gitStatus="conflict"
              theme={theme}
              language={guessLanguage(currentFile)}
            />
          ) : (
            <div className="solver-idle">
              <div className="solver-idle-title">Nothing to compare</div>
              <div className="solver-idle-body">
                Pick a file on the left to see both versions side by side.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Best-effort language for Monaco's syntax highlighting. */
function guessLanguage(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', sh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', sql: 'sql',
  }
  return map[ext] || 'plaintext'
}
