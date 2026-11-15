import { describe, expect, it } from 'vitest'
import { validatePublicRollbackCandidate } from './verify-public-rollback-candidate.mjs'

const hyperdriveId = '905f5791e9d84cf285f7533b92d03f49'
const activeVersionId = 'f64775c3-d869-4a67-905f-f48f5f8f058f'
const sourceSha = '5d3588c1948e2bca5786b13e04c1ded6322e15fd'
const deploymentsDocument = { deployments: [{
  id: '0f85c1fd-2ff4-448d-aa86-493760d0ba8a',
  created_on: '2026-11-14T15:00:40.955238Z',
  versions: [{ version_id: activeVersionId, percentage: 100 }],
}] }
const headers = `HTTP/2 200\nx-dpg-source-sha: ${sourceSha}\n`
const commonBindings = [
  { name: 'APP_ENV', type: 'plain_text', text: 'production' },
  { name: 'APP_ORIGIN', type: 'plain_text', text: 'https://www.dongphugia.vn' },
]

describe('Public Production rollback candidate', () => {
  it('accepts the active PostgreSQL Worker as rollback target when Production is PostgreSQL', () => {
    const result = validatePublicRollbackCandidate({
      deploymentsDocument,
      versionDocument: { version: { id: activeVersionId, resources: { bindings: [
        ...commonBindings,
        { name: 'PUBLIC_CATALOGUE_SOURCE', type: 'plain_text', text: 'postgresql' },
        { name: 'PUBLIC_DB', type: 'hyperdrive', id: hyperdriveId },
      ] } } },
      healthHeaders: headers,
      health: { status: 'ok', catalogueMode: 'postgresql', publicProducts: 5964, listingProducts: 5362, publishedBlogs: 10 },
      hyperdriveId,
    })

    expect(result).toEqual({ mode: 'postgresql', versionId: activeVersionId, sourceSha, checkpoint: '' })
  })

  it('keeps the verified snapshot fallback valid when the active deployment is snapshot mode', () => {
    const checkpoint = '6'.repeat(40)
    const result = validatePublicRollbackCandidate({
      deploymentsDocument,
      versionDocument: { version: { id: activeVersionId, resources: { bindings: [
        ...commonBindings,
        { name: 'PUBLIC_CATALOGUE_SOURCE', type: 'plain_text', text: 'snapshot' },
      ] } } },
      healthHeaders: headers,
      health: { status: 'ok', catalogueMode: 'verified-snapshot', publicProducts: 5223, listingProducts: 4853, catalogueCheckpoint: checkpoint },
      hyperdriveId,
    })

    expect(result).toEqual({ mode: 'verified-snapshot', versionId: activeVersionId, sourceSha, checkpoint })
  })

  it('rejects a PostgreSQL rollback target with a different Hyperdrive binding', () => {
    expect(() => validatePublicRollbackCandidate({
      deploymentsDocument,
      versionDocument: { version: { id: activeVersionId, resources: { bindings: [
        ...commonBindings,
        { name: 'PUBLIC_CATALOGUE_SOURCE', type: 'plain_text', text: 'postgresql' },
        { name: 'PUBLIC_DB', type: 'hyperdrive', id: 'a'.repeat(32) },
      ] } } },
      healthHeaders: headers,
      health: { status: 'ok', catalogueMode: 'postgresql', publicProducts: 5964, listingProducts: 5362, publishedBlogs: 10 },
      hyperdriveId,
    })).toThrow('ROLLBACK_CANDIDATE_POSTGRES_BINDING_INVALID')
  })

  it('rejects unhealthy or inconsistent PostgreSQL rollback data', () => {
    expect(() => validatePublicRollbackCandidate({
      deploymentsDocument,
      versionDocument: { version: { id: activeVersionId, resources: { bindings: [
        ...commonBindings,
        { name: 'PUBLIC_CATALOGUE_SOURCE', type: 'plain_text', text: 'postgresql' },
        { name: 'PUBLIC_DB', type: 'hyperdrive', id: hyperdriveId },
      ] } } },
      healthHeaders: headers,
      health: { status: 'ok', catalogueMode: 'postgresql', publicProducts: 5964, listingProducts: 5361, publishedBlogs: 10 },
      hyperdriveId,
    })).toThrow('ROLLBACK_CANDIDATE_POSTGRES_HEALTH_INVALID')
  })
})
