import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const rendered = vi.hoisted(() => vi.fn(async () => new Response('<html><h1>Snapshot Public</h1></html>', { headers: { 'Content-Type': 'text/html' } })))
vi.mock('vinext/server/fetch-handler', () => ({ default: { fetch: rendered } }))

let worker: typeof import('../../worker')['default']

const checkpoint = 'c'.repeat(40)
const source = 'a'.repeat(40)
const origin = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'

beforeAll(async () => {
  vi.stubGlobal('__DPG_BUILD_SOURCE_SHA__', source)
  worker = (await import('../../worker')).default
})

beforeEach(() => {
  vi.stubGlobal('__DPG_BUILD_SOURCE_SHA__', source)
  vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', checkpoint)
  rendered.mockClear()
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

function environment(manifestCheckpoint = checkpoint) {
  const fetch = vi.fn(async (raw: string) => raw.endsWith('/__catalogue/v1/manifest.json')
    ? Response.json({ contract: 'dpg:public-catalogue-snapshot:v1', checkpoint: manifestCheckpoint })
    : new Response('Not found.', { status: 404 }))
  return { APP_ENV: 'staging', APP_BUILD_TARGET: 'public', APP_ORIGIN: origin, PREVIEW_NOINDEX: 'true',
    PUBLIC_CATALOGUE_SOURCE: 'snapshot', PUBLIC_CATALOGUE_CHECKPOINT: checkpoint, ASSETS: { fetch } }
}

it('renders a valid fresh staging snapshot without requiring legacy prerender assets', async () => {
  const env = environment()
  const response = await worker.fetch(new Request(origin + '/'), env, {} as ExecutionContext)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('Snapshot Public')
  expect(rendered).toHaveBeenCalledTimes(1)
  expect(env.ASSETS.fetch.mock.calls.map(([url]) => url)).toEqual(['https://catalogue-assets.invalid/__catalogue/v1/manifest.json'])
  expect(response.headers.get('X-DPG-Source-SHA')).toBe(source)
  expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})

it('still rejects a staging snapshot with the wrong checkpoint before rendering', async () => {
  const response = await worker.fetch(new Request(origin + '/thiet-bi-ve-sinh/bon-cau'), environment('d'.repeat(40)), {} as ExecutionContext)
  expect(response.status).toBe(503)
  expect(rendered).not.toHaveBeenCalled()
})

it('still requires the prerender proof for Production snapshot mode', async () => {
  const env = { ...environment(), APP_ENV: 'production', APP_ORIGIN: 'https://www.dongphugia.vn', PREVIEW_NOINDEX: 'false' }
  const response = await worker.fetch(new Request('https://www.dongphugia.vn/'), env, {} as ExecutionContext)
  expect(response.status).toBe(503)
  expect(env.ASSETS.fetch.mock.calls[0][0]).toContain('/__render/v1/')
  expect(rendered).not.toHaveBeenCalled()
})
