import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const hosts = new Set(['cdn.dongphugia.com.vn','dpg-products.b-cdn.net','media.dongphugia.vn','dpg-publishing-production.b-cdn.net','cdn.hita.com.vn','hita.com.vn','vietceramics.com','tygjmrhandbffjllxveu.supabase.co'])
const archive = JSON.parse(readFileSync(new URL('../../apps/public/src/runtime/legacy-blog-snapshot.json', import.meta.url), 'utf8'))
assert.equal(archive.contract, 'dpg:verified-legacy-blog-snapshot:v1')
// Preserve the exact original image references already reviewed in M1, without
// granting arbitrary paths on every third-party host mentioned in an article.
export const legacyBlogImageUrls = new Set(archive.posts.flatMap(post => [
  post.thumbnail_url, post.cover_image_url,
  ...[...post.content.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]),
]).flatMap(raw => {
  try { const url = new URL(raw?.replaceAll('&amp;', '&')); return url.protocol === 'https:' && !url.username && !url.password ? [url.href] : [] } catch { return [] }
}))

export function isM2PublicImageTarget(url, origin) {
  if (url.username || url.password) return false
  return url.origin === origin || (url.protocol === 'https:' && (hosts.has(url.hostname) || legacyBlogImageUrls.has(url.href)))
}
