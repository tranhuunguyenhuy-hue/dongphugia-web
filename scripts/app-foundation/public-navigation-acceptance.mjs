import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
const [base, sha] = process.argv.slice(2)
assert.match(sha ?? '', /^[a-f0-9]{40}$/)
const origin = new URL(base).origin
assert.ok(origin === 'https://www.dongphugia.vn' || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
const proxyUrl = origin.startsWith('https:') && process.env.https_proxy ? new URL(process.env.https_proxy) : null
const browser = await chromium.launch({ headless: true, ...(proxyUrl ? { proxy: {
  server: proxyUrl.origin, username: proxyUrl.username, password: proxyUrl.password,
} } : {}) })
const started = Date.now()
let probes = 0
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width === 390 })
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    const errors = []
    const responseChecks = []
    page.on('pageerror', () => errors.push('browser-pageerror'))
    page.on('response', r => {
      const url = new URL(r.url())
      if (url.origin !== origin || !r.request().isNavigationRequest() && !r.request().headers().rsc) return
      if (r.status() >= 300 && r.status() < 400) return
      responseChecks.push((async () => {
        assert.equal(r.status(), 200, `${url.pathname}: HTTP ${r.status()}`)
        assert.equal(r.headers()['x-dpg-source-sha'], sha, `${url.pathname}: SHA`)
        const text = await r.text()
        assert.ok(!/This page couldn.t load|Worker exceeded resource|Catalogue temporarily unavailable|\n[0-9a-f]+:E\{/.test(text), `${url.pathname}: error body`)
        probes += 1
      })().catch(e => errors.push(e.message)))
    })
    await page.goto(origin, { waitUntil: 'networkidle' })
    const api = await context.request.get(origin + '/api/search?q=A-LFV-402S-1&limit=8')
    assert.equal(api.status(), 200)
    const pdp = (await api.json()).results.find(p => p.sku === 'A-LFV-402S-1')?.url
    assert.match(pdp ?? '', /^\/thiet-bi-ve-sinh\/[^/]+\/[^/]+$/)
    // Actual link clicks exercise client navigation and hydration, including back.
    for (let round = 0; round < 2; round++) {
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
      await page.reload({ waitUntil: 'networkidle' })
      // Choose the real DB-only product via its search result link.
      await page.goto(origin + '/tim-kiem?q=A-LFV-402S-1', { waitUntil: 'networkidle' })
      await page.locator(`#main-content a[href="${pdp}"]`).first().click()
      await page.waitForURL('**' + pdp)
      await page.locator('#main-content h1').waitFor()
      assert.ok((await page.locator('#main-content').innerText()).includes('A-LFV-402S-1'))
      await page.goBack({ waitUntil: 'networkidle' })
      await page.getByRole('link', { name: /Đông Phú Gia - Trang chủ/i }).first().click()
      await page.waitForURL(origin + '/')
      await page.locator('footer a[href="/blog"]').first().click()
      await page.waitForURL('**/blog')
      await page.locator('#main-content h1').waitFor()
      await page.getByRole('button', { name: 'Mở tìm kiếm' }).first().click()
      await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).first().fill('A-LFV-402S-1')
      await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).first().press('Enter')
      await page.waitForURL('**/tim-kiem?q=A-LFV-402S-1')
      await page.locator('#main-content h1').waitFor()
      for (const batch of [0, 1]) {
        await Promise.all(['/gach-op-lat', '/thiet-bi-ve-sinh', '/thiet-bi-ve-sinh/bon-cau', pdp, '/blog'].map(async path => {
          const t = Date.now()
          const r = await context.request.get(origin + path, { headers: {
            RSC: '1', 'Next-Router-Prefetch': '1', 'Next-Router-Segment-Prefetch': '1',
            'Next-URL': '/thiet-bi-ve-sinh/bon-cau.',
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
  console.log(`PUBLIC_NAVIGATION_ACCEPTANCE PASS probes=${probes} durationMs=${Date.now()-started} source=${sha}`)
} finally { await browser.close() }
