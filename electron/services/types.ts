import { RingBuffer } from './ringBuffer'

export const AGENT_TYPES = ['claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'copilot', 'mastracode', 'droid', 'amp', 'pi', 'kilocode', 'windsurf'] as const
export type AgentType = typeof AGENT_TYPES[number]

export interface Session {
  id: string
  pty?: any
  type: AgentType | 'server' | 'shell'
  worktreeId: string
  repositoryName?: string
  repositoryType?: string
  status: 'idle' | 'busy' | 'waiting' | 'exited'
  branch: string
  buffer: RingBuffer
  deliveredBufferLength: number
  // Bytes of terminal output dropped while every renderer socket was
  // congested (drop-based backpressure). Announced on the next healthy flush.
  pendingSkipNotice?: number
  lastActivity: number
  tokenUsage: number
  config: SessionConfig
  statusChangedAt: number
  pendingStatus: string | null
  pendingStatusTimer: NodeJS.Timeout | null
  cwdState: CwdState
  autoStarted: boolean
  claudeLaunchState: string | null
  agentStartConfig?: any
  inactivityTimer?: NodeJS.Timeout | null
  processMonitor?: NodeJS.Timeout | null
  workspace?: string | null
  sessionGroupId?: string
  slotRelease?: (() => void) | null
  restorable?: boolean
}

export interface SessionConfig {
  command: string
  args: string[]
  cwd: string
  type: string
  worktreeId: string
  repositoryName?: string
  repositoryType?: string
  timeoutMs?: number
  /** v2 Tasks: links the PTY to a task group + subtask; exported as
   *  AGNTSPCE_TASK_ID / AGNTSPCE_SUBTASK_ID for the collab CLI. */
  taskGroupId?: string | null
  subtaskId?: string | null
}

export interface CwdState {
  current: string
  previous: string | null
  stack: string[]
}

export interface Workspace {
  id: string
  name: string
  workspaceType: 'single-repo' | 'mixed-repo'
  icon?: string
  description?: string
  access?: 'private' | 'team' | 'public'
  repository?: {
    path: string
    type: string
    masterBranch?: string
    remote?: string
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

export interface Worktree {
  id: string
  worktreeId?: string
  path: string
  repositoryName?: string
  repositoryPath?: string
}

export interface SavedSessionData {
  id: string
  type: string
  cwd: string
  taskGroupId?: string | null
  subtaskId?: string | null
  sessionGroupId?: string | null
  worktreeId?: string
  agentConfig?: {
    agentId: string
    mode: string
    flags: string[]
    model?: string
    reasoning?: string
    verbosity?: string
    resumeId?: string
  }
}

export interface WorkspaceExport {
  version: string
  workspace: Workspace
  sessions: SavedSessionData[]
}


