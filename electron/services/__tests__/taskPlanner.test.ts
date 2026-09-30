import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildAssignmentPrompt,
  buildTaskAssignments,
  writeTaskMetaFile,
  type PlanContext,
} from '../orchestration/taskPlanner'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-planner-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

const CTX: PlanContext = {
  taskTitle: 'Login page',
  userGoal: 'Build a login page',
  branchName: 'task/login-abc',
  worktreePath: '/repo/.agntspce/tasks/abc',
  worktreeMode: 'worktree',
  agentCount: 1,
}

const AGENTS = [
  { agentId: 'claude', model: 'opus' },
  { agentId: 'opencode', model: 'x' },
]

// A task is an isolated worktree plus the agents you picked. There is no
// planning step: every agent gets the whole goal and coordinates through file
// claims. The old LLM planner split the goal into per-agent scopeFiles from the
// repo's top-level directory names alone, which was a guess dressed as a plan.
describe('buildAssignmentPrompt', () => {
  it('gives the agent the whole goal, not a slice of it', () => {
    const p = buildAssignmentPrompt(CTX, AGENTS[0]!)
    expect(p).toContain('Build a login page')
    expect(p).toContain('claude')
    expect(p).toContain('opus')
    expect(p).toContain('task/login-abc')
    // No invented scope, and no instruction to stay inside one.
    expect(p).not.toMatch(/scopeFiles/)
    expect(p).toMatch(/PLAN YOUR OWN WORK/i)
  })

  it('tells a solo agent it has the goal to itself', () => {
    const p = buildAssignmentPrompt(CTX, AGENTS[0]!)
    expect(p).toMatch(/only agent on this task/i)
    expect(p).not.toMatch(/1 of \d+ agents/i)
  })

  it('tells a parallel agent it must pick its own work and stay off peers', () => {
    const p = buildAssignmentPrompt({ ...CTX, agentCount: 3 }, AGENTS[1]!)
    expect(p).toMatch(/1 of 3 agents/i)
    expect(p).toMatch(/Nobody was assigned a slice/i)
    expect(p).toMatch(/COLLAB\.md/)
    expect(p).toMatch(/pick work they have not taken/i)
    // It must know peers share the checkout before it edits anything.
    expect(p).toMatch(/claim/i)
  })

  it('keeps the mandatory commit and collab protocol', () => {
    const p = buildAssignmentPrompt(CTX, AGENTS[0]!)
    expect(p).toMatch(/VERSION CONTROL/i)
    expect(p).toContain('git add -A && git commit')
    expect(p).toMatch(/cannot be merged/i)
    expect(p).toMatch(/do NOT merge/i)
    expect(p).toContain('agntspce-collab claim <file>')
    expect(p).toContain('agntspce-collab release <file>')
    expect(p).toContain('agntspce-collab post')
    expect(p).toContain('agntspce-collab done')
  })

  it('tells a worktree agent how to pull in peer work', () => {
    // Verified failure: an agent looked for a file a peer had created, did not
    // find it, and told the user it did not exist. The peer HAD committed it —
    // it was on the integration branch, which this worktree lacks.
    const p = buildAssignmentPrompt({ ...CTX, integrationBranch: 'myrepo_agntspce' }, AGENTS[0]!)
    expect(p).toContain('PEER WORK')
    expect(p).toContain('myrepo_agntspce')
    expect(p).toContain('git merge myrepo_agntspce --no-edit')
    expect(p).toMatch(/never rebase/i)
  })

  it('omits peer-work instructions when there is no integration branch', () => {
    const p = buildAssignmentPrompt(CTX, AGENTS[0]!)
    expect(p).not.toContain('PEER WORK')
  })

  it('asks a shared-folder agent to commit without implying a branch', () => {
    const p = buildAssignmentPrompt({ ...CTX, worktreeMode: 'none', branchName: '' }, AGENTS[0]!)
    expect(p).toMatch(/VERSION CONTROL/i)
    expect(p).toMatch(/git commit/i)
    expect(p).not.toContain('branch task/login-abc')
    expect(p).toMatch(/shared workspace/i)
  })

  it('appends a follow-up message when there is one', () => {
    const p = buildAssignmentPrompt({ ...CTX, followUp: 'also add logout' }, AGENTS[0]!)
    expect(p).toContain('FOLLOW-UP FROM THE USER')
    expect(p).toContain('also add logout')
    // The original goal is still there — a follow-up adds to it.
    expect(p).toContain('Build a login page')
  })

  it('omits the follow-up section when there is none', () => {
    expect(buildAssignmentPrompt(CTX, AGENTS[0]!)).not.toContain('FOLLOW-UP')
  })
})

describe('buildTaskAssignments', () => {
  it('gives every agent the same goal', () => {
    const a = buildTaskAssignments({ ...CTX, agentCount: 2 }, AGENTS)
    expect(a).toHaveLength(2)
    expect(a[0]!.agentId).toBe('claude')
    expect(a[1]!.agentId).toBe('opencode')
    // Same goal, and each is told how many peers share it.
    for (const x of a) {
      expect(x.assignmentPrompt).toContain('Build a login page')
      expect(x.assignmentPrompt).toMatch(/1 of 2 agents/i)
    }
  })

  it('cannot leave an agent without an assignment', () => {
    // The old parser filtered subtasks to known agents and nothing checked that
    // every chosen agent was covered, so an agent could be spawned with nothing
    // to do. One prompt per agent, always.
    const a = buildTaskAssignments({ ...CTX, agentCount: 3 }, AGENTS)
    expect(new Set(a.map(x => x.agentId)).size).toBe(AGENTS.length)
    for (const x of a) expect(x.assignmentPrompt.length).toBeGreaterThan(0)
  })

  it('needs no LLM to produce a complete assignment set', () => {
    // The point of the removal: planning used to be optional-but-degrading, with
    // a directory split fallback and a "usedFallback" warning. Now there is
    // nothing to degrade.
    const a = buildTaskAssignments(CTX, AGENTS)
    expect(a.every(x => x.assignmentPrompt.includes('Build a login page'))).toBe(true)
  })
})

describe('writeTaskMetaFile', () => {
  it('records the task and who is taking part, with no plan', () => {
    const dir = tmpDir()
    writeTaskMetaFile(dir, {
      taskGroupId: 'g1',
      branchName: 'task/x-1',
      baseSha: 'abc123',
      worktreeMode: 'worktree',
      agents: ['claude', 'opencode'],
    })
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.task.json'), 'utf-8'))
    expect(meta.taskGroupId).toBe('g1')
    expect(meta.branchName).toBe('task/x-1')
    expect(meta.agents).toEqual(['claude', 'opencode'])
    // The plan fields are gone, not left as empty scaffolding.
    expect(meta.todoList).toBeUndefined()
    expect(meta.subtasks).toBeUndefined()
    expect(typeof meta.writtenAt).toBe('number')
  })
})
