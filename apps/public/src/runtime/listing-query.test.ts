import { describe, expect, it } from 'vitest'
import { isSupportedListingSort, isTrackingQueryKey, resolveListingQuery, supportedListingKeys } from './listing-query'

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

describe('price sort is accepted only for sanitary on the isolated TEST Preview (#447)', () => {
  const testPreview = { APP_ENV: 'staging', PREVIEW_TEST_DATABASE_ISOLATED: 'true' }
  it('adds `sort` for thiet-bi-ve-sinh on the isolated TEST Preview', () => {
    expect(supportedListingKeys('thiet-bi-ve-sinh', testPreview)).toContain('sort')
    expect(resolveListingQuery({ sort: 'price-asc', page: '1' }, supportedListingKeys('thiet-bi-ve-sinh', testPreview))).toEqual({ ok: true, query: { sort: 'price-asc', page: '1' } })
  })
  it('keeps every other category and environment exactly as before (sort still rejected)', () => {
    for (const [category, env] of [
      ['thiet-bi-bep', testPreview], ['gach-op-lat', testPreview], ['vat-lieu-nuoc', testPreview],
      ['thiet-bi-ve-sinh', { APP_ENV: 'production' }], ['thiet-bi-ve-sinh', { APP_ENV: 'production', PREVIEW_TEST_DATABASE_ISOLATED: 'true' }],
      ['thiet-bi-ve-sinh', { APP_ENV: 'staging' }], ['thiet-bi-ve-sinh', { APP_ENV: 'staging', PREVIEW_TEST_DATABASE_ISOLATED: 'false' }],
      ['thiet-bi-ve-sinh', { APP_ENV: 'preview', PREVIEW_TEST_DATABASE_ISOLATED: 'true' }], ['thiet-bi-ve-sinh', {}],
    ] as const) {
      const keys = supportedListingKeys(category, env)
      expect(keys, `${category} ${JSON.stringify(env)}`).not.toContain('sort')
      expect(resolveListingQuery({ sort: 'price-asc' }, keys)).toEqual({ ok: false })
    }
    expect(supportedListingKeys('thiet-bi-ve-sinh', testPreview)).toEqual(['page', 'brand', 'dong', 'is_featured', 'sort'])
  })
  it('accepts only the three known sort values', () => {
    for (const ok of ['default', 'price-asc', 'price-desc']) expect(isSupportedListingSort(ok)).toBe(true)
    for (const bad of ['newest', 'price', 'PRICE-ASC', '', 'price-asc;drop', undefined, ['price-asc'], 1]) expect(isSupportedListingSort(bad)).toBe(false)
  })
})
