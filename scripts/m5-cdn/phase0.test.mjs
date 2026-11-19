import { describe, expect, it } from 'vitest'
import { analyse, resolvePath, tileCandidate, parseObjects, sample } from './phase0.mjs'
import { headAll } from './head-check.mjs'

const objects = parseObjects([
  'migrated/toto/a-1.jpg\t100\tX',
  'products/gach-op-lat/36GP0880.original.jpg\t200\tY',
  'products/gach-op-lat/120BBIV_11.original.jpg\t200\tZ',
  'products/ckfinder/userfiles/images/toto/Bồn cầu 2 khối/x.png\t50\tW',
  'hita/empty.png\t0\tE',
].join('\n'))

describe('M5 CDN phase 0', () => {
  it('counts only byte-identical keys as present and reports decoded / normalised matches separately', () => {
    expect(resolvePath('migrated/toto/a-1.jpg', objects).status).toBe('present')
    expect(resolvePath('migrated/TOTO/a-1.jpg', objects).status).toBe('missing') // case is significant
    expect(resolvePath('migrated/toto/a-1.jpg?x=1', objects).status).toBe('missing')
    expect(resolvePath('products//ckfinder/userfiles/images/toto/B%E1%BB%93n%20c%E1%BA%A7u%202%20kh%E1%BB%91i/x.png', objects).status).toBe('present_normalized')
    expect(resolvePath('products/ckfinder/userfiles/images/toto/B%E1%BB%93n%20c%E1%BA%A7u%202%20kh%E1%BB%91i/x.png', objects).status).toBe('present_decoded')
    expect(resolvePath('bad%E0%A4%A.png', objects).status).toBe('missing')
  })

  it('proposes a .original sibling only when that exact object exists', () => {
    expect(tileCandidate('products/gach-op-lat/36GP0880.jpg', objects)).toBe('products/gach-op-lat/36GP0880.original.jpg')
    expect(tileCandidate('products/gach-op-lat/1154EKPA.jpg', objects)).toBeNull()
    expect(tileCandidate('products/gach-op-lat/36GP0880.original.jpg', objects)).toBeNull()
    expect(tileCandidate('products/gach-op-lat/36GP0880.png', objects)).toBeNull()
  })

  it('deduplicates references, keeps per-field counts and records provenance', () => {
    const refsText = [
      'product_images\t1\timage_url\t10\tmigrated/toto/a-1.jpg\t1',
      'product_images\t2\timage_url\t11\tmigrated/toto/a-1.jpg\t1',
      'products\t10\tdescription\t10\tmigrated/toto/a-1.jpg\t1',
      'product_images\t3\timage_url\t20\tproducts/gach-op-lat/36GP0880.jpg\t1',
      'product_images\t4\timage_url\t20\tproducts/gach-op-lat/36GP0880.original.jpg\t1',
      'products\t21\timage_main_url\t21\tproducts/gach-op-lat/120BBIV_11.jpg\t1',
      'product_images\t5\timage_url\t22\thita/empty.png\t0',
    ].join('\n')
    const productsText = '20\tTILE-36GP0880\tgach-36gp0880\n21\tOTHER\tother\n'
    const { summary, tiles } = analyse({ objectsText: [...objects].map(([k, v]) => `${k}\t${v.size}\t${v.checksum}`).join('\n'), refsText, productsText })
    expect(summary.refs).toBe(7)
    expect(summary.distinctPaths).toBe(5)
    expect(summary.present).toBe(2)
    expect(summary.presentEmpty).toBe(1)
    expect(summary.missing).toBe(2)
    expect(summary.fields['product_images.image_url']).toEqual({ refs: 5, distinct: 4, missingRefs: 2, unanchored: 1 })
    const t36 = tiles.find((t) => t.path.endsWith('36GP0880.jpg'))
    expect(t36.evidence).toEqual(expect.arrayContaining(['product:20:references_sibling', 'product:20:code_in_sku_or_slug']))
    expect(tiles.find((t) => t.path.endsWith('120BBIV_11.jpg')).evidence).toEqual([])
  })

  it('samples deterministically', () => {
    const xs = Array.from({ length: 50 }, (_, i) => i)
    expect(sample(xs, 5)).toEqual(sample(xs, 5))
    expect(new Set(sample(xs, 5)).size).toBe(5)
  })

  it('bounds HEAD concurrency and never downloads bodies', async () => {
    let active = 0, peak = 0
    const methods = new Set()
    const fetchImpl = async (_u, init) => { methods.add(init.method); active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } }) }
    const rows = await headAll(Array.from({ length: 12 }, (_, i) => `https://dpg-products.b-cdn.net/x${i}.jpg`), { concurrency: 4, spacingMs: 1, fetchImpl })
    expect(peak).toBeLessThanOrEqual(4)
    expect([...methods]).toEqual(['HEAD'])
    expect(rows.every((r) => r[0] === 200 && r[1] === 'image/jpeg')).toBe(true)
  })
})

import { buildNormalization, confirmTiles, buildTileRepair, sqlString } from './build-sql.mjs'
import { readFileSync } from 'node:fs'

