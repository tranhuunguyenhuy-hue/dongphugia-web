import { acquirePublicReadSlot, publicReadScope, withPublicReadScope } from './public-read-scope'
// M1: read-only connection to V1 Supabase through a scoped Cloudflare Hyperdrive.
// Disabled by default; never insert connection strings or service keys in source.
export type PublicHyperdrive = { connectionString: string }
export type PublicQueryValue = string | number | boolean | readonly string[]
export function publicPostgresEnabled() {
  return process.env.PUBLIC_CATALOGUE_SOURCE === 'postgresql'
}
const DIAGNOSTIC_TABLES = new Set([
  'products', 'categories', 'subcategories', 'brands', 'product_images', 'product_descriptions',
  'product_spec_values', 'spec_definitions', 'spec_options', 'product_documents',
  'product_feature_values', 'product_features', 'blog_posts', 'blog_categories',
  'blog_post_categories', 'blog_post_tags', 'tags',
])
function publicQueryTables(statement: string) {
  const tables = [...statement.matchAll(/\b(?:FROM|JOIN)\s+dpg_app\.([a-z_]+)/gi)]
    .map(match => match[1])
    .filter((table): table is string => DIAGNOSTIC_TABLES.has(table))
  return [...new Set(tables)].sort()
}

function recordPublicReadDiagnostic(event: 'PUBLIC_DATABASE_READ_OK' | 'PUBLIC_DATABASE_READ_FAILURE', queryTables: string[], started: number, error?: unknown) {
  if (process.env.PUBLIC_DB_DIAGNOSTICS !== 'true') return
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  const failureKind = message === 'Query read timeout' ? 'QUERY_TIMEOUT'
    : message === 'PUBLIC_DATABASE_READ_QUEUE_TIMEOUT' ? 'QUEUE_TIMEOUT'
    : message === 'PUBLIC_DATABASE_REQUEST_ABORTED' ? 'ABORTED'
    : /timeout expired|Connection terminated due to connection timeout/.test(message) ? 'CONNECT_TIMEOUT' : 'OTHER'
  console.log(JSON.stringify({
    event,
    queryTables,
    ...(event === 'PUBLIC_DATABASE_READ_FAILURE' ? { failureKind } : {}),
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    activePgClients: publicReadScope()?.active ?? 0,
    peakPgClients: publicReadScope()?.peak ?? 0,
    ...(event === 'PUBLIC_DATABASE_READ_FAILURE' && /^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {}),
  }))
}

// Cache resolved module/binding values only, never an in-flight request Promise.
let hyperdriveBinding: PublicHyperdrive | undefined
let pgClientModule: typeof import('pg') | undefined
async function getHyperdrive() {
  if (hyperdriveBinding) return hyperdriveBinding
  const { env } = await import('cloudflare:workers')
  const hyperdrive = (env as { PUBLIC_DB?: PublicHyperdrive }).PUBLIC_DB
  if (!hyperdrive?.connectionString) throw new Error('PUBLIC_DATABASE_BINDING_REQUIRED')
  return (hyperdriveBinding = hyperdrive)
}
/** Fixed SELECT only; all dynamic parameters are bound, no Postgres writes allowed. */
export async function readPublicRows<T>(
  statement: string,
  values: readonly PublicQueryValue[] = [],
): Promise<T[]> {
  if (!publicPostgresEnabled()) throw new Error('PUBLIC_DATABASE_MODE_DISABLED')
  if (!/^\s*SELECT\b/i.test(statement) || statement.includes(';')
    || /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE|TRUNCATE|COPY|CALL)\b/i.test(statement)) {
    throw new Error('PUBLIC_DATABASE_READ_ONLY_REQUIRED')
  }
  // Local Next.js callers also get an independent scope; Worker rendering
  // establishes one shared scope for all reads belonging to that invocation.
  if (!publicReadScope()) return withPublicReadScope(undefined, () => readPublicRows<T>(statement, values))
  const started = performance.now()
  const queryTables = publicQueryTables(statement)
  let releaseReadSlot: (() => void) | null = null
  let closeClient: (() => Promise<unknown>) | null = null
  let removeAbortListener = () => {}
  try {
    releaseReadSlot = await acquirePublicReadSlot()
    const { connectionString } = await getHyperdrive()
    const { Client } = pgClientModule ?? (pgClientModule = await import('pg'))
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    })
    // pg.end() destroys an in-flight query's socket. Reuse its Promise when
    // cancellation races finally; never close a client from another request.
    let closing: Promise<void> | undefined
    closeClient = () => (closing ??= client.end())
    const signal = publicReadScope()?.signal
    const abort = () => { void closeClient?.().catch(() => undefined) }
    signal?.addEventListener('abort', abort, { once: true })
    removeAbortListener = () => signal?.removeEventListener('abort', abort)
    if (signal?.aborted) throw new Error('PUBLIC_DATABASE_REQUEST_ABORTED')
    await client.connect()
    const response = await client.query(statement, [...values])
    recordPublicReadDiagnostic('PUBLIC_DATABASE_READ_OK', queryTables, started)
    return response.rows as T[]
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    recordPublicReadDiagnostic('PUBLIC_DATABASE_READ_FAILURE', queryTables, started, error)
    throw error
  } finally {
    removeAbortListener()
    if (closeClient) await closeClient().catch(() => undefined)
    releaseReadSlot?.()
  }
}
