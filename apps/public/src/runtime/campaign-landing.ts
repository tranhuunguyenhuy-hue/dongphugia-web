const CAMPAIGN_PATH = '/uudaicuoinam2026'

type CampaignAssetEnvironment = Readonly<Record<string, unknown>>

/** Serve the campaign's unmodified static directory ahead of the Vinext route fallback. */
export async function serveCampaignLanding(
  request: Request,
  environment: CampaignAssetEnvironment,
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (pathname !== CAMPAIGN_PATH && !pathname.startsWith(`${CAMPAIGN_PATH}/`)) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'private, no-store' },
    })
  }

  if (pathname === CAMPAIGN_PATH) {
    url.pathname = `${CAMPAIGN_PATH}/`
    return Response.redirect(url, 308)
  }

  const assets = environment.ASSETS as { fetch?: (request: Request) => Promise<Response> } | undefined
  if (!assets || typeof assets.fetch !== 'function') {
    return new Response('Campaign assets temporarily unavailable.', {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  // Preserve the public directory URL so the Static Assets binding resolves
  // its index.html using the configured HTML handling behavior.
  return assets.fetch(new Request(url, request))
}
