import { createHash } from 'node:crypto'
import type { SnapshotCategory, SnapshotProduct, SnapshotSearchProduct } from '../../apps/public/src/runtime/public-snapshot-catalogue'
import type { LegacyBlogCategory, PublicLegacyBlogPost } from '../../apps/public/src/runtime/legacy-blog'

const CONTRACT = 'dpg:public-catalogue-snapshot:v1'
const PRODUCT_KEYS = new Set(['id','name','display_name','slug','sku','price','price_display','stock_status','image_main_url','is_active','is_featured','is_promotion','variant_options','categories','subcategories','brands','canonical_category_slug','canonical_subcategory_slug','url','publicContent','variant_group','variant_type','variant_label','product_feature_values'])
const ROOTS = ['thiet-bi-ve-sinh', 'thiet-bi-bep', 'vat-lieu-nuoc', 'gach-op-lat']
export type CaptureEntry = { product: SnapshotProduct; card: SnapshotProduct; listed: boolean; searchable: boolean; priority: number | null; order: number | null }
export type CaptureCategory = { category_slug: string; category_name: string; listing_slug: string; listing_name: string; total_count: number }
export type PublicCapture = { sourceSha: string; productionSourceSha: string; capturedAt: string; entries: CaptureEntry[]; categories: CaptureCategory[]; posts: readonly PublicLegacyBlogPost[]; blogCategories: readonly LegacyBlogCategory[] }

