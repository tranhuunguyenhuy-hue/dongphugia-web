// Supabase Edge Function `admin-api` (M3 G4 pilot). verify_jwt=false: authentication is the Worker-signed HMAC
// envelope (see envelope.mjs) plus a DB-backed admin session; the function holds NO service-role key.
import postgres from 'postgres'
import bcrypt from 'bcryptjs'
import { handleRequest, type Db } from './handlers.ts'

const databaseUrl = Deno.env.get('ADMIN_API_DB_URL')
const sql = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 5 }) : undefined

function wrap(client: any): Db {
  return {
    query: (text, params = []) => client.unsafe(text, params as never[]),
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
  })
})
