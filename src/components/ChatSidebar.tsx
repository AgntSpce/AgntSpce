import { useState, useEffect, useRef, useCallback, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import useSocketEvent from '../hooks/useSocketEvent'
import type { ChatMessage, ChatModelInfo, ChatThread, StreamChunk, ChatAttachment } from '../types'
import { apiHeadersSync } from '../utils/serverAuth'

interface Props {
  onClose: () => void
  onNavigateToSettings?: () => void
  socket: {
    chatGetModels: () => Promise<ChatModelInfo[]>
    chatSendStream: (threadId: string, providerId: string, content: string, model?: string, attachments?: ChatAttachment[]) => void
    chatStopStream: (threadId: string) => void
    chatGetHistory: (threadId: string) => Promise<{ threadId: string; messages: ChatMessage[] }>
    chatListThreads: () => Promise<ChatThread[]>
    chatCreateThread: (providerId: string, model: string) => Promise<ChatThread | null>
    chatRenameThread: (threadId: string, title: string) => void
    chatClearThread: (threadId: string) => void
    chatDeleteThread: (threadId: string) => void
    onChatStreamChunk: (cb: (data: StreamChunk) => void) => () => void
    onChatResponse: (cb: (data: { threadId: string; message: ChatMessage }) => void) => () => void
    onChatError: (cb: (data: { threadId: string; error: string }) => void) => () => void
    onChatThreads: (cb: (data: { threads: ChatThread[] }) => void) => () => void
  }
}

const SERVER_URL = 'http://127.0.0.1:9460'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ── Attachments (images + files) ─────────────────────────────
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_PENDING_ATTACHMENTS = 6

interface PendingAttachment {
  id: string
  name: string
  mediaType: string
  kind: 'image' | 'file'
  data: string   // base64 (image/pdf) or raw text — what gets sent
  dataUrl?: string // thumbnail preview for images
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsText(file)
  })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// Stable plugin identity so ReactMarkdown doesn't see a new array on every
// MessageItem render (avoids redundant markdown re-parse/GC churn). No
// behavior change — same single remarkGfm plugin.
const CHAT_REMARK_PLUGINS = [remarkGfm]

