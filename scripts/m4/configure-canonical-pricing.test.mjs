import { describe, expect, it } from 'vitest'
import { APPROVED_CANONICAL_BRANDS, CANONICAL_BRAND_CHOICES, applyCanonicalPricing, assertCanonicalPricingVars } from './configure-canonical-pricing.mjs'
import { CANONICAL_APPROVED_BRANDS } from '../../src/lib/canonical-price'

const base = { name: 'dongphugia-v1-public-production', vars: { APP_ENV: 'production', PUBLIC_CATALOGUE_SOURCE: 'postgresql' } }
describe('#470 canonical pricing flag plumbing (M4 lane)', () => {
  it('the lane allowlist equals the runtime allowlist', () => { expect([...APPROVED_CANONICAL_BRANDS]).toEqual([...CANONICAL_APPROVED_BRANDS]) })
  it('off (default) removes both vars and leaves everything else untouched', () => {
    const cfg = applyCanonicalPricing({ ...base, vars: { ...base.vars, PUBLIC_CANONICAL_PRICING: 'on', PUBLIC_CANONICAL_PRICE_BRANDS: 'toto' } }, 'off')
    expect(cfg.vars).toEqual(base.vars); expect(assertCanonicalPricingVars(cfg.vars, 'off')).toBe(true); expect(assertCanonicalPricingVars(cfg.vars, 'on')).toBe(false)
  })
  it.each(CANONICAL_BRAND_CHOICES)('on writes exactly the approved scope "%s" (each brand can be switched on separately)', brands => {
    const cfg = applyCanonicalPricing(base, 'on', brands)
    expect(cfg.vars).toEqual({ ...base.vars, PUBLIC_CANONICAL_PRICING: 'on', PUBLIC_CANONICAL_PRICE_BRANDS: brands })
    expect(assertCanonicalPricingVars(cfg.vars, 'on')).toBe(true); expect(assertCanonicalPricingVars(cfg.vars, 'off')).toBe(false)
  })
  it('refuses unapproved brands, wrong order/duplicates, bad modes and other Workers', () => {
    for (const bad of ['', 'toto,american-standard', 'inax,toto', 'toto,toto', 'all', 'TOTO']) expect(() => applyCanonicalPricing(base, 'on', bad), bad).toThrow('CANONICAL_PRICING_SCOPE_NOT_APPROVED')
    expect(() => applyCanonicalPricing(base, 'maybe')).toThrow('CANONICAL_PRICING_MODE_INVALID')
    expect(() => applyCanonicalPricing({ ...base, name: 'other' }, 'off')).toThrow('WRONG_WORKER_TARGET')
    expect(assertCanonicalPricingVars({ PUBLIC_CANONICAL_PRICING: 'on', PUBLIC_CANONICAL_PRICE_BRANDS: 'american-standard' }, 'on')).toBe(false)
  })
  it('switching brand sets replaces (never accumulates) the previous scope', () => {
    const first = applyCanonicalPricing(base, 'on', 'toto'), second = applyCanonicalPricing(first, 'on', 'inax')
    expect(second.vars.PUBLIC_CANONICAL_PRICE_BRANDS).toBe('inax')
  })
})
