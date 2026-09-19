import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildAssignmentPrompt,
  buildPlannerPrompt,
  parsePlanJson,
  checkScopeOverlap,
  fallbackSplit,
  buildPlanFromParsed,
  planTask,
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
}

const AGENTS = [
  { agentId: 'claude', model: 'opus' },
  { agentId: 'opencode', model: 'x' },
]

describe('taskPlanner', () => {
  it('builds prompts naming agents, scopes, and the collab CLI', () => {
    const p = buildAssignmentPrompt(CTX, AGENTS[0]!, 'DB slice', ['src/db.ts'], 'opencode owns UI', 'db done')
    expect(p).toContain('claude')
    expect(p).toContain('src/db.ts')
    expect(p).toContain('agntspce-collab claim')
    expect(p).toContain('task/login-abc')
    const planner = buildPlannerPrompt(CTX, AGENTS, ['src', 'docs'])
    expect(planner).toContain('JSON')
    expect(planner).toContain('scopeFiles')
  })

  it('parses fenced and raw JSON plans', () => {
    const body = '{"todoList": ["a"], "subtasks": [{"agentId": "claude", "title": "DB", "scopeFiles": ["src/db.ts"]}]}'
    expect(parsePlanJson('```json\n' + body + '\n```')?.subtasks).toHaveLength(1)
    expect(parsePlanJson(body)?.todoList).toEqual(['a'])
    expect(parsePlanJson('not json')).toBeNull()
  })

  it('detects pairwise scope overlap', () => {
    const conflicts = checkScopeOverlap([
      { agentId: 'a', scopeFiles: ['src/x.ts', 'src/y.ts'] },
      { agentId: 'b', scopeFiles: ['src/y.ts'] },
      { agentId: 'c', scopeFiles: ['docs/'] },
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.file).toBe('src/y.ts')
    expect(checkScopeOverlap([{ agentId: 'a', scopeFiles: [] }])).toHaveLength(0)
  })

  it('falls back to a non-overlapping directory split', () => {
    const plan = fallbackSplit(CTX, AGENTS, ['src', 'docs', 'tests'])
    expect(plan.usedFallback).toBe(true)
    expect(plan.subtasks).toHaveLength(2)
    expect(checkScopeOverlap(plan.subtasks)).toHaveLength(0)
    expect(plan.warnings.length).toBeGreaterThan(0)
  })

  it('accepts a clean LLM plan', async () => {
    const llm = async () => '{"todoList": ["db", "ui"], "subtasks": [{"agentId": "claude", "title": "DB", "scopeFiles": ["src/db.ts"]}, {"agentId": "opencode", "title": "UI", "scopeFiles": ["src/ui.tsx"]}]}'
    const plan = await planTask(CTX, AGENTS, ['src'], llm)
    expect(plan.usedFallback).toBe(false)
    expect(plan.subtasks).toHaveLength(2)
    expect(plan.subtasks[0]!.assignmentPrompt).toContain('agntspce-collab')
  })

  it('re-prompts once on overlap, then falls back', async () => {
    const overlapping = '{"todoList": ["x"], "subtasks": [{"agentId": "claude", "title": "A", "scopeFiles": ["src/same.ts"]}, {"agentId": "opencode", "title": "B", "scopeFiles": ["src/same.ts"]}]}'
    const calls: string[] = []
    const llm = async (prompt: string) => {
      calls.push(prompt)
      return calls.length === 1 ? overlapping : overlapping
    }
    const plan = await planTask(CTX, AGENTS, ['src'], llm)
    expect(calls).toHaveLength(2)
    expect(plan.usedFallback).toBe(true)
    expect(checkScopeOverlap(plan.subtasks)).toHaveLength(0)
  })

  it('goes deterministic when the LLM is missing or throws', async () => {
    const plan = await planTask(CTX, AGENTS, ['src'])
    expect(plan.usedFallback).toBe(true)
    const throwing = await planTask(CTX, AGENTS, ['src'], async () => { throw new Error('no key') })
    expect(throwing.usedFallback).toBe(true)
  })

  it('writes .task.json metadata', () => {
    const dir = tmpDir()
    const file = writeTaskMetaFile(dir, {
      taskGroupId: 'g1', branchName: 'task/x', baseSha: 'abc', worktreeMode: 'worktree',
      todoList: ['a'], subtasks: [{ agentId: 'claude', title: 'DB', scopeFiles: [] }],
    })
    expect(file.endsWith('.task.json')).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(parsed.taskGroupId).toBe('g1')
    expect(buildPlanFromParsed(CTX, AGENTS, { todoList: ['a'], subtasks: [] }).subtasks).toHaveLength(0)
  })
})
