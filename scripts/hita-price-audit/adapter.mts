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
type Product = { '@type'?: string; sku?: string; offers?: Offer; '@graph'?: Product[] }

export function parsePdp(html: string, sku: string, hit?: Hit) {
  const $ = load(html)
  const section = $('#main-price-product')
  const raw = {
    sku: $('.product-detail .product-column-right .product-code-location').text().trim(),
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

  if (skuKey(raw.sku) !== skuKey(sku)) return result(raw.sku ? 'AMBIGUOUS' : 'UNKNOWN', 'PDP_SKU_MISMATCH')
  if (raw.autocomplete?.sku && skuKey(raw.autocomplete.sku) !== skuKey(sku)) return result('AMBIGUOUS', 'SEARCH_PRICE_SKU_MISMATCH')
  const detail = $('.product-detail .product-column-right').first()
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
  const offers = products.filter(p => p?.['@type'] === 'Product' && skuKey(p.sku ?? '') === skuKey(sku))
    .map(p => p.offers).filter((offer): offer is Offer => Boolean(offer))
  if (offers.length === 1) {
    const { price, priceCurrency, availability, priceValidUntil } = offers[0]
    raw.offer = {
      price: typeof price === 'number' || typeof price === 'string' ? price : null,
      priceCurrency, availability, priceValidUntil,
    }
  }
  const selling = integerVnd(raw.selling)
  const regular = integerVnd(raw.regular)
  if (section.length !== 1 || section.find('.product-new-price-land').length !== 1 ||
      section.find('.product-old-price-land').length > 1 ||
      !selling || raw.offer?.priceCurrency !== 'VND' || integerVnd(raw.offer.price) !== selling ||
      (raw.autocomplete && integerVnd(raw.autocomplete.priceNew) !== selling) ||
      (raw.autocomplete && integerVnd(raw.autocomplete.priceOld) !== regular) ||
      (raw.regular && (!regular || !/^giá gốc\s*:?$/i.test(raw.regular_label))) ||
      (regular !== null && regular < selling)) {
    return result('UNKNOWN', 'PRICE_EVIDENCE_MISSING_OR_CONFLICTING')
  }

  const voucher = integerVnd(raw.voucher)
  const onlineVoucher = voucher && voucher < selling && section.find('.cashback-box .gift-cashback').length === 1 &&
    /^giảm thêm\s*:?$/i.test(raw.voucher_label) && /(?:đặt|mua)\s+online/i.test(raw.voucher_condition) &&
    (!raw.autocomplete || integerVnd(raw.autocomplete.cashback) === voucher) ? voucher : null
  return result('EXACT', !onlineVoucher && (raw.voucher || raw.autocomplete?.cashback) ? 'ONLINE_VOUCHER_UNVERIFIED' : null, {
    regular_price_vnd: regular ?? selling,
    promotional_price_vnd: regular && regular > selling ? selling : null,
    online_voucher_amount_vnd: onlineVoucher,
  })
}
