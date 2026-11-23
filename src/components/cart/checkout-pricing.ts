import type { ApplyOnlineVoucher } from '@/lib/cart-store'

// The isolated checkout CTA stays closed until the #453 integration supplies the shared helper.
// At integration this export becomes: export { applyOnlineVoucher } from '@/lib/cart-pricing'
export const applyOnlineVoucher: ApplyOnlineVoucher | undefined = undefined
