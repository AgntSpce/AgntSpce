import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

export interface SessionResourceUsage {
  sessionId: string
  pid: number
  cpuPercent: number
  /** RSS of the direct PTY process only (kept for threshold back-compat). */
  memoryMB: number
  /**
   * RSS summed over the session's FULL descendant process tree. The direct
   * PTY pid is just the shell/wrapper (`sh → bin/<agent>`); the agent's real
   * node heap lives in descendants this field now captures. This is the number
   * that matches what Activity Monitor shows for the agent.
   */
  subtreeMemoryMB?: number
  /** Processes attributed to this session's tree (incl. the PTY shell). */
  processCount?: number
  collectedAt: number
}

export interface AppMemoryBuckets {
  mainMB: number
  rendererMB: number
  gpuMB: number
  otherMB: number
}

export interface ResourceThresholds {
  maxMemoryMB: number
  maxCpuPercent: number
  maxSessions: number
}

const DEFAULT_THRESHOLDS: ResourceThresholds = {
  maxMemoryMB: 1024,
  maxCpuPercent: 90,
  maxSessions: 12,
}

interface PsRow {
  pid: number
  ppid: number
  cpu: number
  rssKB: number
}

export class ResourceTracker {
  private thresholds: ResourceThresholds
  private usageCache = new Map<string, SessionResourceUsage>()
  private intervalId: NodeJS.Timeout | null = null
  private pidToSessionId = new Map<number, string>()
  private collectInFlight: Promise<void> | null = null

  constructor(thresholds?: Partial<ResourceThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  registerSession(sessionId: string, pid: number): void {
    this.pidToSessionId.set(pid, sessionId)
  }

  unregisterSession(sessionId: string): void {
    for (const [pid, sid] of this.pidToSessionId) {
      if (sid === sessionId) {
        this.pidToSessionId.delete(pid)
        break
      }
    }
    this.usageCache.delete(sessionId)
  }

  startMonitoring(intervalMs = 10000): void {
    if (this.intervalId) return
    this.intervalId = setInterval(() => { void this.collect() }, intervalMs)
  }

  stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * One host-wide `ps` sweep, then attribute each session's full descendant
   * subtree (pattern ported from Orca's memory collector): the PTY's direct
   * pid is a shell/wrapper — the agent binary it spawns holds the real heap,
   * and without subtree attribution that memory is invisible to the app.
   * Shared descendants are attributed to exactly ONE session (first-registered
   * wins) so totals never double-count.
   */
  private async collect(): Promise<void> {
    // Coalesce overlapping sweeps onto one in-flight promise.
    if (this.collectInFlight) return this.collectInFlight
    this.collectInFlight = this.collectNow().finally(() => { this.collectInFlight = null })
    return this.collectInFlight
  }

  private async collectNow(): Promise<void> {
    const roots = [...this.pidToSessionId.keys()]
    if (roots.length === 0) return

    try {
      const { stdout } = await execFile('ps', ['-eo', 'pid=,ppid=,pcpu=,rss='], {
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      })

      const byPid = new Map<number, PsRow>()
      const childrenOf = new Map<number, number[]>()
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 4) continue
        const pid = parseInt(parts[0])
        const ppid = parseInt(parts[1])
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
        const row: PsRow = {
          pid,
          ppid,
          cpu: parseFloat(parts[2]) || 0,
          rssKB: parseInt(parts[3]) || 0,
        }
        byPid.set(pid, row)
        const siblings = childrenOf.get(ppid)
        if (siblings) siblings.push(pid)
        else childrenOf.set(ppid, [pid])
      }

      const claimed = new Set<number>()
      const collectedAt = Date.now()

      for (const [rootPid, sessionId] of this.pidToSessionId) {
        const rootRow = byPid.get(rootPid)
        let directRSS = rootRow?.rssKB ?? 0
        let treeRSS = 0
        let cpuSum = 0
        let count = 0

        // Walk descendants breadth-first; skip subtrees another session claimed.
        const queue: number[] = [rootPid]
        while (queue.length > 0) {
          const pid = queue.shift()!
          if (claimed.has(pid)) continue
          claimed.add(pid)
          const row = byPid.get(pid)
          if (!row) continue
          treeRSS += row.rssKB
          cpuSum += row.cpu
          count++
          const kids = childrenOf.get(pid)
          if (kids) queue.push(...kids)
        }

        // Direct-row fallback when only aggregates are available.
        if (!rootRow && count === 0) continue
        if (count === 0) { treeRSS = directRSS; count = 1; cpuSum = rootRow?.cpu ?? 0 }
        if (count === 1 && rootRow) directRSS = rootRow.rssKB

        this.usageCache.set(sessionId, {
          sessionId,
          pid: rootPid,
          cpuPercent: Math.round(cpuSum * 10) / 10,
          memoryMB: Math.round(directRSS / 1024),
          subtreeMemoryMB: Math.round(treeRSS / 1024),
          processCount: count,
          collectedAt,
        })
      }
    } catch {}
  }

  getUsage(sessionId: string): SessionResourceUsage | undefined {
    return this.usageCache.get(sessionId)
  }

  getAllUsage(): SessionResourceUsage[] {
    return [...this.usageCache.values()]
  }

  isOverMemoryThreshold(sessionId: string): boolean {
    const usage = this.usageCache.get(sessionId)
    // Threshold intentionally evaluated on the DIRECT process (back-compat:
    // feeds restart/health decisions and must not change behavior), not the
    // agent's whole tree.
    return usage ? usage.memoryMB > this.thresholds.maxMemoryMB : false
  }

  isOverCpuThreshold(sessionId: string): boolean {
    const usage = this.usageCache.get(sessionId)
    return usage ? usage.cpuPercent > this.thresholds.maxCpuPercent : false
  }

  /** Total agent-subtree memory across sessions — what "how much do my agents use" means. */
  getTotalMemoryMB(): number {
    let total = 0
    for (const usage of this.usageCache.values()) total += (usage.subtreeMemoryMB ?? usage.memoryMB)
    return total
  }

  /** Total CPU across all tracked session subtrees (app-wide agent total). */
  getTotalCpuPercent(): number {
    let total = 0
    for (const usage of this.usageCache.values()) total += usage.cpuPercent || 0
    return Math.round(total * 10) / 10
  }

  /** Total processes attributed across all session subtrees. */
  getTotalProcessCount(): number {
    let total = 0
    for (const usage of this.usageCache.values()) total += usage.processCount ?? 1
    return total
  }

  get thresholds_(): ResourceThresholds {
    return this.thresholds
  }

  clear(): void {
    this.stopMonitoring()
    this.usageCache.clear()
    this.pidToSessionId.clear()
  }
}