// Memoized so that unrelated re-renders (e.g. the parent App re-rendering on
// every status/command event, or a sibling message streaming in) do NOT force
// all ~2000 messages to be re-parsed by ReactMarkdown. Without this, an open
// chat with a long history re-parses the entire history several times per
// second, saturating the renderer's main thread — which in turn stalls Socket.IO
// processing and lets the main process accumulate an unbounded terminal-output
// buffer (the multi-GB RAM growth). Only the message whose object actually
// changed (the one streaming) re-renders.
const MessageItem = memo(function MessageItem({ msg }: { msg: ChatMessage }) {
  return (
    <div className={`chat-msg ${msg.role}${msg.error ? ' chat-msg-error' : ''}`}>
      <div className="chat-msg-avatar">
        <i className={`codicon ${msg.role === 'assistant' ? 'codicon-robot' : 'codicon-person'}`} style={{ fontSize: 14 }}></i>
      </div>
      <div className="chat-msg-content">
        <div className="chat-msg-sender">
          {msg.role === 'assistant' ? 'Assistant' : 'You'}
          {msg.model && <span className="chat-msg-provider"> · {msg.model}</span>}
        </div>
        <div className="chat-msg-text">
          {msg.role === 'assistant' ? (
            <div className="chat-md">
              <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS}>{msg.content}</ReactMarkdown>
              {msg.streaming && msg.content && <span className="chat-cursor">|</span>}
              {!msg.content && msg.streaming && <span className="chat-cursor">|</span>}
            </div>
          ) : (
            <>
              {msg.content || (msg.streaming ? <span className="chat-cursor">|</span> : '')}
              {msg.streaming && msg.content && <span className="chat-cursor">|</span>}
            </>
          )}
          {!msg.attachments?.length ? null : (
            <div className="chat-msg-attachments">
              {msg.attachments.map((a, ai) => a.kind === 'image' && a.dataUrl ? (
                <img key={ai} src={a.dataUrl} alt={a.name} className="chat-msg-att-thumb" title={a.name} />
              ) : (
                <span key={ai} className="chat-msg-att-file" title={a.name}>
                  <i className="codicon codicon-file" />{a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

export default function ChatSidebar({ onClose, onNavigateToSettings, socket }: Props) {
  const [providers, setProviders] = useState<ChatModelInfo[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [threadId, setThreadId] = useState<string>('')
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)

  const configured = providers.filter(p => p.configured && p.hasKey)
  const anyConfigured = configured.length > 0

  useEffect(() => {
    const load = async () => {
      try {
        const [m, t] = await Promise.all([socket.chatGetModels(), socket.chatListThreads()])
        setProviders(m)
        setThreads(t)
        const avail = m.filter(p => p.configured && p.hasKey)
        if (avail.length > 0) {
          const first = avail[0]
          setSelectedProvider(first.id)
          setSelectedModel(first.model)
          if (t.length > 0) {
            setThreadId(t[0].id)
          }
        }
      } catch {}
      setLoading(false)
    }
    load()
  }, [socket])

  useEffect(() => {
    if (!threadId) {
      setMessages([])
      return
    }
    const known = threads.some(t => t.id === threadId)
    if (!known) return
    // Staleness guard: a slow response for an earlier thread must not
    // overwrite the messages of the thread the user switched to.
    const requested = threadId
    socket.chatGetHistory(threadId).then(data => {
      if (threadIdRef.current === requested) {
        setMessages(data?.messages || [])
      }
    })
  }, [socket, threadId, threads])

  // Restore the provider/model of the active thread so reopening the panel or
  // restarting the app keeps chatting with the same model instead of falling
  // back to the first configured provider. The LAST MESSAGE is the source of
  // truth for "the model we were using" — thread.model is only written when
  // the thread is created and goes stale after mid-chat model changes. Falls
  // back to it for empty threads. A ref guards against later thread/provider
  // refreshes re-firing, and keepModelRef protects the restored choice from
  // the model-list fetch reset until the user explicitly picks something else.
  const syncedThreadRef = useRef('')
  const keepModelRef = useRef('')
  useEffect(() => {
    if (!threadId || syncedThreadRef.current === threadId) return
    const th = threads.find(x => x.id === threadId)
    if (!th) return
    const msgs = th.messages || []
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined
    const providerId = lastMsg?.provider || th.providerId
    const model = lastMsg?.model || th.model || ''
    const prov = providers.find(p => p.id === providerId)
    if (!providerId || !prov?.configured || !prov.hasKey) return
    syncedThreadRef.current = threadId
    keepModelRef.current = model
    setSelectedProvider(prev => (prev === providerId ? prev : providerId))
    setSelectedModel(prev => (prev === model ? prev : model))
  }, [threadId, threads, providers])

  useEffect(() => {
    // Only auto-scroll to bottom when the user is already near the bottom,
    // so scrolling up through history isn't yanked back down on new output.
    const el = messagesScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 80) {
      // Instant scroll while streaming: a smooth animation restarted on every
      // commit tick visibly stutters and keeps layout work in flight.
      messagesEndRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
    }
  }, [messages, streaming])

  useEffect(() => {
    if (selectedProvider) {
      setLoading(false)
      fetch(`${SERVER_URL}/api/chat/models/${selectedProvider}`, { headers: apiHeadersSync() })
        .then(res => res.json())
        .then(data => {
          if (data.ok && data.models?.length) {
            const sorted = [...data.models].sort((a, b) => a.localeCompare(b))
            setModels(sorted)
            setSelectedModel(prev => {
              // A restored per-thread selection wins even when the provider's
              // list omits it (e.g. stealth models); user changes clear the guard.
              if (prev && prev === keepModelRef.current) return prev
              return sorted.includes(prev) ? prev : sorted[0]
            })
          }
        })
        .catch(() => {})
    }
  }, [selectedProvider])

  useEffect(() => {
    if (loading || anyConfigured) return
    const id = setInterval(() => {
      socket.chatGetModels().then(m => setProviders(m))
    }, 2000)
    return () => clearInterval(id)
  }, [loading, anyConfigured, socket])

  useEffect(() => {
    if (!selectedProvider) {
      const avail = providers.filter(p => p.configured && p.hasKey)
      if (avail.length > 0) {
        const first = avail[0]
        setSelectedProvider(first.id)
        setSelectedModel(first.model)
        socket.chatListThreads().then(t => {
          setThreads(t)
          if (t.length > 0) setThreadId(t[0].id)
        })
      }
    }
  }, [providers, selectedProvider, socket])

  // ── Stream commit throttling ────────────────────────────────
  // Committing every stream chunk to React state re-parses the entire growing
  // markdown document on each arrival — O(n²) over a long response, and the
  // dominant cause of chat jank while an agent streams. Chunks accumulate in a
  // ref and are committed on a fixed tick instead: identical final content,
  // bounded render rate. (Same pattern as superset's StreamingMessageText.)
  const STREAM_COMMIT_MS = 50
  const STREAM_BUFFER_HARD_CAP = 256 * 1024
  const streamBufRef = useRef('')
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushStreamBuffer = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
      streamTimerRef.current = null
    }
    const buffered = streamBufRef.current
    if (!buffered) return
    streamBufRef.current = ''
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant' || !last.streaming) return prev
      const updated = [...prev]
      updated[updated.length - 1] = { ...last, content: last.content + buffered }
      return updated
    })
  }, [])

  // Switching threads mid-stream must not leak buffered text from the previous
  // thread into the new thread's messages.
  useEffect(() => {
    streamBufRef.current = ''
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current)
      streamTimerRef.current = null
    }
  }, [threadId])

  useSocketEvent<StreamChunk>(socket.onChatStreamChunk, (chunk) => {
    if (chunk.threadId !== threadId) return
    if (chunk.done) {
      setStreaming(false)
      // Finalize with whatever is still buffered so nothing is lost or reordered.
      const buffered = streamBufRef.current
      streamBufRef.current = ''
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current)
        streamTimerRef.current = null
      }
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant' || !last.streaming) return prev
        const updated = [...prev]
        updated[updated.length - 1] = { ...last, content: last.content + buffered, streaming: false }
        return updated
      })
      return
    }
    streamBufRef.current += chunk.content
    // Hard cap: if timers are throttled (e.g. hidden window), flush
    // synchronously rather than letting the buffer grow without bound.
    if (streamBufRef.current.length >= STREAM_BUFFER_HARD_CAP) {
      flushStreamBuffer()
      return
    }
    if (!streamTimerRef.current) {
      streamTimerRef.current = setTimeout(flushStreamBuffer, STREAM_COMMIT_MS)
    }
  }, [socket, threadId, flushStreamBuffer])

  useSocketEvent<{ threadId: string; message: ChatMessage }>(socket.onChatResponse, (data) => {
    if (data.threadId !== threadId) return
    setStreaming(false)
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        const updated = [...prev]
        updated[updated.length - 1] = { ...data.message, streaming: false }
        return updated
      }
      return [...prev, { ...data.message, streaming: false }]
    })
  }, [socket, threadId])

  useSocketEvent<{ threadId: string; error: string }>(socket.onChatError, (data) => {
    if (data.threadId !== threadId) return
    setStreaming(false)
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        const updated = [...prev]
        updated[updated.length - 1] = { ...last, content: data.error, streaming: false, error: true }
        return updated
      }
      return [...prev, { id: generateId(), role: 'assistant', content: data.error, timestamp: Date.now(), error: true }]
    })
  }, [socket, threadId])

  useSocketEvent<{ threads: ChatThread[] }>(socket.onChatThreads, (data) => {
    if (data?.threads) setThreads(data.threads)
  }, [socket])

  const refreshThreads = useCallback(() => {
    socket.chatListThreads().then(t => setThreads(t))
  }, [socket])

  // ── Attachments ──────────────────────────────────────────────
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const removePending = useCallback((id: string) => {
    setPending(prev => prev.filter(p => p.id !== id))
  }, [])

  const handleFilesChosen = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) continue
      try {
        if (file.type.startsWith('image/') || file.type === 'application/pdf') {
          const dataUrl = await readFileAsDataUrl(file)
          const isImage = file.type.startsWith('image/')
          setPending(prev => prev.length >= MAX_PENDING_ATTACHMENTS ? prev : [
            ...prev,
            {
              id: generateId(),
              name: file.name,
              mediaType: file.type || 'application/octet-stream',
              kind: isImage ? ('image' as const) : ('file' as const),
              data: dataUrl.replace(/^data:[^;]+;base64,/, ''),
              ...(isImage ? { dataUrl } : {}),
            },
          ])
        } else {
          const text = await readFileAsText(file)
          setPending(prev => prev.length >= MAX_PENDING_ATTACHMENTS ? prev : [
            ...prev,
            {
              id: generateId(),
              name: file.name,
              mediaType: file.type || 'text/plain',
              kind: 'file' as const,
              data: text,
            },
          ])
        }
      } catch {}
    }
  }, [])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if ((!text && pending.length === 0) || streaming) return
    setInput('')
    const payloadAttachments: ChatAttachment[] = pending.map(p => ({
      name: p.name, mediaType: p.mediaType, kind: p.kind, data: p.data,
    }))
    const displayAttachments = pending.length > 0
      ? pending.map(p => ({ name: p.name, kind: p.kind, dataUrl: p.dataUrl }))
      : undefined
    setPending([])
    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      provider: selectedProvider,
      model: selectedModel,
      ...(displayAttachments ? { attachments: displayAttachments } : {}),
    }
    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      provider: selectedProvider,
      model: selectedModel,
    }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setStreaming(true)
    let tid = threadId
    if (!tid) {
      tid = generateId()
      setThreadId(tid)
    }
    socket.chatSendStream(
      tid, selectedProvider, text, selectedModel,
      payloadAttachments.length > 0 ? payloadAttachments : undefined,
    )
  }, [input, streaming, selectedProvider, selectedModel, threadId, socket, pending])

  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      refreshThreads()
    }
    prevStreamingRef.current = streaming
  }, [streaming, refreshThreads])

  const handleStop = useCallback(() => {
    socket.chatStopStream(threadId)
    setStreaming(false)
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.streaming) {
        const updated = [...prev]
        updated[updated.length - 1] = { ...last, streaming: false }
        return updated
      }
      return prev
    })
  }, [socket, threadId])

  const handleNewChat = useCallback(() => {
    if (streaming) socket.chatStopStream(threadId)
    setStreaming(false)
    setThreadId('')
    setMessages([])
    setShowHistory(false)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [socket, streaming, threadId])

  const selectThread = useCallback((id: string) => {
    if (streaming) socket.chatStopStream(threadId)
    setStreaming(false)
    setThreadId(id)
    setShowHistory(false)
  }, [socket, streaming, threadId])

  const deleteThread = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    socket.chatDeleteThread(id)
    if (threadId === id) {
      setThreadId('')
      setMessages([])
    }
  }, [socket, threadId])

  const clearThread = useCallback(() => {
    if (!threadId) return
    socket.chatClearThread(threadId)
    setMessages([])
  }, [socket, threadId])

  const handleProviderChange = (id: string) => {
    keepModelRef.current = ''
    setSelectedProvider(id)
    const p = providers.find(x => x.id === id)
    setSelectedModel(p?.model || '')
    setModels([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && pending.length === 0) {
      e.preventDefault()
      handleSend()
    }
  }

  const renderMessage = (msg: ChatMessage, i: number) => (
    <MessageItem key={msg.id || i} msg={msg} />
  )

  return (
    <aside className="chat-sidebar">
      <div className="chat-header">
        <div className="chat-header-left">
          <i className="codicon codicon-comment-discussion" style={{ fontSize: 16 }}></i>
          <span className="chat-header-title">Assistant</span>
        </div>
        <div className="chat-header-actions">
          <button className="chat-header-btn" onClick={handleNewChat} title="New chat">
            <i className="codicon codicon-add" style={{ fontSize: 14 }}></i>
          </button>
          <button
            className={`chat-header-btn${showHistory ? ' chat-header-btn-active' : ''}`}
            onClick={() => setShowHistory(s => !s)}
            title="Chat history"
          >
            <i className="codicon codicon-history" style={{ fontSize: 14 }}></i>
          </button>
          <button className="chat-close-btn" onClick={onClose} title="Close">
            <i className="codicon codicon-close" style={{ fontSize: 14 }}></i>
          </button>
        </div>
      </div>

      {showHistory && (
        <div className="chat-history-panel">
          <div className="chat-history-header">Sessions</div>
          {threads.length === 0 ? (
            <div className="chat-history-empty">No sessions yet</div>
          ) : (
            <div className="chat-history-list">
              {threads.map(t => (
                <div
                  key={t.id}
                  className={`chat-history-item${t.id === threadId ? ' active' : ''}`}
                  onClick={() => selectThread(t.id)}
                >
                  <i className="codicon codicon-comment" style={{ fontSize: 13 }}></i>
                  <div className="chat-history-item-main">
                    <div className="chat-history-item-title">{t.title || 'New chat'}</div>
                    <div className="chat-history-item-meta">
                      <span>{t.providerId}</span>
                      {t.model && <span> · {t.model}</span>}
                      <span> · {formatTime(t.updatedAt)}</span>
                    </div>
                  </div>
                  <button className="chat-history-item-del" onClick={(e) => deleteThread(t.id, e)} title="Delete">
                    <i className="codicon codicon-trash" style={{ fontSize: 12 }}></i>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="chat-loading">Loading...</div>
      ) : !anyConfigured ? (
        <div className="chat-welcome">
          <div className="chat-welcome-icon">
            <i className="codicon codicon-key" style={{ fontSize: 32 }}></i>
          </div>
          <div className="chat-welcome-text">
            Set up an API key to start chatting with AI assistants like OpenAI, Anthropic, Grok or Gemini.
          </div>
          <div className="chat-welcome-setup">
            <button className="chat-setup-btn" onClick={() => onNavigateToSettings?.()}>
              <i className="codicon codicon-settings-gear" style={{ fontSize: 13 }}></i>
              Open Settings → API Keys
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="chat-model-bar">
            <select
              className="chat-model-select"
              value={selectedProvider}
              onChange={e => handleProviderChange(e.target.value)}
              title="Provider"
            >
              {configured.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              className="chat-model-select"
              value={selectedModel}
              onChange={e => { keepModelRef.current = ''; setSelectedModel(e.target.value) }}
              title="Model"
            >
              {Array.from(new Set([selectedModel, ...models].filter(Boolean))).sort((a, b) => a.localeCompare(b)).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          <div className="chat-messages" ref={messagesScrollRef}>
            {messages.length > 0 && (
              <div className="chat-messages-toolbar">
                <button className="chat-clear-btn" onClick={clearThread} disabled={streaming}>
                  <i className="codicon codicon-clear-all" style={{ fontSize: 12 }}></i>
                  Clear
                </button>
              </div>
            )}
            {messages.length === 0 ? (
              <div className="chat-welcome">
                <div className="chat-welcome-icon">
                  <i className="codicon codicon-comment-discussion" style={{ fontSize: 32 }}></i>
                </div>
                <div className="chat-welcome-text">
                  Ask me anything about your workspace, agents, or code.
                </div>
              </div>
            ) : (
              messages.map((msg, idx) => renderMessage(msg, idx))
            )}
            <div ref={messagesEndRef} />
          </div>

          {pending.length > 0 && (
            <div className="chat-attach-row">
              {pending.map(p => (
                <div key={p.id} className={`chat-attach-chip${p.kind === 'image' ? ' has-thumb' : ''}`} title={p.name}>
                  {p.kind === 'image' && p.dataUrl
                    ? <img src={p.dataUrl} alt={p.name} className="chat-attach-thumb" />
                    : <i className="codicon codicon-file chat-attach-icon" />}
                  <span className="chat-attach-name">{p.name}</span>
                  <button className="chat-attach-remove" onClick={() => removePending(p.id)} title="Remove">
                    <i className="codicon codicon-close" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-input-area">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={handleFilesChosen}
            />
            <button
              className="chat-attach-btn"
              onClick={handleAttachClick}
              disabled={streaming}
              title="Attach images or files"
            >
              <i className="codicon codicon-attach" style={{ fontSize: 14 }}></i>
            </button>
            <textarea
              ref={inputRef}
              className="chat-input"
              rows={1}
              placeholder={`Message ${selectedProvider}...`}
              value={input}
              onChange={e => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
              }}
              onKeyDown={handleKeyDown}
            />
            {streaming ? (
              <button className="chat-stop-btn" onClick={handleStop}>
                <i className="codicon codicon-debug-stop" style={{ fontSize: 14 }}></i>
                Stop
              </button>
            ) : (
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!input.trim() && pending.length === 0}
                title="Send"
              >
                <i className="codicon codicon-send" style={{ fontSize: 13 }}></i>
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
