import { Client } from 'pg'

export const PREVIEW_SOURCE_PROJECT = 'dongphugia-production'
export const PREVIEW_SOURCE_PROJECT_REF = 'bonxyxluzlxfkdetryoo'
export const PREVIEW_SOURCE_CONTRACT_NAME = 'dongphugia-runtime'
export const PREVIEW_SOURCE_REGION = 'ap-southeast-1'
export const PREVIEW_SOURCE_ROLE = 'dpg_readonly'

export const PREVIEW_SOURCE_TABLES = [
  'products', 'categories', 'subcategories', 'brands',
  'product_taxon_assignments', 'catalog_taxons', 'blog_posts', 'blog_categories',
  'product_families', 'product_family_memberships',
  'product_family_configuration_groups', 'product_family_catalogue_gaps', 'redirects',
] as const

type TargetContract = {
  project_name: string
  region: string
  environment: string
  data_class: string
  production_data_allowed: boolean
  production_credentials_allowed: boolean
  production_writes_allowed: boolean
}

type FreeTierGuard = {
  status: string
  database_bytes: number
  hard_stop_350_mib_bytes: number
}

type PreviewSourceIdentity = {
  project: typeof PREVIEW_SOURCE_PROJECT
  projectRef: typeof PREVIEW_SOURCE_PROJECT_REF
}

export type PreviewSourceAttestation = {
  currentUser: string
  transactionReadOnly: string
  targetContract: TargetContract
  freeTierGuard: FreeTierGuard
  missingSelectTables: string[]
}

export function assertPreviewSourceDatabaseIdentity(connectionString: string): PreviewSourceIdentity {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('PREVIEW_SOURCE_DATABASE_IDENTITY_FAILED:invalid connection URL')
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('PREVIEW_SOURCE_DATABASE_IDENTITY_FAILED:unsupported protocol')
  }
  if (url.port && url.port !== '5432') {
    throw new Error('PREVIEW_SOURCE_DATABASE_IDENTITY_FAILED:unexpected port')
  }
  if (url.pathname !== '/postgres') {
    throw new Error('PREVIEW_SOURCE_DATABASE_IDENTITY_FAILED:unexpected database')
  }

  const blockedParameters = ['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'password', 'options', 'service', 'servicefile']
  if (blockedParameters.some((parameter) => url.searchParams.has(parameter))) {
    throw new Error('PREVIEW_SOURCE_DATABASE_IDENTITY_FAILED:connection override is not allowed')
  }

  const directHost = `db.${PREVIEW_SOURCE_PROJECT_REF}.supabase.co`
  const poolerHost = 'aws-0-ap-southeast-1.pooler.supabase.com'
  const direct = url.hostname === directHost
  const pooler = url.hostname === poolerHost
    && decodeURIComponent(url.username).endsWith(`.${PREVIEW_SOURCE_PROJECT_REF}`)
  if (!direct && !pooler) {
    throw new Error('PREVIEW_SOURCE_DATABASE_IDENTITY_FAILED:project ref mismatch')
  }

  return { project: PREVIEW_SOURCE_PROJECT, projectRef: PREVIEW_SOURCE_PROJECT_REF }
}

