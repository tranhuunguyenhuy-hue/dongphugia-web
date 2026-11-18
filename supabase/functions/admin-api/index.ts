// Supabase Edge Function `admin-api` (M3 G4 pilot). verify_jwt=false: authentication is the Worker-signed HMAC
// envelope (see envelope.mjs) plus a DB-backed admin session; the function never uses the service-role key.
//
// Database identity: the connection is opened with the startup option `-c role=dpg_admin_api_test`, so EVERY statement
// runs as that role (column-level grants + RLS, see supabase/m3-test/004) with no per-request SET ROLE round trip.
// If ADMIN_API_DB_URL is provided (a login as that role itself) the option is omitted. SUPABASE_DB_URL is injected
// by the platform and is only used to connect; the role switch is enforced by the server for the whole session.
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import { BCRYPT_ROUNDS, handleRequest, type Db } from './handlers.ts'

const dedicatedUrl = Deno.env.get('ADMIN_API_DB_URL')
const databaseUrl = dedicatedUrl ?? Deno.env.get('SUPABASE_DB_URL')
const API_ROLE = 'dpg_admin_api_test'
const sql = databaseUrl
  ? postgres(databaseUrl, {
    // Two connections let concurrent requests in one isolate overlap instead of queueing behind a single socket.
    max: 2, prepare: false, idle_timeout: 20, connect_timeout: 5,
    connection: dedicatedUrl ? undefined : { options: `-c role=${API_ROLE}` },
  })
  : undefined

// deno-lint-ignore no-explicit-any
function wrap(client: any): Db {
  return {
    query: (text, params = []) => client.unsafe(text, params as never[]),
    // Edits run in a real transaction (audit row and update commit or roll back together).
    // deno-lint-ignore no-explicit-any
    transaction: (fn) => client.begin((tx: any) => fn(wrap(tx))),
  }
}

Deno.serve((request) => {
  if (!sql) return new Response(JSON.stringify({ error: { code: 'NOT_CONFIGURED' } }), { status: 503, headers: { 'content-type': 'application/json' } })
  return handleRequest(request, {
    db: wrap(sql),
    hmacSecret: Deno.env.get('ADMIN_API_HMAC_SECRET') ?? '',
    allowedOrigin: Deno.env.get('ADMIN_API_ALLOWED_ORIGIN') ?? '',
    allowedMediaHosts: Deno.env.get('ADMIN_API_MEDIA_HOSTS') ?? '',
    verifyPassword: (plain, hash) => bcrypt.compare(plain, hash),
    hashPassword: (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS),
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'ADMIN_API_FAILURE', name: error instanceof Error ? error.name : 'unknown', sqlstate: (error as { code?: unknown })?.code ?? null }))
    return new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  })
})