export function buildM2PublicSnapshot(capture: PublicCapture) {
  if (![capture.sourceSha, capture.productionSourceSha].every(v => /^[a-f0-9]{40}$/.test(v))
    || !Number.isFinite(Date.parse(capture.capturedAt)) || !capture.entries.length) throw new Error('M2_CAPTURE_IDENTITY_REQUIRED')
  const checkpoint = createHash('sha256').update(JSON.stringify(capture)).digest('hex').slice(0, 40)
  const entries = structuredClone(capture.entries)
  const ids = new Set<number>(), paths = new Set<string>()
  const productPathsBySlug: Record<string, string> = {}
  const rawGroups = [...new Set(entries.flatMap(e => e.product.variant_group ? [e.product.variant_group] : []))].sort()
  const groups = new Map(rawGroups.map((name, index) => [name, `public-${index + 1}`]))
  const variants = new Map<string, SnapshotProduct[]>()
  for (const entry of entries) {
    const p = entry.product
    if ([p, entry.card].some(value => Object.keys(value).some(key => !PRODUCT_KEYS.has(key)))
      || !Number.isSafeInteger(p.id) || p.id < 1 || ids.has(p.id) || paths.has(p.url)
      || !ROOTS.includes(p.categories.slug) || p.url !== `/${p.categories.slug}/${p.subcategories.slug}/${p.slug}`
      || ![p.categories.slug, p.subcategories.slug, p.slug].every(s => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))
      || p.price !== null || p.stock_status !== 'contact') throw new Error('M2_CAPTURE_PUBLIC_PRODUCT_INVALID')
    const slugKey = `${p.categories.slug}/${p.slug}`
    if (Object.hasOwn(productPathsBySlug, slugKey)) throw new Error('M2_CAPTURE_DUPLICATE_CATEGORY_SLUG')
    productPathsBySlug[slugKey] = p.subcategories.slug
    ids.add(p.id); paths.add(p.url)
    // Browser listing shards intentionally carry only the narrow card DTO.
    delete entry.card.publicContent
    if (p.variant_group) {
      const group = groups.get(p.variant_group)!
      p.variant_group = group; entry.card.variant_group = group
      if (!variants.has(group)) variants.set(group, [])
      variants.get(group)!.push(entry.card)
    }
  }
  const compare = (a: CaptureEntry, b: CaptureEntry) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity)
    || (a.order ?? Infinity) - (b.order ?? Infinity) || a.product.id - b.product.id
  const assets = new Map<string, unknown>()
  const envelope = <T extends object>(value: T) => ({ contract: CONTRACT, checkpoint, ...value })
  const buckets = new Map<string, SnapshotProduct[]>()
  for (const { product } of entries) {
    const key = createHash('sha256').update(product.url).digest('hex').slice(0, 2)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(product)
  }
  for (const [key, products] of buckets) assets.set(`products/${key}.json`, envelope({ products }))
  const categories: SnapshotCategory[] = ROOTS.map(slug => {
    const metadata = capture.categories.filter(c => c.category_slug === slug)
    if (!metadata.length) throw new Error('M2_CAPTURE_CATEGORY_MISSING')
    const listed = entries.filter(e => e.listed && e.product.categories.slug === slug).sort(compare)
    const listings = metadata.map(m => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.listing_slug) || !Number.isSafeInteger(m.total_count) || m.total_count < 1) throw new Error('M2_CAPTURE_LISTING_INVALID')
      const products = listed.filter(e => e.product.subcategories.slug === m.listing_slug).map(e => e.card)
      if (!products.length || products.length !== m.total_count) throw new Error('M2_CAPTURE_LISTING_COUNT_MISMATCH')
      assets.set(`listing-index/${slug}/${m.listing_slug}.json`, envelope({ products }))
      for (let offset = 0; offset < products.length; offset += 48) assets.set(`listings/${slug}/${m.listing_slug}/${offset / 48 + 1}.json`, envelope({ page: offset / 48 + 1, totalCount: products.length, products: products.slice(offset, offset + 48) }))
      return { slug: m.listing_slug, name: m.listing_name, thumbnail_url: null, totalCount: products.length }
    })
    if (listings.reduce((n, l) => n + l.totalCount, 0) !== listed.length) throw new Error('M2_CAPTURE_UNDECLARED_LISTING')
    const first = listed.filter(e => e.product.subcategories.slug === listings[0].slug).slice(0, 48).map(e => e.card)
    const brands = new Map(listed.flatMap(({ card }) => card.brands ? [[card.brands.slug, card.brands] as const] : []))
    return { slug, name: metadata[0].category_name, listings, totalCount: listed.length, homeProducts: first.slice(0, 8), featuredProducts: first.filter(p => p.is_featured).slice(0, 8), brands: [...brands.values()].sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, 500) }
  })
  for (const [group, products] of variants) {
    products.sort((a, b) => a.id - b.id)
    assets.set(`variants/${group}.json`, envelope({ memberIds: products.map(p => p.id), products: products.slice(0, 9) }))
  }
  const search: SnapshotSearchProduct[][] = [[], [], [], []]
  for (const { card: p, searchable } of entries) if (searchable) search[p.id % 4].push({
    id: p.id, sku: p.sku, name: p.name, slug: p.slug, url: p.url, price: null, original_price: null,
    list_price: null, sale_price: null, online_discount_amount: null, final_online_price: null,
    price_display: p.price_display, image_main_url: p.image_main_url, category_slug: p.categories.slug,
    subcategory_slug: p.subcategories.slug, brand_name: p.brands?.name ?? null, product_feature_values: [], colors: null,
  })
  for (let i = 0; i < 4; i++) assets.set(`search/${i}.json`, envelope({ products: search[i] }))
  assets.set('blog.json', envelope({ posts: capture.posts, categories: capture.blogCategories }))
  const manifest = envelope({ captureSource: 'm1-public-read-model', sourceSha: capture.sourceSha,
    productionSourceSha: capture.productionSourceSha, capturedAt: capture.capturedAt,
    products: entries.length, listingProducts: entries.filter(e => e.listed).length, publishedBlogs: capture.posts.length,
    notice: 'Snapshot Public chỉ đọc; giá và tồn kho cần xác nhận với Đông Phú Gia.', categories,
    productPathsBySlug, productBuckets: [...buckets.keys()].sort(), searchShards: ['0', '1', '2', '3'],
    searchProducts: search.reduce((n, s) => n + s.length, 0), variantAssetGroups: [...variants.keys()] })
  assets.set('manifest.json', manifest)
  const files = [...assets].map(([name, value]) => {
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > 2_000_000) throw new Error('M2_PUBLIC_ASSET_TOO_LARGE')
    return { name, body, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) }
  })
  if (files.length > 5000 || files.reduce((n, f) => n + f.bytes, 0) > 100_000_000) throw new Error('M2_PUBLIC_SNAPSHOT_BUDGET')
  return { checkpoint, manifest, files }
}