export function assertPreviewSourceAttestation(
  attestation: PreviewSourceAttestation,
  sourceIdentity: PreviewSourceIdentity,
) {
  const failures: string[] = []
  const target = attestation.targetContract
  const guard = attestation.freeTierGuard
  if (attestation.currentUser !== PREVIEW_SOURCE_ROLE) failures.push('effective role is not dpg_readonly')
  if (attestation.transactionReadOnly !== 'on') failures.push('transaction is not read-only')
  if (sourceIdentity.project !== PREVIEW_SOURCE_PROJECT || sourceIdentity.projectRef !== PREVIEW_SOURCE_PROJECT_REF) {
    failures.push('Supabase project ref mismatch')
  }
  if (target.project_name !== PREVIEW_SOURCE_CONTRACT_NAME) failures.push('internal target contract mismatch')
  if (target.region !== PREVIEW_SOURCE_REGION) failures.push('region identity mismatch')
  if (target.environment !== 'preview') failures.push('environment is not preview')
  if (target.data_class !== 'production-derived-reduced-runtime') failures.push('data class mismatch')
  if (target.production_data_allowed !== true) failures.push('approved reduced dataset is not enabled')
  if (target.production_credentials_allowed !== false) failures.push('Production credentials are allowed')
  if (target.production_writes_allowed !== false) failures.push('Production writes are allowed')
  if (guard.status !== 'WITHIN_BUDGET') failures.push(`free-tier status is ${guard.status}`)
  if (guard.database_bytes > guard.hard_stop_350_mib_bytes) failures.push('free-tier hard stop exceeded')
  if (attestation.missingSelectTables.length > 0) failures.push(`missing SELECT grants: ${attestation.missingSelectTables.join(', ')}`)
  if (failures.length > 0) throw new Error(`PREVIEW_SOURCE_ATTESTATION_FAILED: ${failures.join('; ')}`)
  return {
    project: PREVIEW_SOURCE_PROJECT,
    projectRef: PREVIEW_SOURCE_PROJECT_REF,
    region: PREVIEW_SOURCE_REGION,
    environment: 'preview',
    dataClass: target.data_class,
    productionDataAllowed: true,
    effectiveRole: PREVIEW_SOURCE_ROLE,
    transactionReadOnly: true,
    productionWritesAllowed: false,
    databaseBytes: guard.database_bytes,
    freeTierStatus: guard.status,
  }
}

async function attest() {
  if (process.env.PUBLIC_STATIC_BUILD_READ_ONLY !== 'true') throw new Error('PREVIEW_SOURCE_READ_ONLY_GUARD_FAILED')
  if (!process.env.DATABASE_URL) throw new Error('PREVIEW_SOURCE_DATABASE_URL_MISSING')

  const sourceIdentity = assertPreviewSourceDatabaseIdentity(process.env.DATABASE_URL)
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  let transactionStarted = false
  try {
    await client.connect()
    await client.query(`SET ROLE ${PREVIEW_SOURCE_ROLE}`)
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionStarted = true
    const result = await client.query<{
      current_user: string
      transaction_read_only: string
      target_contract: TargetContract
      free_tier_guard: FreeTierGuard
      required_table_privileges: Record<string, boolean>
    }>(`select current_user,
      current_setting('transaction_read_only') as transaction_read_only,
      (select row_to_json(target) from dpg_control.target_contract target limit 1) as target_contract,
      (select row_to_json(guard) from dpg_control.free_tier_database_guard guard limit 1) as free_tier_guard,
      (select coalesce(json_object_agg(required.table_name,
        has_table_privilege(current_user, format('dpg_app.%I', required.table_name), 'SELECT')), '{}'::json)
        from unnest($1::text[]) as required(table_name)) as required_table_privileges`, [PREVIEW_SOURCE_TABLES])
    await client.query('ROLLBACK')
    transactionStarted = false

    const row = result.rows[0]
    const missingSelectTables = PREVIEW_SOURCE_TABLES.filter((table) => row.required_table_privileges[table] !== true)
    const evidence = assertPreviewSourceAttestation({
      currentUser: row.current_user,
      transactionReadOnly: row.transaction_read_only,
      targetContract: row.target_contract,
      freeTierGuard: row.free_tier_guard,
      missingSelectTables,
    }, sourceIdentity)
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
    const message = error instanceof Error && error.message.startsWith('PREVIEW_SOURCE_')
      ? error.message
      : `PREVIEW_SOURCE_ATTESTATION_FAILED:${getDatabaseErrorCode(error)}`
    throw new Error(message)
  } finally {
    await client.end().catch(() => undefined)
  }
}

function getDatabaseErrorCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'UNKNOWN'
}

if (import.meta.url === `file://${process.argv[1]}`) await attest()
