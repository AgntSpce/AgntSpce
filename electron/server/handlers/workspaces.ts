import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import { injectClaudeCodeConfig } from '../../services/searchManager'

export function registerWorkspaceHandlers(ctx: ServerContext, socket: Socket): void {
  socket.on('switch-workspace', async ({ workspaceId }) => {
    try {
      const prevWs = ctx.workspaceManager.getActiveWorkspace()
      if (prevWs) {
        try { await ctx.workspaceManager.runTeardownScript(prevWs) } catch (e) {
          console.warn('Teardown script failed:', e)
        }
        await ctx.autoSaveSessions()
      }
      const newWs = await ctx.workspaceManager.switchWorkspace(workspaceId)
      await ctx.worktreeHelper.ensureWorktreesExist(newWs)
      try { await ctx.workspaceManager.runSetupScript(newWs) } catch (e) {
        console.warn('Setup script failed:', e)
      }
      if (newWs?.repository?.path) {
        injectClaudeCodeConfig(newWs.repository.path)
      }
      const { sessions } = await ctx.sessionManager.switchWorkspacePreservingSessions(newWs)
      socket.emit('workspace-changed', { workspace: newWs, sessions })
      ctx.rebuildMenu()
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to switch workspace', error: error.message })
    }
  })

  socket.on('list-workspaces', async () => {
    socket.emit('workspaces-list', ctx.workspaceManager.listWorkspaces())
  })

  socket.on('create-workspace', async (data: any, callback?: Function) => {
    try {
      const ws = await ctx.workspaceManager.createWorkspace(data)
      if (callback) callback({ ok: true, workspace: ws })
      ctx.io.emit('workspaces-list', ctx.workspaceManager.listWorkspaces())
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('create-workspace-from-git', async (data: { gitUrl: string, name?: string, setupScript?: string, teardownScript?: string, basePath?: string }, callback?: Function) => {
    try {
      const ws = await ctx.workspaceManager.cloneFromGitUrl(data.gitUrl, data.name, { setupScript: data.setupScript, teardownScript: data.teardownScript }, data.basePath)
      if (callback) callback({ ok: true, workspace: ws })
      ctx.io.emit('workspaces-list', ctx.workspaceManager.listWorkspaces())
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('update-workspace-config', async (data: { workspaceId: string, updates: any }, callback?: Function) => {
    try {
      const ws = await ctx.workspaceManager.updateWorkspace(data.workspaceId, data.updates)
      if (callback) callback({ ok: true, workspace: ws })
      ctx.io.emit('workspaces-list', ctx.workspaceManager.listWorkspaces())
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('list-deleted-workspaces', async (_data: any, callback?: Function) => {
    const deleted = await ctx.workspaceManager.listDeletedWorkspaces()
    if (callback) callback(deleted)
  })

  socket.on('restore-workspace', async ({ workspaceId }, callback?: Function) => {
    const ws = await ctx.workspaceManager.restoreWorkspace(workspaceId)
    if (ws) {
      ctx.io.emit('workspaces-list', ctx.workspaceManager.listWorkspaces())
      if (callback) callback({ ok: true, workspace: ws })
    } else {
      if (callback) callback({ ok: false })
    }
  })

  socket.on('permanent-delete-workspace', async ({ workspaceId }, callback?: Function) => {
    await ctx.workspaceManager.permanentDeleteWorkspace(workspaceId)
    if (callback) callback({ ok: true })
  })

  socket.on('delete-workspace', async ({ workspaceId }) => {
    try {
      await ctx.workspaceManager.deleteWorkspace(workspaceId)
      ctx.io.emit('workspaces-list', ctx.workspaceManager.listWorkspaces())
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to delete workspace', error: error.message })
    }
  })

  socket.on('add-worktree', async ({ workspaceId }, callback?: Function) => {
    try {
      const ws = ctx.workspaceManager.getWorkspace(workspaceId)
      if (!ws) throw new Error('Workspace not found')
      const nextIndex = (ws.worktrees?.count || 0) + 1
      const worktreeId = (ws.worktrees?.namingPattern || 'work{n}').replace('{n}', String(nextIndex))
      const path = await ctx.worktreeHelper.createWorktree(ws, worktreeId)
      await ctx.workspaceManager.updateWorkspace(workspaceId, {
        worktrees: { ...ws.worktrees, enabled: true, count: nextIndex, autoCreate: true, namingPattern: ws.worktrees?.namingPattern || 'work{n}' },
      })
      if (callback) callback({ ok: true, worktree: { id: worktreeId, path } })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('remove-worktree', async ({ workspaceId, worktreeId }, callback?: Function) => {
    try {
      const ws = ctx.workspaceManager.getWorkspace(workspaceId)
      if (!ws) throw new Error('Workspace not found')
      const sessionIds: string[] = []
      const states = ctx.sessionManager.getSessionStates()
      for (const [id, s] of Object.entries(states) as any) {
        if (s.worktreeId === worktreeId) sessionIds.push(id)
      }
      for (const id of sessionIds) {
        ctx.sessionManager.closeSession(id)
        ctx.io.emit('session-closed', { sessionId: id })
      }
      await ctx.worktreeHelper.removeWorktree(ws, worktreeId)
      if (callback) callback({ ok: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('list-worktrees', async ({ workspaceId }, callback?: Function) => {
    try {
      const ws = ctx.workspaceManager.getWorkspace(workspaceId)
      if (!ws) {
        if (callback) callback([])
        return
      }
      const wtList = ctx.sessionManager.getWorktrees().map(wt => ({
        id: wt.id,
        path: wt.path,
      }))
      if (callback) callback(wtList)
    } catch {
      if (callback) callback([])
    }
  })
}
