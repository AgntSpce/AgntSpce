import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { StateManager } from '../orchestration/stateManager'
import { CollabShim, renderCollabMd } from '../orchestration/collabShim'

const tmpDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-collab-'))
  tmpDirs.push(dir)
  return dir
}

function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe('CollabShim', () => {
  it('round-trips claim/release/post/request/done and regenerates COLLAB.md', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const shim = new CollabShim(sm, dir)
    const g = sm.createTaskGroup({ repoPath: dir, title: 'Login', userGoal: 'build it' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude', title: 'DB', scopeFiles: ['src/db.ts'] })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode', title: 'UI', scopeFiles: ['src/ui.tsx'] })

    expect(shim.claim(g.id, a.id, 'src/db.ts').ok).toBe(true)
    expect(shim.claim(g.id, b.id, 'src/db.ts').ok).toBe(false)
    expect(shim.post(g.id, a.id, { touched: ['src/db.ts'], next: 'need API shape' }).ok).toBe(true)
    expect(shim.request(g.id, b.id, 'what is the login endpoint?').ok).toBe(true)
    expect(shim.release(g.id, a.id, 'src/db.ts').ok).toBe(true)
    expect(shim.done(g.id, a.id, 'schema done').ok).toBe(true)
    expect(sm.getSubTask(a.id)?.status).toBe('done')

    const mdPath = path.join(dir, 'COLLAB.md')
    expect(fs.existsSync(mdPath)).toBe(true)
    const md = fs.readFileSync(mdPath, 'utf-8')
    expect(md).toContain('# Task: Login')
    expect(md).toContain('## Subtasks')
    expect(md).toContain('## Progress')
    expect(md).toContain('schema done')
  })

  it('renderCollabMd lists open claims and caps progress history', () => {
    const dir = tmpDir()
    const sm = new StateManager(path.join(dir, 'c.db'), dir)
    const g = sm.createTaskGroup({ repoPath: dir, title: 'T' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    sm.claimFile(g.id, 'src/x.ts', a.id, 'claude')
    const md = renderCollabMd(
      sm.getTaskGroup(g.id)!,
      sm.listSubTasks(g.id),
      sm.getCollabEvents(g.id),
      [{ file: 'src/x.ts', agentId: 'claude' }]
    )
    expect(md).toContain('## Open claims')
    expect(md).toContain('src/x.ts')
  })
})

describe('agntspce-collab CLI', () => {
  const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'agntspce-collab.mjs')

  function setupRepo(): { repo: string; sm: StateManager; g: any; a: any; b: any } {
    const repo = tmpDir()
    initRepo(repo)
    fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
    const sm = new StateManager(path.join(repo, '.agntspce', 'coordinator.db'), repo)
    const g = sm.createTaskGroup({ repoPath: repo, title: 'CLI task' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })
    return { repo, sm, g, a, b }
  }

  function runCli(repo: string, taskId: string, subtaskId: string, args: string[]): { code: number; out: string } {
    try {
      const out = execFileSync(process.execPath, [CLI, ...args], {
        cwd: repo,
        env: { ...process.env, AGNTSPCE_TASK_ID: taskId, AGNTSPCE_SUBTASK_ID: subtaskId },
        encoding: 'utf-8',
        timeout: 30000,
      })
      return { code: 0, out: String(out) }
    } catch (e: any) {
      return { code: e?.status ?? 1, out: String(e?.stdout || '') + String(e?.stderr || '') + String(e?.message || '') }
    }
  }

  it('posts progress and regenerates COLLAB.md from the worktree cwd', () => {
    const { repo, sm, g, a } = setupRepo()
    const r = runCli(repo, g.id, a.id, ['post', 'touched schema, need API shape'])
    expect(r.code).toBe(0)
    expect(sm.getCollabEvents(g.id).some(e => e.kind === 'progress')).toBe(true)
    const md = fs.readFileSync(path.join(repo, 'COLLAB.md'), 'utf-8')
    expect(md).toContain('touched schema')
  })

  it('enforces claims across separate CLI invocations', () => {
    const { repo, sm, g, a, b } = setupRepo()
    expect(runCli(repo, g.id, a.id, ['claim', 'src/x.ts']).code).toBe(0)
    const blocked = runCli(repo, g.id, b.id, ['claim', 'src/x.ts'])
    expect(blocked.code).toBe(1)
    expect(blocked.out).toMatch(/claimed by/i)
    expect(runCli(repo, g.id, b.id, ['release', 'src/x.ts']).code).toBe(1)
    expect(runCli(repo, g.id, a.id, ['release', 'src/x.ts']).code).toBe(0)
    expect(runCli(repo, g.id, b.id, ['claim', 'src/x.ts']).code).toBe(0)
    expect(sm.getFileClaimHolder(g.id, 'src/x.ts')?.subtaskId).toBe(b.id)
  })

  it('fails clearly without task env', () => {
    const { repo } = setupRepo()
    const r = runCli(repo, '', '', ['post', 'hi'])
    expect(r.code).not.toBe(0)
  })
})
