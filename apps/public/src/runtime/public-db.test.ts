import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: { PUBLIC_DB: { connectionString: 'postgresql://readonly.invalid/test' } },
}))
vi.mock('pg', () => ({
  Client: class MockClient {
    constructor() {
      return { connect: mocks.connect, query: mocks.query, end: mocks.end }
    }
  },
}))

import { withPublicReadScope } from './public-read-scope'
import { readPublicRows } from './public-db'

describe('Public PostgreSQL read boundary', () => {
  beforeEach(() => {
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql')
    mocks.connect.mockReset().mockResolvedValue(undefined)
    mocks.query.mockReset().mockResolvedValue({ rows: [{ id: 7 }] })
    mocks.end.mockReset().mockResolvedValue(undefined)
  })

  it('uses a bound SELECT through the Hyperdrive client and closes it', async () => {
    await expect(readPublicRows<{ id: number }>('SELECT id FROM dpg_app.products WHERE sku = $1', ['DPG-7']))
      .resolves.toEqual([{ id: 7 }])
    expect(mocks.query).toHaveBeenCalledWith('SELECT id FROM dpg_app.products WHERE sku = $1', ['DPG-7'])
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('binds text-array filters without interpolating filter values into SQL', async () => {
    const brands = ['brand-one', "brand' OR true --"]
    await readPublicRows('SELECT id FROM dpg_app.products WHERE brand_slug = ANY($1::text[])', [brands])
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT id FROM dpg_app.products WHERE brand_slug = ANY($1::text[])',
      [brands],
    )
  })

  it('caps concurrent read clients and queue within one request', async () => {
    let active = 0
    let peak = 0
    mocks.connect.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
    })
    mocks.query.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { rows: [{ id: 7 }] }
    })
    mocks.end.mockImplementation(async () => {
      active -= 1
    })

    const results = await withPublicReadScope(undefined, () => Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
      readPublicRows<{ id: number }>('SELECT id FROM dpg_app.products WHERE id = $1', [index]),
    )))

    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(36)
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(4)
    expect(rejected.every((result) => result.status === 'rejected'
      && result.reason.message === 'PUBLIC_DATABASE_READ_CAPACITY_EXCEEDED')).toBe(true)
  })

  it('#457: reads an identical bound SELECT once per request and never shares it with another request', async () => {
    const statement = 'SELECT id FROM dpg_app.products WHERE sku = $1'
    const [first, second, other] = await withPublicReadScope(undefined, () => Promise.all([
      readPublicRows<{ id: number }>(statement, ['DPG-7']),
      readPublicRows<{ id: number }>(statement, ['DPG-7']),
      readPublicRows<{ id: number }>(statement, ['DPG-8']),
    ]))
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(first).toEqual([{ id: 7 }])
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(other).toEqual([{ id: 7 }])
    await withPublicReadScope(undefined, () => readPublicRows(statement, ['DPG-7']))
    expect(mocks.query).toHaveBeenCalledTimes(3)
    expect(mocks.end).toHaveBeenCalledTimes(3)
  })

  it('#457: a failed read is not memoized, so a later caller in the same request reads again', async () => {
    mocks.query.mockRejectedValueOnce(new Error('Query read timeout'))
    await withPublicReadScope(undefined, async () => {
      await expect(readPublicRows('SELECT id FROM dpg_app.products')).rejects.toThrow('Query read timeout')
      await expect(readPublicRows('SELECT id FROM dpg_app.products')).resolves.toEqual([{ id: 7 }])
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it.each([
    'UPDATE dpg_app.products SET name = $1',
    'SELECT id FROM dpg_app.products; DELETE FROM dpg_app.products',
    'WITH changed AS (DELETE FROM dpg_app.products RETURNING id) SELECT id FROM changed',
  ])('rejects non-read-only SQL before connecting: %s', async (statement) => {
    await expect(readPublicRows(statement)).rejects.toThrow('PUBLIC_DATABASE_READ_ONLY_REQUIRED')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('keeps database reads disabled when Production selects the snapshot source', async () => {
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'snapshot')
    await expect(readPublicRows('SELECT id FROM dpg_app.products')).rejects.toThrow('PUBLIC_DATABASE_MODE_DISABLED')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('reports a query timeout safely and still closes the client', async () => {
    vi.stubEnv('PUBLIC_DB_DIAGNOSTICS', 'true')
    mocks.query.mockRejectedValueOnce(new Error('Query read timeout'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(readPublicRows('SELECT id FROM dpg_app.products')).rejects.toThrow('Query read timeout')
    expect(mocks.end).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({event:'PUBLIC_DATABASE_READ_FAILURE',failureKind:'QUERY_TIMEOUT'})
    log.mockRestore()
  })

  it('logs bounded query labels and concurrent read-client counts only in the diagnostic Worker', async () => {
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql')
    vi.stubEnv('PUBLIC_DB_DIAGNOSTICS', 'true')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await readPublicRows('SELECT id FROM dpg_app.products WHERE sku = $1', ['private-sku'])

    const record = JSON.parse(String(log.mock.calls[0][0]))
    expect(record).toMatchObject({
      event: 'PUBLIC_DATABASE_READ_OK', queryTables: ['products'],
      queryLabel: 'other', activePgClients: 1,
    })
    expect(JSON.stringify(record)).not.toContain('private-sku')
    expect(JSON.stringify(record)).not.toContain('postgresql://readonly.invalid')
    log.mockRestore()
  })

  it('retains only a static allowlisted label for a timed-out listing query', async () => {
    vi.stubEnv('PUBLIC_DB_DIAGNOSTICS', 'true')
    mocks.query.mockRejectedValueOnce(new Error('Query read timeout'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(readPublicRows('SELECT id FROM dpg_app.products', [], 'listing-page')).rejects.toThrow('Query read timeout')
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      event: 'PUBLIC_DATABASE_READ_FAILURE', queryTables: ['products'], queryLabel: 'listing-page',
      failureKind: 'QUERY_TIMEOUT',
    })
    log.mockRestore()
  })
})
