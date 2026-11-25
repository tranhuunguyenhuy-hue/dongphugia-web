// #505 risk lanes. A path-based FLOOR, computed (never declared) so an agent cannot lower it; GO may only raise it (LANE line).
// none < fast < standard < extended < full. Unknown paths raise to `extended`; an unknown release scope is `full`.
import { execFileSync } from 'node:child_process'
import { SHA, appendSummary, isMain, writeOutputs } from './lib.mjs'

export const LANES = Object.freeze(['none', 'fast', 'standard', 'extended', 'full'])
export const laneRank = (lane) => {
  const rank = LANES.indexOf(lane)
  if (rank < 0) throw new Error(`LANE_INVALID:${lane}`)
  return rank
}
export const maxLane = (...lanes) => lanes.reduce((a, b) => (laneRank(b) > laneRank(a) ? b : a), 'none')

// Full = real hosted risk, by category; each needs its own existing lane before a Worker publish (see go-evidence.mjs).
// Pipeline-only files (.github/workflows, scripts/release, scripts/backup) are NOT full: they do not change a hosted database,
// function or binding, so they rate `extended` (TL review once) and never block future Worker-only releases.
export const FULL_CATEGORIES = Object.freeze({
  sql: [/^prisma\//, /^db\//, /^supabase\/(?!functions\/)/, /^scripts\/(db|migration|m6)\//, /^release\/plans\//],
  function: [/^supabase\/functions\//],
  bindings: [/(^|\/)wrangler[^/]*\.jsonc?$/],
})
// No runtime effect: documentation and tests only (checked first, so a test next to a migration stays `none`).
const NONE = [
  /\.md$/, /^docs\//, /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$)/,
  /\.test\.(ts|tsx|mts|mjs|js)$/, /(^|\/)__tests__\//, /^tests\//, /^e2e\//, /^scripts\/release\/fixtures\//,
]
// Static presentation only.
const FAST = [/\.(css|scss)$/, /^public\/.*\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?)$/, /^src\/.*\.(png|jpe?g|webp|avif|gif|svg)$/]
// UI components and pages.
const STANDARD = [/^src\/app\/\(public\)\//, /^src\/components\//, /^src\/app\/admin\//, /^apps\/admin-spa\/src\//, /^apps\/admin\//]
// Business data, money, ordering and access control raise any non-static path to at least extended (whole tokens, so `border` or
// `author` do not match; camelCase is split, so `CartDrawer` does). Vietnamese route slugs for cart/quote/order/payment included.
const SENSITIVE_TOKENS = new Set(['price', 'prices', 'pricing', 'voucher', 'vouchers', 'commerce', 'checkout', 'order', 'orders', 'cart',
  'quote', 'quotes', 'auth', 'session', 'sessions', 'permission', 'permissions', 'rbac', 'role', 'roles', 'sales', 'payment', 'payments'])
const SENSITIVE_SLUGS = /(^|\/)(gio-hang|bao-gia|dat-hang|don-hang|thanh-toan)(\/|$)/
export function isSensitivePath(path) {
  if (SENSITIVE_SLUGS.test(path)) return true
  return path.split(/[/_.\-\s()[\]]+/).flatMap((part) => part.split(/(?=[A-Z])/)).some((token) => SENSITIVE_TOKENS.has(token.toLowerCase()))
}

export function fullCategory(path) {
  const p = path.replaceAll('\\', '/')
  if (NONE.some((re) => re.test(p))) return null
  return Object.entries(FULL_CATEGORIES).find(([, res]) => res.some((re) => re.test(p)))?.[0] ?? null
}

export function laneForPath(path) {
  const p = path.replaceAll('\\', '/')
  if (NONE.some((re) => re.test(p))) return 'none'
  if (fullCategory(p)) return 'full'
  if (FAST.some((re) => re.test(p))) return 'fast' // styles and images cannot carry price/order/auth logic
  if (isSensitivePath(p)) return 'extended'
  if (STANDARD.some((re) => re.test(p))) return 'standard'
  return 'extended' // src/lib, apps/public runtime, packages, scripts, config, dependencies and anything unrecognised
}

export function classifyLane(paths) {
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, []]))
  for (const path of paths) byLane[laneForPath(path)].push(path)
  const lane = paths.reduce((acc, path) => maxLane(acc, laneForPath(path)), 'none')
  const categories = {}
  for (const path of paths) { const c = fullCategory(path); if (c) (categories[c] ??= []).push(path) }
  return { lane, byLane, categories, count: paths.length }
}

