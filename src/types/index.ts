export interface WorkspaceInfo {
  id: string
  name: string
  workspaceType?: string
  icon?: string
  description?: string
  repository?: {
    path: string
    type: string
    masterBranch?: string
  }
  worktrees?: {
    enabled: boolean
    count: number
    namingPattern: string
    autoCreate: boolean
  }
  terminals?: any
  projectType?: string
  lastAccess?: string
  gitUrl?: string
  envVars?: Record<string, string>
  setupScript?: string
  teardownScript?: string
}

export interface SessionState {
  id: string
  type: 'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor-agent' | 'copilot' | 'mastracode' | 'droid' | 'amp' | 'pi' | 'kilocode' | 'windsurf' | 'server' | 'shell'
  worktreeId: string
  repositoryName?: string
  repositoryType?: string
  status: 'idle' | 'busy' | 'waiting' | 'exited'
  branch: string
  lastActivity: number
  sessionGroupId?: string
  restorable?: boolean
}

export interface TerminalOutput {
  sessionId: string
  data: string
}

export interface StatusChange {
  sessionId: string
  status: string
}

export interface BranchChange {
  sessionId: string
  branch: string
  worktreeId: string
}

export interface WorkspaceChange {
  workspace: WorkspaceInfo
  sessions: Record<string, SessionState>
}

export interface AgentMode {
  id: string
  name: string
  description: string
}

export interface AgentFlag {
  id: string
  flag: string
  description: string
  label: string
  category: string
  default: boolean
}

export interface AgentCapabilities {
  supportsWorktree: boolean
  requiresGitRepo: boolean
  supportsParallel: boolean
}

export interface AgentConfig {
  id: string
  name: string
  icon: string
  description: string
  modes: AgentMode[]
  flags: AgentFlag[]
  defaultMode: string
  models?: string[]
  defaultModel?: string
  reasoningLevels?: string[]
  defaultReasoning?: string
  verbosityLevels?: string[]
  defaultVerbosity?: string
  capabilities?: AgentCapabilities
}

export interface AgentStartConfig {
  agentId: string
  mode: string
  flags: string[]
  model?: string
  reasoning?: string
  verbosity?: string
  resumeId?: string
  declaredFiles?: string[]
  prompt?: string
}

export interface FilterEvent {
  sessionId: string
  original: string
  filtered: string
  originalBytes: number
  filteredBytes: number
  originalTokens: number
  filteredTokens: number
  reduction: number
  rulesApplied: string[]
}

export interface FilterStats {
  totalOriginalBytes: number
  totalFilteredBytes: number
  totalOriginalTokens: number
  totalFilteredTokens: number
  eventsProcessed: number
}

export interface CommandEvent {
  sessionId: string
  executionId: string | null
  command: string
  args: string[]
  formatted: string
  rawOutput: string
  filteredOutput: string
  filterName: string | null
  originalTokens: number
  filteredTokens: number
  reduction: number
  exitCode: number | null
  duration: number
  timestamp: number
}

export interface ExecutionEvent {
  id: string
  sessionId: string
  prompt: string
  startedAt: number
  endedAt: number
  commands: CommandEvent[]
  totalOriginalTokens: number
  totalFilteredTokens: number
  totalDuration: number
  success: boolean
  commandCount: number
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

export interface OpenFile {
  id: string
  filePath: string
  fileName: string
  language: string
  isDirty: boolean
  isDiff?: boolean
  gitStatus?: string
  commitHash?: string
}

export type ProviderType = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openai-compatible'

export interface ChatAttachment {
  name: string
  mediaType: string
  kind: 'image' | 'file'
  data: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  provider?: string
  model?: string
  timestamp: number
  streaming?: boolean
  error?: boolean
  attachments?: { name: string; kind: 'image' | 'file'; dataUrl?: string }[]
}

export interface ChatThread {
  id: string
  title: string
  providerId: string
  model: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface ChatModelInfo {
  id: string
  type: ProviderType
  name: string
  model: string
  baseUrl?: string
  hasKey: boolean
  configured: boolean
}

export interface ProviderTemplate {
  id: string
  type: ProviderType
  name: string
  defaultModel: string
  baseUrl?: string
  custom?: boolean
  requiresBaseUrl?: boolean
}

export interface ApiKeyEntry {
  id: string
  type: ProviderType
  name: string
  model: string
  apiKey: string
  baseUrl?: string
  expiresAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface KeySummary {
  id: string
  type: ProviderType
  name: string
  model: string
  baseUrl?: string
  hasKey: boolean
  maskedKey?: string
  expiresAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface StreamChunk {
  threadId: string
  content: string
  done: boolean
  error?: string
}

export interface CavemanRun {
  id: string
  prompt: string
  startedAt: number
  endedAt: number
  agentResponseTokens: number
}

export interface CavemanStats {
  sessionId: string
  enabled: boolean
  level: string
  runs: CavemanRun[]
  currentRun: CavemanRun | null
  startTime: number
  uptime: number
}

export interface CavemanAggregateStats {
  sessionsActive: number
  uptimeMs: number
}

declare global {
  interface Window {
    electronAPI?: {
      readClipboard: () => Promise<string>
      writeClipboard: (text: string) => void
      selectDirectory: () => Promise<string | null>
      selectFile: () => Promise<string | null>
      getDefaultPath: () => Promise<string>
      getServerPort: () => Promise<number>
      getServerAuthToken: () => Promise<string>
      exportWorkspace: () => Promise<string | null>
      importWorkspace: () => Promise<{ workspace: any; path: string } | null>
      duplicateWorkspace: (newName: string) => Promise<any>
      onMenuAction: (callback: (action: string, data?: any) => void) => () => void
      windowMinimize: () => Promise<void>
      windowMaximize: () => Promise<void>
      windowClose: () => Promise<void>
      windowIsMaximized: () => Promise<boolean>
      newWindow: () => Promise<void>
      popupMenu: (menuName: string, x: number, y: number) => Promise<void>
    }
  }
}
