import type { Server as HttpServer } from 'node:http'
import type { Express } from 'express'
import type { Server } from 'socket.io'
import { WorkspaceManager } from '../services/workspaceManager'
import { AgentManager } from '../services/agentManager'
import { SessionManager } from '../services/sessionManager'
import { StatusDetector } from '../services/statusDetector'
import { GitHelper } from '../services/gitHelper'
import { WorktreeHelper } from '../services/worktreeHelper'
import { AgentOrchestrator } from '../services/agentOrchestrator'
import { ChatManager } from '../services/chatManager'
import { AgentStatusService } from '../services/agentStatus'
import { getMaxConcurrentSessions } from '../config'
import type { StateManager } from '../services/orchestration/stateManager'

export interface ServerContext {
  io: Server
  httpServer: HttpServer
  expressApp: Express
  workspaceManager: WorkspaceManager
  sessionManager: SessionManager
  agentManager: AgentManager
  statusDetector: StatusDetector
  gitHelper: GitHelper
  worktreeHelper: WorktreeHelper
  agentOrchestrator: AgentOrchestrator
  chatManager: ChatManager
  /** Structured agent lifecycle status, fed by agent hooks (see
   *  services/agentStatus.ts). Backs the agent rows' status line. */
  agentStatus: AgentStatusService
  autoSaveSessions: () => Promise<void>
  rebuildMenu: () => void
}

export interface CreateServerContextOptions {
  io: Server
  httpServer: HttpServer
  expressApp: Express
  userDataPath: string
  rebuildMenu: () => void
  stateManager?: StateManager | null
}

export function createServerContext(opts: CreateServerContextOptions): ServerContext {
  const workspaceManager = WorkspaceManager.getInstance()
  const agentManager = new AgentManager()
  const sessionManager = new SessionManager(opts.io, agentManager, opts.userDataPath)
  const statusDetector = new StatusDetector()
  const gitHelper = new GitHelper()
  const worktreeHelper = new WorktreeHelper()
  const agentOrchestrator = new AgentOrchestrator(opts.io, getMaxConcurrentSessions())
  agentOrchestrator.setStateManager(opts.stateManager ?? null)
  const chatManager = new ChatManager()
  const agentStatus = new AgentStatusService()

  sessionManager.setStatusDetector(statusDetector)
  sessionManager.setGitHelper(gitHelper)
  sessionManager.orchestrator = agentOrchestrator

  async function autoSaveSessions(): Promise<void> {
    const ws = sessionManager.getWorkspace()
    if (!ws?.id) return
    const sessions = sessionManager.getSessionSaveData()
    await workspaceManager.saveSessionState(ws.id, sessions)
  }

  return {
    io: opts.io,
    httpServer: opts.httpServer,
    expressApp: opts.expressApp,
    workspaceManager,
    sessionManager,
    agentManager,
    statusDetector,
    gitHelper,
    worktreeHelper,
    agentOrchestrator,
    chatManager,
    agentStatus,
    autoSaveSessions,
    rebuildMenu: opts.rebuildMenu,
  }
}
