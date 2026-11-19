// M5 CDN Phase 0 (read-only): exact object listing of the Bunny storage zone `dpg-products`, breadth-first, bounded concurrency.
// Output (TSV): path <TAB> length <TAB> checksum. Metadata only; the key is read from the environment and never printed.
import { writeFileSync } from 'node:fs'

const ZONE = process.env.STORAGE_ZONE ?? 'dpg-products'
const KEY = process.env.MEDIA_KEY ?? ''

export async function listZone({ fetchImpl = fetch, key = KEY, zone = ZONE, concurrency = 4, spacingMs = 100 } = {}) {
  if (!key) throw new Error('MEDIA_KEY missing')
  const out = []; const queue = ['']; let active = 0, dirs = 0
  async function listDir(dir) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(`https://sg.storage.bunnycdn.com/${zone}/${dir}`, { headers: { AccessKey: key, accept: 'application/json' }, signal: AbortSignal.timeout(120000) })
      if (res.ok) return res.json()
      if (attempt >= 4 || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`list ${dir || '/'} failed: HTTP ${res.status}`)
      await new Promise((r) => setTimeout(r, attempt * 1500))
    }
  }
  await new Promise((resolve, reject) => {
    const pump = () => {
      while (active < concurrency && queue.length) {
        const dir = queue.shift(); active++
        listDir(dir).then((items) => {
          dirs++
          for (const it of items) { if (it.IsDirectory) queue.push(`${dir}${it.ObjectName}/`); else out.push(`${dir}${it.ObjectName}\t${it.Length}\t${it.Checksum ?? ''}`) }
        }).then(() => new Promise((r) => setTimeout(r, spacingMs))).then(() => { active--; if (!queue.length && !active) resolve(); else pump() }, reject)
      }
    }
    pump()
  })
  return { lines: out.sort(), dirs }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { lines, dirs } = await listZone()
  writeFileSync(process.argv[2], lines.join('\n') + '\n')
  console.log(`M5_STORAGE_LIST dirs=${dirs} objects=${lines.length}`)
}
