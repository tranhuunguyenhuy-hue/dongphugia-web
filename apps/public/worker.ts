import { withPublicReadScope } from './src/runtime/public-read-scope'
import vinextHandler from 'vinext/server/fetch-handler'
import {exceptionCategory} from '../../scripts/catalogue-direct/preview-diagnostic-safety.mjs'
import { publicSnapshotCheckpoint } from './src/runtime/public-snapshot-mode'
import {servePrerenderedCatalogue} from './src/runtime/prerendered-catalogue'
import {readBoundedPublicAssetText} from './src/runtime/bounded-public-asset'
import {serveCampaignLanding} from './src/runtime/campaign-landing'
import {entryFreshness, isStorablePage, PAGE_CACHE_STALE_IF_ERROR_SECONDS, pageCacheKey, planPageCache} from './src/runtime/page-cache'

import {
  assertPublicRuntime,
  classifyPublicApiRequest,
  isForbiddenInternalControlRequest,
  isMalformedCataloguePagePath,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_BROWSER_CACHE_CONTROL,
  PUBLIC_EDGE_CACHE_CONTROL,
  publicRuntimeRejectionDiagnostics,
  robotsHeader,
  type PublicWorkerEnvironment,
  withHeaders,
} from './src/worker-policy'

declare const __DPG_BUILD_SOURCE_SHA__: string

const sourceIdentityHeader = { 'X-DPG-Source-SHA': __DPG_BUILD_SOURCE_SHA__ }
const SAFE_ROUTE_SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
function routeDiagnostics(request:Request) {
  const segments=new URL(request.url).pathname.split('/').filter(Boolean)
  if(segments.length===2&&segments[0]==='api'&&segments[1]==='health')return {route:'health'}
  if(segments.length===5&&segments[0]==='api'&&segments[1]==='catalogue'&&segments[2]==='listings')return {route:'listing-shard'}
  if(segments.length===2&&segments.every(segment=>SAFE_ROUTE_SLUG.test(segment)))return {
    route:'plp',categorySlug:segments[0],subcategorySlug:segments[1],
  }
  if(segments.length===3&&segments.every(segment=>SAFE_ROUTE_SLUG.test(segment)))return {
    route:'pdp',categorySlug:segments[0],subcategorySlug:segments[1],productSlug:segments[2],
  }
  return {route:'other'}
}

