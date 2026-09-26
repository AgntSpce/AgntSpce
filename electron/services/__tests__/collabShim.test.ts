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

  it('accepts --task/--subtask flags when env is missing', () => {
    const { repo, sm, g, a } = setupRepo()
    const r = (() => {
      try {
        const out = execFileSync(process.execPath, [CLI, 'post', 'via flags', '--task', g.id, '--subtask', a.id], {
          cwd: repo,
          env: { ...process.env, AGNTSPCE_TASK_ID: '', AGNTSPCE_SUBTASK_ID: '' },
          encoding: 'utf-8',
          timeout: 30000,
        })
        return { code: 0, out: String(out) }
      } catch (e: any) {
        return { code: e?.status ?? 1, out: '' }
      }
    })()
    expect(r.code).toBe(0)
    expect(sm.getCollabEvents(g.id).some(e => e.kind === 'progress')).toBe(true)
  })
})

// Regression: agents invoke `agntspce-collab` as an ordinary shell command,
// because the Electron host prepends bin/ to the PTY PATH. The tests above all
// call the .mjs by absolute path, so they passed while the command did not
// exist for any real agent - no claims, no COLLAB.md progress, no done.
describe('agntspce-collab launcher (resolved through PATH, as an agent does)', () => {
  const BIN = path.join(__dirname, '..', '..', '..', 'bin')
  const POSIX = path.join(BIN, 'agntspce-collab')
  const WIN = path.join(BIN, 'agntspce-collab.cmd')

  function setupRepo(): { repo: string; sm: StateManager; g: any; a: any; b: any } {
    const repo = tmpDir()
    initRepo(repo)
    fs.mkdirSync(path.join(repo, '.agntspce'), { recursive: true })
    const sm = new StateManager(path.join(repo, '.agntspce', 'coordinator.db'), repo)
    const g = sm.createTaskGroup({ repoPath: repo, title: 'Launcher task' })
    const a = sm.addSubTask({ taskGroupId: g.id, agentId: 'claude' })
    const b = sm.addSubTask({ taskGroupId: g.id, agentId: 'opencode' })
    return { repo, sm, g, a, b }
  }

  // Spawn the bare command name with bin/ on PATH - the same lookup a shell in
  // the agent's PTY performs.
  function runLauncher(repo: string, taskId: string, subtaskId: string, args: string[]): { code: number; out: string } {
    const pathKey = Object.keys(process.env).find(k => /^path$/i.test(k)) || 'PATH'
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [pathKey]: BIN + path.delimiter + (process.env[pathKey] || ''),
      AGNTSPCE_TASK_ID: taskId,
      AGNTSPCE_SUBTASK_ID: subtaskId,
    }
    const isWin = process.platform === 'win32'
    try {
      const out = execFileSync(isWin ? WIN : 'agntspce-collab', args, {
        cwd: repo,
        env,
        encoding: 'utf-8',
        timeout: 60000,
        shell: isWin,
      })
      return { code: 0, out: String(out) }
    } catch (e: any) {
      return { code: e?.status ?? 1, out: String(e?.stdout || '') + String(e?.stderr || '') + String(e?.message || '') }
    }
  }

  it('ships a launcher for the platform', () => {
    const launcher = process.platform === 'win32' ? WIN : POSIX
    expect(fs.existsSync(launcher)).toBe(true)
    if (process.platform !== 'win32') {
      // Must be executable, or the shell reports "permission denied".
      expect(fs.statSync(POSIX).mode & 0o111).toBeGreaterThan(0)
    }
  })

  it('posts progress through the launcher and regenerates COLLAB.md', () => {
    const { repo, sm, g, a } = setupRepo()
    const r = runLauncher(repo, g.id, a.id, ['post', 'touched schema via launcher'])
    expect(r.code).toBe(0)
    expect(sm.getCollabEvents(g.id).some(e => e.kind === 'progress')).toBe(true)
    const md = fs.readFileSync(path.join(repo, 'COLLAB.md'), 'utf-8')
    expect(md).toContain('touched schema via launcher')
  })

  it('serialises file claims across launcher invocations', () => {
    const { repo, sm, g, a, b } = setupRepo()
    expect(runLauncher(repo, g.id, a.id, ['claim', 'src/y.ts']).code).toBe(0)
    const blocked = runLauncher(repo, g.id, b.id, ['claim', 'src/y.ts'])
    expect(blocked.code).toBe(1)
    expect(blocked.out).toMatch(/claimed by/i)
    expect(sm.getFileClaimHolder(g.id, 'src/y.ts')?.subtaskId).toBe(a.id)
  })

  it('marks a subtask done through the launcher', () => {
    const { repo, sm, g, a } = setupRepo()
    const r = runLauncher(repo, g.id, a.id, ['done', 'finished via launcher'])
    expect(r.code).toBe(0)
    expect(sm.getSubTask(a.id)?.status).toBe('done')
  })
})
