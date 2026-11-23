'use client'

import {useTransition} from 'react'
import {usePathname,useRouter,useSearchParams} from 'next/navigation'
import {notifySearchParamsChange,useLiveSearchParams} from '@/components/category/use-live-search-params'

// serverSort: the listing is rendered on the server (live TEST data), so changing the sort must navigate through the Next
// router to re-render it. Without it (snapshot listings, other categories) the previous client-only behaviour is kept.
export function CategorySort({serverSort=false}:{serverSort?:boolean}={}){
 const router=useRouter()
 const [pending,startTransition]=useTransition()
 const pathname=usePathname()
 const routerSearch=useSearchParams()
 const search=useLiveSearchParams(routerSearch.toString())
 const sort=search.get('sort')??'default'
 return <label className="text-[11px] text-neutral-600">
  <span className="sr-only">Sắp xếp sản phẩm</span>
  <select aria-label="Sắp xếp sản phẩm" value={sort} onChange={event=>{
   const next=new URLSearchParams(search.toString())
   if(event.target.value==='default')next.delete('sort')
   else next.set('sort',event.target.value)
   next.set('page','1')
   const href=`${pathname}?${next}`
   if(serverSort)startTransition(()=>{router.push(href,{scroll:false})})
   else{window.history.pushState(null,'',href);notifySearchParamsChange()}
  }} aria-busy={pending} className="h-8 rounded-md border border-neutral-300 bg-white px-2">
   <option value="default">Sắp xếp mặc định</option>
   <option value="price-asc">Giá tăng dần</option>
   <option value="price-desc">Giá giảm dần</option>
  </select>
 </label>
}
