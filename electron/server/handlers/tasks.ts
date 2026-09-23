import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Socket } from 'socket.io'
import type { ServerContext } from '../context'
import { StateManager } from '../../services/orchestration/stateManager'
import { getDbPath } from '../../services/orchestration/bootstrap'
import { ensureCollabFileColumn } from '../../services/orchestration/schema'
import { TaskOrchestrator } from '../../services/orchestration/taskOrchestrator'
import { TaskMerger } from '../../services/orchestration/taskMerger'
import { WorktreeLifecycle } from '../../services/orchestration/worktreeLifecycle'
import { CollabShim } from '../../services/orchestration/collabShim'
import { injectGroupContext } from '../../services/orchestration/groupSync'
import { writeTaskMetaFile } from '../../services/orchestration/taskPlanner'
import type { ChatMessage } from '../../services/chatTypes'

// Per-repo StateManagers. The boot-time coordinator only covers the workspace
// that was active at launch (possibly none, with blank-start windows), so
// task endpoints lazily ensure a DB for the repo they actually operate on.
// One entry per repo path; SQLite serializes the low-frequency writes.
const smCache = new Map<string, StateManager>()
// Last lazy-ensure failure, surfaced in endpoint errors so a persistent
// failure tells us WHY instead of the generic unavailable message.
let lastResolveError: string | null = null

function resolveSM(ctx: ServerContext, repoPath?: string): StateManager | null {
  const orch = ctx.agentOrchestrator
  const existing = orch.getStateManager()
  let root = ''
  try {
    root = path.resolve(repoPath || ctx.workspaceManager.getActiveWorkspace()?.repository?.path || '')
  } catch { root = '' }
  let sm: StateManager | null = null
  if (existing) {
    try {
      if (!root || existing.getRepoPath() === root) sm = existing
    } catch {}
  }
  if (!sm) {
    if (!root) {
      lastResolveError = 'no repository path resolved'
      return existing
    }
    sm = smCache.get(root) ?? null
    if (!sm) {
      try {
        fs.mkdirSync(path.join(root, '.agntspce'), { recursive: true })
        sm = new StateManager(getDbPath(root), root)
        smCache.set(root, sm)
      } catch (e: any) {
        lastResolveError = e?.message || String(e)
        return existing
      }
    }
  }
  // Self-heal: a DB file written before the file-column migration (by any
  // instance, current or older) must be repaired before claim queries run,
  // otherwise every collab write fails with "no such column: file".
  try {
    if (!ensureCollabFileColumn(sm.getDb())) {
      lastResolveError = 'task database schema repair failed (collab_events.file)'
      return existing
    }
    lastResolveError = null
  } catch (e: any) {
    lastResolveError = e?.message || String(e)
    return existing
  }
  try { orch.setStateManager(sm) } catch {}
  return sm
}

/** StateManager holding a given task group: orchestrator's own first
 *  (fast path), otherwise lazily ensured for the active workspace root. */
