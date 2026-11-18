import {describe,expect,it} from 'vitest'
import {classifyPagePath,entryFreshness,isStorablePage,pageCacheKey,planPageCache} from './page-cache'

const SHA='a'.repeat(40)
const req=(path:string,init:RequestInit={})=>new Request(`https://www.dongphugia.vn${path}`,init)

describe('page cache plan',()=>{
  it('classifies only known public HTML routes',()=>{
    expect(classifyPagePath('/')).toBe('home')
    expect(classifyPagePath('/thiet-bi-ve-sinh')).toBe('category')
    expect(classifyPagePath('/thiet-bi-ve-sinh/bon-cau')).toBe('listing')
    expect(classifyPagePath('/thiet-bi-ve-sinh/bon-cau/toto-ms636')).toBe('product')
    expect(classifyPagePath('/blog/huong-dan-chon/bai-viet')).toBe('blog')
    expect(classifyPagePath('/lien-he')).toBe('static')
    for(const p of ['/api/health','/admin','/tim-kiem','/thiet-bi-ve-sinh/','/thiet-bi-ve-sinh/a/b/c','/unknown/x','/uudaicuoinam2026'])expect(classifyPagePath(p)).toBeNull()
  })
  it('ignores tracking params and normalizes functional ones into one key',()=>{
    const a=planPageCache(req('/thiet-bi-ve-sinh/bon-cau?utm_source=fb&brand=toto&page=2&fbclid=x&gclid=y'))!
    const b=planPageCache(req('/thiet-bi-ve-sinh/bon-cau?page=2&brand=toto'))!
    expect(a.search).toBe('brand=toto&page=2')
    expect(pageCacheKey(req('/thiet-bi-ve-sinh/bon-cau?utm_source=fb&brand=toto&page=2'),a,SHA,null).url)
      .toBe(pageCacheKey(req('/thiet-bi-ve-sinh/bon-cau?page=2&brand=toto'),b,SHA,null).url)
    expect(pageCacheKey(req('/thiet-bi-ve-sinh/bon-cau'),planPageCache(req('/thiet-bi-ve-sinh/bon-cau'))!,SHA,null).url)
      .not.toBe(pageCacheKey(req('/thiet-bi-ve-sinh/bon-cau?page=2'),planPageCache(req('/thiet-bi-ve-sinh/bon-cau?page=2'))!,SHA,null).url)
  })
  it('never caches Flight/RSC, private, unsupported or fragmenting requests',()=>{
    expect(planPageCache(req('/thiet-bi-ve-sinh/bon-cau?_rsc=abc'))).toBeNull()
    expect(planPageCache(req('/thiet-bi-ve-sinh/bon-cau',{headers:{rsc:'1'}}))).toBeNull()
    expect(planPageCache(req('/',{headers:{'next-router-prefetch':'1'}}))).toBeNull()
    expect(planPageCache(req('/',{headers:{cookie:'a=b'}}))).toBeNull()
    expect(planPageCache(req('/',{headers:{authorization:'Bearer x'}}))).toBeNull()
    expect(planPageCache(req('/',{method:'POST'}))).toBeNull()
    expect(planPageCache(req('/thiet-bi-ve-sinh/bon-cau?sort=price-asc'))).toBeNull()
    expect(planPageCache(req('/thiet-bi-ve-sinh/bon-cau?brand=a&brand=b'))).toBeNull()
    expect(planPageCache(req('/thiet-bi-ve-sinh/bon-cau?brand=<script>'))).toBeNull()
    expect(planPageCache(req('/thiet-bi-ve-sinh/bon-cau?page='+'9'.repeat(80)))).toBeNull()
  })
  it('partitions the key by source, checkpoint and representation',()=>{
    const plan=planPageCache(req('/'))!
    const base=pageCacheKey(req('/'),plan,SHA,null).url
    expect(pageCacheKey(req('/'),plan,'b'.repeat(40),null).url).not.toBe(base)
    expect(pageCacheKey(req('/'),plan,SHA,'c'.repeat(40)).url).not.toBe(base)
    expect(base).toContain('__dpg_repr=html')
    expect(()=>pageCacheKey(req('/'),plan,'bad',null)).toThrow()
  })
  it('bounds freshness and stale-if-error',()=>{
    const now=1_000_000
    expect(entryFreshness(now-30_000,now,60)).toBe('fresh')
    expect(entryFreshness(now-61_000,now,60)).toBe('stale-usable')
    expect(entryFreshness(now-661_000,now,60)).toBe('expired')
    expect(entryFreshness(NaN,now,60)).toBe('expired')
    expect(entryFreshness(now+5_000,now,60)).toBe('expired')
  })
  it('stores only 200 cookie-free HTML',()=>{
    const html=(status:number,headers:Record<string,string>={})=>new Response('x',{status,headers:{'content-type':'text/html',...headers}})
    expect(isStorablePage(html(200))).toBe(true)
    expect(isStorablePage(html(404))).toBe(false)
    expect(isStorablePage(html(500))).toBe(false)
    expect(isStorablePage(html(200,{'set-cookie':'a=b'}))).toBe(false)
    expect(isStorablePage(new Response('{}',{status:200,headers:{'content-type':'application/json'}}))).toBe(false)
  })
})
