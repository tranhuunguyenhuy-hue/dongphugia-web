// @vitest-environment node
import { expect, it } from 'vitest'
import { isM2PublicImageTarget, legacyBlogImageUrls } from './m2-public-media.mjs'

const origin = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
it('reuses exact verified M1 article images without accepting arbitrary paths on their hosts', () => {
  const image = [...legacyBlogImageUrls].map(raw => new URL(raw)).find(url => url.hostname === 'showroominax.vn')!
  expect(image).toBeDefined()
  expect(isM2PublicImageTarget(image, origin)).toBe(true)
  expect(isM2PublicImageTarget(new URL('https://showroominax.vn/unreviewed-image.jpg'), origin)).toBe(false)
})
it.each(['http://media.dongphugia.vn/publishing/image.webp', 'https://private:secret@media.dongphugia.vn/publishing/image.webp', 'https://unknown.example/image.jpg', 'http://127.0.0.1/private'])('rejects unverified image target %s', raw => {
  expect(isM2PublicImageTarget(new URL(raw), origin)).toBe(false)
})
it('allows the existing publishing delivery and Product CDN hosts', () => {
  for (const host of ['media.dongphugia.vn', 'dpg-publishing-production.b-cdn.net', 'dpg-products.b-cdn.net']) {
    expect(isM2PublicImageTarget(new URL('https://' + host + '/publishing/image.webp'), origin)).toBe(true)
  }
})
