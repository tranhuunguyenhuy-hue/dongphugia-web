import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client/wasm'
import { Pool } from 'pg'
import { requireWritesAllowed } from '../../src/lib/write-freeze'
import { withRequestPrismaContext, type ProtectedPrismaClient } from '../../src/lib/prisma'
import { withAdminRuntimeEnvironment, type AdminRuntimeEnvironment } from '../../src/lib/admin-runtime-environment'

interface AdminWorkerEnvironment {
  APP_ENV: 'preview'
  APP_ORIGIN: string
  PREVIEW_NOINDEX?: 'true' | 'false'
  HYPERDRIVE_ADMIN_NO_CACHE: { connectionString: string }
  RUNTIME_ROLE: 'staging'
  WRITE_FREEZE_MODE: 'false'
  ALLOW_ISOLATED_TEST_WRITES: 'true'
  ADMIN_TEST_DB_ROLE: 'dpg_admin_m3_test'
  PREVIEW_MEDIA_TARGET_ISOLATED?: 'true' | 'false'
  BUNNY_STORAGE_ZONE_NAME?: string
  BUNNY_STORAGE_API_KEY?: string
  BUNNY_STORAGE_HOSTNAME?: string
  BUNNY_CDN_HOSTNAME?: string
  REVALIDATE_SECRET?: string
  IMAGES?: unknown
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

type ProtectedPrisma = ProtectedPrismaClient
type FetchHandler = typeof import('vinext/server/fetch-handler').default

const WRITE_OPERATIONS = new Set([
  'create', 'createMany', 'createManyAndReturn', 'delete', 'deleteMany',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert',
])
const RAW_WRITE_OPERATIONS = new Set([
  '$executeRaw', '$executeRawUnsafe', '$runCommandRaw',
  'executeRaw', 'executeRawUnsafe', 'runCommandRaw',
])
const FIXED_PREVIEW_ORIGIN = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'

let fetchHandler: Promise<FetchHandler> | undefined
let verifiedTestDatabaseRole: string | undefined
let testDatabaseVerification: Promise<void> | undefined

async function assertIsolatedTestDatabase(pool: Pool, environment: AdminWorkerEnvironment) {
  if (environment.APP_ENV !== 'preview'
    || environment.APP_ORIGIN !== FIXED_PREVIEW_ORIGIN
    || environment.PREVIEW_NOINDEX !== 'true'
    || environment.RUNTIME_ROLE !== 'staging'
    || environment.WRITE_FREEZE_MODE !== 'false'
    || environment.ALLOW_ISOLATED_TEST_WRITES !== 'true'
    || environment.ADMIN_TEST_DB_ROLE !== 'dpg_admin_m3_test') {
    throw new Error('ADMIN_TEST_DATABASE_CONFIGURATION_REQUIRED')
  }
  if (verifiedTestDatabaseRole === environment.ADMIN_TEST_DB_ROLE) return

  testDatabaseVerification ??= pool.query(
    'select current_user::text as current_user',
  ).then(({ rows }) => {
    if (rows[0]?.current_user !== environment.ADMIN_TEST_DB_ROLE) {
      throw new Error('ADMIN_TEST_DATABASE_IDENTITY_MISMATCH')
    }
    verifiedTestDatabaseRole = environment.ADMIN_TEST_DB_ROLE
  }).catch((error) => {
    testDatabaseVerification = undefined
    throw error
  })

  await testDatabaseVerification
}

function createRequestPrisma(connectionString: string): {
  client: ProtectedPrisma
  pool: Pool
  close(): Promise<void>
} {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 7_000,
  })
  const client = new PrismaClient({ adapter: new PrismaPg(pool) })
  const guarded = client.$extends({
    query: {
      async $allOperations({ model, operation, query, args }) {
        if (
          (model && WRITE_OPERATIONS.has(operation))
          || RAW_WRITE_OPERATIONS.has(operation)
        ) {
          requireWritesAllowed(`prisma.${operation}`)
        }
        return query(args)
      },
    },
  })

  let closePromise: Promise<void> | undefined
  return {
    client: guarded as ProtectedPrisma,
    pool,
    close() {
      closePromise ??= (async () => {
        await guarded.$disconnect()
        await pool.end()
      })()
      return closePromise
    },
  }
}

