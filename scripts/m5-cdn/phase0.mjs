// M5 CDN Phase 0 (read-only): compare stored legacy-CDN references with the exact object list of the `dpg-products`
// storage zone. Inputs are metadata only (public media paths, sizes, checksums; product id/sku/slug).
import { readFileSync, writeFileSync } from 'node:fs'

export const OLD_PREFIX = 'https://cdn.dongphugia.com.vn/'
export const NEW_PREFIX = 'https://dpg-products.b-cdn.net/'

export function parseObjects(text) {
  const objects = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    const [path, size, checksum] = line.split('\t')
    objects.set(path, { size: Number(size), checksum: checksum || '' })
  }
  return objects
}

export function parseRefs(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [table, pk, column, productId, path, anchored] = line.split('\t')
    return { table, pk: Number(pk), column, productId: productId ? Number(productId) : null, path, anchored: anchored === '1' }
  })
}

function safeDecode(value) { try { return decodeURIComponent(value) } catch { return null } }

/** Exact object membership. Only byte-identical keys count as `present`; decoded/normalised keys are reported separately. */
export function resolvePath(path, objects) {
  if (objects.has(path)) return { status: 'present', key: path }
  const decoded = safeDecode(path)
  if (decoded !== null && decoded !== path && objects.has(decoded)) return { status: 'present_decoded', key: decoded }
  const collapsed = (decoded ?? path).replace(/\/{2,}/g, '/')
  if (collapsed !== path && objects.has(collapsed)) return { status: 'present_normalized', key: collapsed }
  return { status: 'missing', key: null }
}

const norm = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** `<dir>/<stem>.<ext>` missing, `<dir>/<stem>.original.<ext>` present: a remediation candidate, never a blanket rule. */
export function tileCandidate(path, objects) {
  const m = /^(.*\/)([^/]+?)\.(jpe?g|png|webp)$/i.exec(path)
  if (!m || /\.original$/i.test(m[2])) return null
  const sibling = `${m[1]}${m[2]}.original.${m[3]}`
  return objects.has(sibling) ? sibling : null
}

/** Provenance for a candidate: the same product already references the sibling, or the file stem's code is in its SKU/slug. */
export function provenance(path, sibling, productIds, refsByProduct, products) {
  const stem = /([^/]+?)(?:\.original)?\.[a-z]+$/i.exec(path)?.[1] ?? ''
  const code = norm(stem.split(/[_-]/)[0])
  const evidence = []
  for (const id of productIds) {
    if (refsByProduct.get(id)?.has(sibling)) evidence.push(`product:${id}:references_sibling`)
    const p = products.get(id)
    if (p && code.length >= 4 && (norm(p.sku).includes(code) || norm(p.slug).includes(code))) evidence.push(`product:${id}:code_in_sku_or_slug`)
  }
  return evidence
}

