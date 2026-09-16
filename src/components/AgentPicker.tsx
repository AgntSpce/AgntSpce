import { useEffect, useRef, useState } from 'react'
import { getAgentColorImage } from '../agentImages'

interface AgentItem {
  id: string
  name: string
  icon: string
}

interface Props {
  agents: AgentItem[]
  onSelect: (id: string) => void
  onClose: () => void
}

export default function AgentPicker({ agents, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState(0)
  const highlightRef = useRef(0)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  // Refs so the capture-phase key handler below never closes over stale props.
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  function setHighlightBoth(i: number) {
    highlightRef.current = i
    setHighlight(i)
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  // Arrow/Enter/Escape navigation. Capture phase + stopPropagation so a
  // focused xterm/Monaco underneath doesn't also consume the keystroke
  // (typing a newline into the terminal while picking, or swallowing Esc).
  // App's own shortcut handler ignores non-meta arrows/enter/esc, so nothing
  // else needs shielding.
  useEffect(() => {
    function handleNavKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      const list = agentsRef.current
      if (list.length === 0) return
      if (e.key === 'Enter') {
        const picked = list[highlightRef.current] ?? list[0]
        if (picked) onSelectRef.current(picked.id)
        return
      }
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const next = (highlightRef.current + dir + list.length) % list.length
      setHighlightBoth(next)
    }
    document.addEventListener('keydown', handleNavKey, true)
    return () => {
      document.removeEventListener('keydown', handleNavKey, true)
    }
  }, [])

  // Keep the highlighted row visible in long agent lists.
  useEffect(() => {
    try { itemRefs.current[highlight]?.scrollIntoView({ block: 'nearest' }) } catch {}
  }, [highlight])

  return (
    <div className="agent-dropdown" ref={ref} onClick={e => e.stopPropagation()}>
      {agents.map((a, i) => (
        <div
          key={a.id}
          ref={el => { itemRefs.current[i] = el }}
          className={`agent-dropdown-item${i === highlight ? ' highlighted' : ''}`}
          onClick={() => onSelect(a.id)}
          onMouseEnter={() => setHighlightBoth(i)}
          title={a.name}
        >
          <img className="agent-dropdown-color" src={getAgentColorImage(a.id)} alt={a.name} />
          <span className="agent-dropdown-name">{a.name}</span>
        </div>
      ))}
    </div>
  )
}
