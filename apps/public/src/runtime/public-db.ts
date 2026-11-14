// M1: read-only connection to V1 Supabase through a scoped Cloudflare Hyperdrive.
// Disabled by default; never insert connection strings or service keys in source.
export type PublicHyperdrive = { connectionString: string }
export function publicPostgresEnabled() {
  return process.env.PUBLIC_CATALOGUE_SOURCE === 'postgresql'
}
const DIAGNOSTIC_TABLES = new Set([
  'products', 'categories', 'subcategories', 'brands', 'product_images', 'product_descriptions',
  'product_spec_values', 'spec_definitions', 'spec_options', 'product_documents',
  'product_feature_values', 'product_features', 'blog_posts', 'blog_categories',
  'blog_post_categories', 'blog_post_tags', 'tags',
])
let activeReadClients = 0
let peakReadClients = 0
const MAX_CONCURRENT_PUBLIC_READS = 4
const MAX_QUEUED_PUBLIC_READS = 32
const readClientWaiters: Array<() => void> = []
let hyperdriveBinding: Promise<PublicHyperdrive> | undefined
let pgClientModule: Promise<typeof import('pg')> | undefined

async function acquireReadClientSlot() {
  if (activeReadClients >= MAX_CONCURRENT_PUBLIC_READS) {
    if (readClientWaiters.length >= MAX_QUEUED_PUBLIC_READS) {
      throw new Error('PUBLIC_DATABASE_READ_CAPACITY_EXCEEDED')
    }
    await new Promise<void>((resolve) => readClientWaiters.push(resolve))
  } else {
    activeReadClients += 1
    peakReadClients = Math.max(peakReadClients, activeReadClients)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const next = readClientWaiters.shift()
    if (next) next()
    else activeReadClients -= 1
  }
}

function publicQueryTables(statement: string) {
  const tables = [...statement.matchAll(/\b(?:FROM|JOIN)\s+dpg_app\.([a-z_]+)/gi)]
    .map(match => match[1])
    .filter((table): table is string => DIAGNOSTIC_TABLES.has(table))
  return [...new Set(tables)].sort()
}

function recordPublicReadDiagnostic(event: 'PUBLIC_DATABASE_READ_OK' | 'PUBLIC_DATABASE_READ_FAILURE', queryTables: string[], started: number, error?: unknown) {
  if (process.env.PUBLIC_DB_DIAGNOSTICS !== 'true') return
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  console.log(JSON.stringify({
    event,
    queryTables,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    activePgClients: activeReadClients,
    peakPgClients: peakReadClients,
    ...(event === 'PUBLIC_DATABASE_READ_FAILURE' && /^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {}),
  }))
}

function getHyperdrive() {
  hyperdriveBinding ??= import('cloudflare:workers').then(({ env }) => {
    const hyperdrive = (env as { PUBLIC_DB?: PublicHyperdrive }).PUBLIC_DB
    if (!hyperdrive?.connectionString) throw new Error('PUBLIC_DATABASE_BINDING_REQUIRED')
    return hyperdrive
  })
  return hyperdriveBinding
}
function getPgClientModule() {
  pgClientModule ??= import('pg')
  return pgClientModule
}
/** Fixed SELECT only; all dynamic parameters are bound, no Postgres writes allowed. */
export async function readPublicRows<T>(
  statement: string,
  values: readonly (string | number | boolean)[] = [],
): Promise<T[]> {
  if (!publicPostgresEnabled()) throw new Error('PUBLIC_DATABASE_MODE_DISABLED')
  if (!/^\s*SELECT\b/i.test(statement) || statement.includes(';')
    || /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE|TRUNCATE|COPY|CALL)\b/i.test(statement)) {
    throw new Error('PUBLIC_DATABASE_READ_ONLY_REQUIRED')
  }
  const started = performance.now()
  const queryTables = publicQueryTables(statement)
  let releaseReadSlot: (() => void) | null = null
  let closeClient: (() => Promise<unknown>) | null = null
  try {
    releaseReadSlot = await acquireReadClientSlot()
    const { connectionString } = await getHyperdrive()
    const { Client } = await getPgClientModule()
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    })
    closeClient = () => client.end()
    await client.connect()
    const response = await client.query(statement, [...values])
    recordPublicReadDiagnostic('PUBLIC_DATABASE_READ_OK', queryTables, started)
    return response.rows as T[]
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    recordPublicReadDiagnostic('PUBLIC_DATABASE_READ_FAILURE', queryTables, started, error)
    throw error
  } finally {
    if (closeClient) await closeClient().catch(() => undefined)
    releaseReadSlot?.()
  }
}
