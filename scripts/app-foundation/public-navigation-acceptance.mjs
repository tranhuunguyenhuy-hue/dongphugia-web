import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium, webkit } from '@playwright/test'
import { validatePublicNavigationResponse } from './public-navigation-response.mjs'
const [base, sha] = process.argv.slice(2)
assert.match(sha ?? '', /^[a-f0-9]{40}$/)
const origin = new URL(base).origin
assert.ok(origin === 'https://www.dongphugia.vn' || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
const proxyUrl = origin.startsWith('https:') && process.env.https_proxy ? new URL(process.env.https_proxy) : null
let browser
const browserTypes = [chromium, webkit]
const launchBrowser = type => type.launch({ headless: true, ...(proxyUrl ? { proxy: {
  server: proxyUrl.origin, username: proxyUrl.username, password: proxyUrl.password,
} } : {}) })
const started = Date.now()
let probes = 0
const evidence = []
const record = value => { if (evidence.length < 2500) evidence.push({ utc: new Date().toISOString(), ...value }) }
const routeClass = raw => {
  const p = new URL(raw).pathname
  return p === '/' ? 'home' : p === '/gach-op-lat' ? 'tile-category'
    : p.startsWith('/thiet-bi-ve-sinh') ? 'sanitary-catalogue'
    : p.startsWith('/blog') ? 'blog' : p === '/tim-kiem' ? 'search' : 'other'
}
try {
 for (const browserType of browserTypes) {
  browser = await launchBrowser(browserType)
  record({ event: "browser-start", engine: browserType.name() })
  for (const width of browserType === webkit ? [390] : [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width === 390 })
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    const errors = []
    const responseChecks = []
    const listingShardRequests = []
    page.on('pageerror', () => { errors.push('browser-pageerror'); record({ event: 'pageerror', width, route: routeClass(page.url()) }) })
    page.on('requestfailed', request => {
      if (new URL(request.url()).origin === origin) record({ event: 'requestfailed', width, route: routeClass(request.url()), kind: request.isNavigationRequest() ? 'document' : request.headers().rsc ? 'rsc' : 'other' })
    })
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === origin && url.pathname.startsWith('/api/catalogue/listings/')) {
        listingShardRequests.push(url.pathname)
      }
    })
    page.on('response', r => {
      if (new URL(r.url()).origin === origin && (r.request().isNavigationRequest() || r.request().headers().rsc)) {
        const h = r.headers()
        record({ event: 'response', width, route: routeClass(r.url()), kind: r.request().isNavigationRequest() ? 'document' : r.request().headers()['next-router-prefetch'] ? 'prefetch' : 'rsc', status: r.status(), mime: ['text/html', 'text/x-component'].includes(h['content-type']?.split(';')[0]) ? h['content-type'].split(';')[0] : 'other', sha: /^[a-f0-9]{40}$/.test(h['x-dpg-source-sha'] || '') ? h['x-dpg-source-sha'] : null, ray: /^[a-f0-9]+-[A-Z]+$/.test(h['cf-ray'] || '') ? h['cf-ray'] : null, cache: ['HIT','MISS','BYPASS'].includes(h['x-dpg-cache']) ? h['x-dpg-cache'] : 'other' })
      }
      responseChecks.push(validatePublicNavigationResponse(r, { origin, sha })
        .then(checked => { if (checked) probes += 1 })
        .catch(e => { errors.push(e.message); record({ event: 'response-validation-failed', width, route: routeClass(r.url()) }) }))
    })
    await page.goto(origin, { waitUntil: 'networkidle' })
    const api = await context.request.get(origin + '/api/search?q=A-LFV-402S-1&limit=8')
    assert.equal(api.status(), 200)
    const pdp = (await api.json()).results.find(p => p.sku === 'A-LFV-402S-1')?.url
    assert.match(pdp ?? '', /^\/thiet-bi-ve-sinh\/[^/]+\/[^/]+$/)
    // Actual link clicks exercise client navigation and hydration, including back.
    for (let round = 0; round < 2; round++) {
      const shardRequestCount = listingShardRequests.length
      console.log(`PUBLIC_BROWSER_ROUND width=${width} round=${round} start=home`)
      if (width === 390) {
        await page.getByRole('button', { name: 'Mở menu điều hướng' }).click()
        await page.getByRole('navigation', { name: 'Menu di động' }).getByRole('link', { name: 'Thiết bị vệ sinh' }).click()
      } else {
        await page.getByRole('button', { name: 'Xem sản phẩm' }).click()
        await page.getByRole('menu', { name: 'Danh mục sản phẩm' }).getByRole('menuitem', { name: 'Thiết bị vệ sinh' }).click()
      }
      await page.waitForURL('**/thiet-bi-ve-sinh')
      await page.locator('#main-content h1').waitFor()
      const listingLink = page.locator('#main-content a[href="/thiet-bi-ve-sinh/bon-cau"]').first()
      await listingLink.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
      await listingLink.locator('span').click()
      await page.waitForURL('**/thiet-bi-ve-sinh/bon-cau')
      await page.locator('#main-content h1').waitFor()
      const visibleProduct = page.locator('#main-content a[href^="/thiet-bi-ve-sinh/bon-cau/"]').first()
      await visibleProduct.waitFor({ state: 'visible' })
      await page.reload({ waitUntil: 'networkidle' })
      await visibleProduct.waitFor({ state: 'visible' })
      assert.ok(!(await page.locator('#main-content').innerText()).includes('Chưa tải được danh sách sản phẩm'))
      assert.equal(listingShardRequests.length, shardRequestCount, 'PostgreSQL PLP must server-render the selected page without fetching every listing shard')
      // Choose the real DB-only product via its search result link.
      await page.goto(origin + '/tim-kiem?q=A-LFV-402S-1', { waitUntil: 'networkidle' })
      await page.locator(`#main-content a[href="${pdp}"]`).first().click()
      await page.waitForURL('**' + pdp)
      await page.locator('#main-content h1').waitFor()
      assert.ok((await page.locator('#main-content').innerText()).includes('A-LFV-402S-1'))
      await page.goBack({ waitUntil: 'networkidle' })
      await page.getByRole('link', { name: /Đông Phú Gia - Trang chủ/i }).first().click()
      await page.waitForURL(origin + '/')
      const homeChrome = await page.evaluate(() => ({
        headerCount: document.querySelectorAll('header').length,
        desktopNavigationCount: document.querySelectorAll('nav[aria-label="Menu chính"]').length,
        desktopBlogLinkCount: document.querySelectorAll('nav[aria-label="Menu chính"] a[href="/blog"]').length,
        desktopBlogLinkVisibleCount: [...document.querySelectorAll('nav[aria-label="Menu chính"] a[href="/blog"]')]
          .filter((element) => element.getClientRects().length > 0
            && getComputedStyle(element).visibility !== 'hidden'
            && getComputedStyle(element).display !== 'none').length,
        footerCount: document.querySelectorAll('footer').length,
        footerBlogLinkCount: document.querySelectorAll('footer a[href="/blog"]').length,
        mainContentPresent: document.querySelector('#main-content') !== null,
        mainHeadingCount: document.querySelectorAll('#main-content h1').length,
        errorPageMarker: /This page couldn.t load|Internal Server Error/.test(document.body.innerText),
      }))
      console.log(JSON.stringify({ event: 'PUBLIC_BROWSER_HOME_CHROME', width, ...homeChrome }))
      record({ event: 'home-dom', width, ...homeChrome })
      await page.locator('#main-content h1').waitFor({ state: 'attached' })
      const blogLink = width === 390
        ? page.locator('footer a[href="/blog"]').first()
        : page.getByRole('navigation', { name: 'Menu chính' }).getByRole('link', { name: 'Tin tức' })
      await blogLink.click()
      await page.waitForURL('**/blog')
      await page.locator('#main-content h1').waitFor()
      await page.getByRole('button', { name: 'Mở tìm kiếm' }).first().click()
      await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).first().fill('A-LFV-402S-1')
      await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).first().press('Enter')
      await page.waitForURL('**/tim-kiem?q=A-LFV-402S-1')
      await page.locator('#main-content h1').waitFor()
      for (const batch of [0, 1]) {
        await Promise.all(['/', '/gach-op-lat', '/thiet-bi-ve-sinh', '/thiet-bi-ve-sinh/bon-cau', pdp, '/blog'].map(async path => {
          const t = Date.now()
          const r = await context.request.get(origin + path, { headers: {
            RSC: '1', 'Next-Router-Prefetch': '1', 'Next-Router-Segment-Prefetch': '1',
            'Next-URL': path,
          }, timeout: 30000 })
          assert.equal(r.status(), 200, path)
          assert.match(r.headers()['content-type'], /text\/x-component/)
          assert.equal(r.headers()['x-dpg-source-sha'], sha)
          const text = await r.text()
          assert.ok(!/\n[0-9a-f]+:E\{|"digest":|This page couldn.t load/.test(text), path)
          probes += 1
          console.log(JSON.stringify({event:'NAVIGATION_BURST_PASS',width,round,batch,path,status:r.status(),ray:r.headers()['cf-ray'],elapsedMs:Date.now()-t}))
        }))
      }
      const dot = await context.request.get(origin + '/thiet-bi-ve-sinh/bon-cau.')
      assert.equal(dot.status(), 404)
      assert.equal(dot.headers()['x-dpg-source-sha'], sha)
      await page.goto(origin, { waitUntil: 'networkidle' })
    }
    await Promise.all(responseChecks)
    assert.deepEqual(errors, [])
    console.log(`PUBLIC_BROWSER_NAVIGATION PASS width=${width} rounds=2 errors=0`)
    await context.close()
  }
  await browser.close()
 }
  console.log(`PUBLIC_NAVIGATION_ACCEPTANCE PASS probes=${probes} durationMs=${Date.now()-started} source=${sha}`)
} finally {
  await browser?.close()
  if (process.env.M1_NAVIGATION_DIAGNOSTICS) {
    const path = process.env.M1_NAVIGATION_DIAGNOSTICS
    mkdirSync(dirname(path), { recursive: true })
    const json = JSON.stringify({ source: sha, evidence })
    assert.ok(Buffer.byteLength(json) <= 2 * 1024 * 1024, 'diagnostic size limit')
    writeFileSync(path, json + '\n', { mode: 0o600 })
  }
}
