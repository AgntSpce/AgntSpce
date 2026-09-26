import type { ServerContext } from '../context'

/**
 * Ingests agent lifecycle hook events posted by bin/agntspce-agent-hook and
 * fans the resulting status out to the renderer as `agent-status`.
 *
 * The hook is a subprocess we launch, so it talks plain HTTP to the same
 * server the renderer already uses rather than joining the socket itself.
 *
 * Registered ONCE at server construction — not from registerAllHandlers, which
 * runs per socket connection and would stack a duplicate route every time.
 */
export function registerAgentStatusRoute(ctx: ServerContext): void {
  ctx.expressApp.post('/api/agent-status', (req, res) => {
    void (async () => {
      try {
        const entry = await ctx.agentStatus.ingestHook(req.body)
        if (entry) {
          ctx.io.emit('agent-status', { entry })
        }
        // A rejected payload is a normal outcome — a hook from an untracked
        // session, or an event we don't model. Either way the agent's turn must
        // never be blocked by our side, so this always answers 2xx.
        res.status(202).json({ ok: true, ignored: !entry })
      } catch (e) {
        console.error('[agentStatus] hook ingest failed:', e)
        res.status(202).json({ ok: true, ignored: true })
      }
    })()
  })
}
