import { describe, it, expect } from 'vitest'
import { runMergeAll } from '../../server/handlers/tasks'

/** Merge-all must attempt every task. A single unmergeable task used to stop
 *  the batch ("0 of 2 merged, then stopped"), which is what made a ghost task
 *  block every other merge in the workspace. */
describe('runMergeAll', () => {
  it('attempts every task even when one fails', async () => {
    const attempted: string[] = []
    const results = await runMergeAll(['a', 'b', 'c'], async id => {
      attempted.push(id)
      return id === 'b'
        ? { ok: false, skipped: false, needsConfirm: false, taskGroupId: id, error: 'uncommitted work' }
        : { ok: true, needsConfirm: false, taskGroupId: id }
    })
    expect(attempted).toEqual(['a', 'b', 'c'])
    expect(results.filter(r => r.ok)).toHaveLength(2)
    expect(results.filter(r => !r.ok)).toHaveLength(1)
  })

  it('preserves the given order, since each merge advances the integration branch', async () => {
    const attempted: string[] = []
    await runMergeAll(['oldest', 'middle', 'newest'], async id => {
      attempted.push(id)
      return { ok: true, taskGroupId: id }
    })
    expect(attempted).toEqual(['oldest', 'middle', 'newest'])
  })

  it('keeps going when a merge throws instead of rejecting the batch', async () => {
    const attempted: string[] = []
    const results = await runMergeAll(['x', 'y'], async id => {
      attempted.push(id)
      if (id === 'x') throw new Error('boom')
      return { ok: true, taskGroupId: id }
    })
    expect(attempted).toEqual(['x', 'y'])
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toBe('boom')
    expect(results[1].ok).toBe(true)
  })

  it('does not report a prepared-conflict merge as a failure', async () => {
    // needsConfirm means the AI resolved it and a human still has to approve.
    // Counting that as a failure would tell the user a task broke when it is
    // actually waiting on them.
    const results = await runMergeAll(['c'], async id => ({ ok: false, needsConfirm: true, taskGroupId: id }))
    const failed = results.filter(r => !r.ok && !r.skipped && !r.needsConfirm)
    expect(failed).toHaveLength(0)
  })
})
