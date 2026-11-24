import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findProduct, parsePdp, pdpUrl, searchUrl } from './adapter.mts'

const sku = 'TEST+CAP/BW1#W'
const sibling = 'TEST+CAP-2/BW1#W'

function fixture({
  displayed = sku, regular = '1.000.000đ', selling = '900.000đ', offer = 900_000,
  voucher = '50.000đ', condition = 'Ưu đãi đặc biệt khi đặt Online, chỉ có tại HITA',
  label = 'Giảm thêm:', note = '',
} = {}) {
  return `<div class="product-detail"><div class="product-column-right">
    <span class="product-code-location">${displayed}</span>${note}
    <div id="main-price-product">
      <span class="label-price-old">Giá gốc:</span><span class="product-old-price-land">${regular}</span>
      <span class="product-new-price-land" data-promotion-id="1">${selling}</span>
      <div class="cashback-box"><div class="info"><div class="title-gift"><span>${label}</span>
        <div class="gift-cashback">${voucher}</div></div><div class="note">${condition}</div></div></div>
    </div></div></div>
    <div class="gift-cashback">100.000đ</div>
    <script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'ProductGroup' },
      { '@type': 'Product', sku: sibling, offers: { price: 800_000, priceCurrency: 'VND' } },
      { '@type': 'Product', sku, offers: { price: offer, priceCurrency: 'VND' } },
    ] })}</script>`
}

describe('Hita public pricing', () => {
  it('preserves all SKU separators and suffixes in lookup and exact match', () => {
    expect(searchUrl(sku).search).toBe('?key=TEST%2BCAP%2FBW1%23W')
    const results = findProduct({ status: true, products: [
      { product_code: sibling }, { product_code: '<em>TEST+CAP/BW1#W</em>' }, { product_code: 'TEST+CAP/BW1#XW' },
    ] }, sku)
    expect(results.hits).toHaveLength(1)
    expect(results.candidates).toHaveLength(3)
  })

  it('accepts a product URL on Hita only', () => {
    expect(pdpUrl('bon-cau-2130.html').href).toBe('https://hita.com.vn/bon-cau-2130.html')
    for (const url of ['//other.example/a-1.html', 'https://user@hita.com.vn/a-1.html', '/a-1.html?sku=sibling', '/robots.txt']) {
      expect(() => pdpUrl(url)).toThrow('INVALID_PDP_URL')
    }
  })

  it('extracts three VND prices from the main exact SKU and retains the online condition', () => {
    const result = parsePdp(fixture(), sku)
    expect(result).toMatchObject({
      status: 'EXACT', regular_price_vnd: 1_000_000, promotional_price_vnd: 900_000,
      online_voucher_amount_vnd: 50_000, evidence: { voucher_condition: expect.stringContaining('đặt Online') },
    })
  })

  it('requires online and SKU-specific evidence and a positive amount after voucher', () => {
    for (const page of [fixture({ condition: 'Cashback chung' }), fixture({ voucher: '' }),
      fixture({ voucher: '900.000đ' }), fixture({ label: 'Tặng điểm' })]) {
      expect(parsePdp(page, sku)).toMatchObject({ status: 'EXACT', online_voucher_amount_vnd: null })
    }
    expect(parsePdp(fixture(), sku, { product_code: sku, product_price: { sku, priceOld: '1000000.00',
      priceNew: '900000.00', cashback: 40_000 } })).toMatchObject({
      status: 'EXACT', online_voucher_amount_vnd: null, exception: 'ONLINE_VOUCHER_UNVERIFIED',
    })
  })

  it('returns the single confirmed selling price when no regular comparison is shown', () => {
    expect(parsePdp(fixture({ regular: '', voucher: '' }), sku)).toMatchObject({
      status: 'EXACT', regular_price_vnd: 900_000, promotional_price_vnd: null, online_voucher_amount_vnd: null,
    })
  })

  it('classifies contact and discontinued without borrowing an offer', () => {
    expect(parsePdp(fixture({ selling: 'Giá liên hệ' }), sku)).toMatchObject({ status: 'CONTACT', regular_price_vnd: null })
    expect(parsePdp(fixture({ note: 'Ngừng kinh doanh' }), sku, { product_code: sku, product_status: 0 }))
      .toMatchObject({ status: 'DISCONTINUED', regular_price_vnd: null })
  })

  it('rejects SKU drift and conflicting prices', () => {
    expect(parsePdp(fixture({ displayed: sibling }), sku)).toMatchObject({ status: 'AMBIGUOUS', regular_price_vnd: null })
    for (const page of [fixture({ offer: 800_000 }), fixture({ regular: '800.000đ' }), fixture({ selling: '900.000,50đ' })]) {
      expect(parsePdp(page, sku)).toMatchObject({ status: 'UNKNOWN', regular_price_vnd: null })
    }
  })
})

