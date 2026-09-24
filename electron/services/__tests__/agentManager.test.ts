import { describe, it, expect } from 'vitest'
import { AgentManager } from '../agentManager'

describe('AgentManager', () => {
  const manager = new AgentManager()

  describe('getAllAgents / getAgent', () => {
    it('returns all agent configs', () => {
      const agents = manager.getAllAgents()
      expect(agents.length).toBeGreaterThanOrEqual(10)
      const ids = agents.map(a => a.id)
      expect(ids).toContain('claude')
      expect(ids).toContain('opencode')
      expect(ids).toContain('gemini')
      expect(ids).toContain('codex')
    })

    it('every agent has the required shape', () => {
      for (const agent of manager.getAllAgents()) {
        expect(agent.id).toBeTruthy()
        expect(agent.name).toBeTruthy()
        expect(agent.baseCommand).toBeTruthy()
        expect(agent.modes[agent.defaultMode]).toBeTruthy()
        expect(Array.isArray(agent.availableFlags)).toBe(true)
        expect(agent.capabilities).toBeDefined()
      }
    })

    it('getAgent returns a specific config', () => {
      const claude = manager.getAgent('claude')
      expect(claude?.name).toBe('Claude')
      expect(claude?.baseCommand).toBe('claude')
    })

    it('getAgent returns undefined for unknown agent', () => {
      expect(manager.getAgent('nope')).toBeUndefined()
    })

    it('getAgentConfig accessor is available', () => {
      expect(manager.getAgent('codex')).toBeDefined()
    })
  })

  describe('getUIConfig', () => {
    it('returns a UI shape for a known agent', () => {
      const ui = manager.getUIConfig('claude')
      expect(ui).not.toBeNull()
      expect(ui!.id).toBe('claude')
      expect(ui!.modes.map(m => m.id)).toEqual(['fresh', 'continue', 'resume'])
      expect(ui!.modes[0].name).toBe('Fresh')
      expect(ui!.flags.map(f => f.id)).toEqual(['skipPermissions', 'verbose', 'debug'])
      expect(ui!.defaultMode).toBe('fresh')
      expect(ui!.capabilities.supportsWorktree).toBe(true)
    })

    it('exposes models for agents that define them', () => {
      const ui = manager.getUIConfig('gemini')
      expect(ui!.models).toContain('gemini-2.5-pro')
      expect(ui!.defaultModel).toBe('gemini-2.5-pro')
    })

    it('returns null for unknown agent', () => {
      expect(manager.getUIConfig('nope')).toBeNull()
    })
  })

  describe('buildCommand', () => {
    it('builds a base fresh command', () => {
      expect(manager.buildCommand('claude', 'fresh')).toBe('claude')
      expect(manager.buildCommand('gemini', 'fresh')).toBe('gemini')
    })

    it('throws for unknown agent', () => {
      expect(() => manager.buildCommand('nope', 'fresh')).toThrow('Unknown agent')
    })

    it('throws for unknown mode', () => {
      expect(() => manager.buildCommand('claude', 'nope')).toThrow("Unknown mode 'nope'")
    })

    it('appends enabled flags from an array', () => {
      const cmd = manager.buildCommand('claude', 'fresh', ['verbose', 'debug'])
      expect(cmd).toContain('--verbose')
      expect(cmd).toContain('--debug')
      expect(cmd).not.toContain('--dangerously-skip-permissions')
    })

    it('appends enabled flags from an AgentStartConfig object', () => {
      const cmd = manager.buildCommand('claude', 'fresh', { agentId: 'claude', mode: 'fresh', flags: ['skipPermissions'] })
      expect(cmd).toBe('claude --dangerously-skip-permissions')
    })

    it('adds model flags per agent', () => {
      expect(manager.buildCommand('gemini', 'fresh', { agentId: 'gemini', mode: 'fresh', flags: [], model: 'gemini-2.0-flash' }))
        .toBe('gemini -m gemini-2.0-flash')
      expect(manager.buildCommand('codex', 'fresh', { agentId: 'codex', mode: 'fresh', flags: [], model: 'gpt-5' }))
        .toBe('codex -m gpt-5')
      expect(manager.buildCommand('gemini', 'fresh', { agentId: 'gemini', mode: 'fresh', flags: [], model: 'gemini-2.0-flash' }))
        .toBe('gemini -m gemini-2.0-flash')
    })

    it('adds reasoning for codex and claude', () => {
      expect(manager.buildCommand('codex', 'fresh', { agentId: 'codex', mode: 'fresh', flags: [], reasoning: 'low' }))
        .toBe('codex -c model_reasoning_effort="low"')
      expect(manager.buildCommand('claude', 'fresh', { agentId: 'claude', mode: 'fresh', flags: [], reasoning: 'high' }))
        .toBe('claude --reasoning-effort high')
    })

    it('adds verbosity for codex and claude', () => {
      expect(manager.buildCommand('codex', 'fresh', { agentId: 'codex', mode: 'fresh', flags: [], verbosity: 'medium' }))
        .toBe('codex -c model_verbosity="medium"')
      expect(manager.buildCommand('claude', 'fresh', { agentId: 'claude', mode: 'fresh', flags: [], verbosity: 'low' }))
        .toBe('claude --verbosity low')
    })

    it('appends resumeId for resume mode on claude and codex', () => {
      expect(manager.buildCommand('claude', 'resume', { agentId: 'claude', mode: 'resume', flags: [], resumeId: 'abc123' }))
        .toBe('claude --resume abc123')
      expect(manager.buildCommand('codex', 'resume', { agentId: 'codex', mode: 'resume', flags: [], resumeId: 'def456' }))
        .toBe('codex resume def456')
    })

    it('builds exact Pi fresh and resume commands', () => {
      expect(manager.buildCommand('pi', 'fresh', { agentId: 'pi', mode: 'fresh', flags: [], nativeSessionId: 'pi-session' }))
        .toBe('pi --session-id pi-session')
      expect(manager.buildCommand('pi', 'resume', { agentId: 'pi', mode: 'resume', flags: [], resumeId: 'pi-session' }))
        .toBe('pi --session pi-session')
    })

    it('builds resume commands for Gemini and Droid', () => {
      expect(manager.buildCommand('gemini', 'resume', { agentId: 'gemini', mode: 'resume', flags: [], resumeId: 'gemini-session' }))
        .toBe('gemini --resume gemini-session')
      expect(manager.buildCommand('droid', 'continue', { agentId: 'droid', mode: 'continue', flags: [] }))
        .toBe('droid --resume')
    })

    it('ignores resumeId for agents without resume support', () => {
      expect(manager.buildCommand('gemini', 'fresh', { agentId: 'gemini', mode: 'fresh', flags: [], resumeId: 'abc' }))
        .toBe('gemini')
    })
  })

  describe('getDefaultConfig', () => {
    it('returns default mode and flags for claude', () => {
      const cfg = manager.getDefaultConfig('claude')
      expect(cfg).toEqual({ agentId: 'claude', mode: 'fresh', flags: ['skipPermissions'] })
    })

    it('returns null for unknown agent', () => {
      expect(manager.getDefaultConfig('nope')).toBeNull()
    })
  })

  describe('getPowerfulConfig', () => {
    it('returns defaultFlags when present', () => {
      const cfg = manager.getPowerfulConfig('claude')
      expect(cfg!.flags).toEqual(['skipPermissions'])
    })

    it('falls back to sandbox/permissions flags', () => {
      const cfg = manager.getPowerfulConfig('droid')
      expect(cfg!.flags).toEqual(['autoApprove'])
    })

    it('returns empty flags when nothing powerful exists', () => {
      const cfg = manager.getPowerfulConfig('opencode')
      expect(cfg!.flags).toEqual([])
    })
  })

  describe('validateAndAdjustFlags', () => {
    it('keeps only the last flag in a mutually exclusive category', () => {
      const adjusted = manager.validateAndAdjustFlags('codex', ['readOnly', 'workspaceWrite'])
      expect(adjusted).toEqual(['workspaceWrite'])
    })

    it('keeps flags from different categories', () => {
      const adjusted = manager.validateAndAdjustFlags('codex', ['yolo', 'neverAsk'])
      expect(adjusted).toEqual(['yolo', 'neverAsk'])
    })

    it('passes through unknown agent flags unchanged', () => {
      expect(manager.validateAndAdjustFlags('nope', ['whatever'])).toEqual(['whatever'])
    })
  })

  describe('validateConfig', () => {
    it('accepts a valid config', () => {
      expect(manager.validateConfig({ agentId: 'claude', mode: 'fresh', flags: ['verbose'] }).valid).toBe(true)
    })

    it('rejects unknown agent', () => {
      const result = manager.validateConfig({ agentId: 'nope', mode: 'fresh', flags: [] })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Unknown agent')
    })

    it('rejects unknown mode', () => {
      const result = manager.validateConfig({ agentId: 'claude', mode: 'nope', flags: [] })
      expect(result.valid).toBe(false)
      expect(result.error).toContain("Unknown mode 'nope'")
    })

    it('rejects unknown flags', () => {
      const result = manager.validateConfig({ agentId: 'claude', mode: 'fresh', flags: ['bogus'] })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('bogus')
    })
  })
})
