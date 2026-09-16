import type { Socket } from 'socket.io'
import { app } from 'electron'
import type { ServerContext } from '../context'
import { toWireEvent } from '../../services/outputFilter'
import type { AppMemoryBuckets } from '../../services/resourceTracker'

// Electron's own view of its processes (main/renderer/GPU/other). On macOS,
// RSS here includes large shared Chromium library mappings, so these numbers
// OVERSTATE private memory — they're for attribution ("which bucket grew?"),
// not exact accounting. Pattern from Orca's memory collector.
function getAppMemoryBuckets(): AppMemoryBuckets | null {
  try {
    const metrics = app?.getAppMetrics?.()
    if (!Array.isArray(metrics)) return null
    const buckets: AppMemoryBuckets = { mainMB: 0, rendererMB: 0, gpuMB: 0, otherMB: 0 }
    for (const m of metrics) {
      // workingSetSize is reported in Kilobytes — convert to MB.
      const mb = Math.round(((m as any)?.memory?.workingSetSize ?? 0) / 1024)
      switch (m.type) {
        case 'browser': buckets.mainMB += mb; break
        case 'renderer':
        case 'tab': buckets.rendererMB += mb; break
        case 'gpu': buckets.gpuMB += mb; break
        default: buckets.otherMB += mb; break
      }
    }
    return buckets
  } catch {
    return null
  }
}

// Electron's own CPU across its processes (main/renderer/GPU/other).
// ProcessMetric.cpu.percentCPUUsage is percent of a single core.
function getAppCpuPercent(): number | null {
  try {
    const metrics = app?.getAppMetrics?.()
    if (!Array.isArray(metrics)) return null
    let total = 0
    for (const m of metrics) {
      total += (m as any)?.cpu?.percentCPUUsage ?? 0
    }
    return Math.round(total * 10) / 10
  } catch {
    return null
  }
}
// History payloads go to the renderer for display of token counts only;
// output bodies are trimmed so large histories don't bloat client memory.
function trimHistoryBodies<T extends { original?: string; filtered?: string }>(entries: T[]): T[] {
  return entries.map(e => ({
    ...e,
    original: e.original && e.original.length > 2048 ? e.original.slice(0, 2048) : e.original,
    filtered: e.filtered && e.filtered.length > 2048 ? e.filtered.slice(0, 2048) : e.filtered,
  }))
}

export function registerStatsHandlers(ctx: ServerContext, socket: Socket): void {
  socket.on('get-cumulative-stats', () => {
    try {
      const result = ctx.sessionManager.outputFilter.getAllStats()
      socket.emit('cumulative-stats', { stats: result[0]?.stats || { totalOriginalBytes: 0, totalFilteredBytes: 0, totalOriginalTokens: 0, totalFilteredTokens: 0, eventsProcessed: 0 } })
    } catch (e) {
      console.error('get-cumulative-stats error:', e)
    }
  })

  socket.on('get-filter-stats', () => {
    try {
      const allSessions = ctx.sessionManager.outputFilter.getAllStats()
      const allCommandHistory = ctx.sessionManager.outputFilter.getAllCommandHistory()
      const aggregated = {
        totalOriginalBytes: allSessions.reduce((s: number, x: any) => s + x.stats.totalOriginalBytes, 0),
        totalFilteredBytes: allSessions.reduce((s: number, x: any) => s + x.stats.totalFilteredBytes, 0),
        totalOriginalTokens: allSessions.reduce((s: number, x: any) => s + x.stats.totalOriginalTokens, 0),
        totalFilteredTokens: allSessions.reduce((s: number, x: any) => s + x.stats.totalFilteredTokens, 0),
        eventsProcessed: allSessions.reduce((s: number, x: any) => s + x.stats.eventsProcessed, 0),
        commandsProcessed: allCommandHistory.length,
      }
      const allHistory = ctx.sessionManager.outputFilter.getAllHistory()
      const promptHistory = ctx.sessionManager.promptHistory.getAllHistory()
      socket.emit('filter-stats', { stats: aggregated, history: trimHistoryBodies(allHistory), commandHistory: allCommandHistory.map(toWireEvent), promptHistory })
    } catch (e) {
      console.error('get-filter-stats error:', e)
    }
  })

  socket.on('get-prompt-history', ({ sessionId }: { sessionId?: string }, callback?: Function) => {
    try {
      const history = sessionId
        ? ctx.sessionManager.promptHistory.getHistory(sessionId)
        : ctx.sessionManager.promptHistory.getAllHistory()
      callback?.({ ok: true, history })
    } catch (e: any) {
      callback?.({ ok: false, error: e?.message || String(e) })
    }
  })

  socket.on('report-token-savings', (data: { originalTokens: number; filteredTokens: number; toolName?: string; sessionId?: string }) => {
    try {
      ctx.sessionManager.outputFilter.reportTokenSavings(data.originalTokens, data.filteredTokens, data.toolName, data.sessionId || undefined)
    } catch (e) {
      console.error('report-token-savings error:', e)
    }
  })

  socket.on('reset-filter-stats', () => {
    ctx.sessionManager.outputFilter.reset()
  })

  socket.on('get-command-filter-history', ({ sessionId }: { sessionId?: string }, callback?: Function) => {
    if (sessionId) {
      const history = ctx.sessionManager.outputFilter.getCommandHistory(sessionId)
      if (callback) callback?.({ ok: true, history: history.map(toWireEvent) })
    } else {
      const allHistory = ctx.sessionManager.outputFilter.getAllCommandHistory()
      if (callback) callback?.({ ok: true, history: allHistory.map(toWireEvent) })
    }
  })

  socket.on('get-orchestrator-stats', async (_data: any, callback?: Function) => {
    try {
      callback?.({
        ok: true,
        concurrency: ctx.agentOrchestrator.getConcurrencyLoad(),
        sessionCount: ctx.agentOrchestrator.getSessionCount(),
        totalMemoryMB: ctx.agentOrchestrator.getTotalMemoryMB(),
        totalCpuPercent: ctx.agentOrchestrator.getTotalCpuPercent(),
        totalProcessCount: ctx.agentOrchestrator.getTotalProcessCount(),
        appCpuPercent: getAppCpuPercent(),
        resourceUsage: ctx.agentOrchestrator.getAllResourceUsage(),
        orchestration: ctx.agentOrchestrator.getOrchestrationStats(),
        appMemory: getAppMemoryBuckets(),
      })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-session-usage', async ({ sessionId }: { sessionId: string }, callback?: Function) => {
    try {
      const usage = ctx.agentOrchestrator.getResourceUsage(sessionId)
      callback?.({ ok: true, usage })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-session-history', async (_data: any, callback?: Function) => {
    try {
      callback?.({ ok: true, history: ctx.sessionManager.getSessionHistory() })
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })

  socket.on('get-token-usage', async ({ sessionId }: { sessionId: string }, callback?: Function) => {
    try {
      const all = ctx.sessionManager.tokenUsageTracker.getAllUsage()
      if (sessionId) {
        callback?.({ ok: true, usage: ctx.sessionManager.tokenUsageTracker.getUsage(sessionId) })
      } else {
        callback?.({ ok: true, usage: all, totalTokens: all.reduce((s: number, u: any) => s + u.totalTokens, 0), totalCost: all.reduce((s: number, u: any) => s + u.estimatedCost, 0) })
      }
    } catch (error: any) {
      if (callback) callback?.({ ok: false, error: error.message })
    }
  })
}
