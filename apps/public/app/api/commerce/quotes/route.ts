import { handleCommerce } from '../../../../src/runtime/commerce-intake'

// #470 commerce v1: POST only; closed (404) unless PUBLIC_COMMERCE=on and the intake binding exists.
export async function POST(request: Request) {
  const result = await handleCommerce('quotes', request)
  return Response.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
