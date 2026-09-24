import { useState } from 'react'
import type { WorkspaceInfo, SessionState, FilterStats, CommandEvent } from '../types'
import type { OrchestratorStats } from '../hooks/useSocket'
import ActivityFeed from './ActivityFeed'
import OrchestrationPanel from './OrchestrationPanel'

interface DeletedWs {
  id: string
  name: string
  deletedAt: string
}

// A prompt the user submitted to a session, stored with its
// agntspce-prompter before/after compression. Mirrors the backend
// PromptCompressEvent (electron/services/promptHistory.ts).
export interface PromptCompressEvent {
  sessionId: string
  source: 'typed' | 'agent-start'
  originalPrompt: string
  compressedPrompt: string
  originalTokens: number
  compressedTokens: number
  reduction: number
  timestamp: number
}

interface Props {
  workspaces: WorkspaceInfo[]
  sessions: Record<string, SessionState>
  activeWorkspace: WorkspaceInfo | null
  deletedWorkspaces: DeletedWs[]
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
  onPermanentDelete: (id: string) => void
  onNewWorkspace: () => void
  onClose: () => void
  filterStats?: FilterStats
  searchEvents?: CommandEvent[]
  commandHistory?: CommandEvent[]
  promptHistory?: PromptCompressEvent[]
  getOrchestratorStats?: () => Promise<OrchestratorStats>
}

type DashboardTab = 'workspaces' | 'tokens' | 'prompts' | 'orchestration'

const TAB_ORDER: { id: DashboardTab; label: string }[] = [
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'prompts', label: 'AgntSpce-PC' },
  { id: 'orchestration', label: 'Orchestration' },
]

function getSessionCount(ws: WorkspaceInfo): number {
  if (!ws.terminals) return 0
  if (Array.isArray(ws.terminals)) return ws.terminals.length
  return ws.terminals?.pairs ? ws.terminals.pairs * 2 : 0
}

function getActiveCount(sessions: Record<string, SessionState>): number {
  return Object.values(sessions).filter(s => s.status === 'busy' || s.status === 'waiting').length
}

const TOKEN_COST_PER_1K = 0.015
const BAR_CHARS = 24

function EfficiencyBar({ pct, color = '#22C55E' }: { pct: number; color?: string }) {
  const filled = Math.round((pct / 100) * BAR_CHARS)
  return (
    <span style={{ fontFamily: 'monospace', fontSize: 13, color, letterSpacing: 0 }}>
      {'█'.repeat(Math.max(0, filled))}{'░'.repeat(Math.max(0, BAR_CHARS - filled))} {pct}%
    </span>
  )
}

function OverviewCard({ label, value, change, changeClass }: { label: string; value: string; change?: string; changeClass?: string }) {
  return (
    <div className="dashboard-overview-card">
      <div className="dashboard-overview-card-header">
        <span className="dashboard-overview-label">{label}</span>
      </div>
      <span className="dashboard-overview-value">{value}</span>
      {change && <span className={`dashboard-overview-change ${changeClass || 'neutral'}`}>{change}</span>}
    </div>
  )
}

