import { useRef, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

interface GitDiffViewerProps {
  diffContent: string
  filePath: string
  gitStatus: string
  theme: 'dark' | 'light'
  language: string
}

interface DiffChunk {
  oldContent: string
  newContent: string
}

function parseDiff(diff: string): DiffChunk | null {
  const lines = diff.split('\n')
  const oldParts: string[] = []
  const newParts: string[] = []

  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('\\ ')) continue

    if (line.startsWith(' ')) {
      const content = line.slice(1)
      oldParts.push(content)
      newParts.push(content)
    } else if (line.startsWith('-')) {
      oldParts.push(line.slice(1))
    } else if (line.startsWith('+')) {
      newParts.push(line.slice(1))
    }
  }

  if (oldParts.length === 0 && newParts.length === 0) return null
  return {
    oldContent: oldParts.join('\n'),
    newContent: newParts.join('\n'),
  }
}

export default function GitDiffViewer({
  diffContent,
  filePath,
  gitStatus,
  theme,
  language,
}: GitDiffViewerProps) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [chunk, setChunk] = useState<DiffChunk | null>(null)

  useEffect(() => {
    setChunk(parseDiff(diffContent))
  }, [diffContent])

  const handleBeforeMount = (monaco: any) => {
    // Mirrors CodeEditor's custom-dark so the diff viewer matches the app theme.
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
  }

  const handleEditorMount = (editorInstance: editor.IStandaloneDiffEditor, monaco: any) => {
    editorRef.current = editorInstance
    monacoRef.current = monaco

    editorInstance.getOriginalEditor().updateOptions({ readOnly: true, glyphMargin: false, folding: false, lineNumbers: 'on', minimap: { enabled: false }, renderLineHighlight: 'none', scrollBeyondLastLine: false, wordWrap: 'on' })
    editorInstance.getModifiedEditor().updateOptions({ readOnly: true, glyphMargin: false, folding: false, lineNumbers: 'on', minimap: { enabled: false }, renderLineHighlight: 'none', scrollBeyondLastLine: false, wordWrap: 'on' })
    editorInstance.updateOptions({
      enableSplitViewResizing: true,
      renderSideBySide: true,
      renderIndicators: true,
      ignoreTrimWhitespace: false,
      diffAlgorithm: 'advanced',
    })
  }

  if (!chunk) {
    return (
      <div className="git-diff-empty">
        <p>No diff content available</p>
      </div>
    )
  }

  return (
    <div className="git-diff-root">
      <div className="git-diff-header">
        <span className={`git-diff-status git-status-${gitStatus}`}>{gitStatus}</span>
        <span className="git-diff-filename">{filePath}</span>
        <span className="git-diff-label">Diff</span>
      </div>
      <div className="git-diff-body" ref={containerRef}>
        <DiffEditor
          theme={theme === 'dark' ? 'custom-dark' : 'vs'}
          language={language}
          original={chunk.oldContent}
          modified={chunk.newContent}
          onMount={handleEditorMount}
          beforeMount={handleBeforeMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderSideBySide: true,
            diffAlgorithm: 'advanced',
            enableSplitViewResizing: true,
          }}
        />
      </div>
    </div>
  )
}