describe('INAX single price recovery', () => {
  const code = 'C-504VAN/BW1'
  const hit = { product_code: code, product_price: { sku: code, priceOld: '3640000.00', priceNew: '3640000.00' } }
  const page = readFileSync('scripts/hita-price-audit/fixtures/inax-c-504van-single-price.html', 'utf8')

  it('uses the visible, corroborated single price even when search repeats it twice', () => {
    expect(parsePdp(page, code, hit, 'INAX')).toMatchObject({
      status: 'EXACT', regular_price_vnd: 3_640_000, promotional_price_vnd: null, online_voucher_amount_vnd: null,
    })
  })

  it('rejects conflicting search prices and requires the exact model and brand', () => {
    expect(parsePdp(page, code, { ...hit, product_price: { ...hit.product_price, priceOld: '4140000.00' } }, 'INAX').exception).toBe('SEARCH_PRICE_CONFLICT')
    expect(parsePdp(page, 'C-504VAN', undefined, 'INAX').exception).toBe('PDP_SKU_MISMATCH')
    expect(parsePdp(page, code, undefined, 'TOTO').exception).toBe('PDP_BRAND_NOT_PROVEN')
  })

  it('supports a one-item Offer array and rejects an ambiguous array', () => {
    const offer = '{"price":"3640000.00","priceCurrency":"VND","priceValidUntil":"2026-12-01"}'
    expect(parsePdp(page.replace(offer, `[${offer}]`), code, hit, 'INAX').status).toBe('EXACT')
    expect(parsePdp(page.replace(offer, `[${offer},${offer}]`), code, hit, 'INAX').exception).toBe('MULTIPLE_EXACT_OFFERS')
  })
})

describe('regression against Hita product evidence', () => {
  it('does not use a sibling Offer to price INAX P-CWS15VN-8-2', () => {
    const code = 'P-CWS15VN-8-2'
    const page = fixture({ displayed: code, regular: '', selling: '132.000đ', voucher: '' })
      .replaceAll(sku, 'A-CWS15VN-8')
      .concat('<table><tr><td id="brand-product">INAX</td></tr></table>')
    const hit = { product_code: code, product_price: { sku: code, priceOld: '132000.00', priceNew: '132000.00' } }
    expect(parsePdp(page, code, hit, 'INAX')).toMatchObject({ status: 'UNKNOWN', exception: 'EXACT_OFFER_MISSING', regular_price_vnd: null })
  })

  it('preserves the TOTO LT533R#XW promotion and independent online voucher from the #448 capture', () => {
    const code = 'LT533R#XW'
    const page = fixture({ displayed: code, regular: '2.572.000đ', selling: '2.109.040đ', offer: 2_109_040, voucher: '154.320đ' }).replaceAll(sku, code)
    const hit = { product_code: code, product_price: { sku: code, priceOld: '2572000.00', priceNew: '2109040.00', cashback: 154_320 } }
    expect(parsePdp(page, code, hit)).toMatchObject({ status: 'EXACT', regular_price_vnd: 2_572_000,
      promotional_price_vnd: 2_109_040, online_voucher_amount_vnd: 154_320 })
  })
})
