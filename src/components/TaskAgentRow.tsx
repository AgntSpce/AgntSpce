import { useEffect, useRef, useState, memo } from 'react'
import type { SessionState } from '../types'
import { getAgentColorImage } from '../agentImages'

// View model for one agent inside a task group. Built in App.tsx
// (fetchGroupMembers) from the subtask record the backend already returns.
export interface TaskMember {
  sessionId: string | null
  agentId: string
  status: string // 'pending' | 'running' | 'done' | 'failed'
  title: string
  model: string | null
  assignmentPrompt: string
  subtaskId: string
  lastEventAt: number | null
}

// Agent logo with a letter fallback (mirrors the logo used by the task rows).
function AgentLogo({ agentId, size = 16 }: { agentId: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        className="task-logo-fallback"
        style={{ width: size, height: size, fontSize: Math.max(9, size - 6) }}
        title={agentId}
      >
        {agentId.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="orca-agent-logo"
      style={{ width: size, height: size }}
      src={getAgentColorImage(agentId)}
      alt={agentId}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

function timeAgo(ts: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function fmtTokens(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return 'n/a'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface TaskAgentRowProps {
  member: TaskMember
  sessionStatus: SessionState['status'] | undefined
  /** True only when a prompt was actually submitted and the agent is responding
   *  (never from typing echo) — drives the "working" spinner. */
  isWorking: boolean
  active: boolean
  /** One-line latest thinking/output (already ANSI-cleaned + chrome-filtered).
   *  This is the "answer" line shown under the prompt. */
  previewLine: string
  /** The last message the user submitted to this agent (slash-commands
   *  excluded) — the "question" line. Empty when nothing has been asked yet. */
  lastPrompt: string
  /** Timestamp of the latest output (for the relative-time meta). */
  lastLineTs: number
  /** True once the agent was given a prompt AND finished that run — the only
   *  condition that shows the green check mark. */
  hasCompletedRun: boolean
  getTokenUsage?: (sessionId?: string) => Promise<any>
  onSelectSession?: (sessionId: string) => void
  /** True when this row's task is the one currently open in the main view. */
  isInOpenTask?: boolean
  /** Switch the main view to this row's task (used when clicking an agent that
   *  belongs to a task you're not currently viewing). */
  onOpenTask?: () => void
  /** Whether this row's stats popover is the one open (owned by the panel, so
   *  only one popover is ever open and switching agents closes the previous). */
  detailsOpen: boolean
  /** Toggle this row's stats popover. */
  onToggleDetails: () => void
}

// Orca-style agent row: name + the agent's latest line of thinking/output shown
// directly on the row. Clicking focuses the session and opens a small details
// popover (model / token usage / status).
function TaskAgentRow({
  member,
  sessionStatus,
  isWorking,
  active,
  previewLine,
  lastPrompt,
  lastLineTs,
  hasCompletedRun,
  getTokenUsage,
  onSelectSession,
  isInOpenTask,
  onOpenTask,
  detailsOpen,
  onToggleDetails,
}: TaskAgentRowProps) {
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number } | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // State → glyph:
  //   red cross — the agent stopped/failed (exited or errored)
  //   spinner   — actively working on a prompt the user submitted
  //   check     — the agent was given a prompt AND finished that run
  //   amber ?   — waiting on input/permission (no run completed yet)
  //   grey      — idle: no run given / just opened or resumed
  // `hasCompletedRun` (not raw output/status) gates the check, so merely opening
  // or resuming an agent never shows a check mark before real work is done.
  let state: 'working' | 'waiting' | 'done' | 'blocked' | 'idle' = 'idle'
  if (sessionStatus === 'exited' || member.status === 'failed') state = 'blocked'
  else if (isWorking) state = 'working'
  else if (hasCompletedRun) state = 'done'
  else if (sessionStatus === 'waiting') state = 'waiting'

  const glyph = (() => {
    switch (state) {
      case 'working': return <span className="orca-agent-spinner" />
      case 'waiting': return <span className="orca-agent-dot-waiting"><span className="orca-agent-question">?</span></span>
      // Real tick / cross marks (codicons, matching the app's icon style) rather
      // than plain dots, so a finished agent (✓) vs a stopped one (✕) reads
      // instantly.
      case 'done': return <i className="codicon codicon-check orca-agent-done-check" />
      case 'blocked': return <i className="codicon codicon-close orca-agent-alert-cross" />
      default: return <span className="orca-agent-idle-dot" />
    }
  })()

  // Pull token usage when the details popover opens.
  useEffect(() => {
    if (!detailsOpen || !member.sessionId || !getTokenUsage) return
    let cancelled = false
    getTokenUsage(member.sessionId).then((res: any) => {
      if (!cancelled) setUsage(res?.usage || null)
    }).catch(() => { if (!cancelled) setUsage(null) })
    return () => { cancelled = true }
  }, [detailsOpen, member.sessionId, getTokenUsage])

  // The stats popover is intentionally PERSISTENT: it does NOT auto-close on
  // outside-click, Escape, or navigating to another task/agent. It stays open
  // so you can browse freely, and closes only when you click the SAME agent
  // again (the row's own click toggles it). No dismiss listeners here on purpose.

  const isPending = !member.sessionId
  const displayName = member.title || member.agentId
  const preview = previewLine || (isPending ? 'pending…' : 'No output yet')
  const ts = lastLineTs || member.lastEventAt || 0
  const modelLabel = member.model || 'default'

  return (
    <div className="task-member-row-wrap" ref={rowRef}>
      <div
        className={`orca-agent-row${active ? ' focused' : ''}`}
        onClick={() => {
          // If this agent belongs to a task that isn't the one currently open in
          // the main view, switch to that task first so clicking the agent
          // actually opens its task's agent section (instead of focusing a
          // session that's hidden behind a different task). Then focus the
          // session and open the details popover.
          if (!isInOpenTask) onOpenTask?.()
          if (member.sessionId) onSelectSession?.(member.sessionId)
          onToggleDetails()
        }}
        title={member.sessionId ? `${member.agentId} · ${member.status} — click to focus + details` : `${member.agentId} · ${member.status}`}
      >
        <span className="orca-agent-dot">{glyph}</span>
        <AgentLogo agentId={member.agentId} size={16} />
        <div className="orca-agent-line">
          {/* Q&A layout: the last prompt the user gave (the "question") on top,
              the agent's live output (the "answer") underneath. Both are single
              lines that ellipsize to the panel width. Falls back to the agent
              name when nothing has been asked yet. */}
          <span className={`orca-agent-primary${active ? '-focused' : ''}`} title={lastPrompt || displayName}>
            {lastPrompt || displayName}
            <span className="orca-agent-model"> · {modelLabel}</span>
          </span>
          <span className="orca-agent-secondary">{preview}</span>
        </div>
        <div className="orca-agent-meta">
          <span className="orca-agent-time">{timeAgo(ts)}</span>
          <span className={`orca-agent-caret${detailsOpen ? ' open' : ''}`}>▾</span>
        </div>
      </div>
      {detailsOpen && (
        <div className="orca-agent-details" role="dialog" aria-label={`${displayName} details`}>
          <div className="orca-agent-details-head">
            <AgentLogo agentId={member.agentId} size={14} />
            <span className="orca-agent-details-name">{member.agentId}</span>
            <span className="orca-agent-details-model">{modelLabel}</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Status</span>
            <span className="val">{member.status}{sessionStatus ? ` · ${sessionStatus}` : ''}</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Input</span>
            <span className="val">{usage ? `~${fmtTokens(usage.inputTokens)} tok` : '—'}</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Output</span>
            <span className="val">{usage ? `~${fmtTokens(usage.outputTokens)} tok` : '—'}</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Context</span>
            <span className="val">{usage ? `~${fmtTokens(usage.totalTokens)} tok used` : '—'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(TaskAgentRow)
