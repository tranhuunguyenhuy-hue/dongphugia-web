// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { M2_PUBLIC_TABLES, attestM2PublicRole, connectM2PublicRead } from './m2-public-read-connection.mjs'

function metadata() {
  return {
    identity: { role: 'dpg_public_catalogue', read_only: 'on', row_security: 'on', rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
    rights: M2_PUBLIC_TABLES.map((name: string) => ({ schema: 'dpg_app', name, read: true, write: false, rls: true, platform_statistics: false })),
    authority: { membership: false, ddl: false, dbcreate: false, sequence_write: false },
  }
}
function client(data = metadata()) {
  return { query: vi.fn().mockResolvedValueOnce({ rows: [data.identity] })
    .mockResolvedValueOnce({ rows: data.rights }).mockResolvedValueOnce({ rows: [data.authority] }) }
}
afterEach(() => vi.unstubAllEnvs())

describe('M2 existing Public reader authority', () => {
  it('accepts the existing RLS-protected Public identity including both Blog tables', async () => {
    const data = metadata()
    data.rights.push({ schema: 'extensions', name: 'pg_stat_statements', read: true, write: false, rls: false, platform_statistics: true })
    await expect(attestM2PublicRole(client(data))).resolves.toBeUndefined()
    expect(M2_PUBLIC_TABLES).toHaveLength(14)
  })
  it('rejects the legacy catalogue role and BYPASSRLS identities', async () => {
    for (const change of [{ role: 'dpg_direct_read' }, { rolbypassrls: true }, { rolsuper: true }]) {
      const data = metadata(); Object.assign(data.identity, change)
      await expect(attestM2PublicRole(client(data))).rejects.toThrow('M2_PUBLIC_ROLE_IDENTITY_REQUIRED')
    }
  })
  it('rejects missing Blog privilege, the actual legacy reader boundary', async () => {
    const data = metadata(); data.rights.find(r => r.name === 'blog_posts')!.read = false
    await expect(attestM2PublicRole(client(data))).rejects.toThrow('M2_PUBLIC_ROLE_TABLE_RLS_REQUIRED')
  })
  it('rejects customer reads, any table write, inactive RLS, DDL and elevated membership', async () => {
    for (const variant of ['customer','write','rls','ddl','membership','sequence']) {
      const data = metadata()
      if (variant === 'customer') data.rights.push({ schema: 'dpg_app', name: 'customers', read: true, write: false, rls: true, platform_statistics: false })
      if (variant === 'write') data.rights[0].write = true
      if (variant === 'rls') data.rights[0].rls = false
      if (variant === 'ddl') data.authority.ddl = true
      if (variant === 'membership') data.authority.membership = true
      if (variant === 'sequence') data.authority.sequence_write = true
      await expect(attestM2PublicRole(client(data))).rejects.toThrow(/M2_PUBLIC_ROLE_/)
    }
  })
  it('requires READ ONLY and RLS session settings before reading any products', async () => {
    for (const change of [{ read_only: 'off' }, { row_security: 'off' }]) {
      const data = metadata(); Object.assign(data.identity, change)
      const db = client(data)
      await expect(attestM2PublicRole(db)).rejects.toThrow('M2_PUBLIC_READ_ONLY_RLS_REQUIRED')
      expect(db.query).toHaveBeenCalledTimes(1)
    }
  })
  it('does not fall back to the old catalogue secret or open a DB connection when the Public secret is absent', async () => {
    vi.stubEnv('M2_PUBLIC_READ_DATABASE_URL', '')
    vi.stubEnv('DIRECT_TARGET_READ_DATABASE_URL', 'synthetic-old-reader')
    await expect(connectM2PublicRead()).rejects.toThrow('M2_PUBLIC_SELECT_SECRET_MISSING')
  })
})
