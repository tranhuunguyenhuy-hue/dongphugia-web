import {describe,expect,it} from 'vitest'
import {PAGE_CACHE_TTL_SECONDS,classifyPagePath,entryFreshness,hasRenderErrorMarker,isStorablePage,pageCacheKey,planPageCache,remainingTtlSeconds} from './page-cache'

const SHA='a'.repeat(40)
const req=(path:string,init:RequestInit={})=>new Request(`https://www.dongphugia.vn${path}`,init)

describe('Admin -> Public freshness budget',()=>{
  it('keeps the mutable-HTML TTL short enough for the 60 s freshness target (TTL + Admin poll interval)',()=>{
    expect(PAGE_CACHE_TTL_SECONDS).toBeLessThanOrEqual(45)
    expect(planPageCache(req('/blog'))!.ttlSeconds).toBe(PAGE_CACHE_TTL_SECONDS)
  })
})

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
    expect(planPageCache(req('/',{headers:{accept:'text/x-component'}}))).toBeNull()
    expect(planPageCache(req('/',{headers:{accept:'application/json'}}))).toBeNull()
    expect(planPageCache(req('/',{headers:{accept:'text/html,application/xhtml+xml'}}))).not.toBeNull()
    expect(planPageCache(req('/',{headers:{accept:'*/*'}}))).not.toBeNull()
  })
  it('partitions the key by source, checkpoint and representation',()=>{
    const plan=planPageCache(req('/'))!
    const base=pageCacheKey(req('/'),plan,SHA,null).url
    expect(pageCacheKey(req('/'),plan,'b'.repeat(40),null).url).not.toBe(base)
    expect(pageCacheKey(req('/'),plan,SHA,'c'.repeat(40)).url).not.toBe(base)
    expect(base).toContain('__dpg_repr=html')
    expect(()=>pageCacheKey(req('/'),plan,'bad',null)).toThrow()
  })
  it('bounds freshness: mutable HTML never stale, legal pages bounded stale-if-error',()=>{
    const now=1_000_000
    expect(entryFreshness(now-30_000,now,60)).toBe('fresh')
    expect(entryFreshness(now-61_000,now,60)).toBe('expired')
    expect(entryFreshness(now-61_000,now,60,600)).toBe('stale-usable')
    expect(entryFreshness(now-661_000,now,60,600)).toBe('expired')
    for(const p of ['/','/thiet-bi-ve-sinh','/thiet-bi-ve-sinh/bon-cau','/thiet-bi-ve-sinh/bon-cau/x','/blog'])expect(planPageCache(req(p))!.staleSeconds).toBe(0)
    expect(planPageCache(req('/lien-he'))!.staleSeconds).toBe(600)
    expect(remainingTtlSeconds(now-45_000,now,60)).toBe(15)
    expect(remainingTtlSeconds(now-90_000,now,60)).toBe(0)
    expect(entryFreshness(NaN,now,60)).toBe('expired')
    expect(entryFreshness(now+5_000,now,60)).toBe('expired')
  })
  it('detects render-error markers so failed renders are never cached',()=>{
    expect(hasRenderErrorMarker('<script>self.__next_f.push([1,"3:E{\\"digest\\":\\"123\\"}"])</script>')).toBe(true)
    expect(hasRenderErrorMarker('0:{}\n3:E{"digest":"1"}')).toBe(true)
    expect(hasRenderErrorMarker('<h1>This page couldn’t load</h1>')).toBe(true)
    expect(hasRenderErrorMarker('<h1>Bồn cầu TOTO</h1><p>digest of specs</p>')).toBe(false)
  })
  it('stores only 200 cookie-free HTML',()=>{
    const html=(status:number,headers:Record<string,string>={})=>new Response('x',{status,headers:{'content-type':'text/html',...headers}})
    expect(isStorablePage(html(200))).toBe(true)
    expect(isStorablePage(html(404))).toBe(false)
    expect(isStorablePage(html(500))).toBe(false)
    expect(isStorablePage(html(200,{'set-cookie':'a=b'}))).toBe(false)
    expect(isStorablePage(new Response('{}',{status:200,headers:{'content-type':'application/json'}}))).toBe(false)
  })
  it('#470: the pricing flag/scope is part of the key; OFF keeps the pre-#470 key', () => {
    const plan=planPageCache(req('/thiet-bi-ve-sinh/chau/a'))!
    const off=pageCacheKey(req('/thiet-bi-ve-sinh/chau/a'),plan,SHA,null).url
    expect(pageCacheKey(req('/thiet-bi-ve-sinh/chau/a'),plan,SHA,null,'off').url).toBe(off)
    const on=pageCacheKey(req('/thiet-bi-ve-sinh/chau/a'),plan,SHA,null,'production:toto').url
    expect(on).not.toBe(off); expect(pageCacheKey(req('/thiet-bi-ve-sinh/chau/a'),plan,SHA,null,'production:toto,inax').url).not.toBe(on)
    expect(()=>pageCacheKey(req('/'),planPageCache(req('/'))!,SHA,null,'production:<x>')).toThrow()
  })
  it('#470: pricing and commerce flags can be ON together (worker builds `<pricing>:<brands>:commerce`) — previously every cacheable page answered 503', () => {
    const plan=planPageCache(req('/thiet-bi-ve-sinh/chau/a'))!
    const key=(variant:string)=>pageCacheKey(req('/thiet-bi-ve-sinh/chau/a'),plan,SHA,null,variant).url
    const both=key('production:toto,inax:commerce')
    expect(both).not.toBe(key('production:toto,inax')); expect(both).not.toBe(key('off:commerce'))
    expect(key('off:commerce')).not.toBe(key('off')); expect(() => key('test:commerce')).not.toThrow()
    for (const bad of ['production:toto:inax','production:toto,inax:commerce:commerce','production:<x>:commerce','production:toto,inax:evil'])
      expect(()=>key(bad)).toThrow('PUBLIC_WORKER_CACHE_PRICING_VARIANT_INVALID')
  })
})
