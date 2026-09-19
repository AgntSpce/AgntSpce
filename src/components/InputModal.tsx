import { useState, useEffect, useRef } from 'react'

interface InputModalProps {
  open: boolean
  title: string
  defaultValue?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

export default function InputModal({ open, title, defaultValue, onSubmit, onCancel }: InputModalProps) {
  const [value, setValue] = useState(defaultValue || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue || '')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open, defaultValue])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  function handleSubmit() {
    onSubmit(value)
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
          placeholder={defaultValue || ''}
        />
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="modal-btn modal-btn-ok" onClick={handleSubmit}>OK</button>
        </div>
      </div>
    </div>
  )
}
