// #505 D2 flags-as-code. The Production feature flags live in release/production-flags.json and change only through a reviewed PR.
// Strict schema, no defaults: a missing, extra or unknown value fails closed. The M4 lane reads this file instead of dispatch inputs,
// compares it with the ACTIVE Production version, and a publish that would change a live flag needs an explicit FLAGS-CHANGE line in GO.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { CANONICAL_BRAND_CHOICES } from '../m4/configure-canonical-pricing.mjs'
import { appendSummary, cloudflare, isMain, readActiveProduction, versionBindings, writeOutputs } from './lib.mjs'

export const FLAG_KEYS = Object.freeze(['canonical_pricing', 'canonical_brands', 'commerce', 'series_variant'])
const ON_OFF = ['off', 'on']

export function parseFlags(text) {
  let value
  try { value = JSON.parse(text) } catch { throw new Error('FLAGS_JSON_INVALID') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FLAGS_NOT_OBJECT')
  const keys = Object.keys(value).sort()
  const expected = ['schema', ...FLAG_KEYS].sort()
  if (keys.join() !== expected.join()) throw new Error(`FLAGS_KEYS_INVALID:${keys.join(',')}`)
  if (value.schema !== 1) throw new Error('FLAGS_SCHEMA_UNSUPPORTED')
  for (const key of FLAG_KEYS) if (typeof value[key] !== 'string') throw new Error(`FLAGS_VALUE_NOT_STRING:${key}`)
  if (!ON_OFF.includes(value.canonical_pricing)) throw new Error('FLAGS_CANONICAL_PRICING_INVALID')
  if (value.canonical_pricing === 'on' ? !CANONICAL_BRAND_CHOICES.includes(value.canonical_brands) : value.canonical_brands !== '') {
    throw new Error('FLAGS_CANONICAL_BRANDS_INVALID')
  }
  if (!ON_OFF.includes(value.commerce)) throw new Error('FLAGS_COMMERCE_INVALID')
  // No lane can switch the Series pilot on in Production; widening it is a separate reviewed change.
  if (value.series_variant !== 'off') throw new Error('FLAGS_SERIES_VARIANT_MUST_BE_OFF')
  return Object.freeze(Object.fromEntries(FLAG_KEYS.map((key) => [key, value[key]])))
}

export function loadFlags(path = 'release/production-flags.json') {
  return parseFlags(readFileSync(path, 'utf8'))
}

export function flagsDigest(flags) {
  return createHash('sha256').update(JSON.stringify(FLAG_KEYS.map((key) => [key, flags[key]]))).digest('hex').slice(0, 12)
}

// Derive the flag state actually served by a Worker version. Inconsistent combinations are UNKNOWN (throw), never guessed.
export function flagsFromBindings(bindings) {
  const text = (name) => {
    const found = bindings.filter((b) => b.name === name)
    if (found.length > 1) throw new Error(`LIVE_FLAGS_UNKNOWN:duplicate_${name}`)
    if (!found.length) return undefined
    if (found[0].type !== 'plain_text' || typeof found[0].text !== 'string') throw new Error(`LIVE_FLAGS_UNKNOWN:${name}_type`)
    return found[0].text
  }
  const pricing = text('PUBLIC_CANONICAL_PRICING')
  const brands = text('PUBLIC_CANONICAL_PRICE_BRANDS')
  const commerce = text('PUBLIC_COMMERCE')
  const series = text('PUBLIC_SERIES_VARIANT')
  const intake = bindings.filter((b) => b.name === 'ORDER_INTAKE_DB' && b.type === 'hyperdrive').length
  let canonical_pricing, canonical_brands
  if (pricing === undefined && brands === undefined) { canonical_pricing = 'off'; canonical_brands = '' }
  else if (pricing === 'on' && CANONICAL_BRAND_CHOICES.includes(brands)) { canonical_pricing = 'on'; canonical_brands = brands }
  else throw new Error('LIVE_FLAGS_UNKNOWN:canonical_pricing')
  let commerceState
  if (commerce === undefined && intake === 0) commerceState = 'off'
  else if (commerce === 'on' && intake === 1) commerceState = 'on'
  else throw new Error('LIVE_FLAGS_UNKNOWN:commerce')
  const series_variant = series === undefined ? 'off' : series === 'on' ? 'on' : null
  if (!series_variant) throw new Error('LIVE_FLAGS_UNKNOWN:series_variant')
  return { canonical_pricing, canonical_brands, commerce: commerceState, series_variant }
}

export function diffFlags(candidate, live) {
  return FLAG_KEYS.filter((key) => candidate[key] !== live[key]).map((key) => ({ key, from: live[key], to: candidate[key] }))
}

// Canonical one-line form used in the GO comment: `FLAGS-CHANGE canonical_pricing=on;commerce=off` (FLAG_KEYS order; `;` because
// brand lists contain commas; an empty value is written `-`).
export function formatFlagsChange(diff) {
  return diff.map(({ key, to }) => `${key}=${to === '' ? '-' : to}`).join(';')
}

export function flagOutputs(flags) {
  return { ...flags, flags_digest: flagsDigest(flags) }
}

async function main() {
  const [command, file = 'release/production-flags.json', versionFile] = process.argv.slice(2)
  const flags = loadFlags(file)
  if (command === 'load') {
    writeOutputs(flagOutputs(flags))
    console.error(`RELEASE_FLAGS status=PASS ${FLAG_KEYS.map((k) => `${k}=${flags[k] || '-'}`).join(' ')} digest=${flagsDigest(flags)}`)
    return
  }
  if (command === 'active') {
    // Read the ACTIVE Production version (read-only) and compare. UNKNOWN live state fails closed.
    const { versionId, bindings } = await readActiveProduction(cloudflare())
    const diff = diffFlags(flags, flagsFromBindings(bindings))
    const change = formatFlagsChange(diff)
    const expected = process.env.EXPECT_ROLLBACK_VERSION
    if (expected && expected !== versionId) {
      console.error(`RELEASE_ACTIVE status=FAIL reason=ROLLBACK_TARGET_MISMATCH active=${versionId}`)
      process.exit(1)
    }
    writeOutputs({ active_version: versionId, flags_change: change })
    console.error(`RELEASE_ACTIVE status=PASS active=${versionId} flags=${change ? `CHANGE ${change}` : 'unchanged'}`)
    return
  }
  if (command === 'check-version') {
    // Post-deploy: the version now serving traffic must carry exactly the reviewed flags.
    const live = flagsFromBindings(versionBindings(JSON.parse(readFileSync(versionFile, 'utf8'))))
    const diff = diffFlags(flags, live)
    if (diff.length) { console.error(`RELEASE_FLAGS_DEPLOYED status=FAIL diff=${formatFlagsChange(diff)}`); process.exit(1) }
    appendSummary(`- Deployed flags = reviewed file (digest \`${flagsDigest(flags)}\`)`)
    console.error('RELEASE_FLAGS_DEPLOYED status=PASS')
    return
  }
  throw new Error('USAGE: flags.mjs load|active|check-version <flags.json> [version.json]')
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`RELEASE_FLAGS status=FAIL reason=${error.message}`); process.exit(1) })
