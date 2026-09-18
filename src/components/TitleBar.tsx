import { useEffect, useRef, useState } from 'react'
import type { OrchestratorStats } from '../hooks/useSocket'
import AgentPicker from './AgentPicker'

function formatMemoryMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

function CpuIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="5" y="5" width="2" height="2" fill="currentColor" stroke="none" />
      <path d="M4.5 1v2M7.5 1v2M4.5 9v2M7.5 9v2M1 4.5h2M1 7.5h2M9 4.5h2M9 7.5h2" />
    </svg>
  )
}

function RamIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
      <rect x="1" y="4" width="10" height="4" rx="1" />
      <path d="M3 6h1M5.5 6h1M8 6h1" />
      <path d="M2.5 8v1.5M4.5 8v1M6.5 8v1.5M8.5 8v1" />
    </svg>
  )
}

function SessionsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
      <rect x="1" y="2.5" width="7" height="5.5" rx="1" />
      <path d="M4 8.5h6.5A.5.5 0 0 0 11 8V3.5" />
      <path d="M2.5 4.5h1M2.5 6h3" />
    </svg>
  )
}

function useAppResourceTotals(getOrchestratorStats?: () => Promise<OrchestratorStats>) {
  const [stats, setStats] = useState<OrchestratorStats | null>(null)

  useEffect(() => {
    if (!getOrchestratorStats) return
    let cancelled = false
    const fetchStats = async () => {
      try {
        const res = await getOrchestratorStats()
        if (!cancelled && res) setStats(res)
      } catch {}
    }
    fetchStats()
    const id = setInterval(fetchStats, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [getOrchestratorStats])

  if (!stats) {
    return { cpu: null, mem: null, sessions: null, title: 'App resources (loading…)' as string }
  }

  const agentCpu = stats.totalCpuPercent
    ?? (stats.resourceUsage || []).reduce((s, r) => s + (r.cpuPercent || 0), 0)
  const appCpu = stats.appCpuPercent ?? 0
  const totalCpu = Math.round((agentCpu + appCpu) * 10) / 10

  const agentMem = stats.totalMemoryMB ?? 0
  const buckets = stats.appMemory
  const appMem = buckets ? buckets.mainMB + buckets.rendererMB + buckets.gpuMB + buckets.otherMB : 0
  const totalMem = agentMem + appMem

  const sessionCount = stats.sessionCount ?? (stats.resourceUsage?.length ?? 0)
  const procCount = stats.totalProcessCount
    ?? (stats.resourceUsage || []).reduce((s, r) => s + (r.processCount ?? 1), 0)

  const title =
    `App total · CPU ${totalCpu.toFixed(1)}% (agents ${agentCpu.toFixed(1)}% + app ${appCpu.toFixed(1)}%)` +
    ` · RAM ${formatMemoryMB(totalMem)} (agents ${formatMemoryMB(agentMem)} + app ${formatMemoryMB(appMem)})` +
    ` · ${sessionCount} sessions · ${procCount} procs`

  return { cpu: totalCpu, mem: totalMem, sessions: sessionCount, title }
}

function ResourceStats({ getOrchestratorStats }: { getOrchestratorStats?: () => Promise<OrchestratorStats> }) {
  const { cpu, mem, sessions, title } = useAppResourceTotals(getOrchestratorStats)

  return (
    <div className="title-bar-resources" title={title}>
      <span className="title-bar-resource">
        <CpuIcon />
        <span>{cpu == null ? '--' : `${cpu.toFixed(1)}%`}</span>
      </span>
      <span className="title-bar-resource">
        <RamIcon />
        <span>{mem == null ? '--' : formatMemoryMB(mem)}</span>
      </span>
      <span className="title-bar-resource">
        <SessionsIcon />
        <span>{sessions == null ? '--' : sessions}</span>
      </span>
    </div>
  )
}

interface TitleBarProps {
  getOrchestratorStats?: () => Promise<OrchestratorStats>
  onAddAgent?: () => void
  onSelectAgent?: (agentId: string) => void
  agentsList?: { id: string; name: string; icon: string }[]
  agentPickerTrigger?: number
  onToggleChatSidebar?: () => void
  chatSidebarOpen?: boolean
}

export default function TitleBar({
  getOrchestratorStats,
  onAddAgent,
  onSelectAgent,
  agentsList,
  agentPickerTrigger = 0,
  onToggleChatSidebar,
  chatSidebarOpen = false,
}: TitleBarProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const prevPickerTrigger = useRef(agentPickerTrigger)

  useEffect(() => {
    if (agentPickerTrigger !== prevPickerTrigger.current) {
      prevPickerTrigger.current = agentPickerTrigger
      if (agentsList && agentsList.length > 0) {
        setShowDropdown(o => !o)
      }
    }
  }, [agentPickerTrigger, agentsList])

  function handleAddAgentClick() {
    // Single toggle path: App's handler bumps agentPickerTrigger, the effect
    // above opens/closes the dropdown (view resets happen in App).
    onAddAgent?.()
  }

  function handleDropdownSelect(agentId: string) {
    setShowDropdown(false)
    onSelectAgent?.(agentId)
  }

  function handleDropdownClose() { setShowDropdown(false) }

  const agentActions = (
    <div className="title-bar-agent-actions">
      <button className="new-terminal-btn" onMouseDown={e => e.nativeEvent.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onClick={handleAddAgentClick}>+ Agent</button>
      <button
        className={`shell-btn ${chatSidebarOpen ? 'active' : ''}`}
        onDoubleClick={e => e.stopPropagation()}
        onClick={onToggleChatSidebar}
        title="Chat"
      >
        <i className="codicon codicon-comment-discussion" style={{ fontSize: 15.2 }}></i>
      </button>
      {showDropdown && agentsList && (
        <AgentPicker
          agents={agentsList}
          onSelect={handleDropdownSelect}
          onClose={handleDropdownClose}
        />
      )}
    </div>
  )

  const isMac = navigator.platform?.startsWith('Mac')

  if (isMac) {
    return (
      <div className="macos-title-bar" onDoubleClick={() => window.electronAPI?.windowMaximize?.()}>
        <div className="macos-traffic-light-spacer" />
        <ResourceStats getOrchestratorStats={getOrchestratorStats} />
        <div className="macos-title-drag" />
        {agentActions}
      </div>
    )
  }

  function handleMenuClick(e: React.MouseEvent, label: string) {
    window.electronAPI?.popupMenu(label, Math.round(e.screenX), Math.round(e.screenY))
  }

  const MENUS = ['File', 'Edit', 'View', 'Window', 'Help']

  return (
    <div className="title-bar">
      <div className="title-bar-menus">
        {MENUS.map(m => (
          <button key={m} className="title-bar-menu-btn" onClick={e => handleMenuClick(e, m)}>
            {m}
          </button>
        ))}
      </div>
      <div className="title-bar-drag" />
      <ResourceStats getOrchestratorStats={getOrchestratorStats} />
      <div className="title-bar-drag" />
      {agentActions}
      <div className="title-bar-window-controls">
        <button className="title-bar-win-btn" onClick={() => window.electronAPI?.windowMinimize?.()} title="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" fill="currentColor"/></svg>
        </button>
        <button className="title-bar-win-btn" onClick={() => window.electronAPI?.windowMaximize?.()} title="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button className="title-bar-win-btn title-bar-win-close" onClick={() => window.electronAPI?.windowClose?.()} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
        </button>
      </div>
    </div>
  )
}
