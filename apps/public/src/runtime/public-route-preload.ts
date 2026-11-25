// #457: start the independent catalogue reads of a route together instead of one after another.
// Each read below is the exact call (same function, same arguments, hence the same bound SELECT) that the
// unchanged canonical template makes later; the request-scoped read memo in public-db.ts lets the template,
// generateMetadata and vinext's Flight probe reuse the in-flight result. A preload never decides a
// response: failures are swallowed here and surface again, unchanged, when the template awaits the call.
import {publicPostgresEnabled} from './public-db'
import {getLiveBrandsForListing,getLiveListing,getLiveListingLeaves,getLiveListingRouteMetadata,getLiveProductByCategory} from './live-public-catalogue'

const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FAMILIES=new Set(['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat'])
/** Default first-page size of each family listing template (src/app/(public)/<family>/[sub]/page.tsx PAGE_SIZE). */
export const LISTING_TEMPLATE_PAGE_SIZE:Record<string,number>={'thiet-bi-ve-sinh':12,'thiet-bi-bep':24,'vat-lieu-nuoc':24,'gach-op-lat':24}
/** PDP "related products": getPublicProducts({pageSize:5}) reads one extra row (see canonical-public-api.ts). */
export const PDP_RELATED_READ_SIZE=6

const eligible=(...slugs:string[])=>publicPostgresEnabled()&&FAMILIES.has(slugs[0])&&slugs.every(slug=>SLUG.test(slug))
const settle=(read:Promise<unknown>)=>{read.catch(()=>undefined)}

export function preloadProductRoute(category:string,listing:string,slug:string){
 if(!eligible(category,listing,slug))return
 settle(getLiveProductByCategory(category,slug))
 settle(getLiveListing(category,listing,1,PDP_RELATED_READ_SIZE))
}

/** `unfiltered`: no query parameter at all, i.e. the template's default first page without brand/featured/sort/series. */
export function preloadListingRoute(category:string,listing:string,unfiltered:boolean){
 if(!eligible(category,listing))return
 settle(getLiveListingRouteMetadata(category,listing))
 settle(getLiveListingLeaves(category))
 settle(getLiveBrandsForListing(category,listing))
 if(unfiltered)settle(getLiveListing(category,listing,1,LISTING_TEMPLATE_PAGE_SIZE[category],{brandSlugs:[],featured:false,seriesSlugs:[]}))
}