export default {
  async fetch(
    request: Request,
    environment: PublicWorkerEnvironment,
    context: ExecutionContext,
  ) {
    const robotValue = robotsHeader(request, environment)
    const robotHeaders: Record<string, string> = robotValue ? { 'X-Robots-Tag': robotValue } : {}
    try {
    try {
      assertPublicRuntime(request, environment)
    } catch (error) {
      console.error(JSON.stringify({
        event: 'PUBLIC_RUNTIME_CONFIGURATION_REJECTED',
        ...publicRuntimeRejectionDiagnostics(request, environment, error),
      }))
      return new Response('Public configuration rejected.', {
        status: 503,
        headers: {
          'Cache-Control': PRIVATE_CACHE_CONTROL,
          ...robotHeaders,
        },
      })
    }

    if (environment.APP_ENV === 'production' && new URL(request.url).hostname === 'dongphugia.vn') {
      const destination = new URL(request.url)
      destination.protocol = 'https:'
      destination.hostname = 'www.dongphugia.vn'
      return Response.redirect(destination, 301)
    }

    if (isForbiddenInternalControlRequest(request)) {
      return new Response('Not found.', {
        status: 404,
        headers: {
          'Cache-Control': PRIVATE_CACHE_CONTROL,
          ...robotHeaders,
        },
      })
    }

    // Reject invalid catalogue slugs before passing them into vinext/Next.
    // A trailing-dot PLP consumed the packaged Worker CPU quota in release #29.
    if (isMalformedCataloguePagePath(request)) {
      return new Response('Not found.', {
        status: 404,
        headers: {
          'Cache-Control': PRIVATE_CACHE_CONTROL,
          ...robotHeaders,
          ...sourceIdentityHeader,
        },
      })
    }

    const publicApiDecision = classifyPublicApiRequest(request)
    if (publicApiDecision === 'not-found' || publicApiDecision === 'method-not-allowed') {
      return new Response(publicApiDecision === 'not-found' ? 'Not found.' : 'Method not allowed.', {
        status: publicApiDecision === 'not-found' ? 404 : 405,
        headers: {
          'Cache-Control': PRIVATE_CACHE_CONTROL,
          ...robotHeaders,
          ...(publicApiDecision === 'method-not-allowed' ? { Allow: 'GET, HEAD' } : {}),
          ...sourceIdentityHeader,
        },
      })
    }

    const campaignResponse = await serveCampaignLanding(request, environment)
    if (campaignResponse) {
      return withHeaders(campaignResponse, {
        ...sourceIdentityHeader,
        ...robotHeaders,
      })
    }

    const databaseMode = environment.PUBLIC_CATALOGUE_SOURCE === 'postgresql'
    if (databaseMode && !environment.PUBLIC_DB) {
      return new Response('Database temporarily unavailable.', {status:503,headers:{
        'Cache-Control':PRIVATE_CACHE_CONTROL,...robotHeaders,...sourceIdentityHeader,
      }})
    }
    // M2's pinned staging snapshot uses dynamic SSR over local ASSETS. Only
    // legacy snapshot releases carry the __render prerender proof and pages.
    const stagingSnapshot = environment.APP_ENV === 'staging' && environment.PUBLIC_CATALOGUE_SOURCE === 'snapshot'
    if (!databaseMode && !stagingSnapshot) {
      const prerendered=await servePrerenderedCatalogue(request,environment,__DPG_BUILD_SOURCE_SHA__)
      if(prerendered)return prerendered
    }
    const pathname = new URL(request.url).pathname
    const catalogueRequest = pathname === '/' || ['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat'].some(root => pathname === `/${root}` || pathname.startsWith(`/${root}/`))
    if (!databaseMode && publicSnapshotCheckpoint() && catalogueRequest) {
      const assets = environment.ASSETS as { fetch?: (url: string) => Promise<Response> } | undefined
      let ready = false
      try {
        const response = await assets?.fetch?.('https://catalogue-assets.invalid/__catalogue/v1/manifest.json')
        if (response?.ok) {
          const manifest = JSON.parse(await readBoundedPublicAssetText(response)) as { contract?: string; checkpoint?: string }
          ready = manifest.contract === 'dpg:public-catalogue-snapshot:v1' && manifest.checkpoint === publicSnapshotCheckpoint()
        }
      } catch { /* No raw asset/error response is disclosed. */ }
      if (!ready) return new Response('Catalogue temporarily unavailable.', {status:503,headers:{
        'Cache-Control':PRIVATE_CACHE_CONTROL,...robotHeaders,...sourceIdentityHeader,
      }})
    }
    // Cache-first for anonymous HTML (#360 P1). Production and the isolated TEST staging pilot only;
    // Flight/RSC, cookies, unknown query parameters and non-GET requests always bypass (see page-cache.ts).
    const cacheEnabled = environment.APP_ENV === 'production'
      || (environment.APP_ENV === 'staging' && environment.PREVIEW_TEST_DATABASE_ISOLATED === 'true')
    const plan = cacheEnabled ? planPageCache(request) : null
    const cacheKey = plan ? pageCacheKey(request, plan, __DPG_BUILD_SOURCE_SHA__, publicSnapshotCheckpoint()) : null
    const workerCache = cacheKey ? await caches.open('dongphugia-public-v2') : null
    const edgeControl = plan ? `public, max-age=${plan.ttlSeconds}, must-revalidate` : PUBLIC_EDGE_CACHE_CONTROL
    let staleEntry: Response | null = null

    if (cacheKey && workerCache && plan) {
      const cached = await workerCache.match(cacheKey)
      if (cached) {
        const freshness = entryFreshness(Number(cached.headers.get('x-dpg-cached-at')), Date.now(), plan.ttlSeconds)
        if (freshness === 'fresh') {
          return withHeaders(cached, {
            ...sourceIdentityHeader,
            'Cache-Control': PUBLIC_BROWSER_CACHE_CONTROL,
            'CDN-Cache-Control': edgeControl,
            'X-DPG-Cache': 'HIT',
            ...robotHeaders,
          })
        }
        if (freshness === 'stale-usable') staleEntry = cached
      }
    }
    // A bounded stale copy is served only when rendering fails; it never masks a successful 404/redirect.
    const serveStale = () => withHeaders(staleEntry!, {
      ...sourceIdentityHeader,
      'Cache-Control': PUBLIC_BROWSER_CACHE_CONTROL,
      'CDN-Cache-Control': 'public, max-age=0, must-revalidate',
      'X-DPG-Cache': 'STALE',
      ...robotHeaders,
    })

    let rendered: Response
    try {
      rendered = await withPublicReadScope(request.signal, () => vinextHandler.fetch(request, environment, context))
    } catch (renderError) {
      if (staleEntry) return serveStale()
      throw renderError
    }
    if (staleEntry && rendered.status >= 500) return serveStale()
    if(environment.PUBLIC_DB_DIAGNOSTICS==='true'&&rendered.status>=500){
      const marker=rendered.headers.get('X-DPG-Render-Failure')??''
      const safeMarkers=new Set(['CROSS_REQUEST_IO','GLOBAL_SCOPE_IO','SUBREQUEST_LIMIT','CPU_LIMIT','MEMORY_LIMIT','NO_RESPONSE','STREAM_CLOSED','BODY_USED','NETWORK_LOST','ASSET_UNAVAILABLE','UNCLASSIFIED_EXCEPTION'])
      const rawContentType=rendered.headers.get('content-type')?.split(';',1)[0].toLowerCase()??''
      const contentTypeClass=rawContentType==='text/html'||rawContentType==='application/json'||rawContentType==='text/plain'
        ?rawContentType:rawContentType.startsWith('image/')?'image/*':rawContentType?'other':'missing'
      console.error(JSON.stringify({event:'PUBLIC_RENDER_HTTP_FAILURE',...routeDiagnostics(request),status:rendered.status,
        contentTypeClass,
        hasRenderFailureMarker:safeMarkers.has(marker),...(safeMarkers.has(marker)?{renderFailure:marker}:{})}))
    }
    if (!cacheKey || !plan || !isStorablePage(rendered)) {
      return withHeaders(rendered, {
        ...sourceIdentityHeader,
        'Cache-Control': PRIVATE_CACHE_CONTROL,
        'X-DPG-Cache': 'BYPASS',
        ...robotHeaders,
      })
    }

    const stored = withHeaders(rendered.clone(), {
      ...sourceIdentityHeader,
      'Cache-Control': `public, max-age=${plan.ttlSeconds + PAGE_CACHE_STALE_IF_ERROR_SECONDS}`,
      'X-DPG-Cached-At': String(Date.now()),
      'X-DPG-Cache': 'STORED',
      ...robotHeaders,
    })
    context.waitUntil(workerCache!.put(cacheKey, stored))

    return withHeaders(rendered, {
      ...sourceIdentityHeader,
      'Cache-Control': PUBLIC_BROWSER_CACHE_CONTROL,
      'CDN-Cache-Control': edgeControl,
      'X-DPG-Cache': 'MISS',
      ...robotHeaders,
    })
    } catch(error:unknown) {
      let category='UNCLASSIFIED_EXCEPTION'
      try {if(error&&typeof error==='object'&&'message' in error)category=String(exceptionCategory(error.message))}catch{/* no introspection failure is disclosed */}
      console.error(JSON.stringify({event:'PUBLIC_RENDER_FAILURE',category}))
      return new Response('Catalogue temporarily unavailable.',{status:503,headers:{
        ...sourceIdentityHeader,'Cache-Control':PRIVATE_CACHE_CONTROL,...robotHeaders,
        'X-DPG-Render-Failure':category,
      }})
    }
  },
}
