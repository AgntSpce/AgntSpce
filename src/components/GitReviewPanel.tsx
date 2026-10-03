import { useState, useEffect, useRef, useCallback } from 'react'

interface FileStatus {
  filePath: string
  stagedStatus: string
  workingStatus: string
  status: string
  additions: number
  deletions: number
  staged: boolean
}

interface FullStatus {
  branch: string
  ahead: number
  behind: number
  files: FileStatus[]
  clean: boolean
  total: number
}

interface CommitEntry {
  hash: string
  message: string
  author: string
  date: string
}

interface CommitFileEntry {
  filePath: string
  status: string
  additions: number
  deletions: number
}

interface BranchEntry {
  name: string
  current: boolean
  date: string
}

interface Props {
  worktreePath: string
  onSelectDiff: (filePath: string, status: string, commitHash?: string) => void
  getGitFullStatus: (path: string) => Promise<FullStatus | null>
  getGitFileDiff: (path: string, filePath: string, base?: string, head?: string) => Promise<string | null>
  getGitLog: (path: string, maxCount?: number) => Promise<CommitEntry[] | null>
  getGitBranches: (path: string) => Promise<BranchEntry[] | null>
  getGitCommitFiles: (path: string, commitHash: string) => Promise<CommitFileEntry[] | null>
  gitStageFile: (path: string, filePath: string) => Promise<boolean>
  gitUnstageFile: (path: string, filePath: string) => Promise<boolean>
  gitCommit: (path: string, message: string) => Promise<any>
  gitPull: (path: string) => Promise<any>
  gitPush: (path: string) => Promise<any>
  gitFetch: (path: string) => Promise<any>
}

function statusBadge(code: string): string {
  switch (code) {
    case 'M': return 'M'
    case 'A': return 'A'
    case 'D': return 'D'
    case 'R': return 'R'
    case 'C': return 'C'
    case 'U': return 'U'
    case '??': return '??'
    case 'MM': return 'M'
    default: return code
  }
}

function unstagedBadge(f: FileStatus): string {
  if (f.status === 'U') return 'U'
  return statusBadge(f.workingStatus || f.status)
}

