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
import { syncGroupFiles, linkSessionToGroup } from '../../services/orchestration/groupSync'
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
  worktreeMode?: 'worktree' | 'in-repo' | 'none'
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
      const groups = sm.listTaskGroups(wsId ?? undefined)
      // Attach live membership so the sidebar can render agent logos per
      // task and detect ungrouped sessions without extra roundtrips.
      const withMembers = groups.map(g => {
        let members: { agentId: string; sessionId: string | null }[] = []
        try {
          members = sm.listSubTasks(g.id).map(s => ({ agentId: s.agentId, sessionId: s.sessionId }))
        } catch {}
        return { ...g, members }
      })
      if (callback) callback({ ok: true, taskGroups: withMembers })
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
        worktreeMode: data.worktreeMode === 'in-repo' ? 'in-repo' : data.worktreeMode === 'none' ? 'none' : 'worktree',
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

      // Ack first so task creation feels instant; the isolated worktree
      // (git, else plain dir fallback) + seed files land right after.
      ctx.io.emit('task-groups-changed', { workspaceId: ws.id })
      if (callback) callback({ ok: true, taskGroup: group, subtasks })
      setImmediate(() => {
        try {
          const mode = group.worktreeMode
          // Writes the task's metadata and briefing into `dir`. For 'none' that
          // is the workspace folder itself, so the agent sees them in its cwd.
          const setup = (dir: string, branchName: string | null, baseSha: string | null) => {
            sm.updateTaskGroup(group.id, { branchName, worktreePath: dir, baseSha, status: 'active' })
            writeTaskMetaFile(dir, {
              taskGroupId: group.id,
              branchName: branchName ?? '',
              baseSha,
              worktreeMode: mode,
              todoList: userGoal ? [userGoal] : [title],
              subtasks: subtasks.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: s.scopeFiles })),
            })
            syncGroupFiles(sm, group.id, repoPath)
          }
          if (mode === 'none') {
            // User explicitly accepted running without git: no worktree, no
            // branch, no merge, and agents share the workspace folder.
            sm.updateTaskGroup(group.id, { worktreePath: null, status: 'active' })
            writeTaskMetaFile(repoPath, {
              taskGroupId: group.id,
              branchName: '',
              baseSha: null,
              worktreeMode: mode,
              todoList: userGoal ? [userGoal] : [title],
              subtasks: subtasks.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: s.scopeFiles })),
            })
            syncGroupFiles(sm, group.id, repoPath)
            ctx.io.emit('task-groups-changed', { workspaceId: ws.id })
            return
          }
          const wtl = new WorktreeLifecycle(repoPath)
          const slug = WorktreeLifecycle.sanitizeTaskSlug(title)
          // Only reached for a real git repo now. A repo with no commit still
          // cannot be branched from, so fall back to the shared checkout rather
          // than an empty directory pretending to be isolation.
          const inRepoFallback = () => {
            const branchName = wtl.deduplicateBranchName(wtl.buildTaskBranchName(group.id, slug))
            setup(repoPath, branchName, null)
          }
          if (!WorktreeLifecycle.isGitRepository(repoPath)) {
            console.warn(`[tasks] ${repoPath} is not a git repository — task runs in the workspace folder (no worktree, no merge)`)
            inRepoFallback()
          } else if (!WorktreeLifecycle.hasCommits(repoPath)) {
            console.warn(`[tasks] ${repoPath} has no commits yet — task runs in the workspace folder (no worktree, no merge)`)
            inRepoFallback()
          } else {
            try {
              const res = wtl.createTaskWorktree(group.id, slug, sm.getIntegrationBranchSha() || 'HEAD')
              setup(res.worktreePath, res.branchName, res.branchPoint)
            } catch (e: any) {
              console.warn('[tasks] git worktree setup failed, falling back to the shared folder:', e?.message || e)
              inRepoFallback()
            }
          }
          ctx.io.emit('task-groups-changed', { workspaceId: ws.id })
        } catch (e: any) {
          console.warn('[tasks] task dir setup skipped:', e?.message || e)
        }
      })
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

  socket.on('sync-task-branch', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const result = buildMerger(taskGroupId).syncTaskOntoIntegration(taskGroupId)
      if (callback) callback({ ok: result.ok, error: result.error, mergedFiles: result.mergedFiles })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  // Fast-forward the user's checked-out branch onto the integration branch, so
  // merged task work actually shows up in the folder they are looking at.
  socket.on('apply-task-branch', async ({ branchName }: { branchName?: string } = {}, callback?: Function) => {
    try {
      const sm = resolveSM(ctx) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      const result = new TaskMerger(sm.getRepoPath(), new WorktreeLifecycle(sm.getRepoPath()), sm)
        .applyIntegrationToBranch(branchName)
      if (callback) callback(result)
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('merge-all-tasks', async ({ taskGroupIds }: { taskGroupIds: string[] }, callback?: Function) => {
    try {
      const sm = resolveSM(ctx) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      // Oldest first: each merge advances the integration branch, so every later
      // task merges against the work already landed. Client order was never a
      // meaningful contract and made merge-all results depend on click order.
      const order = new Map(sm.listTaskGroups().map(g => [g.id, g.createdAt ?? 0]))
      const ordered = [...(taskGroupIds || [])].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      const results: any[] = []
      let stopped = false
      for (const id of ordered) {
        if (stopped) {
          results.push({
            ok: false, skipped: true, needsConfirm: false, taskGroupId: id, branchName: '',
            diffSummary: '', actualFiles: [], conflictFiles: [], scopeOverlapFiles: [], buildPassed: false,
            error: 'Skipped — an earlier task failed to merge. Resolve it and run this again.',
          })
          continue
        }
        const result = await buildMerger(id).executeMerge(id, true)
        results.push(result)
        // No rollback: a landed merge stays landed. Stop and report exactly
        // what made it in so the user can decide, instead of pretending the
        // whole batch either worked or failed.
        if (!result.ok) stopped = true
      }
      const landed = results.filter(r => r.ok).length
      const pendingConfirm = results.filter(r => r.needsConfirm).length
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) {
        callback({
          ok: !stopped,
          landed,
          pendingConfirm,
          failed: results.filter(r => !r.ok && !r.skipped).length,
          skipped: results.filter(r => r.skipped).length,
          results,
        })
      }
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
      const subtasks = members.map(m => {
        const s = sm.addSubTask({ taskGroupId: group.id, agentId: m.agentId, title: m.agentId })
        const linked = sm.updateSubTaskStatus(s.id, 'running', m.sessionId)!
        ctx.sessionManager.setSessionTaskLink?.(m.sessionId, group.id, linked.id)
        return linked
      })
      sm.updateTaskGroup(group.id, { status: 'active' })
      ctx.io.emit('task-groups-changed', { workspaceId: ws!.id })
      if (callback) callback({ ok: true, taskGroup: sm.getTaskGroup(group.id), subtasks })

      // Slow part runs after the ack so grouping feels instant: isolated
      // worktree, meta file, and shared briefing files.
      setImmediate(() => {
        try {
          const wtl = new WorktreeLifecycle(repoPath)
          const slug = WorktreeLifecycle.sanitizeTaskSlug(group.title)
          let branchName = sm.getTaskGroup(group.id)?.branchName ?? null
          let worktreePath: string | null = sm.getTaskGroup(group.id)?.worktreePath ?? null
          let baseSha: string | null = sm.getTaskGroup(group.id)?.baseSha ?? null
          if (!branchName) {
            // Non-git folder: skip the worktree attempt entirely (see the
            // create-task-group handler) and use a plain isolated directory.
            if (!WorktreeLifecycle.isGitRepository(repoPath)) {
              console.warn(`[tasks] ${repoPath} is not a git repository — grouped agents run in a plain folder (no worktree, no merge)`)
            } else {
              try {
                const res = wtl.createTaskWorktree(group.id, slug, sm.getIntegrationBranchSha() || 'HEAD')
                branchName = res.branchName
                worktreePath = res.worktreePath
                baseSha = res.branchPoint
              } catch {
                // Git repo, but worktree setup failed: plain isolated directory.
                branchName = wtl.deduplicateBranchName(wtl.buildTaskBranchName(group.id, slug))
                worktreePath = wtl.getTaskWorktreePath(group.id)
                try { fs.mkdirSync(worktreePath, { recursive: true }) } catch {}
              }
            }
            if (!branchName) {
              branchName = wtl.deduplicateBranchName(wtl.buildTaskBranchName(group.id, slug))
              worktreePath = wtl.getTaskWorktreePath(group.id)
              try { fs.mkdirSync(worktreePath, { recursive: true }) } catch {}
            }
            sm.updateTaskGroup(group.id, { branchName, worktreePath, baseSha })
          }
          const cwd = worktreePath ?? repoPath
          writeTaskMetaFile(cwd, {
            taskGroupId: group.id,
            branchName: branchName ?? '',
            baseSha,
            worktreeMode: 'worktree',
            todoList: [`${members.map(m => m.agentId).join(', ')} collaborate in the shared worktree`],
            subtasks: subtasks.map(s => ({ agentId: s.agentId, model: s.model, title: s.title, scopeFiles: [] })),
          })
          syncGroupFiles(sm, group.id, repoPath)
          ctx.io.emit('task-groups-changed', { workspaceId: ws!.id })
        } catch (e: any) {
          console.warn('[tasks] group worktree setup failed:', e?.message || e)
        }
      })
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
      const { subtask, joined } = linkSessionToGroup(sm, ctx.sessionManager.getSessionStates(), taskGroupId, sessionId, group.repoPath)
      ctx.sessionManager.setSessionTaskLink?.(sessionId, taskGroupId, subtask.id)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, subtask, joined })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('rename-task-group', async ({ taskGroupId, title }: { taskGroupId: string; title: string }, callback?: Function) => {
    try {
      const sm = smForTask(ctx, taskGroupId) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      const name = (title ?? '').trim()
      if (!name) throw new Error('Task name cannot be empty')
      const updated = sm.updateTaskGroup(taskGroupId, { title: name })
      if (!updated) throw new Error(`Task ${taskGroupId} not found`)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, taskGroup: updated })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('set-task-pinned', async ({ taskGroupId, pinned }: { taskGroupId: string; pinned: boolean }, callback?: Function) => {
    try {
      const sm = smForTask(ctx, taskGroupId) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      // Pinning stamps "now" so the most recently pinned task sorts first;
      // unpinning clears it and drops the task back into creation order.
      const updated = sm.updateTaskGroup(taskGroupId, { pinnedAt: pinned ? Date.now() : null })
      if (!updated) throw new Error(`Task ${taskGroupId} not found`)
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, taskGroup: updated })
    } catch (error: any) {
      if (callback) callback({ ok: false, error: error.message })
    }
  })

  socket.on('delete-task-group', async ({ taskGroupId }: { taskGroupId: string }, callback?: Function) => {
    try {
      const sm = smForTask(ctx, taskGroupId) ?? ctx.agentOrchestrator.getStateManager()
      if (!sm) throw new Error(`Task orchestration is unavailable (no workspace root)${lastResolveError ? ` — ${lastResolveError}` : ''}`)
      const result = buildOrchestrator(taskGroupId).deleteTask(taskGroupId)
      for (const sid of result.sessionIds) {
        try { ctx.io.emit('session-closed', { sessionId: sid }) } catch {}
      }
      ctx.io.emit('task-groups-changed', { workspaceId: '' })
      if (callback) callback({ ok: true, ...result })
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
