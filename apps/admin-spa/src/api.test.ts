import { afterEach, describe, expect, it, vi } from 'vitest'
import { commerce, displayMediaUrl } from './api'

describe('displayMediaUrl (display only, never stored)', () => {
  it('maps exactly the legacy product CDN host to the verified default pull zone and keeps path and extension', () => {
    expect(displayMediaUrl('https://cdn.dongphugia.com.vn/migrated/kanly/df9b80aa561a-tg02-avt.jpg')).toBe('https://dpg-products.b-cdn.net/migrated/kanly/df9b80aa561a-tg02-avt.jpg')
    expect(displayMediaUrl('https://cdn.dongphugia.com.vn/blog/1782900856082-07fw89.png')).toBe('https://dpg-products.b-cdn.net/blog/1782900856082-07fw89.png')
  })
  it('leaves every other value untouched', () => {
    for (const value of ['https://dpg-products.b-cdn.net/blog/a.webp', 'https://cdn.hita.com.vn/x.jpg', 'http://cdn.dongphugia.com.vn/x.jpg',
      'https://cdn.dongphugia.com.vn.evil.example/x.jpg', 'https://evil.example/https://cdn.dongphugia.com.vn/x.jpg', 'https://cdn.dongphugia.com.vn:8443/x.jpg',
      'https://u:p@cdn.dongphugia.com.vn/x.jpg', '/relative/x.jpg', 'not a url', '']) expect(displayMediaUrl(value), value).toBe(value)
    expect(displayMediaUrl(null)).toBe(''); expect(displayMediaUrl(undefined)).toBe('')
  })
})

describe('order/quote search never puts a customer phone in a URL', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('commerce.list is a no-store POST with the search in the JSON body and a query-free URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { items: [], total: 0, counts: { new: 0, processing: 0, done: 0, cancelled: 0 } } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await commerce.list('orders', { q: '0912345678', status: 'new', page: 1, limit: 25 })
    await commerce.list('quotes', { q: '', status: '', page: 1, limit: 25 })
    const [first, second] = fetchMock.mock.calls as unknown as [string, RequestInit][][] as any
    expect(first[0]).toBe('/admin-next/api/sales/orders/list'); expect(first[0]).not.toMatch(/0912|\?/)
    expect(first[1]).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'same-origin' }); expect(JSON.parse(first[1].body)).toEqual({ q: '0912345678', status: 'new', page: 1, limit: 25 })
    expect(second[0]).toBe('/admin-next/api/sales/quotes/list'); expect(JSON.parse(second[1].body)).toEqual({ page: 1, limit: 25 })     // empty filters are not sent
  })
})
