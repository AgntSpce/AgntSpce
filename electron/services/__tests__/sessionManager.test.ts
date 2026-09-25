import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SessionManager } from '../sessionManager'
import { RingBuffer } from '../ringBuffer'
import type { Session, Workspace } from '../types'

function makeFakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    type: 'claude',
    worktreeId: 'main',
    status: 'idle',
    branch: 'main',
    buffer: new RingBuffer(),
    deliveredBufferLength: 0,
    lastActivity: Date.now(),
    tokenUsage: 0,
    config: { command: '/bin/bash', args: ['-c', 'echo hi'], cwd: '/tmp', type: 'claude', worktreeId: 'main' },
    statusChangedAt: 0,
    pendingStatus: null,
    pendingStatusTimer: null,
    cwdState: { current: '/tmp', previous: null, stack: [] },
    autoStarted: false,
    claudeLaunchState: null,
    ...overrides,
  }
}

describe('SessionManager (orchestration logic)', () => {
  let sm: SessionManager

  beforeEach(() => {
    const io = { emit: vi.fn(), on: vi.fn() }
    sm = new SessionManager(io as any)
  })

  describe('setWorkspace / worktrees', () => {
    it('getWorkspace returns null initially', () => {
      expect(sm.getWorkspace()).toBeNull()
    })

    it('builds worktrees from workspace.terminals', () => {
      const workspace: Workspace = {
        id: 'ws1',
        name: 'test',
        workspaceType: 'single-repo',
        terminals: [
          {
            id: 't1',
            terminalType: 'claude',
            worktree: 'main',
            repository: { name: 'repo', path: '/repo', type: 'git' },
            worktreePath: '/repo/main',
          },
          {
            id: 't2',
            terminalType: 'claude',
            worktree: 'feature',
            repository: { name: 'repo', path: '/repo', type: 'git' },
            worktreePath: '/repo/feature',
          },
        ],
      }
      sm.setWorkspace(workspace)
      expect(sm.worktrees).toHaveLength(2)
      expect(sm.worktrees[0].id).toBe('repo-main')
      expect(sm.worktrees[1].path).toBe('/repo/feature')
    })

    it('dedupes identical terminal worktree keys', () => {
      const workspace: Workspace = {
        id: 'ws1',
        name: 'test',
        workspaceType: 'mixed-repo',
        terminals: [
          { terminalType: 'claude', worktree: 'main', repository: { name: 'repo', path: '/repo', type: 'git' }, worktreePath: '/repo/main' },
          { terminalType: 'claude', worktree: 'main', repository: { name: 'repo', path: '/repo', type: 'git' }, worktreePath: '/repo/main' },
        ],
      }
      sm.setWorkspace(workspace)
      expect(sm.worktrees).toHaveLength(1)
    })

    it('falls back to wtConfig pairs when no terminals array', () => {
      const workspace: Workspace = {
        id: 'ws1',
        name: 'test',
        workspaceType: 'single-repo',
        repository: { path: '/repo', type: 'git' },
        worktrees: { enabled: true, count: 2, namingPattern: 'wt-{n}', autoCreate: true },
        terminals: { pairs: 2 },
      }
      sm.setWorkspace(workspace)
      expect(sm.worktrees).toHaveLength(2)
      expect(sm.worktrees[0].id).toBe('wt-1')
      expect(sm.worktrees[0].path).toBe('/repo/wt-1')
    })

    it('does not generate wtConfig worktrees when disabled', () => {
      const workspace: Workspace = {
        id: 'ws1',
        name: 'test',
        workspaceType: 'single-repo',
        repository: { path: '/repo', type: 'git' },
        worktrees: { enabled: false, count: 2, namingPattern: 'wt-{n}', autoCreate: true },
      }
      sm.setWorkspace(workspace)
      expect(sm.worktrees).toHaveLength(0)
    })

    it('clears worktrees when set to null', () => {
      sm.setWorkspace({ id: 'ws1', workspaceType: 'single-repo', terminals: [{ worktree: 'a', repository: { name: 'r', path: '/r' }, worktreePath: '/r/a' }] } as any)
      expect(sm.worktrees.length).toBeGreaterThan(0)
      sm.setWorkspace(null)
      expect(sm.worktrees).toHaveLength(0)
      expect(sm.getWorkspace()).toBeNull()
    })
  })

  describe('workspace session maps', () => {
    it('initializes a session map for a new workspace id', () => {
      sm.setWorkspace({ id: 'ws1', workspaceType: 'single-repo' } as Workspace)
      expect(sm.workspaceSessionMaps.has('ws1')).toBe(true)
    })

    it('switchWorkspacePreservingSessions reuses session map for same id', async () => {
      const ws: Workspace = { id: 'ws1', name: 'test', workspaceType: 'single-repo' }
      sm.setWorkspace(ws)
      sm.sessions.set('s1', makeFakeSession())
      const result = await sm.switchWorkspacePreservingSessions(ws)
      expect(result.sessions['s1']).toBeDefined()
    })

    it('restores sessions from previous workspace map', async () => {
      const ws1: Workspace = { id: 'ws1', name: 'test', workspaceType: 'single-repo' }
      const ws2: Workspace = { id: 'ws2', name: 'test', workspaceType: 'single-repo' }
      sm.setWorkspace(ws1)
      sm.sessions.set('s1', makeFakeSession({ id: 's1' }))
      const result = await sm.switchWorkspacePreservingSessions(ws2)
      expect(result.sessions['s1']).toBeUndefined() // no sessions to restore on fresh ws2
      // Now switch back — should restore s1
      const back = await sm.switchWorkspacePreservingSessions(ws1)
      expect(back.sessions['s1']).toBeDefined()
    })
  })

  describe('getSessionStates / getUndeliveredOutput', () => {
    it('returns session states in a plain record', () => {
      sm.setWorkspace({ id: 'w', workspaceType: 'single-repo' } as Workspace)
      sm.sessions.set('s1', makeFakeSession({ id: 's1', repositoryName: 'repo' }))
      const states = sm.getSessionStates()
      expect(states['s1'].id).toBe('s1')
      expect(states['s1'].repositoryName).toBe('repo')
      expect(states['s1'].status).toBe('idle')
    })

    it('returns undelivered output backlog and marks delivered', () => {
      sm.setWorkspace({ id: 'w', workspaceType: 'single-repo' } as Workspace)
      const session = makeFakeSession({ id: 's1' })
      session.buffer.write('hello world')
      sm.sessions.set('s1', session)
      const backlog = sm.getUndeliveredOutputAndMarkDelivered()
      expect(backlog['s1']).toBe('hello world')
      expect(session.deliveredBufferLength).toBe(Buffer.byteLength('hello world'))
      // Second call → nothing new
      const backlog2 = sm.getUndeliveredOutputAndMarkDelivered()
      expect(backlog2['s1']).toBeUndefined()
    })
  })

  describe('closeSession', () => {
    it('returns false for unknown session', () => {
      expect(sm.closeSession('nope')).toBe(false)
    })

    it('closes a session, records history, and removes it', () => {
      sm.setWorkspace({ id: 'w', workspaceType: 'single-repo' } as Workspace)
      const session = makeFakeSession({ id: 's1', agentStartConfig: { agentId: 'claude' } })
      const pty = { kill: vi.fn() }
      session.pty = pty
      sm.sessions.set('s1', session)
      expect(sm.closeSession('s1')).toBe(true)
      expect(sm.sessions.has('s1')).toBe(false)
      expect(sm.sessionHistory).toHaveLength(1)
      expect(sm.sessionHistory[0].id).toBe('s1')
      expect(sm.sessionHistory[0].agentId).toBe('claude')
    })

    it('caps session history at 200 entries', () => {
      for (let i = 0; i < 210; i++) {
        const s = makeFakeSession({ id: `s${i}` })
        sm.sessions.set(`s${i}`, s)
        sm.closeSession(`s${i}`)
      }
      expect(sm.sessionHistory.length).toBe(200)
    })
  })

  describe('writeToSession / resizeSession', () => {
    it('writeToSession returns false when no session pty', () => {
      sm.sessions.set('s1', makeFakeSession({ id: 's1' }))
      expect(sm.writeToSession('s1', 'data')).toBe(false)
    })

    it('writeToSession writes to pty and sets pending prompt for agent', () => {
      const writeMock = vi.fn()
      const session = makeFakeSession({ id: 's1', pty: { write: writeMock } })
      sm.sessions.set('s1', session)
      expect(sm.writeToSession('s1', 'hello')).toBe(true)
      expect(writeMock).toHaveBeenCalledWith('hello')
    })

    it('writeToSession ignores command/flag-only lines as prompts', () => {
      const writeMock = vi.fn()
      const session = makeFakeSession({ id: 's1', pty: { write: writeMock } })
      sm.sessions.set('s1', session)
      sm.writeToSession('s1', 'claude')
      sm.writeToSession('s1', '--flag')
      expect(writeMock).toHaveBeenCalledTimes(2)
    })

    it('resizeSession calls pty.resize', () => {
      const resizeMock = vi.fn()
      const session = makeFakeSession({ id: 's1', pty: { resize: resizeMock } })
      sm.sessions.set('s1', session)
      sm.resizeSession('s1', 40, 10)
      expect(resizeMock).toHaveBeenCalledWith(40, 10)
    })
    it('falls back to a fresh Claude command when resume output fails immediately', async () => {
      const buildCommand = vi.fn((_agentId: string, mode: string) => mode === 'resume'
        ? "printf 'No conversation found with session ID: bad\\n'; exit 1"
        : "printf 'fresh-agent\\n'")
      const manager = new SessionManager({ emit: vi.fn(), on: vi.fn() } as any, {
        getAgent: () => ({ modes: { fresh: {}, resume: {} } }),
        validateConfig: () => ({ valid: true }),
        buildCommand,
      } as any)
      const created = await manager.createRawSession('claude', '/tmp', 'resume-fallback-test')
      expect(created?.sessionId).toBe('resume-fallback-test')
      manager.startAgentWithConfig('resume-fallback-test', { agentId: 'claude', mode: 'resume', flags: [], resumeId: 'bad' })
      await new Promise(resolve => setTimeout(resolve, 500))
      const session = manager.sessions.get('resume-fallback-test')
      expect(session?.agentStartConfig?.mode).toBe('fresh')
      expect(session?.buffer.snapshot()).toContain('fresh-agent')
      manager.closeSession('resume-fallback-test')
    })
  })
})
