// Shared primitives for the admin-api Edge Function (no I/O of its own).
import { can, type AdminRole, type Permission } from './permissions.ts'

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>
}
export type Session = { sessionId: number; userId: number; email: string; name: string; role: AdminRole }
export type Context = { request_id: string; ip: string; session?: Session }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly fields?: string[]) { super(code) }
}

/** PostgreSQL SQLSTATE -> API error. Messages from the database never reach the client. */
export function mapDatabaseError(error: unknown): ApiError | undefined {
  const code = (error as { code?: unknown })?.code
  if (code === '23505') return new ApiError(409, 'DUPLICATE')
  if (code === '23503') return new ApiError(409, 'REFERENCE_CONFLICT')
  if (code === '23514' || code === '23502' || code === '22001' || code === '22P02' || code === '22003' || code === '22007') return new ApiError(400, 'VALIDATION_FAILED')
  return undefined
}

/** Vietnamese-aware slug, identical to src/lib/utils.ts `slugify` (kept in sync by a test). */
export function slugify(input: string): string {
  if (!input) return ''
  return String(input)
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

export function requirePermission(ctx: Context, permission: Permission): Session {
  if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
  if (!can(ctx.session.role, permission)) throw new ApiError(403, 'FORBIDDEN')
  return ctx.session
}
