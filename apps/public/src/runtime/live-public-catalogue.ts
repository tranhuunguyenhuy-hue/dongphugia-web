// Opt-in M1 PostgreSQL read model. Prices/stock are never asserted from
// historical unverified values; original database rows remain intact.
import { cache } from 'react'
import { sanitizeRichHtml } from '@/lib/html-sanitizer'
import { QUARANTINED_VARIANT_GROUPS, VARIANT_SIBLING_CAP, normalizeSeriesSelection, type SeriesFacet } from '@/lib/series-facet-contract'
import { readPublicRows } from './public-db'
import { canonicalPricingMode, canonicalProductionBrands, seriesVariantEnabled } from '@/lib/canonical-price'
import { canonicalPublicPricing, canonicalUnverifiedPricing, inCanonicalScope } from '../../../../scripts/catalogue-direct/public-canonical-pricing.mjs'
import type { SnapshotCategory, SnapshotProduct, SnapshotSearchProduct } from './public-snapshot-catalogue'

export type PublicProductRow = {
  id:number; sku:string; name:string; display_name:string|null; slug:string
  description:string|null; image_main_url:string|null; is_featured:boolean
  variant_group:string|null; variant_type:string|null; variant_label:string|null
  category_name:string; category_slug:string; listing_name:string; listing_slug:string
  brand_name:string|null; brand_slug:string|null; total_count?:number|string
  gallery_images?:{image_url:string}[]|null; description_html?:string|null
  specifications?:Record<string,string>|null; documents?:{name:string;url:string;type:string;size?:number|null}[]|null
  regular_price_vnd?:number|string|null; promotional_price_vnd?:number|string|null; online_voucher_amount_vnd?:number|string|null
  canonical_price_status?:string|null
  product_feature_values?:{product_features:{name:string}}[]|null
}
const COLS='p.id,p.sku,p.name,p.display_name,p.slug,p.description,p.image_main_url,p.is_featured,p.variant_group,p.variant_type,p.variant_label,c.name AS category_name,c.slug AS category_slug,s.name AS listing_name,s.slug AS listing_slug,b.name AS brand_name,b.slug AS brand_slug'
// Pricing modes (see src/lib/canonical-price.ts): 'test' = isolated TEST Preview pilot (unchanged), 'production' = #470 live read,
// only when PUBLIC_CANONICAL_PRICING=on (default OFF). With the flag off every statement below is byte-identical to before.
const testPricingEnabled=()=>canonicalPricingMode()==='test'
const productionPricingEnabled=()=>canonicalPricingMode()==='production'
// Statement context. canonical=false is the schema/permission fail-safe: the statement then references NO canonical column at all
// (SELECT, WHERE and ORDER BY), so in-scope rows become "Cần liên hệ xác nhận giá" and the default order is kept.
type PriceCtx={canonical:boolean;brandsParam:()=>string}
const priceColumns=(ctx:PriceCtx)=>testPricingEnabled()
 ? COLS+',p.regular_price_vnd,p.promotional_price_vnd,p.online_voucher_amount_vnd'
 : productionPricingEnabled()&&ctx.canonical
  ? COLS+',p.regular_price_vnd,p.promotional_price_vnd,p.online_voucher_amount_vnd,p.canonical_price_status' : COLS
// Default order: the TEST pilot keeps its priced-first rule; Production keeps the existing order unchanged (no price-based boost).
const pricePriority=(_ctx:PriceCtx)=>testPricingEnabled()
 ? "CASE WHEN c.slug='thiet-bi-ve-sinh' AND p.regular_price_vnd IS NULL THEN 1 ELSE 0 END," : ''
