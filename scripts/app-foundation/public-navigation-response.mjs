import assert from 'node:assert/strict'

const NAVIGATION_ERROR_BODY = /This page couldn.t load|Worker exceeded resource|Catalogue temporarily unavailable|\n[0-9a-f]+:E\{/

/** Validate browser-visible navigation status/source; streamed RSC bodies are checked by direct probes. */
export async function validatePublicNavigationResponse(response, { origin, sha }) {
  const url = new URL(response.url())
  const request = response.request()
  const isNavigation = request.isNavigationRequest()
  if (url.origin !== origin || (!isNavigation && !request.headers().rsc)) return false
  if (response.status() >= 300 && response.status() < 400) return false

  assert.equal(response.status(), 200, `${url.pathname}: HTTP ${response.status()}`)
  assert.equal(response.headers()['x-dpg-source-sha'], sha, `${url.pathname}: SHA`)

  // Chromium may discard an already-consumed streamed RSC body after the next
  // client navigation. Explicit context.request RSC probes below read and
  // validate those bodies; real document responses remain checked here.
  if (isNavigation) {
    const text = await response.text()
    assert.ok(!NAVIGATION_ERROR_BODY.test(text), `${url.pathname}: error body`)
  }
  return true
}
