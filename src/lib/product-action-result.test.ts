import { describe, expect, it } from 'vitest'
import { productActionFailureMessage } from './product-action-result'

describe('productActionFailureMessage', () => {
  it('reports business-rule failures that carry success:false', () => {
    expect(productActionFailureMessage({ success: false, error: 'Sản phẩm cần có ảnh chính trước khi kích hoạt' }))
      .toBe('Sản phẩm cần có ảnh chính trước khi kích hoạt')
    expect(productActionFailureMessage({ success: false })).toBe('Không thể lưu sản phẩm')
  })
  it('keeps the existing field-error and message behaviour', () => {
    expect(productActionFailureMessage({ errors: { sku: ['SKU bắt buộc'] } })).toBe('SKU bắt buộc')
    expect(productActionFailureMessage({ errors: {} })).toBe('Vui lòng kiểm tra lại dữ liệu')
    expect(productActionFailureMessage({ message: 'Slug đã tồn tại' })).toBe('Slug đã tồn tại')
  })
  it('treats a successful or empty result as no failure', () => {
    expect(productActionFailureMessage(undefined)).toBeNull()
    expect(productActionFailureMessage({ success: true })).toBeNull()
    expect(productActionFailureMessage({})).toBeNull()
  })
})
