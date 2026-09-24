import { app, BrowserWindow } from 'electron'
import crypto from 'node:crypto'
import 'dotenv/config'
import { initialize as initRtk } from './services/rtkManager'
import { initialize as initSearch, injectClaudeCodeConfig, injectOpenCodeConfig } from './services/searchManager'
import { ensureCoordinator, getWorkspaceRoot } from './services/orchestration/bootstrap'
import type { Coordinator } from './services/orchestration'
import type { StateManager } from './services/orchestration/stateManager'
import { bootstrapServer } from './server'
import { WorkspaceManager } from './services/workspaceManager'
import { createWindow, getMainWindow, registerIpcHandlers, rebuildMenu } from './window'
app.setName('AgntSpce')
app.name = 'AgntSpce'

// Each terminal pane holds one WebGL context. Blink force-drops the OLDEST
// WebGL context past its default cap of 16 per renderer, which blanks random
// terminals in multi-pane layouts. 128 covers realistic layouts while staying
// bounded enough that a runaway leak still surfaces (Orca uses 128, Superset
// 256; Tabby's 9000 masks leaks).
app.commandLine.appendSwitch('max-active-webgl-contexts', '128')
// Silence benign Chromium GPU-teardown ERROR spam (SharedImageManager /
// Invalid mailbox) printed to stderr on window close. Those come from the
// compositor shutting down, not from app code, so hide them instead of
// changing any behavior.
app.commandLine.appendSwitch('disable-logging')
// TEMP DEBUG: CDP access for diagnosing renderer issues (remove after).
if (process.env.AGNTSPCE_DEBUG_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.AGNTSPCE_DEBUG_CDP)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => {
  const win = getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

let orchestrationCoordinator: Coordinator | null = null

let orchestrationStateManager: StateManager | null = null

let serverHandle: ReturnType<typeof bootstrapServer> | null = null

// Per-launch random token. The renderer obtains it via preload IPC and must
// present it on the Socket.IO handshake and /api/* requests; browser pages on
// other origins cannot get it, which blocks drive-by access to localhost:9460.
const serverAuthToken = crypto.randomBytes(32).toString('hex')

function startServer() {
  serverHandle = bootstrapServer(app.getPath('userData'), rebuildMenu, orchestrationStateManager, serverAuthToken)
  return serverHandle
}

app.whenReady().then(async () => {
  // Initialize RTK: install binary to userData + register agent hooks
  initRtk()

  // Initialize search: install bundled search distribution to userData
  initSearch()
  injectOpenCodeConfig()

  // Initialize workspace manager early so orchestration can use its active workspace root
  const workspaceManager = WorkspaceManager.getInstance()
  try { await workspaceManager.initialize() } catch (e) { console.warn('Workspace manager init failed:', e) }

  // Initialize orchestration coordinator (zero-config bootstrap)
  const activeWs = workspaceManager.getActiveWorkspace()
  const workspaceRoot = activeWs?.repository?.path ? getWorkspaceRoot(activeWs.repository.path) : getWorkspaceRoot()
  if (!workspaceRoot) {
    console.warn('[orchestration] No workspace root found — skipping coordinator')
  } else {
    const result = await ensureCoordinator({ workspaceRoot })
    if (result.status === 'started') {
      orchestrationCoordinator = result.coordinator
      orchestrationStateManager = result.stateManager
      console.log('[orchestration] Coordinator started')
    } else if (result.status === 'already_running') {
      orchestrationStateManager = result.stateManager
      console.log('[orchestration] Coordinator already running for', result.workspaceRoot)
    } else if (result.status === 'error') {
      console.error('[orchestration] Coordinator error:', result.error)
    }
  }

  registerIpcHandlers(rebuildMenu, serverAuthToken)
  createWindow()

  const server = startServer()
  const ctx = server.ctx

  try {
    await ctx.workspaceManager.initialize()
    const activeWs = ctx.workspaceManager.getActiveWorkspace()
    if (activeWs) {
      ctx.sessionManager.setWorkspace(activeWs)
      await ctx.worktreeHelper.ensureWorktreesExist(activeWs)
      try { await ctx.workspaceManager.runSetupScript(activeWs) } catch (e) {
        console.warn('Setup script failed on boot:', e)
      }
      // Check for saved sessions first. If they exist (with correct agent types),
      // restore them directly and skip creating default sessions from workspace.terminals.
      // This prevents wrong-type or duplicate sessions on app restart.
      const savedSessions = await ctx.workspaceManager.loadSessionState(activeWs.id)
      if (savedSessions.length > 0) {
        await ctx.sessionManager.restoreSessions(savedSessions)
        await ctx.workspaceManager.saveSessionState(activeWs.id, ctx.sessionManager.getSessionSaveData())
      } else {
        await ctx.sessionManager.initializeSessions()
      }
      if (activeWs.repository?.path) {
        injectClaudeCodeConfig(activeWs.repository.path)
      }
    }
    rebuildMenu()
  } catch (e) {
    console.error('Failed to initialize workspace system:', e)
  }

  server.listen()
})

app.on('will-quit', () => {
  if (orchestrationCoordinator) {
    orchestrationCoordinator.close()
    orchestrationCoordinator = null
  }
  const ctx = serverHandle?.ctx
  if (ctx) {
    ctx.agentOrchestrator.shutdownAll()
    ctx.chatManager.flushThreads()
    const ws = ctx.sessionManager.getWorkspace()
    if (ws?.id) {
      const sessions = ctx.sessionManager.getSessionSaveData()
      ctx.workspaceManager.saveSessionStateSync(ws.id, sessions)
      ctx.sessionManager.saveAllSessionBuffersSync()
    }
    ctx.sessionManager.outputFilter.persistCumulativeStats()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