export function changedPaths(base, head, run = execFileSync) {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('SCOPE_SHA_INVALID')
  if (base === head) return []
  return run('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

// Release scope = what Production would change: the live source SHA (public health header) to the candidate, cumulative over
// every commit in between (multi-commit pushes included). For each full category it records the newest commit touching it, so
// the GO check can prove that the category's own lane ran on a SHA containing that change. Any failure = UNKNOWN = `full`.
export async function releaseScope(candidate, { fetchImpl = fetch, run = execFileSync, withHistory = false } = {}) {
  const unknown = (productionSha = 'UNKNOWN') => ({ productionSha, lane: 'full', count: 0, unknown: true, fullTouch: null, categories: {} })
  let productionSha
  try {
    const response = await fetchImpl('https://www.dongphugia.vn/api/health', { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    const header = response.headers.get('x-dpg-source-sha')
    if (response.status === 200 && SHA.test(header ?? '')) productionSha = header
  } catch { /* UNKNOWN */ }
  if (!productionSha) return unknown()
  try {
    if (!withHistory) run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', productionSha], { stdio: 'ignore' })
    const result = classifyLane(changedPaths(productionSha, candidate, run))
    let fullTouch = null
    if (withHistory) {
      fullTouch = {}
      for (const [category, files] of Object.entries(result.categories)) {
        const last = run('git', ['log', '-1', '--format=%H', `${productionSha}..${candidate}`, '--', ...files], { encoding: 'utf8' }).trim()
        if (!SHA.test(last)) return unknown(productionSha)
        fullTouch[category] = last
      }
    }
    return { productionSha, ...result, unknown: false, fullTouch }
  } catch {
    return unknown(productionSha)
  }
}

/** #511: a deploy outside a reviewed plan (legacy function lane) must not ship a function change; unknown scope = refuse. */
export function legacyFunctionBlock(scope) {
  if (!scope || scope.unknown) return 'RELEASE_SCOPE_UNKNOWN (fail closed: deploy the function as a plan step)'
  const files = scope.categories?.function ?? []
  return files.length ? `FUNCTION_CHANGE_REQUIRES_PLAN files=${files.length} (deploy it as the function step of a reviewed release plan)` : null
}

async function main() {
  const [command, a, b] = process.argv.slice(2)
  if (command === 'legacy-function') {
    if (!SHA.test(a ?? '')) throw new Error('SCOPE_SHA_INVALID')
    const blocked = legacyFunctionBlock(await releaseScope(a))
    appendSummary(`- Legacy function deploy scope check: ${blocked ? `**REFUSED** — ${blocked}` : 'PASS (no function change since live Production)'}`)
    if (blocked) throw new Error(blocked)
    console.error('RISK_LANE legacy-function=PASS')
    return
  }
  if (command === 'diff') {
    // Lane of one change set (auto-preflight: the pushed commit against its first parent).
    const result = classifyLane(changedPaths(a, b))
    writeOutputs({ risk_lane: result.lane, changed_files: result.count })
    console.error(`RISK_LANE lane=${result.lane} files=${result.count}`)
    return
  }
  if (command === 'scope') {
    const candidate = a
    if (!SHA.test(candidate ?? '')) throw new Error('SCOPE_SHA_INVALID')
    const scope = await releaseScope(candidate, { withHistory: process.env.SCOPE_WITH_HISTORY === 'true' })
    const fullTouch = scope.fullTouch ? JSON.stringify(scope.fullTouch) : 'unknown'
    writeOutputs({ production_sha: scope.productionSha, risk_lane: scope.lane, changed_files: scope.count, full_touch: fullTouch })
    appendSummary(`- Release scope: Production \`${scope.productionSha}\` → candidate \`${candidate}\`, ${scope.count} files, lane floor **${scope.lane}**${scope.unknown ? ' (scope UNKNOWN → full, fail closed)' : ''}${Object.keys(scope.categories ?? {}).length ? `; full categories: ${Object.keys(scope.categories).join(', ')}` : ''}`)
    console.error(`RELEASE_SCOPE production=${scope.productionSha} lane=${scope.lane} files=${scope.count}`)
    return
  }
  throw new Error('USAGE: risk-lane.mjs diff <base> <head> | scope <candidate> | legacy-function <candidate>')
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`RISK_LANE status=FAIL reason=${error.message}`); process.exit(1) })
