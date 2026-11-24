import { describe, expect, it } from 'vitest'
import { applyCanonicalPricing, assertCanonicalPricingVars } from './configure-canonical-pricing.mjs'

const base = { name: 'dongphugia-v1-public-production', vars: { APP_ENV: 'production', PUBLIC_CATALOGUE_SOURCE: 'postgresql' } }
describe('#470 canonical pricing flag plumbing (M4 lane)', () => {
  it('off (default) removes both vars and leaves everything else untouched', () => {
    const cfg = applyCanonicalPricing({ ...base, vars: { ...base.vars, PUBLIC_CANONICAL_PRICING: 'on', PUBLIC_CANONICAL_PRICE_BRANDS: 'toto' } }, 'off')
    expect(cfg.vars).toEqual(base.vars); expect(assertCanonicalPricingVars(cfg.vars, 'off')).toBe(true); expect(assertCanonicalPricingVars(cfg.vars, 'on')).toBe(false)
  })
  it('on writes exactly the approved scope', () => {
    const cfg = applyCanonicalPricing(base, 'on')
    expect(cfg.vars).toEqual({ ...base.vars, PUBLIC_CANONICAL_PRICING: 'on', PUBLIC_CANONICAL_PRICE_BRANDS: 'toto' })
    expect(assertCanonicalPricingVars(cfg.vars, 'on')).toBe(true); expect(assertCanonicalPricingVars(cfg.vars, 'off')).toBe(false)
  })
  it('refuses unapproved brands, bad modes and other Workers', () => {
    expect(() => applyCanonicalPricing(base, 'on', 'toto,inax')).toThrow('CANONICAL_PRICING_SCOPE_NOT_APPROVED')
    expect(() => applyCanonicalPricing(base, 'on', '')).toThrow('CANONICAL_PRICING_SCOPE_NOT_APPROVED')
    expect(() => applyCanonicalPricing(base, 'maybe')).toThrow('CANONICAL_PRICING_MODE_INVALID')
    expect(() => applyCanonicalPricing({ ...base, name: 'other' }, 'off')).toThrow('WRONG_WORKER_TARGET')
    expect(assertCanonicalPricingVars({ PUBLIC_CANONICAL_PRICING: 'on', PUBLIC_CANONICAL_PRICE_BRANDS: 'inax' }, 'on')).toBe(false)
  })
})
