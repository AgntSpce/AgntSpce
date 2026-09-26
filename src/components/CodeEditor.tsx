import { useRef, useCallback, useEffect } from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
})

interface CodeEditorProps {
  filePath: string
  content: string
  language: string
  isDirty: boolean
  theme: 'dark' | 'light'
  fontSize?: number
  fontFamily?: string
  scrollPosition?: { line: number; column: number } | null
  onContentChange: (value: string | undefined) => void
  onSave: () => void
  onScrollChange?: (line: number, column: number) => void
}

export function CodeEditor({
  filePath,
  content,
  language,
  theme,
  fontSize = 13,
  fontFamily = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
  scrollPosition,
  onContentChange,
  onSave,
  onScrollChange,
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  // Latest save handler for the mount-time Monaco action below.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const isUpdatingPositionRef = useRef(false)
  // The saved cursor position must only be replayed once per file, never on
  // every `scrollPosition` update. `onScrollChange` reports *every* cursor move
  // (each step of a mouse drag included), so re-applying it would call
  // setPosition() on top of the user's own selection and collapse it — which
  // is what made drag-select and the context menu's Select All do nothing.
  const filePathRef = useRef(filePath)
  filePathRef.current = filePath
  const savedPositionRef = useRef(scrollPosition)
  savedPositionRef.current = scrollPosition
  const restoredPathRef = useRef<string | null>(null)

  const restoreSavedPosition = useCallback(() => {
    const position = savedPositionRef.current
    const editorInstance = editorRef.current
    if (!position || !editorInstance) return
    restoredPathRef.current = filePathRef.current
    isUpdatingPositionRef.current = true
    editorInstance.revealPositionInCenter({
      lineNumber: position.line,
      column: position.column,
    })
    editorInstance.setPosition({
      lineNumber: position.line,
      column: position.column,
    })
    requestAnimationFrame(() => {
      isUpdatingPositionRef.current = false
    })
  }, [])

  const handleEditorDidMount: OnMount = useCallback((editorInstance, monaco) => {
    editorRef.current = editorInstance
    monacoRef.current = monaco as unknown as typeof import('monaco-editor')
    // Monaco mounts asynchronously, so the saved position is replayed here when
    // a file is opened; the effect below covers a file change without a remount.
    restoreSavedPosition()

    editorInstance.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      // The mount-time action must call through a ref: onSave closes over
      // the current file content, so calling it directly would silently
      // save stale (mount-time) content and drop the user's edits.
      run: () => {
        onSaveRef.current()
      },
    })

    editorInstance.onDidChangeCursorPosition((e) => {
      if (!isUpdatingPositionRef.current && onScrollChange) {
        onScrollChange(e.position.lineNumber, e.position.column)
      }
    })
  }, [restoreSavedPosition, onScrollChange])

  const handleBeforeMount = useCallback(
    (monaco: any) => {
      monaco.editor.defineTheme('custom-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#0E0E10',
          'editor.foreground': '#D4D4D4',
          'editor.lineHighlightBackground': '#1D1D20',
          'editor.selectionBackground': '#22C55E30',
          'editorCursor.foreground': '#D4D4D4',
          'editorLineNumber.foreground': '#858585',
          'editorLineNumber.activeForeground': '#C6C6C6',
        },
      })
      monaco.editor.defineTheme('custom-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#FFFFFF',
          'editor.foreground': '#1E1E1E',
          'editor.lineHighlightBackground': '#F5F5F5',
          'editor.selectionBackground': '#22C55E40',
          'editorCursor.foreground': '#1E1E1E',
          'editorLineNumber.foreground': '#A0A0A0',
          'editorLineNumber.activeForeground': '#1E1E1E',
        },
      })
    },
    [],
  )

  useEffect(() => {
    if (restoredPathRef.current === filePath) return
    restoreSavedPosition()
  }, [filePath, scrollPosition, restoreSavedPosition])

  const monacoLanguage = language === 'typescript' ? 'typescript' :
    language === 'javascript' ? 'javascript' :
    language === 'jsx' ? 'javascript' :
    language === 'tsx' ? 'typescript' :
    language === 'css' ? 'css' :
    language === 'html' ? 'html' :
    language === 'json' ? 'json' :
    language === 'markdown' ? 'markdown' :
    language === 'python' ? 'python' :
    language === 'yaml' ? 'yaml' :
    language === 'shell' ? 'shell' :
    language === 'sql' ? 'sql' :
    language === 'rust' ? 'rust' :
    language === 'go' ? 'go' :
    language === 'ruby' ? 'ruby' :
    language === 'java' ? 'java' :
    language === 'cpp' ? 'cpp' :
    language === 'c' ? 'c' :
    'plaintext'

  return (
    <div className="code-editor-container">
      <div className="code-editor-wrapper">
        <Editor
          key={filePath}
          language={monacoLanguage}
          theme={theme === 'dark' ? 'custom-dark' : 'custom-light'}
          value={content}
          onChange={onContentChange}
          onMount={handleEditorDidMount}
          beforeMount={handleBeforeMount}
          options={{
            fontSize,
            fontFamily,
            lineNumbers: 'on',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            padding: { top: 8 },
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
          }}
        />
      </div>
    </div>
  )
}
