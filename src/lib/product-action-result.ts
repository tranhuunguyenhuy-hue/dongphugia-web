// createProduct/updateProduct return validation problems as { errors } (field map), thrown-and-caught
// failures as { message }, and business-rule failures as { success: false, error }. The form used to read only
// the first two, so a rejected create (for example "needs a main image before activation") looked like a
// success: green toast, redirect, and nothing saved. Return the message to show, or null when the save succeeded.
export type ProductActionResult = {
  errors?: Record<string, unknown>
  message?: string
  success?: boolean
  error?: string
} | undefined | null

export function productActionFailureMessage(result: ProductActionResult): string | null {
  if (!result) return null
  if (result.errors) {
    const first = Object.values(result.errors).flat()[0]
    return String(first || 'Vui lòng kiểm tra lại dữ liệu')
  }
  if (result.message) return result.message
  if (result.success === false) return result.error || 'Không thể lưu sản phẩm'
  return null
}
