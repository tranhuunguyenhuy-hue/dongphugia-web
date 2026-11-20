import { describe, expect, it } from 'vitest'
import { isTrackingQueryKey, resolveListingQuery } from './listing-query'

const SUPPORTED = ['page', 'brand', 'is_featured'] as const

describe('listing query resolution', () => {
  it('ignores marketing and transport parameters instead of rejecting the page', () => {
    expect(resolveListingQuery({ utm_source: 'facebook', utm_campaign: 'x', fbclid: 'abc', gclid: 'def', _rsc: '1x' }, SUPPORTED))
      .toEqual({ ok: true, query: {} })
  })

  it('keeps supported filters and drops only tracking parameters', () => {
    expect(resolveListingQuery({ page: '2', brand: 'toto', fbclid: 'abc' }, SUPPORTED))
      .toEqual({ ok: true, query: { page: '2', brand: 'toto' } })
  })

  it('still rejects unsupported filters so results are never misleading', () => {
    expect(resolveListingQuery({ sort: 'price-asc' }, SUPPORTED)).toEqual({ ok: false })
    expect(resolveListingQuery({ price: '1-2', utm_source: 'x' }, SUPPORTED)).toEqual({ ok: false })
    expect(resolveListingQuery({ utm: 'x' }, SUPPORTED)).toEqual({ ok: false })
  })

  it('identifies tracking keys exactly', () => {
    expect(['utm_medium', 'fbclid', 'gclid', '_rsc'].every(isTrackingQueryKey)).toBe(true)
    expect(['page', 'brand', 'utm', 'xfbclid', 'sort'].some(isTrackingQueryKey)).toBe(false)
  })
})
