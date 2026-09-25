import { useState, useEffect, useCallback, useRef } from 'react'
import type { ProviderTemplate, KeySummary } from '../types'
import { apiHeaders } from '../utils/serverAuth'

const SERVER_URL = 'http://127.0.0.1:9460'

interface UserPrefs {
  fontSize: number
  fontFamily: string
  autoSave: boolean
  tokenCompression: boolean
  autoStart: boolean
  sessionRecovery: boolean
  promptCompressionEnabled: boolean
  layoutPreset: string
}

function loadPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem('agent-workspace-prefs')
    if (raw) {
      const parsed = JSON.parse(raw)
      // Dropped setting: sessions have no token limit.
      delete parsed.maxTokensPerSession
      return { ...defaultPrefs, ...parsed }
    }
  } catch {}
  return { ...defaultPrefs }
}

function savePrefs(prefs: UserPrefs) {
  localStorage.setItem('agent-workspace-prefs', JSON.stringify(prefs))
}

const defaultPrefs: UserPrefs = {
  fontSize: 16,
  fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
  autoSave: true,
  tokenCompression: true,
  autoStart: true,
  sessionRecovery: true,
  promptCompressionEnabled: true,
  layoutPreset: 'auto',
}

const FONT_FAMILIES = [
  { value: "'JetBrains Mono', 'Fira Code', Menlo, monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', 'JetBrains Mono', Menlo, monospace", label: 'Fira Code' },
  { value: "'Cascadia Code', 'JetBrains Mono', monospace", label: 'Cascadia Code' },
  { value: "'Source Code Pro', Menlo, monospace", label: 'Source Code Pro' },
  { value: "Menlo, Monaco, monospace", label: 'Menlo' },
  { value: "monospace", label: 'Default' },
]

interface Props {
  theme: 'dark' | 'light'
  onThemeChange: (theme: 'dark' | 'light') => void
  onFontSizeChange: (size: number) => void
  onFontFamilyChange: (family: string) => void
  onPrefsChange: (prefs: Partial<UserPrefs>) => void
  onClose: () => void
}

interface KeyForm {
  type: string
  name: string
  model: string
  apiKey: string
  baseUrl: string
}

function emptyForm(type = 'openai'): KeyForm {
  return { type, name: '', model: '', apiKey: '', baseUrl: '' }
}

