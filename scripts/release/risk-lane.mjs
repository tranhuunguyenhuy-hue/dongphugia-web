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

// Full: database, migrations, functions, backup, CI/CD and Worker bindings. Never auto-preflighted as a Worker-only change.
const FULL = [
  /^prisma\//, /^db\//, /^supabase\//, /^scripts\/(db|migration|backup|m6)\//, /^\.github\/workflows\//,
  /(^|\/)wrangler[^/]*\.jsonc?$/, /^\.github\/actions\//,
]
// No runtime effect: documentation and tests only.
const NONE = [
  /\.md$/, /^docs\//, /^\.github\/(ISSUE_TEMPLATE\/|pull_request_template\.md$)/,
  /\.test\.(ts|tsx|mts|mjs|js)$/, /(^|\/)__tests__\//, /^tests\//, /(^|\/)fixtures\//, /^e2e\//,
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

export function laneForPath(path) {
  const p = path.replaceAll('\\', '/')
  if (FULL.some((re) => re.test(p))) return 'full'
  if (NONE.some((re) => re.test(p))) return 'none'
  if (FAST.some((re) => re.test(p))) return 'fast' // styles and images cannot carry price/order/auth logic
  if (isSensitivePath(p)) return 'extended'
  if (STANDARD.some((re) => re.test(p))) return 'standard'
  return 'extended' // src/lib, apps/public runtime, packages, scripts, config, dependencies and anything unrecognised
}

export function classifyLane(paths) {
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, []]))
  for (const path of paths) byLane[laneForPath(path)].push(path)
  const lane = paths.reduce((acc, path) => maxLane(acc, laneForPath(path)), 'none')
  return { lane, byLane, count: paths.length }
}

export function changedPaths(base, head, run = execFileSync) {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('SCOPE_SHA_INVALID')
  if (base === head) return []
  return run('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

// Release scope = what Production would change: the live source SHA (public health header) to the candidate.
// Any failure (header missing, SHA not in history) makes the scope UNKNOWN, which is treated as `full`.
export async function releaseScope(candidate, { fetchImpl = fetch, run = execFileSync } = {}) {
  let productionSha = 'UNKNOWN'
  try {
    const response = await fetchImpl('https://www.dongphugia.vn/api/health', { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    const header = response.headers.get('x-dpg-source-sha')
    if (response.status === 200 && SHA.test(header ?? '')) productionSha = header
  } catch { /* UNKNOWN */ }
  if (productionSha === 'UNKNOWN') return { productionSha, lane: 'full', count: 0, unknown: true }
  try {
    run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', productionSha], { stdio: 'ignore' })
    const result = classifyLane(changedPaths(productionSha, candidate, run))
    return { productionSha, ...result, unknown: false }
  } catch {
    return { productionSha, lane: 'full', count: 0, unknown: true }
  }
}

async function main() {
  const [command, a, b] = process.argv.slice(2)
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
    const scope = await releaseScope(candidate)
    writeOutputs({ production_sha: scope.productionSha, risk_lane: scope.lane, changed_files: scope.count })
    appendSummary(`- Release scope: Production \`${scope.productionSha}\` → candidate \`${candidate}\`, ${scope.count} files, lane floor **${scope.lane}**${scope.unknown ? ' (scope UNKNOWN → full)' : ''}`)
    console.error(`RELEASE_SCOPE production=${scope.productionSha} lane=${scope.lane} files=${scope.count}`)
    return
  }
  throw new Error('USAGE: risk-lane.mjs diff <base> <head> | scope <candidate>')
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`RISK_LANE status=FAIL reason=${error.message}`); process.exit(1) })
