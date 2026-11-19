import { publicPostgresEnabled, readPublicRows } from './public-db'
import type {
  PublicHomeCategory,
  PublicHomeContent,
  PublicHomePageData,
} from '@dpg/app-contracts'
import {
  getPreviewCatalogueCategories,
  getPreviewCatalogueProducts,
  PUBLIC_CATALOGUE_FIXTURE_NOTICE,
} from './preview-public-catalogue'
import { publicSnapshotCheckpoint, usesPublicSnapshot, usesProductionPublishedCatalogue } from './public-snapshot-mode'
import { readSnapshotManifest } from './public-snapshot-catalogue'
import { historicalBlogImage } from './legacy-blog'
import { getPublicBlogPosts } from './live-public-blog'

// Hosted M2 parity requires a pinned local Public snapshot, never fixtures or
// a runtime fetch from Production. Production behavior remains unchanged.
function publicHomeParityEnabled() {
  return process.env.APP_ENV === 'production' || (process.env.APP_ENV === 'staging'
    && publicSnapshotCheckpoint() !== null
    && !publicPostgresEnabled() && !usesProductionPublishedCatalogue())
}

// Owner-verified historical Production artwork, archived in the legacy Supabase Storage bucket. These three objects
// correspond to legacy DB rows 6, 4, 5. They remain the fallback until the Production `banners` table serves the hero.
const HISTORICAL_HOME_BANNERS: PublicHomePageData['banners'] = [
    {
      id: 6,
      title: 'Banner 1',
      imageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776486977694-87cnaa.png',
      mobileImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776486977694-87cnaa.png',
      desktopImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776486977694-87cnaa.png',
      desktopLargeImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776486977694-87cnaa.png',
      linkUrl: null,
    },
    {
      id: 4,
      title: 'Banner 2',
      imageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485447824-r0eml8.png',
      mobileImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485447824-r0eml8.png',
      desktopImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485447824-r0eml8.png',
      desktopLargeImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485447824-r0eml8.png',
      linkUrl: null,
    },
    {
      id: 5,
      title: 'Banner 3',
      imageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485426606-t2pflg.png',
      mobileImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485426606-t2pflg.png',
      desktopImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485426606-t2pflg.png',
      desktopLargeImageUrl: 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776485426606-t2pflg.png',
      linkUrl: null,
    },
  ]

// Hero banners are managed in the Admin (`dpg_app.banners`, position HERO, active, by sort_order). Image URLs must be on the
// managed default pull zone under `banners/` (or the verified legacy archive host); links must be same-site paths or https.
const HOME_BANNER_SQL = `SELECT id, title, image_url, link_url FROM dpg_app.banners
 WHERE is_active = true AND position = 'HERO' ORDER BY sort_order, id LIMIT 8`
const MANAGED_BANNER_HOST = 'dpg-products.b-cdn.net'
const MANAGED_BANNER_PATH = /^\/banners\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:png|jpe?g|webp|gif)$/
const LEGACY_BANNER_HOST = 'tygjmrhandbffjllxveu.supabase.co'
const LEGACY_BANNER_PATH = /^\/storage\/v1\/object\/public\/images\/banners\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:png|jpe?g|webp|gif)$/

export function safeHomeBannerImage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.search || url.hash) return null
    if (url.hostname === MANAGED_BANNER_HOST && MANAGED_BANNER_PATH.test(url.pathname)) return url.href
    if (url.hostname === LEGACY_BANNER_HOST && LEGACY_BANNER_PATH.test(url.pathname)) return url.href
    return null
  } catch { return null }
}

export function safeHomeBannerLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  if (/^\/(?![/\\])[\w\-./%?=&#]*$/.test(value)) return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['www.dongphugia.vn', 'dongphugia.vn'].includes(url.hostname) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function mapHomeBannerRows(rows: ReadonlyArray<{ id: unknown; title: unknown; image_url: unknown; link_url: unknown }>): PublicHomePageData['banners'] {
  return rows.flatMap((row) => {
    const image = safeHomeBannerImage(row.image_url)
    if (!image || !Number.isSafeInteger(row.id)) return []
    return [{
      id: Number(row.id), title: typeof row.title === 'string' && row.title ? row.title.slice(0, 200) : null,
      imageUrl: image, mobileImageUrl: image, desktopImageUrl: image, desktopLargeImageUrl: image,
      linkUrl: safeHomeBannerLink(row.link_url),
    }]
  })
}

export async function getPublicHomeBanners(): Promise<PublicHomePageData['banners']> {
  if (!publicHomeParityEnabled()) return []
  if (publicPostgresEnabled()) {
    try {
      const mapped = mapHomeBannerRows(await readPublicRows(HOME_BANNER_SQL))
      if (mapped.length) return mapped
    } catch {
      // The Public role has no banner grant yet, or the read failed: keep the verified historical hero instead of an empty page.
    }
  }
  return HISTORICAL_HOME_BANNERS
}

export async function getPublicHomeContent(): Promise<PublicHomeContent> {
  const blogPosts = await getPublicBlogPosts()
  const catalogueManifest = usesPublicSnapshot() && !publicPostgresEnabled() ? await readSnapshotManifest() : null
  const categories: readonly PublicHomeCategory[] = await Promise.all((await getPreviewCatalogueCategories()).map(async (category) => {
    const listing = category.listings[0]
    const products = listing
      ? (await getPreviewCatalogueProducts(category.slug, listing.slug)).slice(0, 8)
      : []
    const availableBrands = products.reduce<Array<{ name: string; slug: string }>>((brands, product) => {
      const brand = product.brands as { name: string; slug: string } | undefined
      if (brand && !brands.some(({ slug }) => slug === brand.slug)) brands.push(brand)
      return brands
    }, [])

    return {
      id: category.slug,
      label: category.name,
      basePath: `/${category.slug}`,
      products,
      totalCount: 'totalCount' in category ? Number(category.totalCount) : products.length,
      availableBrands,
      availableSubcategories: category.listings.map(({ name, slug }) => ({ name, slug })),
    }
  }))

  return {
    categories,
    posts: publicHomeParityEnabled() ? blogPosts.slice(0, 3).map((post) => ({
          id: post.id,
          title: post.title,
          slug: post.slug,
          excerpt: post.excerpt,
          thumbnailUrl: historicalBlogImage(post.thumbnail_url),
          publishedAt: post.published_at,
          category: { name: post.category.name, slug: post.category.slug },
        })) : [],
    previewNotice: process.env.APP_ENV === 'production' ? undefined : publicHomeParityEnabled()
      ? `Preview — dữ liệu Public chỉ đọc tại checkpoint ${catalogueManifest?.checkpoint}.` : catalogueManifest
      ? `${PUBLIC_CATALOGUE_FIXTURE_NOTICE} Checkpoint: ${catalogueManifest.checkpoint}. Banner và Blog được ẩn vì chưa xác minh được tuyến nội dung công khai. Dữ liệu Admin riêng tư, xác thực, đơn hàng và mọi thao tác ghi không khả dụng trong môi trường này.`
      : PUBLIC_CATALOGUE_FIXTURE_NOTICE,
  }
}
