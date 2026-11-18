// Sitemap XML builders. Pure and bounded: every URL is built from validated slugs only.
const ORIGIN='https://www.dongphugia.vn'
const STATIC_PAGES=['/','/lien-he','/ve-chung-toi','/chinh-sach-bao-mat','/dieu-kien-giao-dich','/dieu-kien-kinh-doanh','/thong-tin-gia','/thong-tin-hang-hoa','/van-chuyen-giao-nhan','/blog']
const SHARD=/^(pages|products-[1-9][0-9]{0,2})$/
export type SitemapEntry={path:string;lastmod?:string|null}
const xml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
export const isSitemapShard=(shard:string)=>SHARD.test(shard)
export const staticSitemapEntries=():SitemapEntry[]=>STATIC_PAGES.map(path=>({path}))
export function buildSitemapIndex(productShards:number){
  const names=['pages',...Array.from({length:productShards},(_,i)=>`products-${i+1}`)]
  return '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    +names.map(n=>`<sitemap><loc>${ORIGIN}/sitemap/${n}</loc></sitemap>`).join('')+'</sitemapindex>\n'
}
export function buildUrlset(entries:readonly SitemapEntry[]){
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    +entries.map(e=>`<url><loc>${ORIGIN}${xml(e.path)}</loc>${e.lastmod?`<lastmod>${xml(e.lastmod)}</lastmod>`:''}</url>`).join('')+'</urlset>\n'
}
