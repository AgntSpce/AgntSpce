import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import { registerSessionHandlers } from './sessions'
import { registerStatsHandlers } from './stats'
import { registerWorkspaceHandlers } from './workspaces'
import { registerGitHandlers } from './git'
import { registerFileHandlers } from './files'
import { registerChatHandlers } from './chat'
import { registerCavemanHandlers } from './caveman'
import { registerTaskHandlers } from './tasks'

export function registerAllHandlers(ctx: ServerContext, socket: Socket): void {
  registerSessionHandlers(ctx, socket)
  registerStatsHandlers(ctx, socket)
  registerWorkspaceHandlers(ctx, socket)
  registerGitHandlers(ctx, socket)
  registerFileHandlers(ctx, socket)
  registerChatHandlers(ctx, socket)
  registerCavemanHandlers(ctx, socket)
  registerTaskHandlers(ctx, socket)
}
