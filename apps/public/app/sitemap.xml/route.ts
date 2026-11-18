import {getPublicAppEnvironment} from '../../src/config/env'
import {publicPostgresEnabled} from '../../src/runtime/public-db'
import {getLiveSitemapProductCount,SITEMAP_PRODUCTS_PER_SHARD} from '../../src/runtime/live-public-catalogue'
import {buildSitemapIndex} from '../../src/runtime/sitemap'
export const runtime='edge'
export const dynamic='force-dynamic'
const HEADERS={'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=0, must-revalidate'}
export async function GET(){
  if(getPublicAppEnvironment().previewNoindex||!publicPostgresEnabled())return new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}})
  const count=await getLiveSitemapProductCount()
  return new Response(buildSitemapIndex(Math.max(1,Math.ceil(count/SITEMAP_PRODUCTS_PER_SHARD))),{headers:HEADERS})
}
