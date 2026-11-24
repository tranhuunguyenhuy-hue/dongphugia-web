import { load } from 'cheerio'

const origin = 'https://hita.com.vn'
export const category = 'thiet-bi-ve-sinh'
type Status = 'EXACT' | 'AMBIGUOUS' | 'NOT_FOUND' | 'CONTACT' | 'DISCONTINUED' | 'BLOCKED' | 'UNKNOWN'

export const skuKey = (value: string) => value.trim().toUpperCase()
const searchCode = (value: string) => load(value, {}, false).text().trim()

export function searchUrl(sku: string) {
  const url = new URL('/product/searchProduct', origin)
  url.searchParams.set('key', sku)
  return url
}

export function pdpUrl(value: string) {
  const url = new URL(value, origin)
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !/^\/[a-z0-9-]+-\d+\.html$/.test(url.pathname)) {
    throw new Error('INVALID_PDP_URL')
  }
  return url
}

type SearchPrice = { sku?: string; priceOld?: string; priceNew?: string; cashback?: number }
type Hit = { product_code: string; product_url?: string; product_price?: SearchPrice; product_status?: number }

export function findProduct(value: unknown, sku: string) {
  if (typeof value !== 'object' || value === null || !('status' in value)) throw new Error('INVALID_SEARCH')
  const products = 'products' in value && Array.isArray(value.products) ? value.products as Hit[] : []
  if (value.status !== true && !(value.status === false && products.length === 0)) throw new Error('INVALID_SEARCH')
  if (products.some(p => typeof p?.product_code !== 'string')) throw new Error('INVALID_SEARCH')
  return {
    hits: products.filter(p => skuKey(searchCode(p.product_code)) === skuKey(sku)),
    candidates: products.slice(0, 5).map(p => searchCode(p.product_code)),
  }
}

