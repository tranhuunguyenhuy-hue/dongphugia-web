import { createGuestOrder } from '../../../src/runtime/order-intake'

// #446: POST only. Closed (404) unless the isolated TEST Preview flag and the dedicated order-intake binding are present.
export async function POST(request: Request) {
  const result = await createGuestOrder(request)
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
