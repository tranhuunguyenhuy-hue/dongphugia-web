import { describe, expect, it, vi } from 'vitest'
import { verifyM2SnapshotReadAccess } from './verify-m2-snapshot-read-access.mjs'

const production = { publicProducts: 5964, listingProducts: 5362, publishedBlogs: 10 }
function client(counts = { products: 5964, listings: 5362, blogs: 10, sample_present: true }, readOnly = 'on') {
  return { query: vi.fn(async (statement: string) => {
    if (statement.startsWith('SELECT current_user')) return { rows: [{ role: 'existing_reader', read_only: readOnly, tls: true }] }
    if (statement.startsWith('SELECT\n')) return { rows: [counts] }
    return { rows: [] }
  }) }
}
describe('M2 protected snapshot reader readiness', () => {
  it('compares actual SQL to current live counts in a read-only transaction and does not claim a snapshot', async () => {
    const db = client()
    expect(await verifyM2SnapshotReadAccess(db, production)).toMatchObject({ status: 'PASS', products: 5964, snapshotCreated: false })
    expect(db.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
  it('rejects the stale snapshot count and leaves the transaction rolled back', async () => {
    const db = client({ products: 5223, listings: 4853, blogs: 10, sample_present: true })
    await expect(verifyM2SnapshotReadAccess(db, production)).rejects.toThrow('PRODUCTION_SQL_COUNTS_MISMATCH')
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
  it('rejects a session without the read-only guard before any catalogue query', async () => {
    const db = client(undefined, 'off')
    await expect(verifyM2SnapshotReadAccess(db, production)).rejects.toThrow('READ_ONLY_TLS_REQUIRED')
    expect(db.query).toHaveBeenCalledTimes(3)
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
})
