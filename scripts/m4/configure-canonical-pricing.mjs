// #470: the ONLY way the canonical pricing flag reaches the Production Worker: written into the release wrangler config by the
// protected M4 lane (input `canonical_pricing`, default off). Never set it on the Worker by hand: the next deploy would drop it.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const APPROVED_CANONICAL_BRANDS = ['toto']   // first release scope; widening it is a reviewed code change, not an input

export function applyCanonicalPricing(cfg, mode, brands = 'toto') {
  if (cfg?.name !== 'dongphugia-v1-public-production') throw new Error('WRONG_WORKER_TARGET')
  if (!['off', 'on'].includes(mode)) throw new Error('CANONICAL_PRICING_MODE_INVALID')
  const vars = { ...(cfg.vars ?? {}) }
  delete vars.PUBLIC_CANONICAL_PRICING; delete vars.PUBLIC_CANONICAL_PRICE_BRANDS
  if (mode === 'on') {
    const list = String(brands).split(',').map(value => value.trim()).filter(Boolean)
    if (!list.length || list.some(value => !APPROVED_CANONICAL_BRANDS.includes(value)) || new Set(list).size !== list.length) throw new Error('CANONICAL_PRICING_SCOPE_NOT_APPROVED')
    vars.PUBLIC_CANONICAL_PRICING = 'on'; vars.PUBLIC_CANONICAL_PRICE_BRANDS = list.join(',')
  }
  return { ...cfg, vars }
}

export function assertCanonicalPricingVars(vars, mode) {
  if (mode === 'off') return vars?.PUBLIC_CANONICAL_PRICING === undefined && vars?.PUBLIC_CANONICAL_PRICE_BRANDS === undefined
  return vars?.PUBLIC_CANONICAL_PRICING === 'on' && typeof vars.PUBLIC_CANONICAL_PRICE_BRANDS === 'string'
    && vars.PUBLIC_CANONICAL_PRICE_BRANDS.split(',').every(value => APPROVED_CANONICAL_BRANDS.includes(value))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [path, mode, brands] = process.argv.slice(2)
  const next = applyCanonicalPricing(JSON.parse(readFileSync(path, 'utf8')), mode, brands)
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log(`M4_CANONICAL_PRICING mode=${mode} brands=${next.vars.PUBLIC_CANONICAL_PRICE_BRANDS ?? '-'}`)
}