function smForTask(ctx: ServerContext, taskGroupId: string): StateManager | null {
  const cur = ctx.agentOrchestrator.getStateManager()
  if (cur) {
    try {
      if (cur.getTaskGroup(taskGroupId)) return cur
    } catch {}
  }
  const sm = resolveSM(ctx)
  if (!sm) return cur
  try {
    if (sm.getTaskGroup(taskGroupId)) return sm
  } catch {}
  return cur ?? sm
}

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
  const getSM = () => resolveSM(ctx)

  socket.on('list-task-groups', async ({ workspaceId }: { workspaceId?: string }, callback?: Function) => {
    try {
      const wsId = workspaceId ?? ctx.workspaceManager.getActiveWorkspace()?.id
      const ws = wsId ? ctx.workspaceManager.getWorkspace(wsId) : ctx.workspaceManager.getActiveWorkspace()
      const sm = resolveSM(ctx, ws?.repository?.path)
      if (!sm) {
        if (callback) callback({ ok: false, error: 'Task orchestration is unavailable (no workspace root)' })
        return
      }
      if (callback) callback({ ok: true, taskGroups: sm.listTaskGroups(wsId ?? undefined) })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('create-task-group', async (data: CreateTaskGroupInput, callback?: Function) => {
    try {
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
      // Lazily ensure the task DB for this repo: with blank-start windows the
      // boot coordinator may never have run, so there is no StateManager yet.
      const sm = resolveSM(ctx, repoPath)
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)

      const userGoal = (data.userGoal ?? '').trim()
      const title = (data.title ?? '').trim() || userGoal.slice(0, 60) || 'Untitled task'
      const agents = Array.isArray(data.agents) ? data.agents.filter(a => a?.agentId) : []
      // Empty groups are allowed: quick-created tasks start with zero agents
      // and members join later (sidebar drop, auto-join, or launch).

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

      // Isolated git worktree up front (per task logic): agents added later
      // spawn straight into it. Best-effort — a non-git folder still yields
      // a usable group rooted at the repo.
      try {
        const wtl = new WorktreeLifecycle(repoPath)
        const slug = WorktreeLifecycle.sanitizeTaskSlug(title)
        let ref = 'HEAD'
        try { ref = sm.getIntegrationBranchSha() } catch {}
        const res = wtl.createTaskWorktree(group.id, slug, ref)
        sm.updateTaskGroup(group.id, { branchName: res.branchName, worktreePath: res.worktreePath, baseSha: res.branchPoint, status: 'active' })
        writeTaskMetaFile(res.worktreePath, {
          taskGroupId: group.id,
          branchName: res.branchName,
          baseSha: res.branchPoint,
          worktreeMode: 'worktree',
          todoList: userGoal ? [userGoal] : [title],
          subtasks: subtasks.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: s.scopeFiles })),
        })
        new CollabShim(sm, repoPath).seed(group.id)
      } catch (e: any) {
        console.warn('[tasks] worktree setup skipped:', e?.message || e)
      }

      ctx.io.emit('task-groups-changed', { workspaceId: ws.id })
      if (callback) callback({ ok: true, taskGroup: sm.getTaskGroup(group.id), subtasks })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  const buildOrchestrator = (taskGroupId?: string) => {
    const sm = (taskGroupId ? smForTask(ctx, taskGroupId) : resolveSM(ctx))
      ?? ctx.agentOrchestrator.getStateManager()
    if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
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
    const sm = smForTask(ctx, taskGroupId) ?? ctx.agentOrchestrator.getStateManager()
    if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
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
      const detail = buildOrchestrator(taskGroupId).getDetail(taskGroupId)
      if (callback) callback({ ok: true, detail: { ...detail, resources: taskResources(taskGroupId) } })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('launch-task', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const result = await buildOrchestrator(taskGroupId).launchTask(taskGroupId)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('close-task', async ({ taskGroupId, abandon }: { taskGroupId: string; abandon?: boolean }, callback?: Function) => {
    try {
      const result = buildOrchestrator(taskGroupId).closeTask(taskGroupId, abandon === true)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('task-followup', async ({ taskGroupId, message }: { taskGroupId: string; message: string }, callback?: Function) => {
    try {
      const result = await buildOrchestrator(taskGroupId).replanTask(taskGroupId, message)
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
      const sm = resolveSM(ctx) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
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

  // ── Orca-style grouping: link live sessions into a shared task ──
  // No planner, no overlap check — grouped agents share everything and
  // coordinate through claims. Scopes recorded here are advisory only.

  socket.on('group-sessions', async ({ sessionIds, title }: { sessionIds: string[]; title?: string }, callback?: Function) => {
    try {
      const activeWs = ctx.workspaceManager.getActiveWorkspace()
      const sm = resolveSM(ctx, activeWs?.repository?.path)
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      const ids = [...new Set(sessionIds || [])]
      if (ids.length === 0) throw new Error('Pick at least one agent session to group')
      const ws = ctx.workspaceManager.getActiveWorkspace()
      const repoPath = ws?.repository?.path
      if (!repoPath || !fs.existsSync(repoPath)) throw new Error('Active workspace has no valid repository folder')

      const states = ctx.sessionManager.getSessionStates()
      const members = ids
        .filter(id => states[id])
        .map(id => ({ sessionId: id, agentId: String(states[id].type || 'shell') }))
      if (members.length === 0) throw new Error('None of those sessions still exist')

      const group = sm.createTaskGroup({
        workspaceId: ws!.id,
        repoPath,
        title: (title ?? '').trim() || `Shared task (${members.length} agents)`,
        userGoal: '',
        worktreeMode: 'worktree',
      })

      // Shared isolated worktree, best-effort: without one the group still
      // works with the repo root as cwd.
      let ref = 'HEAD'
      try { ref = sm.getIntegrationBranchSha() } catch {}
      try {
        const wtl = new WorktreeLifecycle(repoPath)
        const slug = WorktreeLifecycle.sanitizeTaskSlug(group.title)
        const res = wtl.createTaskWorktree(group.id, slug, ref)
        sm.updateTaskGroup(group.id, { branchName: res.branchName, worktreePath: res.worktreePath, baseSha: res.branchPoint, status: 'active' })
      } catch {
        sm.updateTaskGroup(group.id, { status: 'active' })
      }

      const subtasks = members.map(m => {
        const s = sm.addSubTask({ taskGroupId: group.id, agentId: m.agentId, title: m.agentId })
        return sm.updateSubTaskStatus(s.id, 'running', m.sessionId)!
      })
      const cwd = sm.getTaskGroup(group.id)!.worktreePath ?? repoPath
      writeTaskMetaFile(cwd, {
        taskGroupId: group.id,
        branchName: sm.getTaskGroup(group.id)!.branchName ?? '',
        baseSha: sm.getTaskGroup(group.id)!.baseSha,
        worktreeMode: 'worktree',
        todoList: [`${members.map(m => m.agentId).join(', ')} collaborate in the shared worktree`],
        subtasks: subtasks.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: [] })),
      })
      const { injected } = injectGroupContext(sm, ctx.sessionManager, group.id, repoPath)
      ctx.io.emit('task-groups-changed', { workspaceId: ws!.id })
      if (callback) callback({ ok: true, taskGroup: sm.getTaskGroup(group.id), subtasks, injected })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('join-group', async ({ taskGroupId, sessionId }: { taskGroupId: string; sessionId: string }, callback?: Function) => {
    try {
      const sm = smForTask(ctx, taskGroupId) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      const group = sm.getTaskGroup(taskGroupId)
      if (!group) throw new Error(`Task ${taskGroupId} not found`)
      const state = ctx.sessionManager.getSessionStates()[sessionId]
      if (!state) throw new Error('That session no longer exists')
      const already = sm.listSubTasks(taskGroupId).find(s => s.sessionId === sessionId)
      if (already) {
        if (callback) callback({ ok: true, subtask: already, joined: false })
        return
      }
      const created = sm.addSubTask({ taskGroupId, agentId: String(state.type || 'shell'), title: String(state.type || 'shell') })
      const subtask = sm.updateSubTaskStatus(created.id, 'running', sessionId)!
      if (group.status !== 'active') sm.updateTaskGroup(taskGroupId, { status: 'active' })
      injectGroupContext(sm, ctx.sessionManager, taskGroupId, group.repoPath)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, subtask, joined: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('ungroup-session', async ({ taskGroupId, sessionId }: { taskGroupId: string; sessionId: string }, callback?: Function) => {
    try {
      const sm = smForTask(ctx, taskGroupId) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      const group = sm.getTaskGroup(taskGroupId)
      if (!group) throw new Error(`Task ${taskGroupId} not found`)
      const sub = sm.listSubTasks(taskGroupId).find(s => s.sessionId === sessionId)
      if (!sub) {
        if (callback) callback({ ok: true, removed: false })
        return
      }
      sm.updateSubTaskStatus(sub.id, 'pending', null)
      const stillRunning = sm.listSubTasks(taskGroupId).some(s => s.status === 'running')
      if (!stillRunning) sm.updateTaskGroup(taskGroupId, { status: 'paused' })
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, removed: true })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })
}
