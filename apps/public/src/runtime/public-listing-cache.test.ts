import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublicListingCache } from './public-listing-cache'

describe('completed public listing JSON cache', () => {
  afterEach(() => vi.useRealTimers())
  it('expires at 30 seconds even when frequently accessed', () => {
    vi.useFakeTimers()
    const cache = new PublicListingCache()
    cache.set('page', '{"id":7}')
    vi.advanceTimersByTime(29_999)
    expect(cache.get('page')).toBe('{"id":7}')
    vi.advanceTimersByTime(1)
    expect(cache.get('page')).toBeNull()
    expect(cache.retainedChars).toBe(0)
  })
  it('bounds retained characters and entries and evicts least recently used JSON', () => {
    const cache = new PublicListingCache(10, 2)
    cache.set('a', '1234'); cache.set('b', '5678')
    cache.get('a')
    cache.set('c', '9012')
    expect(cache.get('b')).toBeNull()
    expect(cache.size).toBe(2)
    expect(cache.retainedChars).toBe(8)
    cache.set('huge', 'x'.repeat(11))
    expect(cache.get('huge')).toBeNull()
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.retainedChars).toBe(0)
  })
})
