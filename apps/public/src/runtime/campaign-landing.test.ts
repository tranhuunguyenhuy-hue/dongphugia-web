import { describe, expect, it, vi } from 'vitest'
import { serveCampaignLanding } from './campaign-landing'

describe('serveCampaignLanding', () => {
  it('serves the campaign directory index through the static asset binding', async () => {
    const fetch = vi.fn(async (request: Request) => new Response('<html>campaign</html>', {
      headers: { 'Content-Type': 'text/html' },
    }))
    const response = await serveCampaignLanding(
      new Request('https://www.dongphugia.vn/uudaicuoinam2026/?utm_source=test'),
      { ASSETS: { fetch } },
    )

    expect(response?.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
    const assetRequest = fetch.mock.calls[0][0]
    expect(new URL(assetRequest.url).pathname).toBe('/uudaicuoinam2026/index.html')
    expect(new URL(assetRequest.url).searchParams.get('utm_source')).toBe('test')
  })

  it('leaves unrelated paths to the existing app router', async () => {
    const fetch = vi.fn()
    expect(await serveCampaignLanding(
      new Request('https://www.dongphugia.vn/thiet-bi-ve-sinh/voi-sen'),
      { ASSETS: { fetch } },
    )).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redirects the no-slash route and rejects writes', async () => {
    const environment = { ASSETS: { fetch: vi.fn() } }
    const redirect = await serveCampaignLanding(
      new Request('https://www.dongphugia.vn/uudaicuoinam2026?utm_source=test'),
      environment,
    )
    const post = await serveCampaignLanding(
      new Request('https://www.dongphugia.vn/uudaicuoinam2026/', { method: 'POST' }),
      environment,
    )

    expect(redirect?.status).toBe(308)
    expect(redirect?.headers.get('location')).toBe('https://www.dongphugia.vn/uudaicuoinam2026/?utm_source=test')
    expect(post?.status).toBe(405)
    expect(post?.headers.get('allow')).toBe('GET, HEAD')
    expect(environment.ASSETS.fetch).not.toHaveBeenCalled()
  })
})
