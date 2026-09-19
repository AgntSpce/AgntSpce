import { describe, it, expect } from 'vitest'
import { PrioritySemaphore } from '../prioritySemaphore'

describe('PrioritySemaphore.tryAcquire', () => {
  it('reserves a whole block at once', async () => {
    const sem = new PrioritySemaphore(4)
    const releases = await sem.tryAcquire(3, 1000)
    expect(releases).toHaveLength(3)
    expect(sem.currentLoad).toBe(3)
    for (const r of releases) r()
    expect(sem.currentLoad).toBe(0)
  })

  it('fails fast and releases partial reservations on timeout', async () => {
    const sem = new PrioritySemaphore(2)
    const first = await sem.tryAcquire(2, 1000)
    expect(sem.currentLoad).toBe(2)
    await expect(sem.tryAcquire(2, 150)).rejects.toThrow(/reserve 2 slots/)
    // Partial acquisition (0 here — both slots busy) released; the two
    // original holders are untouched.
    expect(sem.currentLoad).toBe(2)
    for (const r of first) r()
    expect(sem.currentLoad).toBe(0)
    // After release, a block fits again.
    const again = await sem.tryAcquire(2, 1000)
    expect(again).toHaveLength(2)
    for (const r of again) r()
  })

  it('returns immediately for empty requests', async () => {
    const sem = new PrioritySemaphore(1)
    expect(await sem.tryAcquire(0)).toEqual([])
  })
})
