import { useState, useEffect } from 'react'
import type { CreateTaskGroupInput, TaskDetailData, TaskGroupInfo } from '../types'
import { getAgentColorImage } from '../agentImages'

export interface InstalledAgent {
  id: string
  name: string
  icon: string
}

interface AgentRow {
  key: number
  agentId: string
}

type Step = 'goal' | 'name' | 'agents' | 'progress'

interface ProgressItem {
  label: string
  state: 'pending' | 'active' | 'done' | 'error'
  detail?: string
}

interface CreateTaskModalProps {
  open: boolean
  onClose: () => void
  onCreate: (input: CreateTaskGroupInput) => Promise<{ ok: boolean; taskGroup?: TaskGroupInfo; error?: string }>
  onLaunch: (taskGroupId: string) => Promise<any>
  onDetail: (taskGroupId: string) => Promise<{ ok: boolean; detail?: TaskDetailData; error?: string }>
  onLaunched?: (taskGroupId: string) => void
  agentsList: InstalledAgent[]
  repoName: string
  repoPath: string
  /** Mixed-repo workspaces: pinned-repo choices. ≤1 choice hides the picker. */
  availableRepos?: { name: string; path: string }[]
}

let rowKey = 0

const STEP_LABELS: { id: Step; label: string }[] = [
  { id: 'goal', label: 'Task' },
  { id: 'name', label: 'Name' },
  { id: 'agents', label: 'Agents' },
  { id: 'progress', label: 'Launch' },
]

