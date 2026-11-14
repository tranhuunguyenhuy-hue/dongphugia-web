import { describe, expect, it, vi } from 'vitest'
import { acquirePublicReadSlot, publicReadScope, withPublicReadScope } from './public-read-scope'

describe('request-owned read scheduling', () => {
  it('expires queued reads, removes waiters and releases every slot exactly once', async () => {
    vi.useFakeTimers()
    try {
      await withPublicReadScope(undefined, async () => {
        const releases = await Promise.all(Array.from({ length: 4 }, acquirePublicReadSlot))
        const queued = expect(acquirePublicReadSlot()).rejects.toThrow('PUBLIC_DATABASE_READ_QUEUE_TIMEOUT')
        await vi.advanceTimersByTimeAsync(5000)
        await queued
        expect(publicReadScope()?.waiters).toHaveLength(0)
        for (const release of releases) { release(); release() }
        expect(publicReadScope()?.active).toBe(0)
        const release = await acquirePublicReadSlot()
        release()
        expect(publicReadScope()?.active).toBe(0)
      })
    } finally { vi.useRealTimers() }
  })

  it('cancels queued reads without affecting a second request', async () => {
    const controller = new AbortController()
    await withPublicReadScope(controller.signal, async () => {
      const releases = await Promise.all(Array.from({ length: 4 }, acquirePublicReadSlot))
      const queued = expect(acquirePublicReadSlot()).rejects.toThrow('PUBLIC_DATABASE_REQUEST_ABORTED')
      controller.abort()
      await queued
      expect(publicReadScope()?.waiters).toHaveLength(0)
      releases.forEach(release => release())
      expect(publicReadScope()?.active).toBe(0)
    })
    await withPublicReadScope(undefined, async () => {
      const release = await acquirePublicReadSlot()
      expect(publicReadScope()?.active).toBe(1)
      release()
    })
  })
})