async function keepPrismaForResponse(
  response: Response,
  client: ProtectedPrisma,
  close: () => Promise<void>,
  context: ExecutionContextLike,
  runtimeEnvironment: AdminRuntimeEnvironment,
): Promise<Response> {
  let closePromise: Promise<void> | undefined
  const closeOnce = () => closePromise ??= close()
  const scheduleClose = () => context.waitUntil(closeOnce())

  if (!response.body) {
    await closeOnce()
    return response
  }

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await withRequestPrismaContext(client, () =>
          withAdminRuntimeEnvironment(runtimeEnvironment, () => reader.read()),
        )
        if (result.done) {
          controller.close()
          scheduleClose()
        } else {
          controller.enqueue(result.value)
        }
      } catch (error) {
        controller.error(error)
        scheduleClose()
      }
    },
    async cancel(reason) {
      try {
        await withRequestPrismaContext(client, () =>
          withAdminRuntimeEnvironment(runtimeEnvironment, () => reader.cancel(reason)),
        )
      } finally {
        scheduleClose()
      }
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function isAdminRequestPath(pathname: string): boolean {
  return pathname === '/admin'
    || pathname.startsWith('/admin/')
    || pathname === '/api/admin/revalidate'
    || pathname === '/api/upload-image'
}

function isFrameworkAssetPath(pathname: string, allowViteDevelopmentPaths: boolean): boolean {
  if (pathname.startsWith('/_next/') || pathname.startsWith('/_vinext/') || pathname === '/favicon.ico') return true
  return allowViteDevelopmentPaths && (
    pathname.startsWith('/@vite/')
    || pathname.startsWith('/@id/')
    || pathname.startsWith('/@fs/')
    || pathname.startsWith('/src/')
    || pathname.startsWith('/node_modules/')
  )
}

export default {
  async fetch(request: Request, environment: AdminWorkerEnvironment, context: ExecutionContextLike) {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/upload-image' && request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })
    }
    const allowViteDevelopmentPaths = false
    if (!isAdminRequestPath(pathname) && !isFrameworkAssetPath(pathname, allowViteDevelopmentPaths)) {
      return new Response('Not found', { status: 404 })
    }
    if (!environment.HYPERDRIVE_ADMIN_NO_CACHE?.connectionString) {
      return new Response('Admin database unavailable', { status: 503 })
    }

    Reflect.set(process.env, 'NODE_ENV', 'production')
    process.env.APP_BUILD_TARGET = 'admin'
    process.env.APP_ENV = environment.APP_ENV
    process.env.APP_ORIGIN = environment.APP_ORIGIN
    process.env.RUNTIME_ROLE = environment.RUNTIME_ROLE
    process.env.WRITE_FREEZE_MODE = environment.WRITE_FREEZE_MODE
    process.env.ALLOW_ISOLATED_TEST_WRITES = environment.ALLOW_ISOLATED_TEST_WRITES
    process.env.ADMIN_TEST_DB_ROLE = environment.ADMIN_TEST_DB_ROLE
    process.env.PRISMA_REQUEST_SCOPE_REQUIRED = 'true'

    fetchHandler ??= import('vinext/server/fetch-handler').then(module => module.default)
    const requestPrisma = createRequestPrisma(environment.HYPERDRIVE_ADMIN_NO_CACHE.connectionString)
    const runtimeEnvironment: AdminRuntimeEnvironment = {
      APP_ENV: environment.APP_ENV,
      APP_ORIGIN: environment.APP_ORIGIN,
      PREVIEW_MEDIA_TARGET_ISOLATED: environment.PREVIEW_MEDIA_TARGET_ISOLATED,
      BUNNY_STORAGE_ZONE_NAME: environment.BUNNY_STORAGE_ZONE_NAME,
      BUNNY_STORAGE_API_KEY: environment.BUNNY_STORAGE_API_KEY,
      BUNNY_STORAGE_HOSTNAME: environment.BUNNY_STORAGE_HOSTNAME,
      BUNNY_CDN_HOSTNAME: environment.BUNNY_CDN_HOSTNAME,
      REVALIDATE_SECRET: environment.REVALIDATE_SECRET,
      IMAGES: environment.IMAGES,
    }

    try {
      try {
        await assertIsolatedTestDatabase(requestPrisma.pool, environment)
      } catch {
        await requestPrisma.close()
        return new Response('Admin TEST database identity is unavailable.', { status: 503 })
      }
      const response = await withRequestPrismaContext(requestPrisma.client, () =>
        withAdminRuntimeEnvironment(runtimeEnvironment, () =>
          fetchHandler!.then(handler => handler.fetch(request, environment, context as never)),
        ),
      )
      return keepPrismaForResponse(response, requestPrisma.client, requestPrisma.close, context, runtimeEnvironment)
    } catch (error) {
      await requestPrisma.close()
      throw error
    }
  },
}
