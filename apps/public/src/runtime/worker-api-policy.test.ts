import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    vinextFetch: vi.fn(async () => Response.json({ ok: true })),
    servePrerendered: vi.fn(async () => null),
}))

vi.mock('vinext/server/fetch-handler', () => ({ default: { fetch: mocks.vinextFetch } }))
vi.mock('./prerendered-catalogue', () => ({ servePrerenderedCatalogue: mocks.servePrerendered }))

let worker: typeof import('../../worker')['default']
const environment = {
    APP_ENV: 'preview',
    APP_BUILD_TARGET: 'public',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    PREVIEW_NOINDEX: 'true',
}

beforeAll(async () => {
    vi.stubGlobal('__DPG_BUILD_SOURCE_SHA__', 'a'.repeat(40))
    vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', '')
    worker = (await import('../../worker')).default
})

beforeEach(() => mocks.vinextFetch.mockClear())

describe('public Worker API route ownership', () => {
    it('serves the campaign landing from static assets before the Vinext fallback', async () => {
        const assetFetch = vi.fn(async (request: Request) => {
            expect(new URL(request.url).pathname).toBe('/uudaicuoinam2026/')
            return new Response('<html>campaign</html>', { headers: { 'Content-Type': 'text/html' } })
        })
        const response = await worker.fetch(
            new Request('http://127.0.0.1:8787/uudaicuoinam2026/'),
            { ...environment, ASSETS: { fetch: assetFetch } },
            {} as ExecutionContext,
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')
        expect(response.headers.get('x-dpg-source-sha')).toBe('a'.repeat(40))
        expect(assetFetch).toHaveBeenCalledTimes(1)
        expect(mocks.vinextFetch).not.toHaveBeenCalled()
    })

    it('routes only the owned listing read endpoint through to the public app', async () => {
        const request = new Request('http://127.0.0.1:8787/api/catalogue/listings/thiet-bi-bep/voi-rua-chen?page=1')
        const response = await worker.fetch(request, environment, {} as ExecutionContext)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(mocks.vinextFetch).toHaveBeenCalledTimes(1)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    })

    it('blocks write methods and unowned API paths before the app handler', async () => {
        const write = await worker.fetch(
            new Request('http://127.0.0.1:8787/api/catalogue/listings/thiet-bi-bep/voi-rua-chen', { method: 'POST' }),
            environment,
            {} as ExecutionContext,
        )
        const unknown = await worker.fetch(
            new Request('http://127.0.0.1:8787/api/private/export'),
            environment,
            {} as ExecutionContext,
        )
        expect(write.status).toBe(405)
        expect(write.headers.get('allow')).toBe('GET, HEAD')
        expect(unknown.status).toBe(404)
        expect(mocks.vinextFetch).not.toHaveBeenCalled()
    })

    describe('POST /api/orders (#446) reaches the app only on the isolated TEST Preview', () => {
        const origin = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
        // Same shape as the deployed Fixed Staging (see m3-fixed-preview-config): TEST read DB + dedicated order-intake binding.
        const stagingTest = {
            APP_ENV: 'staging', APP_BUILD_TARGET: 'public', APP_ORIGIN: origin, PREVIEW_NOINDEX: 'true',
            PUBLIC_CATALOGUE_SOURCE: 'postgresql', PREVIEW_TEST_DATABASE_ISOLATED: 'true',
            PUBLIC_DB: { connectionString: 'postgres://read.invalid' }, ORDER_INTAKE_DB: { connectionString: 'postgres://intake.invalid' },
        }
        const post = (method = 'POST') => new Request(`${origin}/api/orders`, { method, body: method === 'POST' ? '{}' : undefined })

        it('forwards the POST through Worker fetch to the app handler', async () => {
            const response = await worker.fetch(post(), stagingTest as never, {} as ExecutionContext)
            expect(response.status).toBe(200)
            expect(mocks.vinextFetch).toHaveBeenCalledTimes(1)
            expect(response.headers.get('cache-control')).toBe('private, no-store')
        })
        it('answers 405 with Allow: POST for other methods without reaching the app', async () => {
            for (const method of ['GET', 'PUT', 'DELETE']) {
                const response = await worker.fetch(post(method), stagingTest as never, {} as ExecutionContext)
                expect(response.status, method).toBe(405)
                expect(response.headers.get('allow')).toBe('POST')
            }
            expect(mocks.vinextFetch).not.toHaveBeenCalled()
        })
        it('is 404 without the order-intake binding and never reaches the app outside the isolated TEST Preview', async () => {
            const { ORDER_INTAKE_DB: _binding, ...withoutBinding } = stagingTest
            const response = await worker.fetch(post(), withoutBinding as never, {} as ExecutionContext)
            expect(response.status).toBe(404)
            // Local preview env (no flag/binding) is 404 too.
            const local = await worker.fetch(new Request('http://127.0.0.1:8787/api/orders', { method: 'POST', body: '{}' }), environment as never, {} as ExecutionContext)
            expect(local.status).toBe(404)
            // Binding supplied without the isolation flag, or on a non-staging env: the Worker refuses (404/503), never the app.
            const { PREVIEW_TEST_DATABASE_ISOLATED: _flag, ...withoutFlag } = stagingTest
            for (const environmentCase of [withoutFlag, { ...stagingTest, PREVIEW_TEST_DATABASE_ISOLATED: 'false' }, { ...stagingTest, APP_ENV: 'preview' }]) {
                const refused = await worker.fetch(post(), environmentCase as never, {} as ExecutionContext)
                expect([404, 503], JSON.stringify(Object.keys(environmentCase))).toContain(refused.status)
            }
            expect(mocks.vinextFetch).not.toHaveBeenCalled()
        })
    })
})
