import { describe, expect, it } from 'vitest'
import { bundleScope, checkDiscovered, checkRuntimeRoles, currentSchemas, loadContract, resolveBundle, runtimeRoles } from './backup-scope.mjs'

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

  describe('reviewed runtime roles (login roles that are only members of a group role)', () => {
    const good = [
      'roleattr dpg_order_intake_login super=false inherit=false createrole=false createdb=false login=true replication=false bypassrls=false connlimit=5',
      'roleexists dpg_order_intake_login',
      'member dpg_commerce_intake dpg_order_intake_login admin=false inherit=false set=true',
      'rolesetting dpg_order_intake_login statement_timeout=5s',
      'runtime_role dpg_order_intake_login present',
    ]
    it('pins the order-intake login and its NOINHERIT group membership for v2 only', () => {
      expect(Object.keys(runtimeRoles(c, 2))).toEqual(['dpg_order_intake_login'])
      expect(runtimeRoles(c, 2).dpg_order_intake_login.member_of).toEqual({ dpg_commerce_intake: { admin: false, inherit: false, set: true } })
      expect(runtimeRoles(c, 1)).toEqual({})
    })
    it('accepts a complete record and a consistent absent record', () => {
      expect(checkRuntimeRoles(c, 2, good)).toEqual({ ok: true })
      expect(checkRuntimeRoles(c, 2, ['runtime_role dpg_order_intake_login absent', 'roleexists dpg_commerce_intake'])).toEqual({ ok: true })
    })
    it('fails closed when the record is missing, inconsistent, unreviewed or weaker than the reviewed policy', () => {
      const without = (re) => good.filter((l) => !re.test(l))
      expect(checkRuntimeRoles(c, 2, without(/^runtime_role/))).toMatchObject({ ok: false, reason: 'runtime_roles_missing' })
      expect(checkRuntimeRoles(c, 2, [...good, 'runtime_role dpg_other present'])).toMatchObject({ ok: false, reason: 'runtime_role_unreviewed' })
      expect(checkRuntimeRoles(c, 2, [...good.slice(0, 4), 'runtime_role dpg_order_intake_login absent'])).toMatchObject({ ok: false, reason: 'runtime_role_inconsistent' })
      expect(checkRuntimeRoles(c, 2, without(/^roleattr|^roleexists/))).toMatchObject({ ok: false, reason: 'runtime_role_inconsistent' })
      expect(checkRuntimeRoles(c, 2, without(/^member/))).toMatchObject({ ok: false, reason: 'runtime_role_policy_differs' })
      expect(checkRuntimeRoles(c, 2, good.map((l) => l.replace('inherit=false set=true', 'inherit=true set=true')))).toMatchObject({ ok: false, reason: 'runtime_role_policy_differs' })
      expect(checkRuntimeRoles(c, 2, good.map((l) => l.replace('createrole=false', 'createrole=true')))).toMatchObject({ ok: false, reason: 'runtime_role_policy_differs' })
      expect(checkRuntimeRoles(c, 2, good.map((l) => l.replace('login=true', 'login=false')))).toMatchObject({ ok: false, reason: 'runtime_role_policy_differs' })
      expect(checkRuntimeRoles(c, 2, good.map((l) => l.replace('inherit=false createrole', 'inherit=true createrole')))).toMatchObject({ ok: false, reason: 'runtime_role_policy_differs' })
      expect(checkRuntimeRoles(c, 2, [...good, 'member dpg_commerce_owner dpg_order_intake_login admin=false inherit=false set=true'])).toMatchObject({ ok: false, reason: 'runtime_role_policy_differs' })
    })
  })
})
