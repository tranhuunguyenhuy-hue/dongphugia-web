import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_PRICE_FIELDS, PRICE_ERROR_TEXT } from '@/components/admin/products/canonical-pricing'
import { api, type FieldMeta, type ResourceMeta } from './api'
import { ResourceForm } from './Resource'
import { Toaster } from './ui'

const editable = { editable: true, nullable: true, list: false, readOnly: false, required: false }
const money = (name: string, label: string): FieldMeta => ({ ...editable, kind: 'money', name, label })
const [regularLabel, promoLabel, voucherLabel] = ['Giá gốc (VNĐ)', 'Giá khuyến mãi (VNĐ)', 'Voucher online']
const legacyFields: FieldMeta[] = [
  { ...editable, kind: 'ref', name: 'category_id', label: 'Danh mục', ref: 'categories' },
  { ...editable, kind: 'ref', name: 'brand_id', label: 'Thương hiệu', ref: 'brands' },
  money('price', 'Giá bán cũ'),
]
const meta: ResourceMeta = {
  key: 'products', label: 'Sản phẩm', group: 'Sản phẩm', inNav: true, canCreate: true, canUpdate: true, canDelete: false,
  versioned: false, searchable: true, filters: [], relations: [],
  fields: [...legacyFields, ...CANONICAL_PRICE_FIELDS.map((name, index) => money(name, [regularLabel, promoLabel, voucherLabel][index]))],
}

const sanitary = { id: 207, category_id: 18, brand_id: 3, price: '3500000', regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000' }
const productPath = '/admin-next/api/r/products/207'

beforeEach(() => {
  vi.spyOn(api, 'options').mockImplementation(async ref => ref === 'brands'
    ? [{ id: 3, label: 'TOTO' }, { id: 4, label: 'INAX' }, { id: 5, label: 'American Standard' }]
    : [{ id: 18, label: 'Thiết Bị Vệ Sinh' }, { id: 19, label: 'Thiết bị bếp' }])
  vi.spyOn(api, 'get').mockResolvedValue(sanitary)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openPricing(schema = meta) {
  render(<><ResourceForm meta={schema} id={207} go={vi.fn()} /><Toaster /></>)
  const tab = await screen.findByRole('tab', { name: 'Giá' })
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }))
}

function mockPatch(response: Response) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', request)
  return request
}