describe('M5 CDN SQL generation', () => {
  const template = readFileSync('scripts/m5-cdn/002.template.sql', 'utf8')
  it('embeds the exclusion list as SQL literals and refuses anything outside the exact old origin', () => {
    const sql = buildNormalization(template, { excluded: ["https://cdn.dongphugia.com.vn/a/it's.jpg"], phase0: 'run 1', maxStartBytes: 1 })
    expect(sql).toContain("'https://cdn.dongphugia.com.vn/a/it''s.jpg'")
    expect(sql).not.toMatch(/__[A-Z_]+__/)
    expect(sql).not.toMatch(/substr\(|substring\(/) // no magic offsets
    expect(() => buildNormalization(template, { excluded: ['https://evil.example/x'], phase0: '', maxStartBytes: 1 })).toThrow()
    expect(buildNormalization(template, { excluded: [], phase0: '', maxStartBytes: 1 })).toContain('array[\n-- excluded:begin\n\n-- excluded:end\n]::text[]')
  })
  it('confirms a tile repair only with delivery, provenance and a column field', () => {
    const base = { path: 'products/gach-op-lat/A.jpg', sibling: 'products/gach-op-lat/A.original.jpg', evidence: ['product:1:references_sibling'], rows: [['product_images', 9, 'image_url'], ['products', 1, 'description']] }
    const ok = 'https://dpg-products.b-cdn.net/products/gach-op-lat/A.original.jpg'
    expect(confirmTiles([base], [['200', 'image/jpeg', '1', ok]]).confirmed[0].fixable).toEqual([['product_images', 9, 'image_url']])
    expect(confirmTiles([base], [['404', 'text/html', '', ok]]).rejected[0].reasons[0]).toMatch(/^sibling_delivery/)
    expect(confirmTiles([{ ...base, evidence: [] }], [['200', 'image/jpeg', '1', ok]]).rejected[0].reasons).toEqual(['no_provenance'])
    expect(confirmTiles([{ ...base, rows: [['products', 1, 'description']] }], [['200', 'image/jpeg', '1', ok]]).rejected[0].reasons).toEqual(['html_only'])
    const sql = buildTileRepair(confirmTiles([base], [['200', 'image/jpeg', '1', ok]]).confirmed, 'run 1')
    expect(sql).toContain("('product_images', 9, 'image_url', 'https://cdn.dongphugia.com.vn/products/gach-op-lat/A.jpg', 'https://dpg-products.b-cdn.net/products/gach-op-lat/A.original.jpg')")
    expect(sqlString("a'b")).toBe("'a''b'")
  })
})

import { listZone } from './list-storage.mjs'
describe('M5 storage listing', () => {
  it('walks directories breadth-first, retries 429 once and never needs more than the key header', async () => {
    const tree = { '': [{ ObjectName: 'a', IsDirectory: true }, { ObjectName: 'r.txt', IsDirectory: false, Length: 3, Checksum: 'C' }], 'a/': [{ ObjectName: 'x.jpg', IsDirectory: false, Length: 9, Checksum: 'D' }] }
    let calls = 0; const seen = []
    const fetchImpl = async (url, init) => { calls++; seen.push(init.headers.AccessKey); const dir = url.split('/dpg-products/')[1]; if (calls === 1) return new Response('', { status: 429 }); return new Response(JSON.stringify(tree[dir]), { status: 200 }) }
    const { lines, dirs } = await listZone({ fetchImpl, key: 'k', spacingMs: 1 })
    expect(lines).toEqual(['a/x.jpg\t9\tD', 'r.txt\t3\tC']); expect(dirs).toBe(2); expect(new Set(seen)).toEqual(new Set(['k']))
  })
})

import { planBatches, buildBatch } from './build-sql.mjs'
describe('M5 CDN batches', () => {
  it('splits product ids into disjoint, complete windows', () => {
    const ids = Array.from({ length: 17752 }, (_, i) => i + 1 + Math.floor(i / 7)) // gaps
    const w = planBatches(ids, 6)
    expect(w).toHaveLength(6)
    expect(w[0].lo).toBe(1); expect(w.at(-1).hi).toBe(2147483647)
    w.slice(1).forEach((x, i) => expect(x.lo).toBe(w[i].hi))
    const covered = ids.filter((id) => w.some((x) => id >= x.lo && id < x.hi))
    expect(covered.length).toBe(ids.length)
    expect(ids.every((id) => w.filter((x) => id >= x.lo && id < x.hi).length === 1)).toBe(true)
  })
  it('puts the autovacuum tuning only in the first batch and the reset only in the last', () => {
    const template = readFileSync('scripts/m5-cdn/002.template.sql', 'utf8')
    const mk = (batch) => buildBatch(template, { excluded: [], phase0: 'r', maxStartBytes: 320000000, lo: 1, hi: 100, batch, batches: 3 })
    expect(mk(1)).toMatch(/set \(autovacuum_vacuum_scale_factor = 0.01/); expect(mk(1)).not.toMatch(/reset \(autovacuum/)
    expect(mk(2)).not.toMatch(/alter table dpg_app\.\w+ (set|reset) \(autovacuum/)
    expect(mk(3)).toMatch(/reset \(autovacuum/)
    expect(mk(2)).toContain('t.product_id >= 1 and t.product_id < 100'); expect(mk(2)).toContain('p.id >= 1 and p.id < 100')
    expect(mk(2)).not.toMatch(/__[A-Z_]+__/)
    expect(() => buildBatch(template, { excluded: [], phase0: '', maxStartBytes: 1, lo: 5, hi: 5, batch: 1, batches: 1 })).toThrow()
  })
})
