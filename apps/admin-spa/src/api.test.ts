import { describe, expect, it } from 'vitest'
import { displayMediaUrl } from './api'

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
