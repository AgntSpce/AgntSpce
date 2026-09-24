import { useState, useEffect, useCallback } from 'react'
import type { TaskDetailData } from '../types'

export interface TasksApi {
  getDetail: (taskGroupId: string) => Promise<{ ok: boolean; detail?: TaskDetailData; error?: string }>
  closeTask: (taskGroupId: string, abandon?: boolean) => Promise<any>
  mergeTask?: (taskGroupId: string) => Promise<any>
  confirmTaskMerge?: (taskGroupId: string) => Promise<any>
}

interface TaskChatProps {
  taskGroupId: string
  tasksApi: TasksApi
  onClose: () => void
}

function formatMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

export default function TaskChat({ taskGroupId, tasksApi, onClose }: TaskChatProps) {
  const [detail, setDetail] = useState<TaskDetailData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<{ diffSummary: string; conflictFiles: string[]; resolvedDiff?: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await tasksApi.getDetail(taskGroupId)
      if (res?.ok && res.detail) setDetail(res.detail)
      else if (res && !res.ok) setError(res.error || 'Failed to load task')
    } catch (e: any) {
      setError(e?.message || 'Failed to load task')
    }
  }, [tasksApi, taskGroupId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  async function run(key: string, fn: () => Promise<any>) {
    setBusy(key)
    setError('')
    try {
      const res = await fn()
      if (res && res.ok === false) setError(res.error || 'Action failed')
      else await refresh()
    } catch (e: any) {
      setError(e?.message || 'Action failed')
    }
    setBusy(null)
  }

  async function runMerge() {
    if (!tasksApi.mergeTask) return
    setBusy('merge')
    setError('')
    setPendingConfirm(null)
    try {
      const res = await tasksApi.mergeTask(taskGroupId)
      if (res && res.ok === false && !res.needsConfirm) setError(res.error || 'Merge failed')
      else if (res?.needsConfirm) {
        // LLM-resolved candidate: human must approve the diff before it lands.
        setPendingConfirm({
          diffSummary: res.diffSummary || '',
          conflictFiles: res.conflictFiles || [],
          resolvedDiff: res.resolvedDiff,
        })
      } else await refresh()
    } catch (e: any) {
      setError(e?.message || 'Merge failed')
    }
    setBusy(null)
  }

  async function confirmMerge() {
    if (!tasksApi.confirmTaskMerge) return
    await run('confirm', () => tasksApi.confirmTaskMerge!(taskGroupId))
    setPendingConfirm(null)
  }

  const group = detail?.group
  const staleAgents = new Set(
    (detail?.warnings || []).filter(w => w.type === 'stale').map(w => w.message.split(' has posted')[0])
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal task-chat-modal" onClick={e => e.stopPropagation()}>
        <div className="task-chat-header">
          <div>
            <h3 className="modal-title">{group?.title || 'Task'}</h3>
            {group && (
              <p className="modal-subtitle">
                {group.status}{group.branchName ? ` · ${group.branchName}` : ''}{group.worktreeMode === 'in-repo' ? ' · in-repo' : ''}
              </p>
            )}
          </div>
          <button className="task-chat-close" onClick={onClose} title="Close">×</button>
        </div>

        {detail?.resources && (
          <div className="task-chat-resources" title="Live resource usage for this task's agents">
            CPU {detail.resources.cpuPercent.toFixed(1)}% · RAM {formatMem(detail.resources.memoryMB)} · {detail.resources.sessionCount} session{detail.resources.sessionCount === 1 ? '' : 's'}
          </div>
        )}

        {detail?.summary?.summary && (
          <div className="task-chat-summary">{detail.summary.summary}</div>
        )}

        {(detail?.warnings || []).length > 0 && (
          <div className="task-chat-warnings">
            {detail!.warnings.map((w, i) => (
              <div key={i} className={`task-chat-warning ${w.type}`}>⚠ {w.message}</div>
            ))}
          </div>
        )}

        <div className="task-chat-subtasks">
          {(detail?.subtasks || []).map(s => (
            <div key={s.id} className="task-chat-subtask">
              <span className="task-chat-subtask-agent">{s.agentId}{s.model ? ` (${s.model})` : ''}</span>
              <span className="task-chat-subtask-title">{s.title || s.status}</span>
              <span className={`task-chat-subtask-status ${s.status}`}>{s.status}</span>
              {staleAgents.has(s.agentId) && <span className="task-chat-stale" title="No update posted recently">stale</span>}
            </div>
          ))}
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="task-chat-actions">
          {group && group.status === 'active' && (
            <button className="modal-btn" disabled={!!busy} onClick={() => run('close', () => tasksApi.closeTask(taskGroupId))}>
              {busy === 'close' ? 'Pausing…' : 'Pause agents'}
            </button>
          )}
          {group && tasksApi.mergeTask && (group.status === 'active' || group.status === 'done') && (
            <button className="modal-btn" disabled={!!busy} onClick={runMerge}>
              {busy === 'merge' ? 'Merging…' : 'Merge task'}
            </button>
          )}
          {group && group.status !== 'done' && group.status !== 'abandoned' && (
            <button
              className="modal-btn modal-btn-danger"
              disabled={!!busy}
              onClick={() => { if (confirm(`Abandon "${group.title}"? Running agents will be stopped.`)) run('abandon', () => tasksApi.closeTask(taskGroupId, true)) }}
            >
              Abandon
            </button>
          )}
        </div>

        {pendingConfirm && (
          <div className="task-chat-confirm">
            <div className="task-chat-confirm-title">Review LLM-resolved merge before it lands</div>
            {pendingConfirm.conflictFiles.length > 0 && (
              <div className="task-chat-confirm-files">Resolved conflicts in: {pendingConfirm.conflictFiles.join(', ')}</div>
            )}
            <pre className="task-chat-confirm-diff">{pendingConfirm.resolvedDiff || pendingConfirm.diffSummary}</pre>
            <div className="task-chat-actions">
              <button className="modal-btn modal-btn-ok" disabled={!!busy} onClick={confirmMerge}>
                {busy === 'confirm' ? 'Landing…' : 'Confirm & land merge'}
              </button>
              <button className="modal-btn modal-btn-cancel" disabled={!!busy} onClick={() => setPendingConfirm(null)}>
                Review later
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
