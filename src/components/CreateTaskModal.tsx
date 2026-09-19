import { useState } from 'react'
import type { AgentConfig, CreateTaskGroupInput } from '../types'

interface AgentRow {
  key: number
  agentId: string
  model: string
}

interface CreateTaskModalProps {
  open: boolean
  onClose: () => void
  onCreate: (input: CreateTaskGroupInput) => Promise<{ ok: boolean; error?: string }>
  agentConfigs: AgentConfig[]
  repoName: string
  repoPath: string
  /** Mixed-repo workspaces: pinned-repo choices. ≤1 choice hides the picker. */
  availableRepos?: { name: string; path: string }[]
}

let rowKey = 0

function defaultModelFor(config: AgentConfig | undefined): string {
  if (!config) return ''
  return config.defaultModel ?? config.models?.[0] ?? ''
}

function modelOptions(config: AgentConfig | undefined): string[] {
  if (!config) return []
  if (config.models && config.models.length > 0) return config.models
  if (config.defaultModel) return [config.defaultModel]
  return []
}

export default function CreateTaskModal({ open, onClose, onCreate, agentConfigs, repoName, repoPath, availableRepos }: CreateTaskModalProps) {
  const firstAgent = agentConfigs[0]?.id ?? 'claude'
  const repoChoices = (availableRepos || []).filter(r => r?.path)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [pinnedRepo, setPinnedRepo] = useState('')
  const [rows, setRows] = useState<AgentRow[]>([
    { key: rowKey++, agentId: firstAgent, model: '' },
  ])
  const [worktreeMode, setWorktreeMode] = useState<'worktree' | 'in-repo'>('worktree')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  function agentConfigFor(agentId: string): AgentConfig | undefined {
    return agentConfigs.find(a => a.id === agentId)
  }

  function handleAgentChange(key: number, agentId: string) {
    setRows(prev => prev.map(r => {
      if (r.key !== key) return r
      const config = agentConfigFor(agentId)
      return { ...r, agentId, model: defaultModelFor(config) }
    }))
  }

  function addRow() {
    setRows(prev => [...prev, { key: rowKey++, agentId: firstAgent, model: defaultModelFor(agentConfigFor(firstAgent)) }])
  }

  function removeRow(key: number) {
    setRows(prev => (prev.length <= 1 ? prev : prev.filter(r => r.key !== key)))
  }

  async function handleCreate() {
    const trimmedGoal = goal.trim()
    const trimmedTitle = title.trim() || trimmedGoal.slice(0, 60)
    if (!trimmedTitle) {
      setError('Describe the task first.')
      return
    }
    const agents = rows
      .filter(r => r.agentId)
      .map(r => ({
        agentId: r.agentId,
        ...(r.model ? { model: r.model } : {}),
      }))
    if (agents.length === 0) {
      setError('Pick at least one agent.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await onCreate({ title: trimmedTitle, userGoal: trimmedGoal, worktreeMode, agents, ...(pinnedRepo ? { repoPath: pinnedRepo } : {}) })
      if (res?.ok) {
        setTitle('')
        setGoal('')
        setPinnedRepo('')
        onClose()
      } else {
        setError(res?.error || 'Failed to create task')
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to create task')
    }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal create-task-modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">New Task</h3>
        {repoChoices.length > 1 ? (
          <>
            <label>Repository:</label>
            <select
              className="text-input"
              value={pinnedRepo}
              onChange={e => setPinnedRepo(e.target.value)}
            >
              <option value="">{repoName || repoPath} (workspace default)</option>
              {repoChoices.map(r => (
                <option key={r.path} value={r.path}>{r.name || r.path}</option>
              ))}
            </select>
          </>
        ) : (
          <p className="modal-subtitle">Repo: {repoName || repoPath || '—'}</p>
        )}

        <div className="create-task-fields">
          <label>Title:</label>
          <input
            type="text"
            className="text-input"
            placeholder="Login page with design + database"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />

          <label>Task:</label>
          <textarea
            className="text-input create-task-goal"
            placeholder="Describe what the agents should build…"
            value={goal}
            onChange={e => setGoal(e.target.value)}
            rows={4}
          />

          <label>Agents:</label>
          <div className="task-agent-rows">
            {rows.map(row => {
              const config = agentConfigFor(row.agentId)
              const options = modelOptions(config)
              return (
                <div key={row.key} className="task-agent-row">
                  <select
                    className="text-input task-agent-select"
                    value={row.agentId}
                    onChange={e => handleAgentChange(row.key, e.target.value)}
                  >
                    {agentConfigs.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.icon} {a.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="text-input task-model-select"
                    value={row.model}
                    onChange={e => setRows(prev => prev.map(r => (r.key === row.key ? { ...r, model: e.target.value } : r)))}
                    disabled={options.length === 0}
                    title="Model"
                  >
                    {options.length === 0 && <option value="">Default</option>}
                    {options.map(m => (
                      <option key={m} value={m}>{m}</option>
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
              )
            })}
          </div>
          <button className="task-add-agent" onClick={addRow}>+ Add agent</button>

          <label>Isolation:</label>
          <div className="task-mode-toggle">
            <button
              className={`tab-btn ${worktreeMode === 'worktree' ? 'active' : ''}`}
              onClick={() => setWorktreeMode('worktree')}
              title="Each task gets its own git worktree + branch"
            >
              Isolated worktree
            </button>
            <button
              className={`tab-btn ${worktreeMode === 'in-repo' ? 'active' : ''}`}
              onClick={() => setWorktreeMode('in-repo')}
              title="Work on a branch in the main checkout"
            >
              In-repo branch
            </button>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn-ok" onClick={handleCreate} disabled={loading}>
            {loading ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  )
}