export default function Dashboard(props: Props) {
  const { workspaces, sessions, activeWorkspace, deletedWorkspaces, onSelect, onDelete, onRestore, onPermanentDelete, onClose } = props
  const filterStats = props.filterStats || { totalOriginalBytes: 0, totalFilteredBytes: 0, totalOriginalTokens: 0, totalFilteredTokens: 0, eventsProcessed: 0 }
  const searchEvents = props.searchEvents || []
  const commandHistory = props.commandHistory || []
  const promptHistory = props.promptHistory || []
  const getOrchestratorStats = props.getOrchestratorStats
  const totalSessions = Object.keys(sessions).length
  const activeCount = getActiveCount(sessions)
  const [showDeleted, setShowDeleted] = useState(false)
  const [tab, setTab] = useState<DashboardTab>('workspaces')
  const [selectedPromptSession, setSelectedPromptSession] = useState<string | null>(null)

  const totalOriginal = filterStats.totalOriginalTokens
  const totalFiltered = filterStats.totalFilteredTokens
  const totalCalls = filterStats.eventsProcessed
  const tokensSaved = totalOriginal - totalFiltered
  const pctReduction = totalOriginal > 0
    ? Math.round((tokensSaved / totalOriginal) * 100)
    : 0
  const costSaved = tokensSaved > 0 ? ((tokensSaved / 1000) * TOKEN_COST_PER_1K).toFixed(4) : '0'

  const searchTotalOrig = searchEvents.reduce((s, e) => s + e.originalTokens, 0)
  const searchTotalFilt = searchEvents.reduce((s, e) => s + e.filteredTokens, 0)
  const searchSaved = searchTotalOrig - searchTotalFilt
  const searchPct = searchTotalOrig > 0 ? Math.round((searchSaved / searchTotalOrig) * 100) : 0

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="dashboard-header-left">
          <h1>Dashboard</h1>
        </div>
        <div className="dashboard-header-actions">
          <button className="dashboard-close-btn" onClick={onClose} title="Close">
            <i className="codicon codicon-close" style={{ fontSize: 16 }}></i>
          </button>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="dashboard-tabs">
        {TAB_ORDER.map(t => (
          <button
            key={t.id}
            className={`dashboard-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="dashboard-body">
        {tab === 'workspaces' && (
          <>
            {/* Overview Stats */}
            <div className="dashboard-overview">
              <OverviewCard label="Total Sessions" value={String(totalSessions)} change={`${workspaces.length} workspaces`} />
              <OverviewCard label="Active Now" value={String(activeCount)} change={`${totalSessions - activeCount} idle`} />
            </div>

            {/* Workspace Cards */}
            <div className="dashboard-grid">
              {workspaces.map(ws => {
                const isActive = activeWorkspace?.id === ws.id
                const count = getSessionCount(ws)
                return (
                  <div
                    key={ws.id}
                    className={`dashboard-card ${isActive ? 'active' : ''}`}
                    onClick={() => onSelect(ws.id)}
                  >
                    <div className="dashboard-card-header">
                      <span className="dashboard-card-name">{ws.name}</span>
                      {isActive && <span className="dashboard-card-badge">active</span>}
                    </div>
                    <div className="dashboard-card-stats">
                      <div className="card-stat">
                        <span className="card-stat-value">{count}</span>
                        <span className="card-stat-label">sessions</span>
                      </div>
                    </div>
                    <div className="dashboard-card-footer">
                      <button
                        className="dashboard-card-btn"
                        onClick={(e) => { e.stopPropagation(); onSelect(ws.id) }}
                      >
                        {isActive ? 'Switch to' : 'Open'}
                      </button>
                      <button
                        className="dashboard-card-btn danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm(`Delete workspace "${ws.name}"?`)) onDelete(ws.id)
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Deleted Workspaces */}
            {deletedWorkspaces.length > 0 && (
              <div className="dashboard-deleted">
                <div className="dashboard-deleted-header" onClick={() => setShowDeleted(!showDeleted)}>
                  <h2>Trash ({deletedWorkspaces.length})</h2>
                  <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{showDeleted ? '▼' : '▶'}</span>
                </div>
                {showDeleted && (
                  <div className="dashboard-deleted-list">
                    {deletedWorkspaces.map(dws => (
                      <div key={dws.id} className="dashboard-deleted-item">
                        <span>{dws.name}</span>
                        <div className="dashboard-deleted-actions">
                          <button onClick={() => onRestore(dws.id)} title="Restore">↩ Restore</button>
                          <button className="danger" onClick={() => {
                            if (confirm(`Permanently delete "${dws.name}"?`)) onPermanentDelete(dws.id)
                          }} title="Permanent delete">✕ Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Activity Feed */}
            <ActivityFeed sessions={sessions} maxEvents={30} />
          </>
        )}

        {tab === 'tokens' && (
          <>
            {/* Token savings overview */}
            <div className="dashboard-overview">
              <OverviewCard label="Tokens Saved" value={tokensSaved.toLocaleString()} change={pctReduction > 0 ? `↑ ${pctReduction}% reduction` : undefined} changeClass={pctReduction > 0 ? 'up' : 'neutral'} />
              <OverviewCard label="Cost Saved" value={`$${costSaved}`} change={parseFloat(costSaved) > 0 ? '↑ estimated savings' : undefined} changeClass={parseFloat(costSaved) > 0 ? 'up' : 'neutral'} />
            </div>

            {/* Command Filter Savings */}
            {totalCalls > 0 && (
              <div className="dashboard-chart">
                <div className="dashboard-chart-header">
                  <span className="dashboard-chart-label">Command Output Filters</span>
                  <span className="dashboard-chart-legend">exact token reduction in LLM context</span>
                </div>
                <div className="dashboard-savings-table">
                  <div className="savings-row">
                    <span>Saved from LLM context:</span>
                    <span className="savings-value">{tokensSaved.toLocaleString()} tokens ({pctReduction}% reduction)</span>
                  </div>
                  <div className="savings-row">
                    <span>Efficiency:</span>
                    <EfficiencyBar pct={pctReduction} />
                  </div>
                  <div className="savings-row">
                    <span>Commands filtered:</span>
                    <span className="savings-value">{totalCalls} commands &mdash; {totalOriginal.toLocaleString()} raw tokens</span>
                  </div>
                </div>
              </div>
            )}

            {/* Code Search Savings */}
            {searchEvents.length > 0 && (
              <div className="dashboard-chart" style={{ borderLeftColor: '#8b5cf6' }}>
                <div className="dashboard-chart-header">
                  <span className="dashboard-chart-label">Code Search (agntspce-search)</span>
                  <span className="dashboard-chart-legend">estimated tokens avoided vs reading full files</span>
                </div>
                <div className="dashboard-savings-table">
                  <div className="savings-row">
                    <span>Estimated tokens avoided:</span>
                    <span className="savings-value">{searchSaved.toLocaleString()} tokens ({searchPct}% reduction)</span>
                  </div>
                  <div className="savings-row">
                    <span>Efficiency:</span>
                    <EfficiencyBar pct={searchPct} color="#8b5cf6" />
                  </div>
                  <div className="savings-row">
                    <span>Searches run:</span>
                    <span className="savings-value">{searchEvents.length} searches &mdash; {searchTotalOrig.toLocaleString()} chars of source code</span>
                  </div>
                </div>
              </div>
            )}

            {/* Per-Session Breakdown */}
            {commandHistory.length > 0 && (
              <div className="dashboard-chart" style={{ borderLeftColor: '#f59e0b' }}>
                <div className="dashboard-chart-header">
                  <span className="dashboard-chart-label">Per-Session Breakdown</span>
                  <span className="dashboard-chart-legend">tokens tracked via agntspce wrapper</span>
                </div>
                <div className="dashboard-savings-table">
                  {(() => {
                    const bySession = new Map<string, { commands: number; orig: number; filt: number; firstTs: number }>()
                    for (const e of commandHistory) {
                      if (e.command.startsWith('agntspce-search')) continue
                      const s = bySession.get(e.sessionId) || { commands: 0, orig: 0, filt: 0, firstTs: e.timestamp }
                      s.commands++
                      s.orig += e.originalTokens
                      s.filt += e.filteredTokens
                      if (e.timestamp < s.firstTs) s.firstTs = e.timestamp
                      bySession.set(e.sessionId, s)
                    }
                    const sorted = [...bySession.entries()].sort((a, b) => b[1].orig - a[1].orig)
                    return sorted.map(([sid, stats]) => {
                      const saved = stats.orig - stats.filt
                      const pct = stats.orig > 0 ? Math.round((saved / stats.orig) * 100) : 0
                      const ts = new Date(stats.firstTs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                      return (
                        <div key={sid} className="savings-row" style={{ fontSize: 12, padding: '4px 0' }}>
                          <span style={{ color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 11 }}>
                            {sid} <span style={{ opacity: 0.7 }}>&middot; {ts}</span>
                          </span>
                          <span style={{ marginLeft: 8 }}>
                            {stats.commands} cmd{stats.commands !== 1 ? 's' : ''} &mdash;
                            {' '}{stats.orig.toLocaleString()} raw &rarr; {stats.filt.toLocaleString()} filtered
                            <span style={{ color: pct > 0 ? '#22C55E' : 'var(--text-dim)', marginLeft: 8 }}>
                              ({pct}% saved)
                            </span>
                          </span>
                        </div>
                      )
                    })
                  })()}
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                  Raw token counts come from the <code>agntspce</code> wrapper's <code>spawnSync</code> capture; filtered counts come from the wrapper's <code>applyFilter</code> output.
                  Commands not run through the wrapper (e.g. <code>git status</code> without <code>agntspce</code>) are detected via shell prompt patterns
                  and use the RTK filter pipeline. Fallback events capture terminal output when no shell command can be identified.
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'prompts' && (
          <>
            {(() => {
              // One card per full prompt: consecutive typed lines submitted
              // close together (multi-line paste, multi-Enter compose) merge
              // into a single before/after entry. Short per-line submits
              // stored verbatim (compressed == original) are skipped so
              // shell one-liners never flood this list.
              const GROUP_GAP_MS = 30_000
              interface PromptGroup {
                key: string
                source: 'typed' | 'agent-start'
                lines: number
                originalPrompt: string
                compressedPrompt: string
                orig: number
                filt: number
                reduction: number
                latest: number
              }
              const bySession = new Map<string, PromptGroup[]>()
              const compressedOnly = promptHistory.filter(e => e.compressedTokens < e.originalTokens)
              for (const e of [...compressedOnly].sort((a, b) => a.timestamp - b.timestamp)) {
                let list = bySession.get(e.sessionId)
                if (!list) {
                  list = []
                  bySession.set(e.sessionId, list)
                }
                const last = list[list.length - 1]
                if (e.source === 'typed' && last && last.source === 'typed' && e.timestamp - last.latest <= GROUP_GAP_MS) {
                  last.lines += 1
                  last.originalPrompt += '\n' + e.originalPrompt
                  last.compressedPrompt += '\n' + e.compressedPrompt
                  last.orig += e.originalTokens
                  last.filt += e.compressedTokens
                  last.reduction = last.orig > 0 ? Math.round((1 - last.filt / last.orig) * 10000) / 100 : 0
                  last.latest = e.timestamp
                } else {
                  list.push({
                    key: `${e.sessionId}-${e.timestamp}-${list.length}`,
                    source: e.source,
                    lines: 1,
                    originalPrompt: e.originalPrompt,
                    compressedPrompt: e.compressedPrompt,
                    orig: e.originalTokens,
                    filt: e.compressedTokens,
                    reduction: e.reduction,
                    latest: e.timestamp,
                  })
                }
              }
              const groups = [...bySession.entries()].map(([sid, items]) => {
                const sorted = [...items].sort((a, b) => b.latest - a.latest)
                const orig = sorted.reduce((s, g) => s + g.orig, 0)
                const filt = sorted.reduce((s, g) => s + g.filt, 0)
                const saved = orig - filt
                return {
                  sid,
                  items: sorted,
                  count: sorted.length,
                  orig,
                  filt,
                  saved,
                  pct: orig > 0 ? Math.round((saved / orig) * 100) : 0,
                  latest: sorted.length > 0 ? sorted[0].latest : 0,
                }
              }).sort((a, b) => b.latest - a.latest)
              if (groups.length === 0) {
                return (
                  <div className="dashboard-chart">
                    <div className="dashboard-chart-header">
                      <span className="dashboard-chart-label">AgntSpce-PC</span>
                      <span className="dashboard-chart-legend">before &rarr; after per session</span>
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      No prompts recorded yet. Type a prompt into any agent terminal and press Enter —
                      or start an agent with a prompt — and each before/after compression will appear here, newest first.
                    </p>
                  </div>
                )
              }
              const active = groups.find(g => g.sid === selectedPromptSession) || groups[0]
              const totalOrig = groups.reduce((s, g) => s + g.orig, 0)
              const totalFilt = groups.reduce((s, g) => s + g.filt, 0)
              const totalSaved = totalOrig - totalFilt
              const totalPct = totalOrig > 0 ? Math.round((totalSaved / totalOrig) * 100) : 0
              const totalCount = groups.reduce((s, g) => s + g.count, 0)
              return (
                <>
                <div className="dashboard-overview">
                  <OverviewCard label="Prompt Tokens Saved" value={totalSaved.toLocaleString()} change={totalPct > 0 ? `↑ ${totalPct}% reduction` : undefined} changeClass={totalPct > 0 ? 'up' : 'neutral'} />
                  <OverviewCard label="Prompts Compressed" value={String(totalCount)} change={`${totalOrig.toLocaleString()} → ${totalFilt.toLocaleString()} tokens`} />
                </div>
                <div className="dashboard-chart">
                  <div className="dashboard-chart-header">
                    <span className="dashboard-chart-label">AgntSpce-PC</span>
                    <span className="dashboard-chart-legend">before &rarr; after per session, newest first</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    {/* Session list */}
                    <div style={{ minWidth: 220, maxWidth: 280, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {groups.map(g => {
                        const meta = sessions[g.sid]
                        const label = meta ? `${meta.type} · ${meta.branch}` : `session ${g.sid.slice(0, 12)}…`
                        const isActive = g.sid === active.sid
                        const ts = new Date(g.latest).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        return (
                          <button
                            key={g.sid}
                            onClick={() => setSelectedPromptSession(g.sid)}
                            style={{
                              textAlign: 'left',
                              padding: '8px 10px',
                              borderRadius: 6,
                              cursor: 'pointer',
                              background: isActive ? 'rgba(34,197,94,0.12)' : 'transparent',
                              border: isActive ? '1px solid #22C55E' : '1px solid var(--border, #2e2e2e)',
                              color: 'inherit',
                            }}
                          >
                            <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'monospace' }}>{g.sid.slice(0, 12)} · {ts}</div>
                            <div style={{ fontSize: 11, color: g.pct > 0 ? '#22C55E' : 'var(--text-dim)' }}>
                              {g.count} prompt{g.count !== 1 ? 's' : ''} · {g.saved.toLocaleString()} tokens saved ({g.pct}%)
                            </div>
                          </button>
                        )
                      })}
                    </div>
                    {/* Before/after detail, latest to oldest */}
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 560, overflowY: 'auto' }}>
                      {active.items.map((g) => {
                        const ts = new Date(g.latest).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        // Full prompt bodies are rendered verbatim — no
                        // character truncation. The <pre> scrolls (maxHeight
                        // + overflow auto) so large prompts stay readable.
                        const fullText = (text: string) => {
                          if (!text) return '(empty)'
                          return text
                        }
                        return (
                          <div key={g.key} style={{ border: '1px solid var(--border, #2e2e2e)', borderRadius: 6, padding: 8 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                              <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                                {g.source === 'agent-start' ? 'agent start prompt' : g.lines > 1 ? `typed prompt · ${g.lines} lines` : 'typed prompt'}
                              </span>
                              <span style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap', fontSize: 11 }}>{ts}</span>
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                              {g.orig.toLocaleString()} &rarr; {g.filt.toLocaleString()} tokens
                              <span style={{ color: g.reduction > 0 ? '#22C55E' : 'var(--text-dim)', marginLeft: 6 }}>
                                ({g.reduction}% saved)
                              </span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 4 }}>Before</div>
                                <pre style={{ margin: 0, padding: 6, borderRadius: 4, background: 'rgba(255,255,255,0.04)', fontSize: 11, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{fullText(g.originalPrompt)}</pre>
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: '#22C55E', marginBottom: 4 }}>After (compressed)</div>
                                <pre style={{ margin: 0, padding: 6, borderRadius: 4, background: 'rgba(34,197,94,0.07)', fontSize: 11, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{fullText(g.compressedPrompt)}</pre>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                    Prompts are recorded when you press Enter in a terminal or start an agent with a prompt; full before/after bodies are shown.
                  </div>
                </div>
                </>
              )
            })()}
          </>
        )}

        {tab === 'orchestration' && (
          getOrchestratorStats ? (
            <OrchestrationPanel getOrchestratorStats={getOrchestratorStats} />
          ) : (
            <div className="orch-empty">
              <p>Orchestration stats unavailable</p>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                The orchestrator socket handler is not wired up.
              </span>
            </div>
          )
        )}
      </div>
    </div>
  )
}
