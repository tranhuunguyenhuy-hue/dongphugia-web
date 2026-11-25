// Cache-first policy for anonymous Public HTML (#360 P1). Pure functions: the Worker owns I/O.
//
// Design rules (Owner/TL directive 6977090843):
// - HTML only. Flight/RSC/prefetch requests are never cached and never served from an HTML entry.
// - Tracking parameters (utm_*, fbclid, gclid) are ignored for the key; functional parameters are
//   whitelisted per route class, sorted and bounded so the key space cannot be fragmented.
//   Unknown/duplicate/oversized parameters make the request uncacheable (it renders uncached).
// - No cookie / authorization / range / conditional-private requests, no non-GET/HEAD, no errors.
// - Freshness is bounded by TTL (no cross-colo purge exists for the Cache API). Stale entries are
//   only served when rendering fails, and only for a short bounded window.
import {isTrackingQueryKey} from './listing-query'

export type PageCacheClass='home'|'category'|'listing'|'product'|'blog'|'static'
export const PAGE_CACHE_TTL_SECONDS=45
export const STATIC_PAGE_CACHE_TTL_SECONDS=3600
export const PAGE_CACHE_STALE_IF_ERROR_SECONDS=600
/** Mutable catalogue/blog/home HTML is never served past its TTL (hidden/deleted content must not linger). */
export const staleIfErrorSeconds=(cls:PageCacheClass)=>cls==='static'?PAGE_CACHE_STALE_IF_ERROR_SECONDS:0

const FAMILIES=new Set(['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat'])
const STATIC_PATHS=new Set(['/lien-he','/ve-chung-toi','/chinh-sach-bao-mat','/dieu-kien-giao-dich','/dieu-kien-kinh-doanh','/thong-tin-gia','/thong-tin-hang-hoa','/van-chuyen-giao-nhan'])
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PARAM_VALUE=/^[A-Za-z0-9_,.-]{1,64}$/
const ALLOWED_PARAMS:Record<PageCacheClass,readonly string[]>={
  home:[],category:['brands'],listing:['page','brand','dong','is_featured'],product:[],blog:['page'],static:[],
}
const FORBIDDEN_HEADERS=['authorization','cookie','range','rsc','next-router-prefetch','next-router-segment-prefetch','next-router-state-tree','x-nextjs-data','x-vinext-rsc']

export function classifyPagePath(pathname:string):PageCacheClass|null{
  if(pathname==='/')return 'home'
  if(STATIC_PATHS.has(pathname))return 'static'
  const segments=pathname.split('/').filter(Boolean)
  if(pathname.endsWith('/')||segments.length===0||!segments.every(s=>SLUG.test(s)))return null
  if(segments[0]==='blog')return segments.length<=3?'blog':null
  if(!FAMILIES.has(segments[0]))return null
  if(segments.length===1)return 'category'
  if(segments.length===2)return 'listing'
  if(segments.length===3)return 'product'
  return null
}

export type PageCachePlan={cls:PageCacheClass;ttlSeconds:number;staleSeconds:number;search:string}

/** Returns the cache plan for a request, or null when it must not touch the HTML cache. */
export function planPageCache(request:Request):PageCachePlan|null{
  if(request.method!=='GET'&&request.method!=='HEAD')return null
  for(const name of FORBIDDEN_HEADERS)if(request.headers.has(name))return null
  // Only genuine HTML document requests share the HTML representation.
  const accept=request.headers.get('accept')
  if(accept&&!/text\/html|\*\/\*/i.test(accept))return null
  const url=new URL(request.url)
  if(url.searchParams.has('_rsc'))return null
  const cls=classifyPagePath(url.pathname)
  if(!cls)return null
  const allowed=ALLOWED_PARAMS[cls]
  const kept=new Map<string,string>()
  for(const [key,value] of url.searchParams){
    if(isTrackingQueryKey(key))continue
    if(!allowed.includes(key)||kept.has(key)||!PARAM_VALUE.test(value))return null
    kept.set(key,value)
  }
  const search=[...kept].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&')
  return {cls,ttlSeconds:cls==='static'?STATIC_PAGE_CACHE_TTL_SECONDS:PAGE_CACHE_TTL_SECONDS,staleSeconds:staleIfErrorSeconds(cls),search}
}

/** pricingVariant (#470): the canonical-pricing mode + brand scope. Omitted/'off' keeps the exact pre-#470 key; any change of the
 * flag or scope therefore lands on a different key, so a flip ON/OFF never serves HTML rendered under the other setting. */
export function pageCacheKey(request:Request,plan:PageCachePlan,sourceCommit:string,catalogueCheckpoint:string|null,pricingVariant?:string){
  if(!/^[0-9a-f]{40}$/.test(sourceCommit))throw new Error('PUBLIC_WORKER_CACHE_SOURCE_INVALID')
  if(catalogueCheckpoint&&!/^[0-9a-f]{40}$/.test(catalogueCheckpoint))throw new Error('PUBLIC_CATALOGUE_CHECKPOINT_INVALID')
  const url=new URL(request.url)
  const key=new URL(`${url.origin}${url.pathname}`)
  key.searchParams.set('__dpg_repr','html')
  key.searchParams.set('__dpg_source',sourceCommit)
  if(catalogueCheckpoint)key.searchParams.set('__dpg_catalogue',catalogueCheckpoint)
  if(plan.search)key.searchParams.set('__dpg_q',plan.search)
  if(pricingVariant&&pricingVariant!=='off'){
    if(!/^[a-z]+(?::[a-z0-9,-]{1,200})?(?::commerce)?$/.test(pricingVariant))throw new Error('PUBLIC_WORKER_CACHE_PRICING_VARIANT_INVALID')
    key.searchParams.set('__dpg_pricing',pricingVariant)
  }
  return new Request(key.toString(),{method:'GET'})
}

export type CacheFreshness='fresh'|'stale-usable'|'expired'
export function entryFreshness(cachedAtMs:number,nowMs:number,ttlSeconds:number,staleSeconds=0):CacheFreshness{
  const age=(nowMs-cachedAtMs)/1000
  if(!Number.isFinite(age)||age<0)return 'expired'
  if(age<=ttlSeconds)return 'fresh'
  return age<=ttlSeconds+staleSeconds?'stale-usable':'expired'
}

/** Seconds a downstream cache may still keep a HIT: never restarts the TTL on every hit. */
export function remainingTtlSeconds(cachedAtMs:number,nowMs:number,ttlSeconds:number){
  return Math.max(0,Math.floor(ttlSeconds-(nowMs-cachedAtMs)/1000))
}

// React/vinext render errors can still produce a 200 HTML shell with an error digest in the inline
// Flight payload or the generic error page. Such responses are served once but never cached.
const RENDER_ERROR_MARKER=/digest\\?":|(?:^|\n)[0-9a-f]+:E\{|This page couldn.t load/
export const hasRenderErrorMarker=(html:string)=>RENDER_ERROR_MARKER.test(html)

/** Only successful, cookie-free HTML is stored. Errors, redirects and 404 never are. */
export function isStorablePage(response:Response){
  return response.status===200
    &&response.headers.get('content-type')?.includes('text/html')===true
    &&!response.headers.has('set-cookie')
}