export function analyse({ objectsText, refsText, productsText = '' }) {
  const objects = parseObjects(objectsText)
  const refs = parseRefs(refsText)
  const products = new Map(productsText.split('\n').filter(Boolean).map((l) => { const [id, sku, slug] = l.split('\t'); return [Number(id), { sku, slug }] }))
  const byPath = new Map()
  const refsByProduct = new Map()
  for (const r of refs) {
    const entry = byPath.get(r.path) ?? { path: r.path, refs: 0, fields: new Set(), productIds: new Set(), unanchored: 0, rows: [] }
    entry.refs++; entry.rows.push([r.table, r.pk, r.column]); entry.fields.add(`${r.table}.${r.column}`); if (r.productId) entry.productIds.add(r.productId); if (!r.anchored) entry.unanchored++
    byPath.set(r.path, entry)
    if (r.productId) { const s = refsByProduct.get(r.productId) ?? new Set(); s.add(r.path); refsByProduct.set(r.productId, s) }
  }
  const fields = {}
  const distinct = []
  const tiles = []
  for (const e of byPath.values()) {
    const res = resolvePath(e.path, objects)
    e.status = res.status; e.size = res.key ? objects.get(res.key).size : null
    if (res.key && objects.get(res.key).size === 0) e.status = 'present_empty'
    distinct.push(e)
    if (e.status === 'missing') {
      const sibling = tileCandidate(e.path, objects)
      if (sibling) tiles.push({ path: e.path, sibling, productIds: [...e.productIds], fields: [...e.fields], refs: e.refs, rows: e.rows, evidence: provenance(e.path, sibling, e.productIds, refsByProduct, products) })
    }
  }
  for (const r of refs) {
    const key = `${r.table}.${r.column}`
    const f = fields[key] ??= { refs: 0, distinct: new Set(), missingRefs: 0, unanchored: 0 }
    f.refs++; f.distinct.add(r.path); if (!r.anchored) f.unanchored++
    if (byPath.get(r.path).status === 'missing' || byPath.get(r.path).status === 'present_empty') f.missingRefs++
  }
  const count = (s) => distinct.filter((e) => e.status === s).length
  const summary = {
    objects: objects.size, refs: refs.length, distinctPaths: distinct.length,
    present: count('present'), presentDecoded: count('present_decoded'), presentNormalized: count('present_normalized'),
    presentEmpty: count('present_empty'), missing: count('missing'), tileCandidates: tiles.length,
    tilesWithEvidence: tiles.filter((t) => t.evidence.length > 0).length,
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { refs: v.refs, distinct: v.distinct.size, missingRefs: v.missingRefs, unanchored: v.unanchored }])),
    missingByFolder: Object.fromEntries(Object.entries(distinct.filter((e) => e.status === 'missing').reduce((a, e) => { const k = e.path.split('/').slice(0, 2).join('/'); a[k] = (a[k] ?? 0) + 1; return a }, {})).sort((a, b) => b[1] - a[1])),
  }
  return { summary, distinct, tiles }
}

/** Deterministic sample (no Math.random) so reruns check the same URLs. */
export function sample(items, n, seed = 7) {
  const scored = items.map((x, i) => [((i + 1) * 2654435761 + seed) % 4294967296, x])
  return scored.sort((a, b) => a[0] - b[0]).slice(0, n).map(([, x]) => x)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [objectsFile, refsFile, productsFile, outDir] = process.argv.slice(2)
  const { summary, distinct, tiles } = analyse({ objectsText: readFileSync(objectsFile, 'utf8'), refsText: readFileSync(refsFile, 'utf8'), productsText: readFileSync(productsFile, 'utf8') })
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2))
  writeFileSync(`${outDir}/distinct-paths.tsv`, distinct.map((e) => [e.path, e.status, e.refs, e.size ?? '', [...e.fields].join(','), e.unanchored].join('\t')).join('\n') + '\n')
  const excluded = distinct.filter((e) => e.status !== 'present').map((e) => OLD_PREFIX + e.path).sort()
  writeFileSync(`${outDir}/excluded-urls.txt`, excluded.join('\n') + (excluded.length ? '\n' : ''))
  writeFileSync(`${outDir}/tiles.json`, JSON.stringify(tiles, null, 2))
  const head = [
    ...distinct.filter((e) => e.status !== 'present').slice(0, 3000).map((e) => NEW_PREFIX + e.path),
    ...tiles.map((t) => NEW_PREFIX + t.sibling),
    ...sample(distinct.filter((e) => e.status === 'present'), 300).map((e) => NEW_PREFIX + e.path),
  ]
  writeFileSync(`${outDir}/head-urls.txt`, [...new Set(head)].join('\n') + '\n')
  console.log(`M5_CDN_PHASE0 ${JSON.stringify({ ...summary, fields: undefined, missingByFolder: undefined })}`)
  console.log(`M5_CDN_PHASE0 fields=${JSON.stringify(summary.fields)}`)
  console.log(`M5_CDN_PHASE0 missing_by_folder=${JSON.stringify(summary.missingByFolder)}`)
}
