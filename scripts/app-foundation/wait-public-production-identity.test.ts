import { describe, expect, it } from 'vitest'
import { waitPublicProductionIdentity } from './wait-public-production-identity.mjs'

const sha = 'a'.repeat(40)
const response = (source = sha, mode = 'postgresql', status = 200) => new Response(JSON.stringify({ catalogueMode: mode }), {
  status, headers: { 'x-dpg-source-sha': source },
})

describe('bounded Production identity propagation', () => {
  it('waits five seconds between identity mismatches and returns on exact source/mode', async () => {
    let clock = 0
    const records: unknown[] = []
    const replies = [response('b'.repeat(40)), response(sha, 'snapshot'), response()]
    await waitPublicProductionIdentity(sha, { fetchImpl: async () => replies.shift()!, now: () => clock,
      pause: async ms => { expect(ms).toBe(5000); clock += ms }, record: value => records.push(value) })
    expect(clock).toBe(10000)
    expect(records).toHaveLength(3)
  })
  it('stops at 120 seconds rather than accepting the previous source', async () => {
    let clock = 0
    await expect(waitPublicProductionIdentity(sha, { fetchImpl: async () => response('b'.repeat(40)),
      now: () => clock, pause: async ms => { clock += ms }, record: () => {} })).rejects.toThrow('PROPAGATION_TIMEOUT')
    expect(clock).toBe(120000)
  })
  it('never retries an HTTP or transport failure', async () => {
    for (const fetchImpl of [async () => response(sha, 'postgresql', 500), async () => { throw new Error('transport failure') }]) {
      let pauses = 0
      await expect(waitPublicProductionIdentity(sha, { fetchImpl, pause: async () => { pauses++ }, record: () => {} })).rejects.toThrow()
      expect(pauses).toBe(0)
    }
  })
})
