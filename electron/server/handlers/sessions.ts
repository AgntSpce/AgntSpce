import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import { linkSessionToGroup } from '../../services/orchestration/groupSync'

export function registerSessionHandlers(ctx: ServerContext, socket: Socket): void {
  socket.on('terminal-input', ({ sessionId, data, input }) => {
    const inputData = data || input
    if (!inputData) return
    ctx.sessionManager.writeToSession(sessionId, inputData)
    // Accumulate keystrokes per session; submitted lines (Enter) are recorded
    // as prompts with before/after agntspce-prompter compression.
    try {
      ctx.sessionManager.promptHistory.handleTerminalInput(sessionId, inputData)
    } catch {}
  })

  socket.on('terminal-resize', ({ sessionId, cols, rows }) => {
    ctx.sessionManager.resizeSession(sessionId, cols, rows)
  })

  socket.on('restart-session', ({ sessionId }) => {
    ctx.sessionManager.restartSession(sessionId)
  })

  socket.on('create-raw-session', async ({ type, workspacePath }) => {
    try {
      const t = String(type || '').trim().toLowerCase() || 'shell'
      const result = await ctx.sessionManager.createRawSession(t, workspacePath)
      if (result) {
        const states = ctx.sessionManager.getSessionStates()
        socket.emit('session-created', { sessionId: result.sessionId, sessions: states })
        await ctx.autoSaveSessions()
      } else {
        socket.emit('error', { message: 'Failed to create session - check main process console for details' })
      }
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to create session', error: error.message })
    }
  })

  socket.on('create-agent-session', async ({ type, workspacePath, config, taskGroupId }) => {
    try {
      const t = String(type || '').trim().toLowerCase() || 'shell'
      const result = await ctx.sessionManager.createRawSession(t, workspacePath)
      if (result) {
        if (taskGroupId) {
          try {
            const sm = ctx.agentOrchestrator.getStateManager()
            const group = sm?.getTaskGroup(taskGroupId)
            if (sm && group) {
              const linked = linkSessionToGroup(sm, ctx.sessionManager.getSessionStates(), taskGroupId, result.sessionId, group.repoPath)
              ctx.sessionManager.setSessionTaskLink?.(result.sessionId, taskGroupId, linked.subtask.id)
              ctx.io.emit('task-groups-changed', { workspaceId: '' })
            }
          } catch (e: any) {
            console.warn('[sessions] spawn group-link failed:', e?.message || e)
          }
        }
        try {
          ctx.sessionManager.startAgentWithConfig(result.sessionId, config)
        } catch (e: any) {
          socket.emit('error', { message: 'Agent start failed', error: e.message })
        }
        const states = ctx.sessionManager.getSessionStates()
        socket.emit('session-created', { sessionId: result.sessionId, sessions: states })
        await ctx.autoSaveSessions()
      } else {
        socket.emit('error', { message: 'Failed to create session' })
      }
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to create agent session', error: error.message })
    }
  })

  socket.on('start-agent', async ({ sessionId, config }) => {
    try {
      ctx.sessionManager.startAgentWithConfig(sessionId, config)
      socket.emit('agent-started', { sessionId, config })
      await ctx.autoSaveSessions()
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to start agent', error: error.message })
    }
  })

  socket.on('resume-session', async ({ sessionId }) => {
    try {
      const ok = await ctx.sessionManager.resumeSession(sessionId)
      if (ok) {
        const states = ctx.sessionManager.getSessionStates()
        socket.emit('session-resumed', { sessionId, sessions: states })
        await ctx.autoSaveSessions()
      } else {
        socket.emit('error', { message: 'Failed to resume session - session not restorable' })
      }
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to resume session', error: error.message })
    }
  })

  socket.on('close-tab', async ({ sessionIds }) => {
    try {
      const ids = Array.isArray(sessionIds) ? sessionIds : []
      const states = ctx.sessionManager.getSessionStates()
      let taskGroupsChanged = false
      for (const id of ids) {
        const state = states[id]
        ctx.sessionManager.closeSession(id)
        if (state?.taskGroupId) {
          taskGroupsChanged = true
          if (state.subtaskId) {
            try {
              const sm = ctx.agentOrchestrator.getStateManager()
              const subtask = sm?.getSubTask(state.subtaskId)
              if (sm && subtask?.sessionId === id) {
                sm.updateSubTaskStatus(subtask.id, 'pending', null)
                if (!sm.listSubTasks(state.taskGroupId).some(s => s.status === 'running')) {
                  sm.updateTaskGroup(state.taskGroupId, { status: 'paused' })
                }
              }
            } catch (e: any) {
              console.warn('[sessions] task member cleanup failed:', e?.message || e)
            }
          }
        }
        ctx.io.emit('session-closed', { sessionId: id })
      }
      if (taskGroupsChanged) ctx.io.emit('task-groups-changed', { workspaceId: ctx.sessionManager.getWorkspace()?.id || '' })
      await ctx.autoSaveSessions()
    } catch (error: any) {
      socket.emit('error', { message: 'Failed to close tabs', error: error.message })
    }
  })

  socket.on('start-parallel-task', async (data: any, callback?: Function) => {
    try {
      const load = ctx.agentOrchestrator.getConcurrencyLoad()
      const availableSlots = load.max - load.active
      if (data.worktreeCount > availableSlots) {
        if (callback) callback({ ok: false, error: `Only ${availableSlots} of ${data.worktreeCount} requested slots available. Try fewer agents.` })
        return
      }
      const { sessionIds, groupId } = await ctx.sessionManager.createParallelTask(data)
      const states = ctx.sessionManager.getSessionStates()
      const groupSessions = sessionIds.map(id => states[id]).filter(Boolean)
      if (callback) callback({ ok: true, sessionIds, groupId, sessions: groupSessions, load: ctx.agentOrchestrator.getConcurrencyLoad() })
      for (const id of sessionIds) {
        ctx.io.emit('session-created', { sessionId: id, sessions: states })
      }
      await ctx.autoSaveSessions()
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('set-user-settings', (settings: { autoRestartSessions?: boolean }) => {
    if (typeof settings.autoRestartSessions === 'boolean') {
      ctx.sessionManager.autoRestartSessions = settings.autoRestartSessions
    }
  })
}
