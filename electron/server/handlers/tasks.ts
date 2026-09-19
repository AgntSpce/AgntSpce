import * as fs from 'node:fs'
import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import { TaskOrchestrator } from '../../services/orchestration/taskOrchestrator'
import { TaskMerger } from '../../services/orchestration/taskMerger'
import { WorktreeLifecycle } from '../../services/orchestration/worktreeLifecycle'
import type { ChatMessage } from '../../services/chatTypes'

export interface CreateTaskGroupInput {
  workspaceId?: string
  /** Mixed-repo pin: explicit repo for this task (must exist on disk). */
  repoPath?: string
  title?: string
  userGoal?: string
  worktreeMode?: 'worktree' | 'in-repo'
  agents?: { agentId: string; model?: string; reasoning?: string; verbosity?: string }[]
}

export function registerTaskHandlers(ctx: ServerContext, socket: Socket): void {
  const getSM = () => ctx.agentOrchestrator.getStateManager()

  socket.on('list-task-groups', async ({ workspaceId }: { workspaceId?: string }, callback?: Function) => {
    try {
      const sm = getSM()
      if (!sm) {
        if (callback) callback({ ok: false, error: 'Task orchestration is unavailable (no workspace root)' })
        return
      }
      const wsId = workspaceId ?? ctx.workspaceManager.getActiveWorkspace()?.id
      if (callback) callback({ ok: true, taskGroups: sm.listTaskGroups(wsId ?? undefined) })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('create-task-group', async (data: CreateTaskGroupInput, callback?: Function) => {
    try {
      const sm = getSM()
      if (!sm) throw new Error('Task orchestration is unavailable (no workspace root)')

      const ws = data.workspaceId
        ? ctx.workspaceManager.getWorkspace(data.workspaceId)
        : ctx.workspaceManager.getActiveWorkspace()
      if (!ws) throw new Error('No workspace selected')
      // Single-repo: the workspace repo. Mixed-repo: the pinned repo, when given.
      const pinned = (data.repoPath ?? '').trim()
      const repoPath = pinned || ws.repository?.path
      if (!repoPath || !fs.existsSync(repoPath)) {
        throw new Error(pinned
          ? `Pinned repo path does not exist: ${pinned}`
          : `Workspace "${ws.name}" has no valid repository folder`)
      }

      const userGoal = (data.userGoal ?? '').trim()
      const title = (data.title ?? '').trim() || userGoal.slice(0, 60) || 'Untitled task'
      const agents = Array.isArray(data.agents) ? data.agents.filter(a => a?.agentId) : []
      if (agents.length === 0) throw new Error('Pick at least one agent for the task')

      const group = sm.createTaskGroup({
        workspaceId: ws.id,
        repoPath,
        title,
        userGoal,
        worktreeMode: data.worktreeMode === 'in-repo' ? 'in-repo' : 'worktree',
      })
      const subtasks = agents.map(a =>
        sm.addSubTask({
          taskGroupId: group.id,
          agentId: a.agentId,
          model: a.model ?? null,
          reasoning: a.reasoning ?? null,
          verbosity: a.verbosity ?? null,
        })
      )

      // Worktree/branch creation + agent spawn happen at launch-task time
      // (TaskOrchestrator) — the group stays in 'planning' until then.
      ctx.io.emit('task-groups-changed', { workspaceId: ws.id })
      if (callback) callback({ ok: true, taskGroup: group, subtasks })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  const buildOrchestrator = () => {
    const sm = ctx.agentOrchestrator.getStateManager()
    if (!sm) throw new Error('Task orchestration is unavailable (no workspace root)')
    const llm = buildLlm()
    return new TaskOrchestrator(sm, ctx.sessionManager, ctx.agentOrchestrator, llm ? { llm } : undefined)
  }

  const buildLlm = (): ((prompt: string) => Promise<string | null>) | undefined => {
    // Planner/conflict-solver LLM: first configured chat provider, one-shot
    // (no thread pollution). None configured → deterministic fallback split.
    for (const pid of ['anthropic', 'openai', 'google', 'deepseek', 'grok', 'mistral', 'groq', 'openrouter']) {
      try {
        const provider = ctx.chatManager.getProvider(pid)
        if (provider?.isConfigured()) {
          const model = (provider as any).model as string
          return async (prompt: string) => {
            try {
              const msg: ChatMessage = { id: `task-plan-${Date.now()}`, role: 'user', content: prompt, timestamp: Date.now() }
              return await provider.chat([msg], model)
            } catch {
              return null
            }
          }
        }
      } catch {}
    }
    return undefined
  }

  const buildMerger = (taskGroupId: string) => {
    const sm = ctx.agentOrchestrator.getStateManager()
    if (!sm) throw new Error('Task orchestration is unavailable (no workspace root)')
    const group = sm.getTaskGroup(taskGroupId)
    if (!group) throw new Error(`Task ${taskGroupId} not found`)
    return new TaskMerger(group.repoPath, new WorktreeLifecycle(group.repoPath), sm, buildLlm())
  }

  const taskResources = (taskGroupId: string) => {
    try {
      return ctx.agentOrchestrator.getTaskResourceUsage().find(r => r.taskGroupId === taskGroupId) ?? null
    } catch {
      return null
    }
  }

  socket.on('get-task-detail', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const detail = buildOrchestrator().getDetail(taskGroupId)
      if (callback) callback({ ok: true, detail: { ...detail, resources: taskResources(taskGroupId) } })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('launch-task', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const result = await buildOrchestrator().launchTask(taskGroupId)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('close-task', async ({ taskGroupId, abandon }: { taskGroupId: string; abandon?: boolean }, callback?: Function) => {
    try {
      const result = buildOrchestrator().closeTask(taskGroupId, abandon === true)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('task-followup', async ({ taskGroupId, message }: { taskGroupId: string; message: string }, callback?: Function) => {
    try {
      const result = await buildOrchestrator().replanTask(taskGroupId, message)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('preview-task-merge', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const preview = buildMerger(taskGroupId).previewMerge(taskGroupId)
      if (callback) callback({ ok: !preview.error, preview })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('merge-task', async ({ taskGroupId, autoResolve }: { taskGroupId: string; autoResolve?: boolean }, callback?: Function) => {
    try {
      const result = await buildMerger(taskGroupId).executeMerge(taskGroupId, autoResolve !== false)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('confirm-task-merge', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const result = buildMerger(taskGroupId).confirmMerge(taskGroupId)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('merge-all-tasks', async ({ taskGroupIds }: { taskGroupIds: string[] }, callback?: Function) => {
    try {
      const sm = ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error('Task orchestration is unavailable (no workspace root)')
      // Serialize through the first group's merger (per-merger lock); groups
      // are expected to share the repo. Mismatched repos merge independently.
      const results: any[] = []
      for (const id of taskGroupIds || []) {
        results.push(await buildMerger(id).executeMerge(id, true))
      }
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, results })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })
}