export default function Settings({ theme, onThemeChange, onFontSizeChange, onFontFamilyChange, onPrefsChange, onClose }: Props) {
  const [prefs, setPrefs] = useState<UserPrefs>(loadPrefs)
  const [templates, setTemplates] = useState<ProviderTemplate[]>([])
  const [keys, setKeys] = useState<KeySummary[]>([])
  const [form, setForm] = useState<KeyForm>(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    savePrefs(prefs)
    onPrefsChange(prefs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs])

  const refresh = useCallback(async () => {
    try {
      const [tRes, kRes] = await Promise.all([
        fetch(`${SERVER_URL}/api/chat/providers`, { headers: await apiHeaders() }),
        fetch(`${SERVER_URL}/api/chat/keys`, { headers: await apiHeaders() }),
      ])
      if (tRes.ok) setTemplates(await tRes.json())
      if (kRes.ok) setKeys(await kRes.json())
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (initializedRef.current) return
    const t = templates.find(x => x.id === form.type)
    if (t && !t.custom) {
      initializedRef.current = true
      setForm(f => ({ ...f, name: t.name, model: t.defaultModel, baseUrl: t.baseUrl || '' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates])

  function updatePrefs(partial: Partial<UserPrefs>) {
    setPrefs(p => ({ ...p, ...partial }))
  }

  function changeFontSize(delta: number) {
    setPrefs(p => {
      const next = Math.max(10, Math.min(24, p.fontSize + delta))
      onFontSizeChange(next)
      return { ...p, fontSize: next }
    })
  }

  function changeFontFamily(value: string) {
    setPrefs(p => {
      onFontFamilyChange(value)
      return { ...p, fontFamily: value }
    })
  }

  const selectedTemplate = templates.find(t => t.id === form.type)

  function selectProvider(type: string) {
    const t = templates.find(x => x.id === type)
    setForm(f => ({
      ...f,
      type,
      name: t?.custom ? f.name : t?.name || '',
      model: t?.defaultModel || '',
      baseUrl: t?.baseUrl || '',
    }))
    setModels([])
  }

  async function loadModelsFromEntered() {
    if (selectedTemplate?.custom) return
    const key = form.apiKey.trim()
    if (!key) {
      setStatus({ kind: 'err', text: 'Enter an API key first to fetch models.' })
      return
    }
    setLoadingModels(true)
    try {
      const res = await fetch(`${SERVER_URL}/api/chat/models/query`, {
        method: 'POST',
        headers: await apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          type: selectedTemplate?.type || form.type,
          apiKey: key,
          baseUrl: form.baseUrl.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (data.ok && Array.isArray(data.models)) {
        const sorted = [...data.models].sort((a, b) => a.localeCompare(b))
        setModels(sorted)
        setForm(f => ({ ...f, model: sorted[0] || f.model }))
        setStatus({ kind: 'ok', text: sorted.length > 0 ? `${sorted.length} models loaded from API.` : 'Provider returned no models.' })
      } else {
        setStatus({ kind: 'err', text: data.error || 'Failed to fetch models.' })
      }
    } catch {
      setStatus({ kind: 'err', text: 'Failed to fetch models.' })
    }
    setLoadingModels(false)
  }

  async function loadModelsFromSaved(providerId: string) {
    if (selectedTemplate?.custom) return
    setLoadingModels(true)
    try {
      const res = await fetch(`${SERVER_URL}/api/chat/models/${providerId}`, { headers: await apiHeaders() })
      const data = await res.json()
      if (data.ok && Array.isArray(data.models)) {
        const sorted = [...data.models].sort((a, b) => a.localeCompare(b))
        setModels(sorted)
        setForm(f => ({ ...f, model: sorted.includes(f.model) ? f.model : (sorted[0] || f.model) }))
        setStatus({ kind: 'ok', text: `${sorted.length} models loaded from API.` })
      } else {
        setStatus({ kind: 'err', text: data.error || 'Failed to fetch models.' })
      }
    } catch {
      setStatus({ kind: 'err', text: 'Failed to fetch models.' })
    }
    setLoadingModels(false)
  }

  function startEdit(key: KeySummary) {
    setEditingId(key.id)
    setShowKey(false)
    let t = templates.find(x => x.type === key.type && !x.custom && x.baseUrl === (key.baseUrl || undefined))
    if (!t) {
      t = templates.find(x => !x.custom && x.name === key.name && x.type === key.type)
    }
    if (!t || t.custom) {
      t = templates.find(x => x.custom)
    }
    setForm({
      type: t?.id || key.type,
      name: key.name || t?.name || '',
      model: key.model || t?.defaultModel || '',
      apiKey: '',
      baseUrl: key.baseUrl || t?.baseUrl || '',
    })
    if (t && !t.custom) loadModelsFromSaved(key.id)
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(emptyForm())
    setModels([])
    setStatus(null)
  }

  async function handleSave() {
    const t = templates.find(x => x.id === form.type)
    if (t?.custom && !form.name.trim()) {
      setStatus({ kind: 'err', text: 'Custom providers require a name.' })
      return
    }
    if (!form.apiKey.trim()) {
      setStatus({ kind: 'err', text: 'API key is required.' })
      return
    }
    if (t?.custom && !form.baseUrl.trim()) {
      setStatus({ kind: 'err', text: 'Custom providers require a base URL (e.g. https://api.example.com/v1).' })
      return
    }
    const body = {
      templateId: form.type,
      type: selectedTemplate?.type || form.type,
      name: form.name.trim(),
      model: form.model.trim() || selectedTemplate?.defaultModel || 'gpt-4o',
      apiKey: form.apiKey.trim(),
      baseUrl: form.baseUrl.trim() || undefined,
    }
    try {
      let ok = false
      if (editingId) {
        const res = await fetch(`${SERVER_URL}/api/chat/keys/${editingId}`, {
          method: 'PUT',
          headers: await apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        })
        ok = res.ok
      } else {
        const res = await fetch(`${SERVER_URL}/api/chat/keys`, {
          method: 'POST',
          headers: await apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        })
        ok = res.ok
      }
      if (ok) {
        setStatus({ kind: 'ok', text: editingId ? 'API key updated.' : 'API key added.' })
        cancelEdit()
        await refresh()
      } else {
        setStatus({ kind: 'err', text: 'Failed to save API key.' })
      }
    } catch (e) {
      setStatus({ kind: 'err', text: `Error: ${(e as Error).message}` })
    }
  }

  async function handleDelete(key: KeySummary) {
    if (!window.confirm(`Delete API key "${key.name}"?`)) return
    try {
      const res = await fetch(`${SERVER_URL}/api/chat/keys/${key.id}`, { method: 'DELETE', headers: await apiHeaders() })
      const data = await res.json()
      if (data.ok) {
        if (editingId === key.id) cancelEdit()
        await refresh()
      }
    } catch {}
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>Settings</h1>
        <button className="settings-close-btn" onClick={onClose} title="Close">
          <i className="codicon codicon-close" style={{ fontSize: 16 }}></i>
        </button>
      </div>
      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-header">
            <h2>Appearance</h2>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">Theme</span>
              <span className="settings-label-desc">Switch between dark and light mode</span>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={theme === 'dark'}
                onChange={e => onThemeChange(e.target.checked ? 'dark' : 'light')}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h2>Terminal</h2>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">Font Size</span>
              <span className="settings-label-desc">{prefs.fontSize}px</span>
            </div>
            <div className="settings-stepper">
              <button className="settings-stepper-btn" onClick={() => changeFontSize(-1)} disabled={prefs.fontSize <= 10}>−</button>
              <span className="settings-stepper-value">{prefs.fontSize}px</span>
              <button className="settings-stepper-btn" onClick={() => changeFontSize(1)} disabled={prefs.fontSize >= 24}>+</button>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">Font Family</span>
              <span className="settings-label-desc">Terminal font style</span>
            </div>
            <select
              className="settings-select"
              value={prefs.fontFamily}
              onChange={e => changeFontFamily(e.target.value)}
            >
              {FONT_FAMILIES.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h2>Session</h2>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">Auto-save</span>
              <span className="settings-label-desc">Automatically save session state</span>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs.autoSave}
                onChange={e => updatePrefs({ autoSave: e.target.checked })}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">Auto-start agents</span>
              <span className="settings-label-desc">Auto-launch agent sessions on workspace open</span>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs.autoStart}
                onChange={e => updatePrefs({ autoStart: e.target.checked })}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">agntspce-pc prompt compression</span>
              <span className="settings-label-desc">Show compression mode and controls on agent windows</span>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs.promptCompressionEnabled}
                onChange={e => updatePrefs({ promptCompressionEnabled: e.target.checked })}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
          <div className="settings-row">
            <div>
              <span className="settings-label">Session recovery</span>
              <span className="settings-label-desc">Restore sessions from last workspace on startup</span>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={prefs.sessionRecovery}
                onChange={e => updatePrefs({ sessionRecovery: e.target.checked })}
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">
            <h2>API Keys</h2>
            <span className="settings-label-desc">Used by the AI chat assistant</span>
          </div>

          <div className="api-form">
            <div className="api-form-row">
              <div className="api-form-field api-form-field-grow">
                <span className="settings-label">Provider</span>
                <select
                  className="settings-select"
                  value={form.type}
                  onChange={e => selectProvider(e.target.value)}
                >
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}{t.custom ? ' (custom)' : ''}</option>
                  ))}
                </select>
              </div>
              {selectedTemplate?.custom && (
                <div className="api-form-field api-form-field-grow">
                  <span className="settings-label">Name</span>
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="e.g. My Local LLM"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>
              )}
              <div className="api-form-field">
                <span className="settings-label">API Key</span>
                <div className="settings-api-key-field">
                  <input
                    className="settings-input settings-api-key-input"
                    type={showKey ? 'text' : 'password'}
                    placeholder={editingId ? 'Leave blank to keep current' : 'sk-...'}
                    value={form.apiKey}
                    onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                  />
                  <button className="settings-api-eye" onClick={() => setShowKey(s => !s)} title={showKey ? 'Hide key' : 'Show key'}>
                    <i className={`codicon ${showKey ? 'codicon-eye-closed' : 'codicon-eye'}`}></i>
                  </button>
                </div>
              </div>
            </div>

            <div className="api-form-row">
              <div className="api-form-field api-form-field-grow">
                <span className="settings-label">Model</span>
                <div className="settings-api-key-field">
                  <select
                    className="settings-select settings-input api-model-pick"
                    value={form.model}
                    onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                    disabled={models.length === 0}
                  >
                    {models.length > 0 ? (
                      [...models].sort((a, b) => a.localeCompare(b)).map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))
                    ) : (
                      <option value={form.model}>{form.model || selectedTemplate?.defaultModel || 'No models loaded'}</option>
                    )}
                  </select>
                  <button
                    className="settings-api-eyesave"
                    disabled={loadingModels || !!selectedTemplate?.custom}
                    onClick={() => {
                      if (form.apiKey.trim()) loadModelsFromEntered()
                      else if (editingId) loadModelsFromSaved(editingId)
                      else setStatus({ kind: 'err', text: 'Enter an API key first to fetch models.' })
                    }}
                    title="Fetch available models from the provider API"
                  >
                    <i className={`codicon ${loadingModels ? 'codicon-loading codicon-spin' : 'codicon-refresh'}`}></i>
                  </button>
                </div>
                <span className="settings-label-desc">
                  {selectedTemplate?.custom
                    ? 'Custom providers use the model id you specify.'
                    : models.length > 0
                      ? 'Models fetched from the provider API.'
                      : 'Click refresh to load models from the provider API.'}
                </span>
              </div>
              {selectedTemplate?.custom && (
                <div className="api-form-field api-form-field-grow">
                  <span className="settings-label">Model ID</span>
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="e.g. my-model"
                    value={form.model}
                    onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                  />
                </div>
              )}
              {selectedTemplate?.custom && (
                <div className="api-form-field api-form-field-grow">
                  <span className="settings-label">Base URL</span>
                  <input
                    className="settings-input"
                    type="text"
                    placeholder="https://api.example.com/v1"
                    value={form.baseUrl}
                    onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
                  />
                </div>
              )}
            </div>

            <div className="api-form-actions">
              {status && <span className={`api-status ${status.kind === 'ok' ? 'api-status-ok' : 'api-status-err'}`}>{status.text}</span>}
              {editingId ? (
                <>
                  <button className="settings-api-key-save" onClick={handleSave}>Update Key</button>
                  <button className="settings-btn-ghost" onClick={cancelEdit}>Cancel</button>
                </>
              ) : (
                <button className="settings-api-key-save" onClick={handleSave} disabled={!form.apiKey.trim()}>
                  <i className="codicon codicon-add" style={{ fontSize: 12 }}></i> Add API Key
                </button>
              )}
            </div>
          </div>

          <div className="api-key-list">
            {keys.length === 0 ? (
              <div className="api-key-empty">
                No API keys configured. Select a provider above to get started.
              </div>
            ) : (
              keys.map(key => (
                <div key={key.id} className="api-key-card">
                  <div className="api-key-card-icon">
                    <i className="codicon codicon-key"></i>
                  </div>
                  <div className="api-key-card-info">
                    <div className="api-key-card-name">
                      {key.name}
                      {key.id === editingId && <span className="api-key-badge">editing</span>}
                    </div>
                    <div className="api-key-card-meta">
                      <span className="api-key-card-type">{key.type}</span>
                      <span className="api-key-card-model">{key.model}</span>
                      {key.maskedKey && <span className="api-key-card-masked">{key.maskedKey}</span>}
                    </div>
                  </div>
                  <div className="api-key-card-actions">
                    <button className="api-key-card-btn" onClick={() => startEdit(key)} title="Edit">
                      <i className="codicon codicon-edit"></i>
                    </button>
                    <button className="api-key-card-btn api-key-card-btn-danger" onClick={() => handleDelete(key)} title="Delete">
                      <i className="codicon codicon-trash"></i>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export type { UserPrefs }
