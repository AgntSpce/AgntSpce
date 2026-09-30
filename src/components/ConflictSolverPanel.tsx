import { useEffect, useRef, useState } from 'react'
import type { AgentConfig, AgentStartConfig, SessionState } from '../types'
import TerminalPane from './TerminalPane'

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
  /** The solver's own session, once started. Not a member of the task. */
  solverSessionId: string | null
  /** Only agents actually installed on this machine. */
  installedAgents: Record<string, boolean>
  agentConfigs: AgentConfig[]
  sessions: Record<string, SessionState>
  busy: boolean
  error: string
  statusText: string
  onInput: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onTerminalOutput?: (cb: (event: { sessionId: string, data: string }) => void) => () => void
  onStartAgent: (sessionId: string, config: AgentStartConfig) => void
  onShowAgentModal: (sessionId: string) => void
  onRestart: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  onOpenSolver: (agentId: string) => void
  onKeepTask: () => void
  onKeepMerged: () => void
  onClose: () => void
}

const AGENT_ORDER = ['claude', 'opencode', 'codex', 'gemini']

/** Conflict solver: the whole story on the left, a live agent on the right.
 *
 *  The agent is deliberately NOT part of the task. It runs in the task's
 *  worktree, so the files it edits are the ones being merged, but it is its own
 *  session — it never joins the task's agent roster, never takes one of its
 *  slots, and is closed when this panel closes. An earlier attempt reused the
 *  task's own sessions, which meant solving a conflict could hijack a running
 *  agent's terminal. */
export function ConflictSolverPanel(props: Props) {
  const {
    context, solverSessionId, installedAgents, agentConfigs, sessions, busy, error, statusText,
    onInput, onResize, onTerminalOutput, onStartAgent, onShowAgentModal,
    onRestart, onCloseSession, onOpenSolver, onKeepTask, onKeepMerged, onClose,
  } = props

  const [selected, setSelected] = useState<string>(() => {
    const available = AGENT_ORDER.filter(a => installedAgents[a])
    return available[0] || Object.keys(installedAgents).find(a => installedAgents[a]) || 'claude'
  })
  const [active, setActive] = useState<'file' | 'diff'>('file')
  const [fileIdx, setFileIdx] = useState(0)
  const fileRef = useRef<HTMLDivElement>(null)
  const agentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!context.conflictFiles.length) setFileIdx(0)
    else if (fileIdx >= context.conflictFiles.length) setFileIdx(0)
  }, [context.conflictFiles.length])

  const solverSession = solverSessionId ? sessions[solverSessionId] : undefined
  const detail = context.details[fileIdx]

  const available = AGENT_ORDER.filter(a => installedAgents[a])

  return (
    <div className="solver-overlay">
      <div className="solver-header">
        <div>
          <h2>Conflict solver</h2>
          <span className="solver-sub">
            {context.taskTitle} · {context.branchName} → {context.integrationBranch}
          </span>
        </div>
        <button className="task-chat-close" onClick={onClose} title="Close solver and stop the agent" disabled={busy}>×</button>
      </div>

      <div className="solver-body">
        {/* ---------------- left: the problem ---------------- */}
        <div className="solver-left" ref={fileRef}>
          <div className="solver-block">
            <div className="solver-label">Task goal</div>
            <div className="solver-goal">{context.userGoal || '(none given)'}</div>
          </div>

          <div className="solver-block">
            <div className="solver-label">
              Conflicting files <span className="solver-count">{context.conflictFiles.length}</span>
            </div>
            {context.conflictFiles.length === 0 && (
              <div className="solver-empty">No conflicting files. This merge can be completed directly.</div>
            )}
            <div className="solver-files">
              {context.conflictFiles.map((f, i) => (
                <button
                  key={f}
                  className={`solver-file${i === fileIdx ? ' is-active' : ''}`}
                  onClick={() => setFileIdx(i)}
                >
                  <code>{f}</code>
                </button>
              ))}
            </div>
          </div>

          {detail && (
            <div className="solver-block solver-grow">
              <div className="solver-tabs">
                <button className={active === 'file' ? 'is-active' : ''} onClick={() => setActive('file')}>Both versions</button>
                <button className={active === 'diff' ? 'is-active' : ''} onClick={() => setActive('diff')}>Diff</button>
              </div>
              {active === 'file' ? (
                <div className="solver-versions">
                  <div className="solver-version">
                    <div className="solver-version-label">This task wrote</div>
                    <pre>{detail.taskSide || '(file did not exist on this branch)'}</pre>
                  </div>
                  <div className="solver-version">
                    <div className="solver-version-label">The integration branch has</div>
                    <pre>{detail.mergedSide || '(file did not exist on the integration branch)'}</pre>
                  </div>
                </div>
              ) : (
                <pre className="solver-diff">{detail.diff || 'No textual diff between the two sides.'}</pre>
              )}
            </div>
          )}

          {error && <div className="solver-error">{error}</div>}

          <div className="solver-actions">
            <button className="modal-btn modal-btn-ok" onClick={() => onOpenSolver(selected)} disabled={busy || !selected}>
              Solve with {selected}
            </button>
            <button className="modal-btn" onClick={onKeepTask} disabled={busy}>Keep this task's version</button>
            <button className="modal-btn" onClick={onKeepMerged} disabled={busy}>Keep the merged version</button>
            <button className="modal-btn modal-btn-cancel" onClick={onClose} disabled={busy}>Close</button>
          </div>
        </div>

        {/* ---------------- right: the agent ---------------- */}
        <div className="solver-right" ref={agentRef}>
          <div className="solver-agentbar">
            <span className="solver-label">Solve with</span>
            {available.length === 0 && <span className="solver-empty">No agents found on this system.</span>}
            {available.map(a => (
              <button
                key={a}
                className={`solver-agentbtn${selected === a ? ' is-active' : ''}`}
                onClick={() => setSelected(a)}
                disabled={busy}
              >
                {a}
              </button>
            ))}
            {statusText && <span className="solver-status">{statusText}</span>}
          </div>

          <div className="solver-term">
            {solverSession ? (
              <TerminalPane
                session={solverSession}
                onInput={onInput}
                onResize={onResize}
                onRestart={onRestart}
                onStartAgent={onStartAgent}
                onShowAgentModal={onShowAgentModal}
                onClose={onCloseSession}
                writeData={''}
                agentConfigs={agentConfigs}
                style={{ height: '100%', width: '100%' }}
                onTerminalOutput={onTerminalOutput}
              />
            ) : (
              <div className="solver-idle">
                <div className="solver-idle-title">No solver agent running</div>
                <div className="solver-idle-body">
                  Pick an agent above and choose <strong>Solve with {selected}</strong>.
                  It opens in this task's worktree, gets the full conflict written out,
                  and starts working on the files that are actually being merged.
                </div>
                <div className="solver-idle-body solver-dim">
                  The agent is separate from the task: it does not take one of the task's
                  agent slots, and closing this panel stops it.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