export default function GitReviewPanel({
  worktreePath, onSelectDiff,
  getGitFullStatus, getGitLog, getGitBranches, getGitCommitFiles,
  gitStageFile, gitUnstageFile, gitCommit,
  gitPull, gitPush, gitFetch,
}: Props) {
  const [status, setStatus] = useState<FullStatus | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [logs, setLogs] = useState<CommitEntry[]>([])
  // Pull/push/fetch were passed in and their socket handlers exist, but were
  // never wired to anything, so a repo with a remote had no way to sync from
  // this panel at all.
  const [remoteBusy, setRemoteBusy] = useState<'pull' | 'push' | 'fetch' | null>(null)
  const [remoteResult, setRemoteResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [branches, setBranches] = useState<BranchEntry[]>([])
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<CommitFileEntry[] | null>(null)
  // Distinguishes "still loading" from "the read failed": both leave
  // commitFiles null, and collapsing them into one state means a commit that
  // cannot be read renders as an empty dropdown with no explanation.
  const [commitFilesLoading, setCommitFilesLoading] = useState(false)
  // handleSelectCommit awaits a socket round-trip. Two commits clicked in quick
  // succession resolve out of order, and the slower response would land last —
  // showing commit A's files underneath commit B. This mirrors the selection so
  // a stale response can tell it lost the race and drop itself.
  const selectedCommitRef = useRef<string | null>(null)
  const [graphHeight, setGraphHeight] = useState(200)
  const graphRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  const stagedFiles = status?.files?.filter(f => f.staged) || []
  const unstagedFiles = status?.files?.filter(f => !f.staged) || []

  const loadStatus = useCallback(() => {
    if (!worktreePath) return
    getGitFullStatus(worktreePath).then(setStatus)
    getGitLog(worktreePath, 50).then(v => setLogs(v ?? []))
    getGitBranches(worktreePath).then(v => setBranches(v ?? []))
  }, [worktreePath, getGitFullStatus, getGitLog, getGitBranches])

  useEffect(() => {
    loadStatus()
    const id = setInterval(loadStatus, 5000)
    return () => clearInterval(id)
  }, [loadStatus])

  async function handleCommit() {
    if (!commitMsg.trim() || committing) return
    setCommitting(true)
    setCommitResult(null)
    const res = await gitCommit(worktreePath, commitMsg.trim())
    setCommitting(false)
    if (res?.ok) {
      setCommitMsg('')
      setCommitResult({ ok: true, msg: `Committed as ${res.hash?.slice(0, 8) || ''}` })
      loadStatus()
    } else {
      setCommitResult({ ok: false, msg: res?.error || 'Commit failed' })
    }
    setTimeout(() => setCommitResult(null), 4000)
  }

  async function handleSelectCommit(hash: string) {
    if (selectedCommitRef.current === hash) {
      selectedCommitRef.current = null
      setSelectedCommit(null)
      setCommitFiles(null)
      setCommitFilesLoading(false)
      return
    }
    selectedCommitRef.current = hash
    setSelectedCommit(hash)
    // Clear the previous commit's rows first, so the expanding dropdown never
    // shows one commit's files under another's heading while this one loads.
    setCommitFiles(null)
    setCommitFilesLoading(true)
    const files = await getGitCommitFiles(worktreePath, hash)
    if (selectedCommitRef.current !== hash) return
    setCommitFiles(files)
    setCommitFilesLoading(false)
  }

  // Switching workspace replaces the log underneath the open dropdown. Without
  // this the expanded commit keeps its rows, and reopening the same repo shows
  // the previous repo's files.
  useEffect(() => {
    selectedCommitRef.current = null
    setSelectedCommit(null)
    setCommitFiles(null)
    setCommitFilesLoading(false)
  }, [worktreePath])

  function onGraphMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    dragging.current = true
    const startY = e.clientY
    const startH = graphHeight
    function onMove(ev: MouseEvent) {
      if (!dragging.current) return
      const delta = startY - ev.clientY
      setGraphHeight(Math.max(80, Math.min(600, startH + delta)))
    }
    function onUp() {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      dragCleanupRef.current = null
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    dragCleanupRef.current = onUp
  }

  const currentBranch = branches?.find(b => b.current)?.name || status?.branch || ''

  return (
    <div className="git-review-panel">
      <div className="git-review-titlebar">
        <span className="git-review-title">GIT REVIEW</span>
        <span className="git-review-branch">
          <i className="codicon codicon-source-control" style={{ fontSize: 13 }}></i>
          <span className="git-review-branch-name">{currentBranch}</span>
        </span>
        <span className="git-review-remote-actions">
          {(['fetch', 'pull', 'push'] as const).map(kind => (
            <button
              key={kind}
              className="git-review-remote-btn"
              disabled={remoteBusy !== null}
              title={
                kind === 'fetch' ? 'Fetch from the remote without changing your branch'
                : kind === 'pull' ? 'Pull the remote branch into this one'
                : 'Push this branch to the remote'
              }
              onClick={async () => {
                setRemoteBusy(kind)
                setRemoteResult(null)
                try {
                  const fn = kind === 'fetch' ? gitFetch : kind === 'pull' ? gitPull : gitPush
                  const res = await fn(worktreePath)
                  setRemoteResult({
                    ok: res?.ok !== false,
                    msg: res?.error || (res?.output || res?.message || `${kind} finished`),
                  })
                  loadStatus()
                } catch (e: any) {
                  setRemoteResult({ ok: false, msg: e?.message || `${kind} failed` })
                } finally {
                  setRemoteBusy(null)
                }
              }}
            >
              {remoteBusy === kind ? `${kind}…` : kind}
            </button>
          ))}
        </span>
      </div>
      {remoteResult && (
        <div className={`git-commit-result ${remoteResult.ok ? 'ok' : 'err'}`}>{remoteResult.msg}</div>
      )}

      {/* Commit section */}
      <div className="git-commit-section">
        <textarea
          className="git-commit-input"
          placeholder="Commit message..."
          value={commitMsg}
          onChange={e => setCommitMsg(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit() }}
          rows={2}
        />
        <button
          className="git-commit-btn"
          disabled={!commitMsg.trim() || committing}
          onClick={handleCommit}
        >
          {committing ? 'Committing...' : 'Commit'}
        </button>
        {commitResult && (
          <div className={`git-commit-result ${commitResult.ok ? 'ok' : 'err'}`}>
            {commitResult.msg}
          </div>
        )}
      </div>

      {/* Staged files */}
      <div className="git-section-header">
        <span className="git-section-title">Staged Changes</span>
        {stagedFiles.length > 0 && <span className="git-section-count">{stagedFiles.length}</span>}
      </div>
      <div className="git-files-list">
        {stagedFiles.length === 0 ? (
          <div className="git-files-empty">No staged changes</div>
        ) : (
          stagedFiles.map(f => (
            <div
              key={f.filePath}
              className="git-file-item"
              onClick={() => onSelectDiff(f.filePath, f.status)}
            >
              <span className={`git-file-status git-status-${f.status}`}>
                {statusBadge(f.stagedStatus || f.status)}
              </span>
              <span className="git-file-name">{f.filePath}</span>
              <button
                className="git-file-unstage"
                onClick={e => { e.stopPropagation(); gitUnstageFile(worktreePath, f.filePath).then(loadStatus) }}
                title="Unstage"
              >
                −
              </button>
            </div>
          ))
        )}
      </div>

      {/* Untracked / unstaged files */}
      <div className="git-section-header">
        <span className="git-section-title">Untracked Files</span>
        {unstagedFiles.length > 0 && <span className="git-section-count">{unstagedFiles.length}</span>}
        {unstagedFiles.length > 0 && (
          <button
            className="git-section-stage-all"
            onClick={() => {
              Promise.all(unstagedFiles.map(f => gitStageFile(worktreePath, f.filePath))).then(loadStatus)
            }}
            title="Add all changes to staging area"
          >
            +
          </button>
        )}
      </div>
      <div className="git-files-list">
        {unstagedFiles.length === 0 ? (
          <div className="git-files-empty">No untracked changes</div>
        ) : (
          unstagedFiles.map(f => (
            <div
              key={f.filePath}
              className="git-file-item"
              onClick={() => onSelectDiff(f.filePath, f.status, f.status === 'U' ? 'EMPTY' : 'working')}
            >
              <span className={`git-file-status git-status-${f.status}`}>
                {unstagedBadge(f)}
              </span>
              <span className="git-file-name">{f.filePath}</span>
              {f.additions > 0 && <span className="git-file-additions">+{f.additions}</span>}
              {f.deletions > 0 && <span className="git-file-deletions">−{f.deletions}</span>}
              <button
                className="git-file-stage"
                onClick={e => { e.stopPropagation(); gitStageFile(worktreePath, f.filePath).then(loadStatus) }}
                title="Stage"
              >
                +
              </button>
            </div>
          ))
        )}
      </div>

      {/* Spacer + Graph */}
      <div className="git-graph-resizer" onMouseDown={onGraphMouseDown} />
      <div className="git-graph-section" ref={graphRef} style={{ height: graphHeight }}>
        <div className="git-section-header">
          <span className="git-section-title">Git Graph</span>
          <button className="git-refresh-btn" onClick={loadStatus} title="Refresh">
            <i className="codicon codicon-refresh" style={{ fontSize: 12 }}></i>
          </button>
        </div>
        <div className="git-graph-list">
          {logs.length === 0 ? (
            <div className="git-files-empty">No commits</div>
          ) : (
            logs.map((commit, idx) => {
              return (
                <div key={commit.hash}>
                  <div
                    className={`git-commit-item${selectedCommit === commit.hash ? ' selected' : ''}`}
                    onClick={() => handleSelectCommit(commit.hash)}
                  >
                    <div className="git-commit-graph">
                      <div className="git-graph-line" />
                      <div className={`git-graph-dot${idx === 0 ? ' head' : ''}`} />
                    </div>
                    <div className="git-commit-info">
                      <div className="git-commit-msg">{commit.message}</div>
                      <div className="git-commit-meta">
                        <span className="git-commit-hash">{commit.hash}</span>
                        <span className="git-commit-author">{commit.author}</span>
                        <span className="git-commit-date">{commit.date}</span>
                      </div>
                    </div>
                  </div>
                  {selectedCommit === commit.hash && (
                    <div className="git-commit-files">
                      {commitFilesLoading ? (
                        <div className="git-files-empty">Loading files…</div>
                      ) : !commitFiles ? (
                        <div className="git-files-empty">Could not read this commit's files</div>
                      ) : commitFiles.length === 0 ? (
                        <div className="git-files-empty">No files in this commit</div>
                      ) : commitFiles.map(cf => (
                        <div
                          key={cf.filePath}
                          className="git-file-item"
                          onClick={() => onSelectDiff(cf.filePath, cf.status, commit.hash)}
                        >
                          <span className={`git-file-status git-status-${cf.status}`}>
                            {statusBadge(cf.status)}
                          </span>
                          <span className="git-file-name">{cf.filePath}</span>
                          {cf.additions > 0 && <span className="git-file-additions">+{cf.additions}</span>}
                          {cf.deletions > 0 && <span className="git-file-deletions">−{cf.deletions}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