// Explicit price sort (user-chosen). Production: only a VISIBLE price sorts = same scope as the mapper (sanitary x approved brands,
// bound as a parameter, never interpolated) and PRICE_VERIFIED; every other row follows in the default order. Fail-safe: no price term.
const priceSortTerm=(ctx:PriceCtx,dir:'asc'|'desc')=>{
 const d=dir==='desc'?'DESC':'ASC'
 if(testPricingEnabled())return 'COALESCE(p.promotional_price_vnd,p.regular_price_vnd) '+d+' NULLS LAST,'
 if(!productionPricingEnabled()||!ctx.canonical)return ''
 return "CASE WHEN c.slug='thiet-bi-ve-sinh' AND b.slug=ANY("+ctx.brandsParam()+") AND p.canonical_price_status='PRICE_VERIFIED'"+
  ' THEN COALESCE(p.promotional_price_vnd,p.regular_price_vnd) END '+d+' NULLS LAST,'
}
// #470 fail-safe: if the canonical columns are missing/unreadable (42703/42501/42P01) the SAME statement runs without them.
// Only a retry that SUCCEEDS marks canonical unavailable (60 s per isolate); otherwise the retry's own error propagates untouched.
let canonicalUnavailableUntil=0
type QueryValue=string|number|boolean|readonly string[]
async function readProductRows<T>(build:(ctx:PriceCtx)=>string,values:readonly QueryValue[],label?:Parameters<typeof readPublicRows>[2]):Promise<T[]>{
 const attempt=(canonical:boolean)=>{
  const extra:QueryValue[]=[]
  let brands:string|null=null
  const ctx:PriceCtx={canonical,brandsParam:()=>{if(!brands){extra.push([...canonicalProductionBrands()]);brands='$'+(values.length+extra.length)+'::text[]'}return brands}}
  const sql=build(ctx)
  return readPublicRows<T>(sql,[...values,...extra],label) as Promise<T[]>
 }
 const canonical=productionPricingEnabled()&&Date.now()>=canonicalUnavailableUntil
 try{return await attempt(canonical)}
 catch(error){
  const code=error&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):''
  if(!productionPricingEnabled()||!canonical||!['42703','42501','42P01'].includes(code))throw error
  const rows=await attempt(false)
  canonicalUnavailableUntil=Date.now()+60_000
  console.error(JSON.stringify({event:'PUBLIC_CANONICAL_SCHEMA_UNAVAILABLE',sqlState:code}))
  return rows
 }
}
/** Test hook only: forget the remembered fail-safe window. */
export function resetCanonicalAvailabilityForTests(){canonicalUnavailableUntil=0}
const vnd=(input:number|string|null|undefined)=>{
 const value=Number(input)
 return Number.isSafeInteger(value)&&value>0&&value<=9_999_999_999_999?value:null
}
const FROM=" FROM dpg_app.products p JOIN dpg_app.categories c ON c.id=p.category_id AND c.is_active=true AND c.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' JOIN dpg_app.subcategories s ON s.id=p.subcategory_id AND s.category_id=c.id AND s.is_active=true AND s.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' LEFT JOIN dpg_app.brands b ON b.id=p.brand_id AND b.is_active=true"
// Keep malformed canonical paths out of every Public query. The mapper and
// route layer fail closed on these fields, so letting one row into a page would
// turn a valid listing/search/PDP request into a 503 instead of omitting it.
const PUBLIC_PRODUCT="p.is_active=true AND p.publication_status='public' AND p.pdp_visibility='public' AND p.id>0 AND p.name<>'' AND char_length(p.name)<=240 AND p.sku<>'' AND char_length(p.sku)<=120 AND p.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"
const PUBLIC= " "+PUBLIC_PRODUCT+" AND c.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND s.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"
const LIST=" p.listing_visibility IN ('default','low_priority')"
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROUTE_CATEGORIES=new Set(['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat'])
const HOSTS=new Set(['cdn.dongphugia.com.vn','dpg-products.b-cdn.net','cdn.hita.com.vn','hita.com.vn','vietceramics.com','tygjmrhandbffjllxveu.supabase.co'])
const LEGACY_PRODUCT_CDN='cdn.dongphugia.com.vn'
const PRODUCT_PULL_ZONE_CDN='dpg-products.b-cdn.net'
import { isStagingMediaHost } from './staging-media-host'
function safeImage(s:string|null){
 if(!s||s.length>2048)return null
 if(s.startsWith('/images/')&&!s.includes('..'))return s
 try{const u=new URL(s);if(u.protocol!=='https:'||u.search||u.hash||u.username||u.password||!(HOSTS.has(u.hostname)||isStagingMediaHost(u.hostname))
   ||(u.hostname.endsWith('.supabase.co')&&!u.pathname.startsWith('/storage/v1/object/public/')))return null
  // The legacy custom hostname is a documented alias for this Bunny Pull Zone,
  // but its TLS endpoint rejects modern clients. Match snapshot-mode delivery.
  if(u.hostname===LEGACY_PRODUCT_CDN)u.hostname=PRODUCT_PULL_ZONE_CDN
  return u.href
 }catch{return null}
}
function normalizeProductHtmlImages(html:string){
 return html.replace(/(\bsrc\s*=\s*)(["'])([^"']+)\2/gi,(whole,prefix:string,quote:string,raw:string)=>{
  const normalized=safeImage(raw)
  return normalized?`${prefix}${quote}${normalized}${quote}`:whole
 })
}
// #470: the ONE price DTO shared with the snapshot projection (scripts/catalogue-direct/public-canonical-pricing.mjs).
// Fail-safe: anything inconsistent or missing becomes "Cần liên hệ xác nhận giá"; legacy columns are never read.
function productionPricing(row:PublicProductRow){
 try{return canonicalPublicPricing(row,{requireFresh:false})}catch{return canonicalUnverifiedPricing()}
}
export function mapLiveProduct(row:PublicProductRow):SnapshotProduct{
 if(!Number.isSafeInteger(row.id)||row.id<=0||![row.category_slug,row.listing_slug,row.slug].every(s=>SLUG.test(s))
   ||!row.name||row.name.length>240||!row.sku||row.sku.length>120)throw Error('PUBLIC_PRODUCT_DB_ROW_INVALID')
 const sanitaryTest=testPricingEnabled()&&row.category_slug==='thiet-bi-ve-sinh'
 const production=productionPricingEnabled()&&inCanonicalScope({category_slug:row.category_slug,brand_slug:row.brand_slug},{categories:['thiet-bi-ve-sinh'],brands:canonicalProductionBrands()})
 const regular=sanitaryTest?vnd(row.regular_price_vnd):null
 const suppliedPromo=vnd(row.promotional_price_vnd)
 const promo=regular!==null&&suppliedPromo!==null&&suppliedPromo<regular?suppliedPromo:null
 const selling=promo??regular
 const suppliedVoucher=vnd(row.online_voucher_amount_vnd)
 const voucher=selling!==null&&suppliedVoucher!==null&&suppliedVoucher<selling?suppliedVoucher:null
 const image=safeImage(row.image_main_url)
 const brand=row.brand_name&&row.brand_slug&&SLUG.test(row.brand_slug)?{name:row.brand_name,slug:row.brand_slug}:null
 return {
  id:row.id,sku:row.sku,name:row.name,display_name:row.display_name||row.name,slug:row.slug,
  price:selling,price_display:selling===null?'Liên hệ báo giá':null,stock_status:'contact',image_main_url:image,
  ...(sanitaryTest?{list_price:regular,original_price:regular,sale_price:promo,online_discount_amount:voucher,price_provenance:'hita-exact-test'}:{}),
  is_active:true,is_featured:Boolean(row.is_featured),is_promotion:promo!==null,variant_options:[],
  ...(production?productionPricing(row):{}),
  categories:{name:row.category_name,slug:row.category_slug},subcategories:{name:row.listing_name,slug:row.listing_slug},
  brands:brand,canonical_category_slug:row.category_slug,canonical_subcategory_slug:row.listing_slug,
  url:'/'+row.category_slug+'/'+row.listing_slug+'/'+row.slug,
  publicContent:{summary:row.description?.slice(0,12000)||null,descriptionBlocks:[],specifications:{},
   gallery:image?[image]:[],referencePrice:null},
  ...(row.variant_group?{variant_group:row.variant_group}:{}),
  ...(row.variant_type==='size'||row.variant_type==='seat_type'?{variant_type:row.variant_type}:{}),
  ...(row.variant_label?{variant_label:row.variant_label}:{}),
 }
}
export type LiveListingFilters={brandSlugs?:readonly string[];featured?:boolean;seriesSlugs?:readonly string[];priceSort?:'asc'|'desc'}
// #432: a product matches a series tag only through an approved option of spec "Bộ sưu tập" (never legacy text) AND the option's brand namespace equals the product's brand.
const SERIES_MATCH=" EXISTS (SELECT 1 FROM dpg_app.product_spec_values sv JOIN dpg_app.spec_definitions sd ON sd.id=sv.spec_definition_id AND sd.key='Bộ sưu tập'"+
 " JOIN dpg_app.spec_options so ON so.id=sv.option_id AND so.is_active=true WHERE sv.product_id=p.id AND so.slug=ANY($7::text[]) AND left(so.slug,length(b.slug)+1)=b.slug||'-')"
export const getLiveListing=cache(async(category:string,listing:string,page=1,pageSize=48,filters:LiveListingFilters={})=>{
 const brandSlugs=[...(filters.brandSlugs??[])]
 if(![category,listing].every(s=>SLUG.test(s))||!Number.isSafeInteger(page)||page<1||page>512||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>48)
  return {products:[] as SnapshotProduct[],totalCount:0,page}
 if(brandSlugs.length>32||brandSlugs.some(slug=>!SLUG.test(slug)))return {products:[] as SnapshotProduct[],totalCount:0,page}
 // A series tag without a selected brand (or of another brand) is ignored; it never produces an odd/empty result.
 const seriesSlugs=seriesVariantEnabled()?normalizeSeriesSelection(brandSlugs,[...(filters.seriesSlugs??[])].filter(s=>SLUG.test(s))).accepted.slice(0,16):[]
 // One product (SKU) = one row = one card. Series is a filter on SKUs, never a grouping.
 const priceSort=(testPricingEnabled()||productionPricingEnabled())&&category==='thiet-bi-ve-sinh'&&filters.priceSort
 const rows=await readProductRows<PublicProductRow>(c=>{
  const priceOrder=priceSort?priceSortTerm(c,priceSort):pricePriority(c)
  return 'SELECT '+priceColumns(c)+',count(*) OVER() AS total_count'+FROM+
   ' WHERE '+PUBLIC+' AND '+LIST+' AND c.slug=$1 AND s.slug=$2'+
   ' AND (cardinality($5::text[])=0 OR b.slug=ANY($5::text[]))'+
   ' AND (NOT $6::boolean OR p.is_featured=true)'+
   (seriesVariantEnabled()?' AND (cardinality($7::text[])=0 OR'+SERIES_MATCH+')':' AND cardinality($7::text[])=0')+   // series OFF: statement never references the series spec tables
   ' ORDER BY '+priceOrder+'p.listing_priority DESC NULLS LAST,p.sort_order,p.id LIMIT $4 OFFSET $3'},
   [category,listing,(page-1)*pageSize,pageSize,brandSlugs,filters.featured===true,seriesSlugs], 'listing-page')
 return {products:rows.map(mapLiveProduct),totalCount:Number(rows[0]?.total_count??0),page}
})
// Category roots show eight cards and up to eight featured cards from the same
// first listing. Keep the original 48-row selection for identical ordering,
// while avoiding a full-listing window count that the root never uses.
export const getLiveListingPreview=cache(async(category:string,listing:string)=>{
 if(![category,listing].every(s=>SLUG.test(s)))return [] as SnapshotProduct[]
 const rows=await readProductRows<PublicProductRow>(c=>'SELECT '+priceColumns(c)+FROM+
   ' WHERE '+PUBLIC+' AND '+LIST+' AND c.slug=$1 AND s.slug=$2'+
   ' ORDER BY '+pricePriority(c)+'p.listing_priority DESC NULLS LAST,p.sort_order,p.id LIMIT $3',
   [category,listing,48], 'category-root-featured')
 return rows.map(mapLiveProduct)
})
type ListingLeaf={slug:string;name:string;totalCount:number}
export const getLiveListingLeaves=cache(async(category:string):Promise<ListingLeaf[]>=>{
 if(!ROUTE_CATEGORIES.has(category)||!SLUG.test(category))return []
 const rows=await readPublicRows<{slug:string;name:string;total_count:number|string}>(
  'SELECT s.slug,s.name,count(p.id) AS total_count'+
  ' FROM dpg_app.categories c JOIN dpg_app.subcategories s ON s.category_id=c.id'+
  ' JOIN dpg_app.products p ON p.category_id=c.id AND p.subcategory_id=s.id'+
  ' WHERE c.is_active=true AND c.slug=$1 AND s.is_active=true'+
  " AND c.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND s.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"+
  ' AND '+PUBLIC_PRODUCT+' AND '+LIST+
  ' GROUP BY s.id,s.slug,s.name HAVING count(p.id)>0 ORDER BY s.name,s.slug LIMIT 100',
  [category], 'listing-leaves')
 return rows.flatMap(row=>{
  const totalCount=Number(row.total_count)
  return SLUG.test(row.slug)&&typeof row.name==='string'&&row.name.length>0&&row.name.length<=240
   &&Number.isSafeInteger(totalCount)&&totalCount>0?[{slug:row.slug,name:row.name,totalCount}]:[]
 })
})
type ListingRouteMetadata={categoryName:string;listingName:string}
export const getLiveListingRouteMetadata=cache(async(category:string,listing:string):Promise<ListingRouteMetadata|null>=>{
 if(!ROUTE_CATEGORIES.has(category)||!SLUG.test(category)||!SLUG.test(listing))return null
 const rows=await readPublicRows<ListingRouteMetadata>(
  'SELECT c.name AS "categoryName",s.name AS "listingName" FROM dpg_app.categories c'+
  ' JOIN dpg_app.subcategories s ON s.category_id=c.id AND s.is_active=true'+
  " AND s.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"+
  ' WHERE c.is_active=true AND c.slug=$1 AND s.slug=$2'+
  ' AND EXISTS (SELECT 1 FROM dpg_app.products p WHERE p.category_id=c.id AND p.subcategory_id=s.id'+
  ' AND '+PUBLIC_PRODUCT+' AND '+LIST+') LIMIT 1',
  [category,listing], 'listing-route-metadata')
 const row=rows[0]
 return row&&typeof row.categoryName==='string'&&row.categoryName.length>0&&row.categoryName.length<=240
  &&typeof row.listingName==='string'&&row.listingName.length>0&&row.listingName.length<=240
  ?{categoryName:row.categoryName,listingName:row.listingName}:null
})
type Count={category_slug:string;category_name:string;listing_slug:string;listing_name:string;total_count:number|string}
type Brand={category_slug:string;slug:string;name:string}
export const getLiveCategories=cache(async():Promise<SnapshotCategory[]>=>{
 return loadLiveCategories()
})
export const getLiveCategory=cache(async(category:string):Promise<SnapshotCategory|null>=>{
 if(!ROUTE_CATEGORIES.has(category))return null
 return (await loadLiveCategories(category))[0]??null
})
async function loadLiveCategories(categoryFilter?:string):Promise<SnapshotCategory[]> {
 const categoryClause=categoryFilter?' AND c.slug=$1':''
 const values=categoryFilter?[categoryFilter]:[]
 const rows=await readPublicRows<Count>('SELECT c.slug AS category_slug,c.name AS category_name,s.slug AS listing_slug,'+
  's.name AS listing_name,count(p.id) AS total_count'+FROM+' WHERE '+PUBLIC+' AND '+LIST+categoryClause+
  ' GROUP BY c.slug,c.name,s.slug,s.name HAVING count(p.id)>0 ORDER BY c.slug,s.name LIMIT 100',values,
  'category-listing-counts')
 // Brand facets (single-category page only) and the first-listing preview are independent
 // once the listing counts are known: run them together instead of three serial round-trips.
 const categorySlugs=categoryFilter?[categoryFilter]:['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat']
 const brandsPromise=categoryFilter
  ?readPublicRows<Brand>('SELECT DISTINCT c.slug AS category_slug,b.slug,b.name'+FROM+
    ' WHERE '+PUBLIC+' AND '+LIST+categoryClause+' AND b.slug IS NOT NULL ORDER BY c.slug,b.slug LIMIT 500',values,
    'category-brand-facets')
  :Promise.resolve([] as Brand[])
 brandsPromise.catch(()=>undefined) // awaited below; avoids an unhandled rejection when no category matches
 const result=await Promise.all(categorySlugs.map(async (slug): Promise<SnapshotCategory | null>=>{
  const byCategory=rows.filter(r=>r.category_slug===slug)
  if(!byCategory.length)return null
  const listings=byCategory.map(r=>({slug:r.listing_slug,name:r.listing_name,thumbnail_url:null,totalCount:Number(r.total_count)}))
  const [first,brands]=await Promise.all([getLiveListingPreview(slug,listings[0].slug),brandsPromise])
  return {slug,name:byCategory[0].category_name,listings,
   homeProducts:first.slice(0,8),
   featuredProducts:first.filter(p=>p.is_featured).slice(0,8),
   totalCount:listings.reduce((n,l)=>n+l.totalCount,0),
   brands:brands.filter(b=>b.category_slug===slug).map(b=>({slug:b.slug,name:b.name}))}
 }))
 return result.filter((x):x is SnapshotCategory=>x!==null)
}

export const getLiveBrandsForListing=cache(async(category:string,listing:string)=>{
 if(![category,listing].every(s=>SLUG.test(s)))return [] as {slug:string;name:string}[]
 return readPublicRows<{slug:string;name:string}>(
  'SELECT DISTINCT b.slug,b.name'+FROM+' WHERE '+PUBLIC+' AND '+LIST+
  ' AND c.slug=$1 AND s.slug=$2 AND b.slug IS NOT NULL ORDER BY b.slug LIMIT 32',
  [category,listing], 'listing-brand-facets')
})
const detailSelect=`
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url',i.image_url) ORDER BY i.sort_order,i.id),'[]'::jsonb)
   FROM (SELECT id,image_url,sort_order FROM dpg_app.product_images WHERE product_id=p.id ORDER BY sort_order,id LIMIT 12) i) AS gallery_images,
  (SELECT pd.clean_html FROM dpg_app.product_descriptions pd WHERE pd.product_id=p.id ORDER BY pd.updated_at DESC,pd.id DESC LIMIT 1) AS description_html,
  (SELECT jsonb_object_agg(v.label,v.value) FROM (
    SELECT sd.label,COALESCE(NULLIF(BTRIM(psv.value_text),''),psv.value_number::text,so.value,psv.value_json#>>'{}',NULLIF(BTRIM(psv.raw_value),'')) AS value
    FROM dpg_app.product_spec_values psv
    JOIN dpg_app.spec_definitions sd ON sd.id=psv.spec_definition_id AND sd.is_pdp_visible=true
    LEFT JOIN dpg_app.spec_options so ON so.id=psv.option_id
    WHERE psv.product_id=p.id
    ORDER BY psv.sort_order,psv.id LIMIT 60
  ) v WHERE v.value IS NOT NULL) AS specifications,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',d.name,'url',d.url,'type',d.document_type,'size',d.file_size) ORDER BY d.sort_order,d.id),'[]'::jsonb)
   FROM (SELECT id,name,url,document_type,file_size,sort_order FROM dpg_app.product_documents WHERE product_id=p.id ORDER BY sort_order,id LIMIT 24) d) AS documents,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_features',jsonb_build_object('name',f.name)) ORDER BY f.sort_order,f.id),'[]'::jsonb)
   FROM (SELECT f.name,f.sort_order,f.id FROM dpg_app.product_feature_values fv JOIN dpg_app.product_features f ON f.id=fv.feature_id WHERE fv.product_id=p.id ORDER BY f.sort_order,f.id LIMIT 3) f) AS product_feature_values`

// Protected M2 exporter reuses exactly the Public SELECT projection and mapper.
// The query is never called from the browser or from staging.
export const M1_PUBLIC_CAPTURE_SQL = 'SELECT '+COLS+','+detailSelect+
  ",p.listing_visibility IN ('default','low_priority') AS listing_eligible,p.search_visibility='visible' AS search_eligible,p.listing_priority AS capture_priority,p.sort_order AS capture_sort_order"+
  FROM+' WHERE '+PUBLIC+' AND p.id>$1 ORDER BY p.id LIMIT $2'
export const M1_PUBLIC_CATEGORY_CAPTURE_SQL = 'SELECT c.slug AS category_slug,c.name AS category_name,s.slug AS listing_slug,'+
  's.name AS listing_name,count(p.id)::integer AS total_count'+FROM+' WHERE '+PUBLIC+' AND '+LIST+
  ' GROUP BY c.slug,c.name,s.slug,s.name HAVING count(p.id)>0 ORDER BY c.slug,s.name LIMIT 100'

export function mapLiveProductDetail(row: PublicProductRow) {
 const product=mapLiveProduct(row)
 const gallery=[...new Set([product.image_main_url,...(row.gallery_images??[]).map(i=>safeImage(i.image_url))]
  .filter((s):s is string=>Boolean(s)))]
 const specifications=Object.fromEntries(Object.entries(row.specifications??{}).filter(([key,value])=>key.trim()&&value.trim()).slice(0,60))
 const documents=(row.documents??[]).flatMap(doc=>{
  const url=safeImage(doc.url)
  return url&&doc.name&&doc.name.length<=240? [{name:doc.name.slice(0,240),url,type:doc.type.slice(0,80),size:doc.size===null||doc.size===undefined?'':String(doc.size)}]:[]
 })
 const descriptionHtml=row.description_html
  ?sanitizeRichHtml(normalizeProductHtmlImages(row.description_html)):undefined
 return {...product,product_feature_values:row.product_feature_values??[],publicContent:{...product.publicContent!,gallery,
  specifications,...(descriptionHtml?{descriptionHtml}:{}),documents},imageUrl:product.image_main_url,
  brand:product.brands??{name:'',slug:''},categoryName:product.categories.name,listingName:product.subcategories.name,
  categoryPath:'/'+product.categories.slug,listingPath:'/'+product.categories.slug+'/'+product.subcategories.slug,productPath:product.url,priceDisplay:product.price_display}
}

const loadLiveProduct=async(where:string,values:readonly string[])=>{
 const rows=await readProductRows<PublicProductRow>(c=>'SELECT '+priceColumns(c)+','+detailSelect+FROM+' WHERE '+PUBLIC+' '+where+' LIMIT 1',values)
 return rows.length?mapLiveProductDetail(rows[0]):null
}
export const getLiveProduct=cache(async(category:string,listing:string,slug:string)=>{
 if(![category,listing,slug].every(s=>SLUG.test(s)))return null
 return loadLiveProduct('AND c.slug=$1 AND s.slug=$2 AND p.slug=$3',[category,listing,slug])
})
export const getLiveProductByCategory=cache(async(category:string,slug:string)=>{
 if(![category,slug].every(s=>SLUG.test(s)))return null
 return loadLiveProduct('AND c.slug=$1 AND p.slug=$2',[category,slug])
})
export async function searchLiveProducts(raw:string,page:number,limit:number){
 const query=raw.trim().slice(0,120)
 if(query.length<2||!Number.isSafeInteger(page)||page<1||page>100||!Number.isSafeInteger(limit)||limit<1||limit>48)
  return {results:[] as SnapshotSearchProduct[],total:0,page,limit,query}
 const rows=await readProductRows<PublicProductRow>(c=>'SELECT '+priceColumns(c)+',count(*) OVER() AS total_count'+FROM+
  ' WHERE '+PUBLIC+" AND p.search_visibility='visible' AND (p.sku ILIKE $1 OR p.name ILIKE $1)"+
  " ORDER BY CASE WHEN lower(p.sku)=lower($2) THEN 0 WHEN lower(p.sku) LIKE lower($2)||'%' THEN 1 ELSE 2 END,p.name,p.id"+
  ' LIMIT $3 OFFSET $4',['%'+query+'%',query,limit,(page-1)*limit], 'public-search')
 const results=rows.map(row=>{
  const p=mapLiveProduct(row)
  return {id:p.id,sku:p.sku,name:p.name,slug:p.slug,url:p.url,price:p.price,original_price:p.original_price??null,
   list_price:p.list_price??null,sale_price:p.sale_price??null,online_discount_amount:p.online_discount_amount??null,final_online_price:p.final_online_price??null,
   price_display:p.price_display,image_main_url:p.image_main_url,
   ...(p.price_provenance?{price_provenance:p.price_provenance}:{}),
   category_slug:p.categories.slug,subcategory_slug:p.subcategories.slug,
   brand_name:p.brands?.name??null,product_feature_values:[],colors:null} satisfies SnapshotSearchProduct
 })
 return {results,total:Number(rows[0]?.total_count??0),page,limit,query}
}
// #432: siblings are the public SKUs of the SAME variant group, same brand and same sub-category as the current SKU.
// Never the whole series. A group is excluded when it is in the reviewed-wrong list (#431 D5) or when its public members
// carry two different approved series (mixed group). No prefix guessing; cap is a safety bound, not a 8-item truncation.
export async function getLiveVariantSiblings(group:string,currentId:number){
 if(!seriesVariantEnabled())return [] as SnapshotProduct[]   // #470: variants not accepted yet -> no query
 try{return await loadVariantSiblings(group,currentId)}catch(error){
  // #470 finding: the Production public role cannot read spec_definitions.key / spec_options.slug (the #432 series grants are not applied).
  // Without them a PDP must degrade to "no siblings" instead of a 5xx. Any other error still propagates.
  if(error&&typeof error==='object'&&'code' in error&&(error as {code:unknown}).code==='42501'){console.error(JSON.stringify({event:'PUBLIC_VARIANT_SIBLINGS_UNAVAILABLE',sqlState:'42501'}));return [] as SnapshotProduct[]}
  throw error
 }
}
async function loadVariantSiblings(group:string,currentId:number){
 if(!group||group.length>100||!Number.isSafeInteger(currentId)||QUARANTINED_VARIANT_GROUPS.includes(group))return [] as SnapshotProduct[]
 const rows=await readProductRows<PublicProductRow>(c=>'SELECT '+priceColumns(c)+FROM+' WHERE '+PUBLIC+
  ' AND p.variant_group=$1 AND p.id<>$2'+
  ' AND p.brand_id IS NOT NULL AND p.brand_id=(SELECT cur.brand_id FROM dpg_app.products cur WHERE cur.id=$2)'+
  ' AND p.subcategory_id=(SELECT cur.subcategory_id FROM dpg_app.products cur WHERE cur.id=$2)'+
  ' AND (SELECT count(DISTINCT sv.option_id) FROM dpg_app.product_spec_values sv'+
  " JOIN dpg_app.spec_definitions sd ON sd.id=sv.spec_definition_id AND sd.key='Bộ sưu tập'"+
  ' JOIN dpg_app.products m ON m.id=sv.product_id'+
  " WHERE m.variant_group=$1 AND m.is_active=true AND m.publication_status='public' AND m.pdp_visibility='public' AND sv.option_id IS NOT NULL)<=1"+
  ' ORDER BY p.sort_order,p.id LIMIT '+VARIANT_SIBLING_CAP,[group,currentId],'variant-siblings')
 return rows.map(mapLiveProduct)
}
/**
 * #470 legacy path (regression guard vs the live baseline e070986a): while the series/variant gate (#432/#433/#440) is OFF the PDP keeps the
 * variant chips that already exist on live. Same variant group, same brand, same sub-category, public only, quarantined groups excluded,
 * bounded to the legacy cap of 8. Touches ONLY columns the Production public role already has (no spec_definitions / spec_options / product_spec_values),
 * so it needs none of the #432 grants and cannot 5xx on them. No series logic, no URL/SEO/filter change.
 */
const LEGACY_VARIANT_CAP=8
export async function getLiveLegacyVariantSiblings(group:string,currentId:number){
 if(!group||group.length>100||!Number.isSafeInteger(currentId)||QUARANTINED_VARIANT_GROUPS.includes(group))return [] as SnapshotProduct[]
 const rows=await readProductRows<PublicProductRow>(c=>'SELECT '+priceColumns(c)+FROM+' WHERE '+PUBLIC+
  ' AND p.variant_group=$1 AND p.id<>$2'+
  ' AND p.brand_id IS NOT NULL AND p.brand_id=(SELECT cur.brand_id FROM dpg_app.products cur WHERE cur.id=$2)'+
  ' AND p.subcategory_id=(SELECT cur.subcategory_id FROM dpg_app.products cur WHERE cur.id=$2)'+
  ' ORDER BY p.sort_order,p.id LIMIT '+LEGACY_VARIANT_CAP,[group,currentId],'variant-siblings')
 return rows.map(mapLiveProduct)
}
/** Label of the CURRENT SKU on the variant axis (DB column only, never inferred from the name). */
export async function getLiveVariantLabel(currentId:number):Promise<string|null>{
 if(!Number.isSafeInteger(currentId))return null
 const rows=await readPublicRows<{variant_label:string|null}>('SELECT p.variant_label FROM dpg_app.products p WHERE p.id=$1 AND '+PUBLIC_PRODUCT,[currentId],'variant-siblings')
 return rows[0]?.variant_label??null
}
/**
 * "Dòng sản phẩm" facet. Applicable only with ≥1 selected brand. Options = approved series of the selected brands that have
 * ≥1 PUBLIC listing-visible SKU in (category ∩ listing ∩ brands ∩ featured). Counts are SKU counts. The facet's own selection
 * is not applied to its counts (standard facet semantics), so users can add more tags (OR).
 */
export async function getLiveSeriesFacet(category:string,listing:string,brandSlugs:readonly string[],selectedSeries:readonly string[]=[],opts:{featured?:boolean}={}):Promise<SeriesFacet>{
 const none:SeriesFacet={applicable:false,options:[],selected:[],dropped:[...selectedSeries]}
 if(!seriesVariantEnabled())return none   // #470: series filter not accepted yet -> no query
 if(![category,listing].every(s=>SLUG.test(s))||brandSlugs.length===0||brandSlugs.length>32||brandSlugs.some(s=>!SLUG.test(s)))return none
 // #470 finding (same as siblings): the Production public role cannot read spec_definitions.key / spec_options.slug (#432 grants not
 // applied). Degrade to "no series facet" (the page then drops any ?dong= and redirects) instead of a 5xx on brand-filtered PLPs.
 let rows:{slug:string;name:string;brand_slug:string;sku_count:number|string}[]
 try{ rows=await readPublicRows<{slug:string;name:string;brand_slug:string;sku_count:number|string}>(
  'SELECT so.slug,so.value AS name,b.slug AS brand_slug,count(DISTINCT p.id) AS sku_count'+FROM+
  ' JOIN dpg_app.product_spec_values sv ON sv.product_id=p.id'+
  " JOIN dpg_app.spec_definitions sd ON sd.id=sv.spec_definition_id AND sd.key='Bộ sưu tập'"+
  ' JOIN dpg_app.spec_options so ON so.id=sv.option_id AND so.is_active=true'+
  ' WHERE '+PUBLIC+' AND '+LIST+' AND c.slug=$1 AND s.slug=$2 AND b.slug=ANY($3::text[])'+
  ' AND (NOT $4::boolean OR p.is_featured=true)'+
  " AND left(so.slug,length(b.slug)+1)=b.slug||'-'"+
  ' GROUP BY so.slug,so.value,b.slug,so.sort_order ORDER BY b.slug,so.sort_order,so.value LIMIT 100',
  [category,listing,[...brandSlugs],opts.featured===true],'listing-series-facets') }
 catch(error){
  if(error&&typeof error==='object'&&'code' in error&&(error as {code:unknown}).code==='42501'){console.error(JSON.stringify({event:'PUBLIC_SERIES_FACET_UNAVAILABLE',sqlState:'42501'}));return none}
  throw error
 }
 const options=rows.flatMap(r=>SLUG.test(r.slug)&&SLUG.test(r.brand_slug)&&Number(r.sku_count)>0
  ?[{slug:r.slug,name:r.name,brandSlug:r.brand_slug,count:Number(r.sku_count),selected:selectedSeries.includes(r.slug)}]:[])
 const valid=new Set(options.map(o=>o.slug))
 return {applicable:options.length>0,options,selected:selectedSeries.filter(s=>valid.has(s)),dropped:selectedSeries.filter(s=>!valid.has(s))}
}

// Sitemap data (#360): bounded shards, same public/visibility predicates as every Public page,
// so draft/inactive/non-public products can never be listed.
export const SITEMAP_PRODUCTS_PER_SHARD=2000
export async function getLiveSitemapProductCount():Promise<number>{
 const rows=await readPublicRows<{n:number|string}>('SELECT count(p.id) AS n'+FROM+' WHERE '+PUBLIC,[],'other')
 return Number(rows[0]?.n??0)
}
// The Production Public role has column-level SELECT without products.updated_at, so product
// shards carry no <lastmod> (read only granted columns; never widen the role for a sitemap).
export async function getLiveSitemapProducts(shard:number):Promise<{path:string}[]>{
 if(!Number.isSafeInteger(shard)||shard<1||shard>1000)return []
 const rows=await readPublicRows<{category_slug:string;listing_slug:string;slug:string}>(
  'SELECT c.slug AS category_slug,s.slug AS listing_slug,p.slug'+FROM+' WHERE '+PUBLIC+
  ' ORDER BY p.id LIMIT '+SITEMAP_PRODUCTS_PER_SHARD+' OFFSET $1',[(shard-1)*SITEMAP_PRODUCTS_PER_SHARD],'other')
 return rows.filter(r=>[r.category_slug,r.listing_slug,r.slug].every(v=>SLUG.test(v))).map(r=>({
  path:'/'+r.category_slug+'/'+r.listing_slug+'/'+r.slug,
 }))
}
export async function getLiveSitemapListings():Promise<{path:string}[]>{
 const rows=await readPublicRows<Count>('SELECT c.slug AS category_slug,c.name AS category_name,s.slug AS listing_slug,'+
  's.name AS listing_name,count(p.id) AS total_count'+FROM+' WHERE '+PUBLIC+' AND '+LIST+
  ' GROUP BY c.slug,c.name,s.slug,s.name HAVING count(p.id)>0 ORDER BY c.slug,s.slug LIMIT 500',[],'category-listing-counts')
 return [...new Set(rows.map(r=>'/'+r.category_slug))].map(path=>({path}))
  .concat(rows.map(r=>({path:'/'+r.category_slug+'/'+r.listing_slug})))
}
