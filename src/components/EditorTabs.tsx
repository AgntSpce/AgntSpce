import type { OpenFile } from '../types'

interface EditorTabsProps {
  openFiles: OpenFile[]
  activeFileId: string | null
  onSelectFile: (id: string) => void
  onCloseFile: (id: string) => void
  onCloseViewer?: () => void
}

export function EditorTabs({
  openFiles,
  activeFileId,
  onSelectFile,
  onCloseFile,
  onCloseViewer,
}: EditorTabsProps) {
  if (openFiles.length === 0) return null

  return (
    <div className="editor-tabs">
      <div className="editor-tabs-scroll">
        {openFiles.map((file) => (
          <div
            key={file.id}
            className={`editor-tab ${activeFileId === file.id ? 'active' : ''}${file.isDiff ? ' editor-tab-diff' : ''}`}
            onClick={() => onSelectFile(file.id)}
          >
            {file.isDiff ? (
              <i className="codicon codicon-diff" style={{ fontSize: 13, marginRight: 3, flexShrink: 0 }}></i>
            ) : file.isDirty ? (
              <span className="editor-tab-dirty">●</span>
            ) : null}
            <span className="editor-tab-name">{file.fileName}</span>
            <button
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                onCloseFile(file.id)
              }}
              title="Close"
            >
              <i className="codicon codicon-close" style={{ fontSize: 12 }} />
            </button>
          </div>
        ))}
      </div>
      {onCloseViewer && (
        <div className="editor-tabs-actions">
          <button className="editor-tab-viewer-btn" onClick={onCloseViewer} title="Close file viewer (open files are kept)">
            <i className="codicon codicon-close" style={{ fontSize: 16 }}></i>
          </button>
        </div>
      )}
    </div>
  )
}