describe('Admin product pricing', () => {
  it('renders only the three canonical controls and patches valid whole-VND amounts', async () => {
    const input = { regular_price_vnd: 1_200_000, promotional_price_vnd: 950_000, online_voucher_amount_vnd: 75_000 }
    const request = mockPatch(Response.json({ data: { ...sanitary, ...input } }))
    await openPricing()
    expect(await screen.findByLabelText(regularLabel)).toHaveValue(1_000_000)
    expect(screen.getByLabelText(promoLabel)).toHaveValue(900_000)
    expect(screen.getByLabelText(voucherLabel)).toHaveValue(50_000)
    expect(screen.queryByLabelText('Giá bán cũ')).not.toBeInTheDocument()
    const labels = [regularLabel, promoLabel, voucherLabel]
    CANONICAL_PRICE_FIELDS.forEach((field, index) => {
      fireEvent.change(screen.getByLabelText(labels[index]), { target: { value: String(input[field]) } })
    })
    submit()
    await waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith(productPath, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ input }),
    })))
    expect(await screen.findByText('Đã lưu.')).toBeInTheDocument()
  })

  it('sends null to clear the voucher and keeps the other prices', async () => {
    const input = { online_voucher_amount_vnd: null }
    const request = mockPatch(Response.json({ data: { ...sanitary, ...input } }))
    await openPricing()
    fireEvent.change(await screen.findByLabelText(voucherLabel), { target: { value: '' } })
    submit()
    await waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith(productPath, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ input }),
    })))
    expect(await screen.findByText('Đã lưu.')).toBeInTheDocument()
    expect(screen.getByLabelText(voucherLabel)).toHaveValue(null)
    expect(screen.getByLabelText(regularLabel)).toHaveValue(1_000_000)
    expect(screen.getByLabelText(promoLabel)).toHaveValue(900_000)
  })

  it.each([
    [promoLabel, '1000000', 'PRICE_RELATION_INVALID'],
    [voucherLabel, '900000', 'VOUCHER_INVALID'],
  ] as const)('blocks invalid %s before submitting', async (label, value, code) => {
    const request = mockPatch(Response.json({ data: sanitary }))
    await openPricing()
    fireEvent.change(await screen.findByLabelText(label), { target: { value } })
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(PRICE_ERROR_TEXT[code])
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['PRICE_RELATION_INVALID', 'VOUCHER_INVALID'] as const)('displays API error %s and keeps the edit', async (code) => {
    const request = mockPatch(Response.json({ error: { code } }, { status: 400 }))
    await openPricing()
    fireEvent.change(await screen.findByLabelText(promoLabel), { target: { value: '800000' } })
    submit()
    expect(await screen.findByRole('alert')).toHaveTextContent(PRICE_ERROR_TEXT[code])
    expect(request).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText(promoLabel)).toHaveValue(800_000)
  })

  it.each([[3, 'TOTO'], [4, 'INAX']])('approved sanitary brand %s (%s) uses the canonical controls', async brandId => {
    vi.mocked(api.get).mockResolvedValue({ ...sanitary, brand_id: brandId })
    await openPricing()
    expect(await screen.findByLabelText(regularLabel)).toBeInTheDocument()
    expect(screen.queryByLabelText('Giá bán cũ')).not.toBeInTheDocument()
  })

  it.each([[5, 'another sanitary brand'], [null, 'no brand yet']])('%s keeps the legacy price controls (canonical hidden)', async brandId => {
    vi.mocked(api.get).mockResolvedValue({ ...sanitary, brand_id: brandId })
    await openPricing()
    expect(await screen.findByLabelText('Giá bán cũ')).toBeInTheDocument()
    for (const label of [regularLabel, promoLabel, voucherLabel]) expect(screen.queryByLabelText(label)).not.toBeInTheDocument()
  })

  it('keeps the existing price controls for other categories', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...sanitary, category_id: 19 })
    await openPricing()
    expect(await screen.findByLabelText('Giá bán cũ')).toHaveValue(3_500_000)
    expect(screen.queryByLabelText(regularLabel)).not.toBeInTheDocument()
  })

  it('keeps the existing price controls when the API schema has no canonical pricing', async () => {
    await openPricing({ ...meta, fields: legacyFields })
    expect(await screen.findByLabelText('Giá bán cũ')).toHaveValue(3_500_000)
    expect(screen.queryByLabelText(regularLabel)).not.toBeInTheDocument()
  })
})

describe('Admin product pricing — REVERIFY_REQUIRED (#470 2C)', () => {
  const reverify = { ...sanitary, canonical_price_status: 'REVERIFY_REQUIRED', canonical_price_checked_at: '2026-10-01T00:00:00.000Z' }
  it('tells the Admin why the price is hidden, keeps the historical values visible, and verifies by sending the three prices', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(reverify)
    const request = mockPatch(Response.json({ data: { ...reverify, canonical_price_status: 'PRICE_VERIFIED' } }))
    await openPricing()
    expect(await screen.findByText(/Giá đang ẩn trên website/)).toBeInTheDocument()
    expect(screen.getByText(/Cần liên hệ xác nhận giá/)).toBeInTheDocument()
    expect(screen.getByLabelText(regularLabel)).toHaveValue(1_000_000)
    fireEvent.click(screen.getByRole('button', { name: 'Xác minh giá' }))
    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe(productPath)
    expect(JSON.parse(String(init?.body))).toMatchObject({ input: { regular_price_vnd: 1_000_000, promotional_price_vnd: 900_000, online_voucher_amount_vnd: 50_000 } })
  })
  it('shows no notice for a normally verified price', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...sanitary, canonical_price_status: 'PRICE_VERIFIED' })
    await openPricing()
    await screen.findByLabelText(regularLabel)
    expect(screen.queryByText(/Giá đang ẩn trên website/)).not.toBeInTheDocument()
  })
})

