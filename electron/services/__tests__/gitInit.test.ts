import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectGitFolder, initGitFolder } from '../../server/handlers/git'
import { WorktreeLifecycle } from '../orchestration/worktreeLifecycle'

const tmpDirs: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-gitinit-'))
  tmpDirs.push(dir)
  return dir
}
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe('workspace git readiness', () => {
  it('reports a plain folder as not a repo', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    expect(inspectGitFolder(dir)).toEqual({ isRepo: false, hasCommits: false, isFresh: true, branch: null })
    expect(WorktreeLifecycle.isGitRepository(dir)).toBe(false)
    expect(WorktreeLifecycle.hasCommits(dir)).toBe(false)
  })

  it('reports a freshly initialized repo as having no commits yet', () => {
    const dir = tmpDir()
    git(['init', '-b', 'main'], dir)
    expect(WorktreeLifecycle.isGitRepository(dir)).toBe(true)
    expect(WorktreeLifecycle.hasCommits(dir)).toBe(false)
    expect(inspectGitFolder(dir).isRepo).toBe(true)
    expect(inspectGitFolder(dir).hasCommits).toBe(false)
  })
})

// A repo of nothing but dotfiles still gets an isolated worktree. It used to be
// treated as "too empty to isolate", which removed the branch and the worktree
// together — so a fresh workspace had no Merge button, no Update button, and the
// agent's file landed untracked in the user's own folder, refusing every apply.
describe('fresh-repo detection (reported, but no longer used to skip isolation)', () => {
  it('treats a non-repo as fresh', () => {
    expect(inspectGitFolder(tmpDir()).isFresh).toBe(true)
  })

  it('reports a dotfiles-only repo as fresh', () => {
    const dir = tmpDir()
    initGitFolder(dir)
    const state = inspectGitFolder(dir)
    expect(state.hasCommits).toBe(true)
    expect(state.isFresh).toBe(true)
    // Still fully isolated: a worktree can branch from this repo, so the task
    // gets a branch and can be merged.
    expect(WorktreeLifecycle.isGitRepository(dir)).toBe(true)
    expect(WorktreeLifecycle.hasCommits(dir)).toBe(true)
  })

  it('stops being fresh as soon as a real file is committed', () => {
    const dir = tmpDir()
    initGitFolder(dir)
    expect(inspectGitFolder(dir).isFresh).toBe(true)
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n')
    git(['add', '-A'], dir)
    git(['commit', '-m', 'add page'], dir)
    expect(inspectGitFolder(dir).isFresh).toBe(false)
  })

  it('treats a nested project file as real content', () => {
    const dir = tmpDir()
    initGitFolder(dir)
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export {}\n')
    git(['add', '-A'], dir)
    git(['commit', '-m', 'src'], dir)
    expect(inspectGitFolder(dir).isFresh).toBe(false)
  })
})

describe('initGitFolder', () => {
  it('creates the repo, ignores .agntspce, and makes the commit worktrees need', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>\n')
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n')
    fs.mkdirSync(path.join(dir, '.agntspce', 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agntspce', 'coordinator.db'), 'sqlite\n')

    const res = initGitFolder(dir)
    expect(res.created).toBe(true)
    // index.html + app.js + the .gitignore we just wrote (ignore rules belong
    // in version control).
    expect(res.committedFiles).toBe(3)

    // Our own state directory must never be committed — it holds a .git pointer
    // file that git treats as an embedded repository.
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain('.agntspce/')
    const tracked = git(['ls-files'], dir).split('\n').filter(Boolean)
    expect(tracked).toContain('index.html')
    expect(tracked).toContain('app.js')
    expect(tracked).toContain('.gitignore')
    expect(tracked.some(f => f.startsWith('.agntspce'))).toBe(false)

    // A repo with a commit is what `git worktree add -b` needs.
    expect(WorktreeLifecycle.isGitRepository(dir)).toBe(true)
    expect(WorktreeLifecycle.hasCommits(dir)).toBe(true)
  })

  it('honours an existing .gitignore and appends without clobbering', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n*.log\n')
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n')
    fs.writeFileSync(path.join(dir, 'debug.log'), 'noise\n')

    const res = initGitFolder(dir)
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(ignore).toContain('node_modules/')
    expect(ignore).toContain('.agntspce/')
    // app.js + .gitignore; debug.log stays ignored.
    expect(res.committedFiles).toBe(2)
    expect(git(['ls-files'], dir).split('\n')).not.toContain('debug.log')
  })

  it('is idempotent: a repo that already has commits is left alone', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    initGitFolder(dir)
    const headBefore = git(['rev-parse', 'HEAD'], dir)

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
    const again = initGitFolder(dir)
    expect(again.created).toBe(false)
    // b.txt is not committed — we never commit on an already-initialized repo.
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(headBefore)
    expect(git(['status', '--porcelain'], dir)).toContain('b.txt')
  })
})
