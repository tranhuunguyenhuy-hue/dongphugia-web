// Supabase Edge Function `admin-api` (M3 G4 pilot). verify_jwt=false: authentication is the Worker-signed HMAC
// envelope (see envelope.mjs) plus a DB-backed admin session; the function never uses the service-role key.
//
// Database identity: every request runs in ONE transaction that first executes `SET LOCAL ROLE dpg_admin_api_test`
// (column-level grants + RLS, see supabase/m3-test/004). If ADMIN_API_DB_URL is provided (a login as that role
// itself) the SET ROLE step is skipped. SUPABASE_DB_URL is injected by the platform; it is only used to connect.
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import { handleRequest, type Db } from './handlers.ts'

const dedicatedUrl = Deno.env.get('ADMIN_API_DB_URL')
const databaseUrl = dedicatedUrl ?? Deno.env.get('SUPABASE_DB_URL')
const API_ROLE = 'dpg_admin_api_test'
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 5 }) : undefined

// deno-lint-ignore no-explicit-any
function wrap(client: any, depth = 0): Db {
  return {
    query: (text, params = []) => client.unsafe(text, params as never[]),
    // Nested units use savepoints so a failed edit rolls back without aborting the request transaction.
    // deno-lint-ignore no-explicit-any
    transaction: (fn) => client.savepoint((tx: any) => fn(wrap(tx, depth + 1))),
  }
}

Deno.serve((request) => {
  if (!sql) return new Response(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } }), { status: 503, headers: { 'content-type': 'application/json' } })
  const deps = {
    hmacSecret: Deno.env.get('ADMIN_API_HMAC_SECRET') ?? '',
    allowedOrigin: Deno.env.get('ADMIN_API_ALLOWED_ORIGIN') ?? '',
    allowedMediaHosts: Deno.env.get('ADMIN_API_MEDIA_HOSTS') ?? '',
    verifyPassword: (plain: string, hash: string) => bcrypt.compare(plain, hash),
  }
  // handleRequest never throws for application errors (it returns the Response), so the request transaction commits
  // what handlers deliberately persisted (nonce, login attempts) and rolls back only on infrastructure failure.
  // deno-lint-ignore no-explicit-any
  return sql.begin(async (tx: any) => {
    if (!dedicatedUrl) await tx.unsafe(`set local role ${API_ROLE}`)
    return handleRequest(request, { ...deps, db: wrap(tx) })
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'ADMIN_API_DB_FAILURE', name: error instanceof Error ? error.name : 'unknown', sqlstate: (error as { code?: unknown })?.code ?? null }))
    return new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  })
})
