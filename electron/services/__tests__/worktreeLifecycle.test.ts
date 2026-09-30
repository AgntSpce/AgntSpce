import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WorktreeLifecycle, parseStatusPath } from '../orchestration/worktreeLifecycle'

// git wraps a path containing a space in quotes when reporting it. Those quotes
// are formatting, not part of the name, and carrying them into the argument list
// made every filename with a space unmergeable.
describe('filenames with spaces', () => {
  it('reads the real name out of a quoted status line', () => {
    expect(parseStatusPath('?? "demo 3.txt"')).toBe('demo 3.txt')
    expect(parseStatusPath(' M "my notes.md"')).toBe('my notes.md')
    expect(parseStatusPath('A  "a b/c d.txt"')).toBe('a b/c d.txt')
  })

  it('leaves an unquoted path alone', () => {
    expect(parseStatusPath('?? demo.txt')).toBe('demo.txt')
    expect(parseStatusPath(' M src/index.ts')).toBe('src/index.ts')
  })

  it('takes the new path from a quoted rename', () => {
    expect(parseStatusPath('R  "old name.txt" -> "new name.txt"')).toBe('new name.txt')
  })

  it('unescapes quoted non-ascii and special characters', () => {
    expect(parseStatusPath('?? "caf\\303\\251.txt"')).toBe('café.txt')
    expect(parseStatusPath('?? "a\\"b.txt"')).toBe('a"b.txt')
  })

  it('commits and merges a file whose name has a space in it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntspce-space-'))
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
      fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n')
      execFileSync('git', ['add', '.'], { cwd: dir })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
      fs.writeFileSync(path.join(dir, 'demo 3.txt'), 'spaced out\n')
      const res = new WorktreeLifecycle(dir).commitTaskWorktree(dir, 'task work')
      // The regression: this used to fail with `pathspec '"demo 3.txt"' did not
      // match any files`, leaving the task uncommittable.
      expect(res.error).toBeUndefined()
      expect(res.committed).toBe(true)
      expect(res.files).toContain('demo 3.txt')
      expect(execFileSync('git', ['show', 'HEAD:demo 3.txt'], { cwd: dir, encoding: 'utf-8' })).toBe('spaced out\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
