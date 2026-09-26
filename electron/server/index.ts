import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { isAllowedCorsOrigin, MAX_JSON_BODY_SIZE, MAX_PORT_RETRIES, SERVER_HOST, SERVER_PORT } from '../config'
import { createServerContext, type ServerContext } from './context'
import { registerApiRoutes } from './api'
import { registerAllHandlers } from './handlers'
import { registerAgentStatusRoute } from './handlers/agentStatus'
import type { StateManager } from '../services/orchestration/stateManager'

export interface ServerHandle {
  io: Server
  httpServer: ReturnType<typeof createServer>
  ctx: ServerContext
  listen: () => void
}

export function bootstrapServer(userDataPath: string, rebuildMenu: () => void, stateManager?: StateManager | null, authToken?: string): ServerHandle {
  const expressApp = express()
  const httpServer = createServer(expressApp)
  const io = new Server(httpServer, {
    // Base64 image/file attachments ride the chat-send events; the default
    // 1MB Socket.IO cap would reject them. Local-only + token-gated, so a
    // generous cap is safe.
    maxHttpBufferSize: 25 * 1024 * 1024,
    cors: {
      origin: (origin, callback) => {
        if (isAllowedCorsOrigin(origin)) {
          callback(null, true)
        } else {
          callback(new Error('Not allowed by CORS'))
        }
      },
    },
  })

  // Socket.IO handshake auth: clients inside Electron present the per-launch
  // token via io(url, { auth: { token } }). Non-browser local tools (no Origin
  // header) are still allowed; any browser page without the token is rejected.
  io.use((socket, next) => {
    if (!authToken || socket.handshake.auth?.token === authToken) return next()
    if (!socket.handshake.headers.origin) return next()
    next(new Error('Unauthorized'))
  })

  // REST: reflect the origin only when allowlisted (never `*`), then require
  // the auth token for anything a browser could send cross-origin. Requests
  // with no Origin header (curl, local scripts like bin/agntspce.mjs) pass.
  expressApp.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && isAllowedCorsOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-agntspce-token')
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    const presented = (() => {
      const header = req.headers['x-agntspce-token']
      if (typeof header === 'string' && header) return header
      const auth = req.headers.authorization
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7)
      return undefined
    })()
    if (authToken && presented !== authToken && origin) {
      res.status(403).json({ error: 'Unauthorized' })
      return
    }
    next()
  })
  expressApp.use(express.json({ limit: MAX_JSON_BODY_SIZE }))

  const ctx = createServerContext({ io, httpServer, expressApp, userDataPath, rebuildMenu, stateManager })

  registerApiRoutes(expressApp, ctx)
  // Hook ingest lives outside registerAllHandlers because that runs per socket
  // connection; an Express route must be added exactly once.
  registerAgentStatusRoute(ctx)

  io.on('connection', (socket) => {
    const activeWs = ctx.workspaceManager.getActiveWorkspace()
    socket.emit('workspace-info', {
      active: activeWs,
      available: ctx.workspaceManager.listWorkspaces(),
      config: ctx.workspaceManager.getConfig(),
    })
    socket.emit('sessions', ctx.sessionManager.getSessionStates())

    const backlog = ctx.sessionManager.getUndeliveredOutputAndMarkDelivered()
    if (Object.keys(backlog).length > 0) {
      socket.emit('backlog', backlog)
    }

    registerAllHandlers(ctx, socket)
  })

  const listen = () => {
    function listenWithRetry(attempt: number) {
      const server = httpServer.listen(SERVER_PORT, SERVER_HOST)
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES) {
          console.log(`[server] Port ${SERVER_PORT} in use, retrying in 500ms (attempt ${attempt + 1}/${MAX_PORT_RETRIES})`)
          server.close()
          setTimeout(() => listenWithRetry(attempt + 1), 500)
        } else {
          console.error(`[server] Failed to bind to port ${SERVER_PORT}:`, err.message)
        }
      })
      server.on('listening', () => {
        console.log(`Server running on http://${SERVER_HOST}:${SERVER_PORT}`)
      })
    }

    listenWithRetry(0)
  }

  return { io, httpServer, ctx, listen }
}
