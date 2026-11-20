import { describe, expect, it } from 'vitest'
import {
  assertPreviewSourceAttestation,
  assertPreviewSourceDatabaseIdentity,
  PREVIEW_SOURCE_PROJECT_REF,
} from './preview-source-attestation.mts'

const validAttestation = {
  currentUser: 'dpg_readonly',
  transactionReadOnly: 'on',
  targetContract: {
    project_name: 'dongphugia-runtime',
    region: 'ap-southeast-1',
    environment: 'preview',
    data_class: 'production-derived-reduced-runtime',
    production_data_allowed: true,
    production_credentials_allowed: false,
    production_writes_allowed: false,
  },
  freeTierGuard: {
    status: 'WITHIN_BUDGET',
    database_bytes: 102.95 * 1024 * 1024,
    hard_stop_350_mib_bytes: 367_001_600,
  },
  missingSelectTables: [],
}

describe('Preview source attestation', () => {
  const directIdentity = assertPreviewSourceDatabaseIdentity(
    'postgresql://dpg_readonly:synthetic@db.bonxyxluzlxfkdetryoo.supabase.co:5432/postgres',
  )

  it('binds the configured read-only source to the immutable Production project ref', () => {
    expect(directIdentity).toEqual({ project: 'dongphugia-production', projectRef: PREVIEW_SOURCE_PROJECT_REF })
    expect(assertPreviewSourceDatabaseIdentity(
      'postgresql://dpg_readonly.bonxyxluzlxfkdetryoo:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
    )).toEqual(directIdentity)
  })

  it('rejects the former/unrelated project endpoint and connection-string host overrides', () => {
    expect(() => assertPreviewSourceDatabaseIdentity(
      'postgresql://dpg_readonly:synthetic@db.uybumsnyqpwcidjxmfsv.supabase.co:5432/postgres',
    )).toThrow('project ref mismatch')
    expect(() => assertPreviewSourceDatabaseIdentity(
      'postgresql://dpg_readonly:synthetic@db.bonxyxluzlxfkdetryoo.supabase.co:5432/postgres?host=other.supabase.co',
    )).toThrow('connection override is not allowed')
  })

  it('accepts the exact isolated Preview target contract', () => {
    expect(assertPreviewSourceAttestation(validAttestation, directIdentity)).toMatchObject({
      project: 'dongphugia-production',
      projectRef: 'bonxyxluzlxfkdetryoo',
      region: 'ap-southeast-1',
      environment: 'preview',
      effectiveRole: 'dpg_readonly',
      transactionReadOnly: true,
      productionWritesAllowed: false,
    })
  })

  it('fails closed when any required table lacks SELECT access', () => {
    expect(() => assertPreviewSourceAttestation({
      ...validAttestation,
      missingSelectTables: ['product_families'],
    }, directIdentity)).toThrow('missing SELECT grants: product_families')
  })
})
