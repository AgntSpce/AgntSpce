import { useEffect, useState, useCallback } from 'react'
import type { OrchestratorStats } from '../hooks/useSocket'

const TASK_ORDER = ['open', 'claimed', 'in_progress', 'merging', 'setup_failed', 'done', 'abandoned', 'escalated']

const TASK_NAMES = TASK_ORDER

const TASK_COLORS: Record<string, string> = {
  open: '#8b949e',
  claimed: '#58a6ff',
  in_progress: '#3fb950',
  merging: '#d29922',
  setup_failed: '#f85149',
  done: '#2ea043',
  abandoned: '#6e7681',
  escalated: '#f0883e',
}

function formatPct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="orch-stat-card">
      <span className="orch-stat-label">{label}</span>
      <span className="orch-stat-value" style={accent ? { color: accent } : undefined}>{value}</span>
      {sub && <span className="orch-stat-sub">{sub}</span>}
    </div>
  )
}

export default function OrchestrationPanel({ getOrchestratorStats }: { getOrchestratorStats: () => Promise<OrchestratorStats> }) {
  const [stats, setStats] = useState<OrchestratorStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await getOrchestratorStats()
      setStats(res)
      setError(null)
      setLastUpdated(Date.now())
    } catch (e: any) {
      setError(e?.message || 'Failed to fetch orchestration stats')
    } finally {
      setRefreshing(false)
    }
  }, [getOrchestratorStats])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const orch = stats?.orchestration
  const taskTotal = orch ? Object.values(orch.tasks || {}).reduce((s, n) => s + n, 0) : 0
  const taskCount = taskTotal
  const activeAgents = stats?.concurrency?.active ?? 0
  const maxAgents = stats?.concurrency?.max ?? 6
  const loadPct = maxAgents > 0 ? activeAgents / maxAgents : 0

  if (error && !stats) {
    return (
      <div className="orch-empty">
        <p>No orchestration state available</p>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{error}</span>
      </div>
    )
  }

  if (!orch) {
    return (
      <div className="orch-empty">
        <p>Orchestration not active yet</p>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Launch an agent session and it will register with the orchestrator.
        </span>
      </div>
    )
  }

  const taskEntries = TaskStatsEntries(orch.tasks)

  return (
    <div className="orch-panel">
      <div className="orch-panel-header">
        <span className="orch-panel-title">Orchestration</span>
        <span className="orch-panel-live" title={lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : undefined}>
          <span className={`orch-live-dot${refreshing ? ' refreshing' : ''}`} />
          {refreshing ? 'refreshing…' : 'live'}
        </span>
      </div>

      {/* Concurrency + agents overview */}
      <div className="orch-overview">
        <StatCard
          label="Concurrency"
          value={`${activeAgents}/${maxAgents}`}
          sub={`${loadPct >= 1 ? 'saturated' : formatPct(loadPct) + ' load'}`}
          accent={loadPct >= 1 ? '#f85149' : loadPct >= 0.7 ? '#d29922' : '#3fb950'}
        />
        <StatCard
          label="Agents"
          value={`${orch.agents.total}`}
          sub={`${orch.agents.active} active · ${orch.agents.idle} idle · ${orch.agents.paused} paused`}
        />
        <StatCard
          label="Sessions"
          value={`${orch.sessions}`}
          sub={`${stats?.sessionCount ?? 0} tracked · ${orch.worktrees} worktrees`}
        />
      </div>

      {/* Tasks by status */}
      <div className="orch-section">
        <div className="orch-section-header">
          <span className="orch-section-title">Tasks</span>
          <span className="orch-section-total">{taskCount} total · {orch.tasks['open'] ?? 0} open</span>
        </div>
        {taskCount === 0 ? (
          <div className="orch-empty-inline" style={{ padding: '12px 0' }}>
            No tasks yet — start a workflow and tasks will appear here.
          </div>
        ) : (
          <div className="orch-task-grid">
            {taskEntries.map(([status, count]) => {
              const pct = taskCount > 0 ? (count / taskCount) * 100 : 0
              return (
                <div key={status} className="orch-task-bar">
                  <div className="orch-task-meta">
                    <span className="orch-task-label">{status.replace(/_/g, ' ')}</span>
                    <span className="orch-task-count">{count}</span>
                  </div>
                  <div className="orch-task-track">
                    <div
                      className="orch-task-fill"
                      style={{ width: `${pct}%`, background: TASK_COLORS[status] || '#8b949e' }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Coordination panels */}
      <div className="orch-grid-2">
        <div className="orch-chart">
          <div className="orch-chart-header">
            <span className="orch-section-title">Messages</span>
            <span className="orch-section-total">{orch.messages.pending} pending of {orch.messages.total}</span>
          </div>
          <div className="orch-savings-table">
            <div className="savings-row">
              <span>Delivered</span>
              <span className="savings-value">{orch.messages.total - orch.messages.pending}</span>
            </div>
            <div className="savings-row">
              <span>Pending</span>
              <span className="savings-value">{orch.messages.pending}</span>
            </div>
          </div>
        </div>

        <div className="orch-chart">
          <div className="orch-chart-header">
            <span className="orch-section-title">Merge Gates</span>
            <span className="orch-section-total">
              {orch.gates.blocked + orch.gates.approved + orch.gates.rejected} total
            </span>
          </div>
          <div className="orch-session-list">
            <div className="orch-session-row">
              <span className="orch-session-name">Blocked</span>
              <span className="orch-session-val warn">{orch.gates.blocked}</span>
            </div>
            <div className="orch-session-row">
              <span className="orch-session-name">Approved</span>
              <span className="orch-session-val ok">{orch.gates.approved}</span>
            </div>
            <div className="orch-session-row">
              <span className="orch-session-name">Rejected</span>
              <span className="orch-session-val bad">{orch.gates.rejected}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="orch-grid-2">
        <div className="orch-chart">
          <div className="orch-chart-header">
            <span className="orch-section-title">Escalations</span>
            <span className={`orch-section-total${orch.escalations > 0 ? ' warn' : ''}`}>
              {orch.escalations} open
            </span>
          </div>
          <div className="orch-session-list">
            <div className="orch-session-row">
              <span className="orch-session-name">Open escalations</span>
              <span className={`orch-session-value${orch.escalations > 0 ? ' warn' : ' ok'}`}>{orch.escalations}</span>
            </div>
          </div>
        </div>

        <div className="orch-chart">
          <div className="orch-chart-header">
            <span className="orch-section-title">Completions</span>
            <span className="orch-section-total">{orch.completions} done</span>
          </div>
          <div className="orch-session-list">
            <div className="orch-session-row">
              <span className="orch-session-name">Completed tasks</span>
              <span className="orch-session-value ok">{orch.completions}</span>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}

function TaskStatsEntries(tasks: Record<string, number>): [string, number][] {
  return TASK_NAMES.filter(s => (tasks?.[s] ?? 0) > 0).map(s => [s, tasks[s]]) as [string, number][]
}