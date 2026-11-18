import {getPublicAppEnvironment} from '../../../src/config/env'
import {publicPostgresEnabled} from '../../../src/runtime/public-db'
import {getLiveSitemapListings,getLiveSitemapProducts} from '../../../src/runtime/live-public-catalogue'
import {getPublicBlogPosts} from '../../../src/runtime/live-public-blog'
import {buildUrlset,isSitemapShard,staticSitemapEntries,type SitemapEntry} from '../../../src/runtime/sitemap'
export const runtime='edge'
export const dynamic='force-dynamic'
const HEADERS={'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=0, must-revalidate'}
const notFound=()=>new Response('Not found',{status:404,headers:{'Cache-Control':'private, no-store'}})
export async function GET(_request:Request,{params}:{params:Promise<{shard:string}>}){
  const {shard}=await params
  if(!isSitemapShard(shard)||getPublicAppEnvironment().previewNoindex||!publicPostgresEnabled())return notFound()
  let entries:SitemapEntry[]
  if(shard==='pages'){
    const [listings,posts]=await Promise.all([getLiveSitemapListings(),getPublicBlogPosts()])
    const blog=posts.map(post=>({path:`/blog/${post.category.slug}/${post.slug}`,lastmod:post.updated_at?new Date(post.updated_at).toISOString():null}))
    entries=[...staticSitemapEntries(),...listings,...blog]
  }else entries=await getLiveSitemapProducts(Number(shard.slice('products-'.length)))
  return entries.length||shard==='pages'?new Response(buildUrlset(entries),{headers:HEADERS}):notFound()
}