function integerVnd(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const str = String(value).trim()
  const plain = /^\d+(?:\.00)?$/.test(str)
  const formatted = /^(?:\d{1,3}(?:\.\d{3})+|\d+)\s*(?:đ|₫|VND)$/i.test(str)
  if (!plain && !formatted) return null
  const amount = Number(plain ? str : str.replace(/[^\d]/g, ''))
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

type Offer = { price?: unknown; priceCurrency?: string; availability?: string; priceValidUntil?: string }
type Product = { '@type'?: string; sku?: string; brand?: string | { name?: string }; offers?: Offer | Offer[]; '@graph'?: Product[] }

export const parserVersion = 'hita-pdp-477.1'

const isMissingPrice = (value: unknown) => value === undefined || value === null ||
  typeof value === 'string' && /^(?:0+(?:\.00)?)?$/.test(value.trim()) || value === 0

export function parsePdp(html: string, sku: string, hit?: Hit, expectedBrand?: string) {
  const $ = load(html)
  const section = $('#main-price-product')
  const codes = $('.product-detail .product-column-right .product-code-location')
  const brandLabels = $('#brand-product')
  const raw = {
    sku: codes.text().trim(),
    brand: brandLabels.text().trim(),
    regular: section.find('.product-old-price-land').text().trim(),
    regular_label: section.find('.label-price-old').text().trim(),
    selling: section.find('.product-new-price-land').text().trim(),
    voucher: section.find('.cashback-box .gift-cashback').text().trim(),
    voucher_label: section.find('.cashback-box .title-gift > span').text().trim(),
    voucher_condition: section.find('.cashback-box .info .note').text().trim(),
    voucher_action: section.find('#action-add-cashback').text().trim(),
    promotion_id: section.find('.product-new-price-land').attr('data-promotion-id') || null,
    offer: null as Offer | null,
    autocomplete: hit?.product_price ?? null,
  }
  const empty = { regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null }
  const result = (status: Status, exception: string | null, prices: {
    regular_price_vnd: number | null; promotional_price_vnd: number | null; online_voucher_amount_vnd: number | null
  } = empty) => ({ ...prices, status, exception, hita_exact_sku: skuKey(raw.sku) === skuKey(sku) ? raw.sku : null, evidence: raw })

  if (codes.length !== 1 || skuKey(raw.sku) !== skuKey(sku)) return result(raw.sku ? 'AMBIGUOUS' : 'UNKNOWN', 'PDP_SKU_MISMATCH')
  if (raw.autocomplete?.sku && skuKey(raw.autocomplete.sku) !== skuKey(sku)) return result('AMBIGUOUS', 'SEARCH_PRICE_SKU_MISMATCH')
  const detail = $('.product-detail .product-column-right').first()
  if (expectedBrand && (brandLabels.length !== 1 || skuKey(raw.brand) !== skuKey(expectedBrand))) return result('AMBIGUOUS', 'PDP_BRAND_NOT_PROVEN')
  if (/ngừng kinh doanh/i.test(detail.text()) && hit?.product_status === 0) return result('DISCONTINUED', 'SOURCE_DISCONTINUED')
  if (/giá liên hệ|liên hệ báo giá/i.test(raw.selling)) return result('CONTACT', 'SOURCE_CONTACT')

  const products: Product[] = []
  $('script[type="application/ld+json"]').each((_, script) => {
    try {
      const data: Product | Product[] = JSON.parse($(script).text())
      products.push(...(Array.isArray(data) ? data : data?.['@graph'] ?? [data]))
    } catch {
      // An invalid unrelated JSON-LD block must not replace product evidence.
    }
  })
  const exactProducts = products.filter(p => p?.['@type'] === 'Product' && typeof p.sku === 'string' && skuKey(p.sku) === skuKey(sku))
  if (expectedBrand && exactProducts.some(p => {
    const name = typeof p.brand === 'string' ? p.brand : p.brand?.name
    return typeof name === 'string' && skuKey(name) !== skuKey(expectedBrand)
  })) return result('AMBIGUOUS', 'OFFER_BRAND_CONFLICT')
  const offers = exactProducts.flatMap(p => p.offers ?? [])
  if (offers.length > 1) return result('UNKNOWN', 'MULTIPLE_EXACT_OFFERS')
  const offer = offers[0]
  if (offer && typeof offer === 'object') {
    const { price, priceCurrency, availability, priceValidUntil } = offer
    raw.offer = {
      price: typeof price === 'number' || typeof price === 'string' ? price : null,
      priceCurrency, availability, priceValidUntil,
    }
  }

  if (section.length !== 1 || section.find('.product-new-price-land').length !== 1 ||
      section.find('.product-old-price-land').length > 1) return result('UNKNOWN', 'PDP_PRICE_MARKUP_AMBIGUOUS')
  const selling = integerVnd(raw.selling)
  const regular = integerVnd(raw.regular)
  if (!selling) return result('UNKNOWN', 'PDP_SELLING_PRICE_INVALID')
  if (raw.regular && (!regular || !/^giá gốc\s*:?$/i.test(raw.regular_label))) return result('UNKNOWN', 'PDP_REGULAR_PRICE_INVALID')
  if (regular !== null && regular < selling) return result('UNKNOWN', 'PDP_PRICE_ORDER_CONFLICT')
  if (!raw.offer) return result('UNKNOWN', 'EXACT_OFFER_MISSING')
  if (raw.offer.priceCurrency !== 'VND' || integerVnd(raw.offer.price) !== selling) return result('UNKNOWN', 'PDP_OFFER_PRICE_CONFLICT')

  // When there is one visible price, Hita can put that amount in both search fields.
  // An empty comparison on the PDP does not contradict a duplicate of the selling price.
  const searchSelling = raw.autocomplete?.priceNew
  const searchRegular = raw.autocomplete?.priceOld
  if ((!isMissingPrice(searchSelling) && integerVnd(searchSelling) !== selling) ||
      (!isMissingPrice(searchRegular) && integerVnd(searchRegular) !== (regular ?? selling))) {
    return result('UNKNOWN', 'SEARCH_PRICE_CONFLICT')
  }

  const voucher = integerVnd(raw.voucher)
  const onlineVoucher = voucher && voucher < selling && section.find('.cashback-box .gift-cashback').length === 1 &&
    /^giảm thêm\s*:?$/i.test(raw.voucher_label) && /(?:đặt|mua)\s+online/i.test(raw.voucher_condition) &&
    (raw.autocomplete?.cashback == null || integerVnd(raw.autocomplete?.cashback) === voucher) ? voucher : null
  return result('EXACT', !onlineVoucher && (raw.voucher || raw.autocomplete?.cashback) ? 'ONLINE_VOUCHER_UNVERIFIED' : null, {
    regular_price_vnd: regular ?? selling,
    promotional_price_vnd: regular && regular > selling ? selling : null,
    online_voucher_amount_vnd: onlineVoucher,
  })
}