export default function CreateTaskModal({ open, onClose, onCreate, onLaunch, onDetail, onLaunched, agentsList, repoName, repoPath, availableRepos }: CreateTaskModalProps) {
  const installed = agentsList.length > 0 ? agentsList : [{ id: 'claude', name: 'Claude Code', icon: '🤖' }]
  const [step, setStep] = useState<Step>('goal')
  const [goal, setGoal] = useState('')
  const [title, setTitle] = useState('')
  const [pinnedRepo, setPinnedRepo] = useState('')
  const [rows, setRows] = useState<AgentRow[]>([{ key: rowKey++, agentId: installed[0]!.id }])
  const [progress, setProgress] = useState<ProgressItem[]>([])
  const [assignments, setAssignments] = useState<{ agentId: string; title: string; scope: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [doneId, setDoneId] = useState<string | null>(null)

  // Fresh wizard on every open.
  useEffect(() => {
    if (open) {
      setStep('goal')
      setGoal('')
      setTitle('')
      setPinnedRepo('')
      setRows([{ key: rowKey++, agentId: installed[0]!.id }])
      setProgress([])
      setAssignments([])
      setBusy(false)
      setError('')
      setDoneId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ])

  if (!open) return null

  const repoChoices = (availableRepos || []).filter(r => r?.path)
  const stepIndex = STEP_LABELS.findIndex(s => s.id === step)

  function nextFromGoal() {
    if (!goal.trim()) {
      setError('Tell us what you would like to do first.')
      return
    }
    setError('')
    setTitle(prev => prev || goal.trim().slice(0, 60))
    setStep('name')
  }

  function nextFromName() {
    if (!title.trim() && !goal.trim()) {
      setError('Give the task a name first.')
      return
    }
    setError('')
    setStep('agents')
  }

  function addRow() {
    const used = new Set(rows.map(r => r.agentId))
    const next = installed.find(a => !used.has(a.id)) ?? installed[0]!
    setRows(prev => [...prev, { key: rowKey++, agentId: next.id }])
  }

  function removeRow(key: number) {
    setRows(prev => (prev.length <= 1 ? prev : prev.filter(r => r.key !== key)))
  }

  async function startLaunch() {
    const agents = rows.filter(r => r.agentId).map(r => ({ agentId: r.agentId }))
    if (agents.length === 0) {
      setError('Select at least one agent.')
      return
    }
    const trimmedTitle = title.trim() || goal.trim().slice(0, 60)
    setError('')
    setBusy(true)
    setStep('progress')
    setProgress([
      { label: 'Creating task', state: 'active' },
      { label: 'Creating git worktree', state: 'pending' },
      { label: 'Assigning subtasks', state: 'pending' },
      { label: 'Spawning agents', state: 'pending' },
    ])
    const mark = (idx: number, patch: Partial<ProgressItem>) =>
      setProgress(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
    try {
      // 1. Task record (+ subtask shells).
      const created = await onCreate({
        title: trimmedTitle,
        userGoal: goal.trim(),
        worktreeMode: 'worktree',
        agents,
        ...(pinnedRepo ? { repoPath: pinnedRepo } : {}),
      })
      if (!created?.ok || !created.taskGroup) throw new Error(created?.error || 'Failed to create task')
      const taskId = created.taskGroup.id
      mark(0, { state: 'done', detail: trimmedTitle })
      // 2–4. The assignment function plans the split, creates the isolated
      // git worktree, and spawns every agent with its own subtask prompt.
      mark(1, { state: 'active' })
      mark(2, { state: 'active' })
      mark(3, { state: 'active' })
      const launched = await onLaunch(taskId)
      if (launched && launched.ok === false) throw new Error(launched.error || 'Failed to launch agents')
      mark(1, { state: 'done', detail: 'isolated branch ready' })
      mark(2, { state: 'done', detail: launched?.usedFallback ? 'deterministic split' : 'planned by model' })
      // Show which subtask each agent received.
      try {
        const res = await onDetail(taskId)
        const subs = res?.detail?.subtasks || []
        if (subs.length > 0) {
          setAssignments(subs.map(s => ({
            agentId: s.agentId,
            title: s.title || s.status,
            scope: (s.scopeFiles || []).join(', '),
          })))
        }
      } catch {}
      mark(3, { state: 'done', detail: `${launched?.sessionIds?.length ?? agents.length} agent session(s) started` })
      setDoneId(taskId)
    } catch (e: any) {
      setProgress(prev => prev.map(p => (p.state === 'active' ? { ...p, state: 'error' } : p)))
      setError(e?.message || 'Launch failed')
    }
    setBusy(false)
  }

  function finish() {
    if (doneId && onLaunched) onLaunched(doneId)
    onClose()
  }

  function onKeyNext(e: React.KeyboardEvent, fn: () => void) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      fn()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-task-modal task-wizard" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">New Task</h3>
        <p className="modal-subtitle">Repo: {repoName || repoPath || '—'}</p>

        <div className="task-wizard-steps">
          {STEP_LABELS.map((s, i) => (
            <span key={s.id} className={`task-wizard-step${i === stepIndex ? ' active' : ''}${i < stepIndex ? ' done' : ''}`}>
              {i + 1}. {s.label}
            </span>
          ))}
        </div>

        {step === 'goal' && (
          <div className="create-task-fields">
            <label>What would you like to do?</label>
            <textarea
              className="text-input create-task-goal"
              placeholder="Create a login page with design and database…"
              value={goal}
              onChange={e => setGoal(e.target.value)}
              onKeyDown={e => onKeyNext(e, nextFromGoal)}
              rows={4}
              autoFocus
            />
          </div>
        )}

        {step === 'name' && (
          <div className="create-task-fields">
            <label>What should we name this task?</label>
            <input
              type="text"
              className="text-input"
              placeholder="Login page"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => onKeyNext(e, nextFromName)}
              autoFocus
            />
          </div>
        )}

        {step === 'agents' && (
          <div className="create-task-fields">
            <label>Select agents for this task</label>
            <div className="task-agent-rows">
              {rows.map(row => (
                <div key={row.key} className="task-agent-row">
                  <img
                    className="task-agent-logo"
                    src={getAgentColorImage(row.agentId)}
                    alt={row.agentId}
                    draggable={false}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <select
                    className="text-input task-agent-select"
                    value={row.agentId}
                    onChange={e => setRows(prev => prev.map(r => (r.key === row.key ? { ...r, agentId: e.target.value } : r)))}
                  >
                    {installed.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.icon} {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="task-remove-agent"
                    onClick={() => removeRow(row.key)}
                    disabled={rows.length <= 1}
                    title="Remove agent"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button className="task-add-agent" onClick={addRow}>+ Add agent</button>
            {repoChoices.length > 1 && (
              <>
                <label>Repository:</label>
                <select className="text-input" value={pinnedRepo} onChange={e => setPinnedRepo(e.target.value)}>
                  <option value="">{repoName || repoPath} (workspace default)</option>
                  {repoChoices.map(r => (
                    <option key={r.path} value={r.path}>{r.name || r.path}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        )}

        {step === 'progress' && (
          <div className="create-task-fields">
            <div className="task-progress-list">
              {progress.map((p, i) => (
                <div key={i} className={`task-progress-item ${p.state}`}>
                  <span className="task-progress-glyph">
                    {p.state === 'done' ? '✓' : p.state === 'active' ? '…' : p.state === 'error' ? '✕' : '○'}
                  </span>
                  <span>{p.label}</span>
                  {p.detail && <span className="task-progress-detail">{p.detail}</span>}
                </div>
              ))}
            </div>
            {assignments.length > 0 && (
              <div className="task-assignments">
                {assignments.map((a, i) => (
                  <div key={i} className="task-assignment-row">
                    <img className="task-agent-logo sm" src={getAgentColorImage(a.agentId)} alt={a.agentId} draggable={false}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    <span className="task-assignment-agent">{a.agentId}</span>
                    <span className="task-assignment-title">{a.title}{a.scope ? ` — ${a.scope}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          {step !== 'progress' ? (
            <>
              <button className="modal-btn modal-btn-cancel" onClick={onClose}>Cancel</button>
              {step !== 'goal' && (
                <button
                  className="modal-btn"
                  onClick={() => setStep(step === 'agents' ? 'name' : 'goal')}
                  disabled={busy}
                >
                  Back
                </button>
              )}
              <button
                className="modal-btn modal-btn-ok"
                onClick={() => {
                  if (step === 'goal') nextFromGoal()
                  else if (step === 'name') nextFromName()
                  else startLaunch()
                }}
                disabled={busy}
              >
                {step === 'agents' ? 'Launch task' : 'Next'}
              </button>
            </>
          ) : (
            <>
              <button className="modal-btn modal-btn-cancel" onClick={onClose}>Close</button>
              <button className="modal-btn modal-btn-ok" onClick={finish} disabled={busy || !doneId}>
                {busy ? 'Working…' : 'Open agents section'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
