import { describe, expect, it } from 'vitest'
import { applyCommerce, assertCommerceConfig } from './configure-commerce.mjs'

const PUBLIC_ID = '905f5791e9d84cf285f7533b92d03f49', INTAKE_ID = '0123456789abcdef0123456789abcdef'
const base = { name: 'dongphugia-v1-public-production', vars: { APP_ENV: 'production' }, hyperdrive: [{ binding: 'PUBLIC_DB', id: PUBLIC_ID }] }
describe('#470 commerce flag + intake binding plumbing (M4 lane)', () => {
  it('off (default) removes the flag and the intake binding and leaves PUBLIC_DB untouched', () => {
    const on = applyCommerce(base, 'on', INTAKE_ID, PUBLIC_ID)
    const off = applyCommerce(on, 'off')
    expect(off).toEqual(base); expect(assertCommerceConfig(off, 'off')).toBe(true); expect(assertCommerceConfig(off, 'on', INTAKE_ID)).toBe(false)
  })
  it('on writes exactly PUBLIC_COMMERCE=on + one ORDER_INTAKE_DB binding next to PUBLIC_DB', () => {
    const cfg = applyCommerce(base, 'on', INTAKE_ID, PUBLIC_ID)
    expect(cfg.vars).toEqual({ APP_ENV: 'production', PUBLIC_COMMERCE: 'on' })
    expect(cfg.hyperdrive).toEqual([{ binding: 'PUBLIC_DB', id: PUBLIC_ID }, { binding: 'ORDER_INTAKE_DB', id: INTAKE_ID }])
    expect(assertCommerceConfig(cfg, 'on', INTAKE_ID)).toBe(true); expect(assertCommerceConfig(cfg, 'off')).toBe(false)
    expect(applyCommerce(cfg, 'on', INTAKE_ID, PUBLIC_ID).hyperdrive.filter(item => item.binding === 'ORDER_INTAKE_DB')).toHaveLength(1)
  })
  it('refuses a missing/odd intake id, reuse of the Public read Hyperdrive, bad mode and other Workers', () => {
    for (const bad of ['', 'x', INTAKE_ID.toUpperCase()]) expect(() => applyCommerce(base, 'on', bad, PUBLIC_ID)).toThrow('COMMERCE_INTAKE_HYPERDRIVE_MISSING')
    expect(() => applyCommerce(base, 'on', PUBLIC_ID, PUBLIC_ID)).toThrow('COMMERCE_INTAKE_MUST_NOT_REUSE_PUBLIC_HYPERDRIVE')
    expect(() => applyCommerce(base, 'maybe')).toThrow('COMMERCE_MODE_INVALID')
    expect(() => applyCommerce({ ...base, name: 'other' }, 'off')).toThrow('WRONG_WORKER_TARGET')
  })
})
