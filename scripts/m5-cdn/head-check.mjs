// Bounded HEAD checks on the default pull zone: concurrency 4, >= 150 ms between request starts per worker, 10 s timeout.
// Headers only (no body download). Output: status <TAB> content-type <TAB> content-length <TAB> url
import { readFileSync, writeFileSync } from 'node:fs'

export async function headAll(urls, { concurrency = 4, spacingMs = 150, fetchImpl = fetch } = {}) {
  const out = new Array(urls.length)
  let next = 0
  async function worker() {
    while (next < urls.length) {
      const i = next++
      const started = Date.now()
      try {
        const r = await fetchImpl(urls[i], { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) })
        out[i] = [r.status, r.headers.get('content-type') ?? '', r.headers.get('content-length') ?? '', urls[i]]
      } catch (e) { out[i] = ['ERR', String(e?.name ?? 'error'), '', urls[i]] }
      const wait = spacingMs - (Date.now() - started); if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inFile, outFile] = process.argv.slice(2)
  const urls = readFileSync(inFile, 'utf8').split('\n').filter((u) => u.startsWith('https://dpg-products.b-cdn.net/'))
  const rows = await headAll(urls)
  writeFileSync(outFile, rows.map((r) => r.join('\t')).join('\n') + '\n')
  const tally = rows.reduce((a, r) => { const k = `${r[0]} ${String(r[1]).split(';')[0]}`; a[k] = (a[k] ?? 0) + 1; return a }, {})
  console.log(`M5_CDN_HEAD requests=${rows.length} ${JSON.stringify(tally)}`)
}
