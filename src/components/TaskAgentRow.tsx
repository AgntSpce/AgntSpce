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
  /** One-line latest thinking/output (already ANSI-cleaned by the panel). */
  previewLine: string
  /** Timestamp of the latest output (for the relative-time meta). */
  lastLineTs: number
  getTokenUsage?: (sessionId?: string) => Promise<any>
  onSelectSession?: (sessionId: string) => void
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
  lastLineTs,
  getTokenUsage,
  onSelectSession,
}: TaskAgentRowProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; totalTokens: number; estimatedCost: number } | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // Derive the Orca state glyph from the member + live session status.
  // "working" uses the prompt-gated flag, not raw `busy` (typing echo safe).
  let state: 'working' | 'waiting' | 'done' | 'blocked' | 'exited' | 'idle' = 'idle'
  if (sessionStatus === 'exited') state = 'exited'
  else if (member.status === 'failed') state = 'blocked'
  else if (member.status === 'done') state = 'done'
  else if (isWorking) state = 'working'
  else if (sessionStatus === 'waiting') state = 'waiting'
  else if (sessionStatus === 'busy') state = 'waiting' // busy without a submitted prompt = user typing

  const glyph = (() => {
    switch (state) {
      case 'working': return <span className="orca-agent-spinner" />
      case 'waiting': return <span className="orca-agent-dot-waiting"><span className="orca-agent-question">?</span></span>
      case 'done': return <span className="orca-agent-done-dot" />
      case 'blocked': return <span className="orca-agent-alert-dot" />
      case 'exited': return <span className="orca-agent-exited">⊘</span>
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

  // Dismiss the popover on outside click / Escape.
  useEffect(() => {
    if (!detailsOpen) return
    const onDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setDetailsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetailsOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [detailsOpen])

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
          if (member.sessionId) onSelectSession?.(member.sessionId)
          setDetailsOpen(v => !v)
        }}
        title={member.sessionId ? `${member.agentId} · ${member.status} — click to focus + details` : `${member.agentId} · ${member.status}`}
      >
        <span className="orca-agent-dot">{glyph}</span>
        <AgentLogo agentId={member.agentId} size={16} />
        <div className="orca-agent-line">
          <span className={`orca-agent-primary${active ? '-focused' : ''}`}>
            {displayName}
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
            <span>Output</span>
            <span className="val">{usage ? `~${fmtTokens(usage.outputTokens)} tok` : '…'}</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Total</span>
            <span className="val">{usage ? `~${fmtTokens(usage.totalTokens)} tok` : '…'}</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Input</span>
            <span className="val muted">n/a</span>
          </div>
          <div className="orca-agent-detail-row">
            <span>Context</span>
            <span className="val muted">n/a</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(TaskAgentRow)
