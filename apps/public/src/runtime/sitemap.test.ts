import {describe,expect,it} from 'vitest'
import {buildSitemapIndex,buildUrlset,isSitemapShard,staticSitemapEntries} from './sitemap'
describe('sitemap',()=>{
  it('validates shard names strictly',()=>{
    for(const s of ['pages','products-1','products-999'])expect(isSitemapShard(s)).toBe(true)
    for(const s of ['products-0','products-1000','products-1x','../pages','Pages','products-01',''])expect(isSitemapShard(s)).toBe(false)
  })
  it('builds index and urlset with escaped absolute canonical URLs',()=>{
    const index=buildSitemapIndex(3)
    expect(index.match(/<sitemap>/g)).toHaveLength(4)
    expect(index).toContain('<loc>https://www.dongphugia.vn/sitemap/products-3</loc>')
    const set=buildUrlset([{path:'/a/b?x=1&y=2',lastmod:'2026-11-18T00:00:00.000Z'},{path:'/c'}])
    expect(set).toContain('https://www.dongphugia.vn/a/b?x=1&amp;y=2')
    expect(set).toContain('<lastmod>2026-11-18T00:00:00.000Z</lastmod>')
    expect(staticSitemapEntries().map(e=>e.path)).toContain('/')
  })
})
