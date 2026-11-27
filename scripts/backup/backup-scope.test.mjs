import { describe, expect, it } from 'vitest'
import { bundleScope, checkDiscovered, currentSchemas, loadContract, resolveBundle } from './backup-scope.mjs'

const c = loadContract()
describe('DPG-42 trusted backup scope', () => {
  it('pins the reviewed v2 schema inventory and the historical v1 inventory', () => {
    expect(currentSchemas(c)).toEqual(['dpg_app', 'dpg_control', 'dpg_commerce'])
    expect(c.versions['1'].schemas).toEqual(['dpg_app', 'dpg_control'])
    expect(c.versions['1'].coverage).toBe('limited')
    expect(c.excluded).toEqual({})
  })
  it('fails closed on an uncovered dpg_* schema (future dpg_core) or a missing approved schema', () => {
    expect(checkDiscovered(c, ['dpg_app', 'dpg_control', 'dpg_commerce'])).toMatchObject({ ok: true })
    expect(checkDiscovered(c, ['dpg_app', 'dpg_control', 'dpg_commerce', 'dpg_core'])).toMatchObject({ ok: false, reason: 'uncovered_schema', uncovered: ['dpg_core'] })
    expect(checkDiscovered(c, ['dpg_app', 'dpg_control'])).toMatchObject({ ok: false, reason: 'approved_schema_missing', missing: ['dpg_commerce'] })
    expect(checkDiscovered(c, ['dpg_app', 'dpg_control', 'dpg_commerce', 'Bad Name'])).toMatchObject({ ok: false, reason: 'discovered_name_invalid' })
  })
  it('accepts a bundle scope only when it equals a reviewed version exactly', () => {
    const good = JSON.stringify(bundleScope(c))
    expect(resolveBundle(c, good)).toMatchObject({ ok: true, version: 2, coverage: 'full' })
    expect(resolveBundle(c, null)).toMatchObject({ ok: true, version: 1, coverage: 'limited', historical: true })
    expect(resolveBundle(c, '{')).toMatchObject({ ok: false, reason: 'scope_json_invalid' })
    expect(resolveBundle(c, JSON.stringify({ ...bundleScope(c), version: 9 }))).toMatchObject({ ok: false, reason: 'scope_version_unknown' })
    expect(resolveBundle(c, JSON.stringify({ ...bundleScope(c), schemas: ['dpg_app'] }))).toMatchObject({ ok: false, reason: 'scope_schemas_not_reviewed' })
    expect(resolveBundle(c, JSON.stringify({ ...bundleScope(c), extra: 1 }))).toMatchObject({ ok: false, reason: 'scope_unexpected_fields' })
    expect(resolveBundle(c, JSON.stringify({ ...bundleScope(c), contract: 'x' }))).toMatchObject({ ok: false, reason: 'scope_contract_mismatch' })
  })
})
