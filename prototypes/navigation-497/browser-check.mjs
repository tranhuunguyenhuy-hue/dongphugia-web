import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { makeCatalogue, searchSample } from './catalogue.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = process.env.NAV_URL || 'http://127.0.0.1:4970'
const output = process.env.NAV_EVIDENCE || '/tmp/navigation-497-evidence'
const snapshot = JSON.parse(await readFile(new URL('./snapshot.json', import.meta.url), 'utf8'))
const catalog = makeCatalogue(snapshot)
for (const row of snapshot.verifiedRelations) {
  const url = new URL(row.listing, snapshot.provenance.origin)
  const [, family, leaf] = url.pathname.split('/')
  const brand = url.searchParams.get('brand')
  const category = catalog.categories.find(item => item.slug === family)
  const type = catalog.types(category, brand).find(item => item.slug === leaf)
  assert.ok(catalog.categoriesFor(brand).includes(category))
  assert.equal(catalog.listing(category, type, brand), url.href)
  assert.ok(snapshot.products.some(product => product.id === row.id && product.sku === row.sku))
}
assert.equal(searchSample(snapshot.products, 'MS636DT2#XW', 8)[0].id, 676)
assert.equal(searchSample(snapshot.products, 'bon cau 1 khoi', 8).length > 0, true)
assert.equal(searchSample(snapshot.products, 'zzzz497', 8).length, 0)

await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--no-sandbox'],
})
const errors = []
async function setup(width, height, touch = false, url = '/') {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, reducedMotion: 'reduce' })
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.addInitScript(() => {
    window.layoutShifts = []
    new PerformanceObserver(list => window.layoutShifts.push(...list.getEntries().filter(entry => !entry.hadRecentInput).map(entry => entry.value)))
      .observe({ type: 'layout-shift', buffered: true })
  })
  await page.goto(origin + url)
  await page.locator('h1').waitFor()
  await page.evaluate(() => document.fonts.ready)
  return { page, requests }
}

async function overflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
}

async function compact(page, expected) {
  await page.waitForFunction(value => document.querySelector('.site-header').classList.contains('compact') === value, expected)
}

async function shot(page, name) {
  await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' })
}

const sanitary = 'Thiết bị vệ sinh'
const toilet = 'Bồn cầu'
const expectedInax = 'https://www.dongphugia.vn/thiet-bi-ve-sinh/bon-cau?brand=inax'
try {
  for (const width of [320, 375, 390, 430, 768, 1024, 1280, 1440]) {
    const height = width >= 1024 ? 900 : 800
    const { page } = await setup(width, height, width < 1024)
    await overflow(page)
    const header = page.locator('.site-header')
    const normal = await header.boundingBox()
    const bodyStart = await page.locator('main').evaluate(element => element.getBoundingClientRect().top + scrollY)
    await page.evaluate(() => scrollTo(0, 180))
    await compact(page, true)
    assert.ok((await header.boundingBox()).height < normal.height, String(width))
    assert.equal(await page.locator('main').evaluate(element => element.getBoundingClientRect().top + scrollY), bodyStart)
    await overflow(page)
    if (width < 1024) {
      await page.getByRole('button', { name: 'Mở tìm kiếm', exact: true }).tap()
      assert.equal(await page.locator('input').evaluate(element => document.activeElement === element), true)
      await compact(page, false)
      await page.keyboard.press('Escape')
      await compact(page, true)
      assert.equal(await page.getByRole('button', { name: 'Mở tìm kiếm', exact: true }).evaluate(element => document.activeElement === element), true)
      await page.getByRole('button', { name: 'Mở menu' }).tap()
      await compact(page, false)
      assert.equal(await page.locator('dialog').evaluate(element => element.open), true)
      assert.equal(await page.locator('body').evaluate(element => getComputedStyle(element).overflow), 'hidden')
      await page.getByRole('button', { name: 'Đóng menu' }).tap()
      await compact(page, true)
    }
    await page.close()
  }

  {
    const { page, requests } = await setup(1440, 900)
    await shot(page, 'desktop-normal')
    const initial = requests.length
    const product = page.getByRole('button', { name: 'Sản phẩm', exact: true })
    const brand = page.getByRole('button', { name: 'Thương hiệu', exact: true })
    const mega = page.locator('#mega')
    await product.hover()
    assert.equal(await mega.isVisible(), false)
    await mega.waitFor()
    await mega.locator('.panel').hover()
    await page.waitForTimeout(300)
    assert.equal(await mega.isVisible(), true)
    assert.equal(await mega.locator('.series').count(), 0)
    const height = (await mega.boundingBox()).height
    await shot(page, 'desktop-products')
    await mega.getByRole('button', { name: 'INAX', exact: true }).click()
    assert.equal(await mega.getByRole('link', { name: toilet, exact: true }).getAttribute('href'), expectedInax)
    assert.equal((await mega.boundingBox()).height, height)
    assert.equal(requests.length, initial)
    await page.keyboard.press('Escape')
    assert.equal(await product.evaluate(element => document.activeElement === element), true)
    await brand.focus()
    await page.keyboard.press('Space')
    await mega.waitFor()
    assert.equal(await mega.locator('.rail button').first().evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Tab')
    assert.equal(await mega.getByRole('button', { name: 'INAX', exact: true }).evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Enter')
    await mega.getByRole('button', { name: sanitary, exact: true }).click()
    assert.equal(await mega.getByRole('link', { name: toilet, exact: true }).getAttribute('href'), expectedInax)
    assert.equal((await mega.boundingBox()).height, height)
    await shot(page, 'desktop-brands')
    await page.locator('.hero-image').click({ position: { x: 20, y: 395 } })
    await mega.waitFor({ state: 'hidden' })
    await page.evaluate(() => scrollTo(0, 190))
    await compact(page, true)
    assert.equal(await page.getByRole('link', { name: 'Tin tức' }).isVisible(), false)
    await shot(page, 'desktop-compact')
    const logos = requests.filter(url => /\/assets\/(inax|toto|elica|karofi)\.png$/.test(url))
    assert.equal(logos.length, 4)
    assert.equal(new Set(logos).size, 4)
    assert.equal(requests.length, initial + 4)
    console.log('desktop requests before/after menu interactions:', initial, requests.length)
    console.log('desktop non-input CLS:', await page.evaluate(() => layoutShifts.reduce((sum, value) => sum + value, 0)))
    await page.close()
  }

  {
    const { page } = await setup(1024, 420, true)
    const product = page.getByRole('button', { name: 'Sản phẩm', exact: true })
    await product.tap()
    const panel = page.locator('.panel')
    assert.ok(await panel.evaluate(element => element.scrollHeight > element.clientHeight))
    await panel.evaluate(element => element.scrollTop = element.scrollHeight)
    assert.ok(await panel.evaluate(element => element.scrollTop > 0))
    await product.tap()
    assert.equal(await page.locator('#mega').isVisible(), false)
    await page.close()
  }

  {
    const { page } = await setup(1440, 900, false, '/?layout=series')
    await page.getByRole('button', { name: 'Sản phẩm', exact: true }).focus()
    await page.keyboard.press('Enter')
    const mega = page.locator('#mega')
    await mega.getByText('INAX S600 LINE').waitFor()
    assert.equal(await mega.locator('.series a').count(), 0)
    await shot(page, 'desktop-series-layout')
    await mega.getByRole('button', { name: 'TOTO', exact: true }).click()
    assert.equal(await mega.locator('.series').count(), 0)
    await page.close()
  }

  {
    const { page } = await setup(390, 844, true)
    await shot(page, 'mobile-normal')
    const menu = page.getByRole('button', { name: 'Mở menu' })
    const drawer = page.getByRole('dialog')
    const back = drawer.getByRole('button', { name: 'Quay lại' })
    const backOrClose = () => page.keyboard.press('Escape')
    await menu.tap()
    await drawer.getByRole('button', { name: 'Sản phẩm', exact: true }).tap()
    await drawer.getByRole('button', { name: sanitary, exact: true }).tap()
    await shot(page, 'mobile-products')
    await drawer.getByRole('button', { name: 'Thương hiệu · Tất cả' }).tap()
    await drawer.getByRole('button', { name: 'INAX' }).tap()
    assert.equal(await drawer.getByRole('link', { name: toilet, exact: true }).getAttribute('href'), expectedInax)
    await back.tap()
    await back.tap()
    await drawer.getByRole('button', { name: 'Thương hiệu', exact: true }).tap()
    await drawer.getByRole('button', { name: 'INAX' }).tap()
    await shot(page, 'mobile-brand')
    await drawer.getByRole('button', { name: sanitary, exact: true }).tap()
    const link = drawer.getByRole('link', { name: toilet, exact: true })
    assert.equal(await link.getAttribute('href'), expectedInax)
    await page.route(expectedInax, route => route.fulfill({ body: 'Đích Listing đã audit', contentType: 'text/plain' }))
    await link.tap()
    await page.waitForURL(expectedInax)
    await page.goBack()
    await page.locator('h1').waitFor()
    assert.equal(await drawer.isVisible(), false)
    await menu.tap()
    await backOrClose()
    await drawer.waitFor({ state: 'hidden' })
    assert.equal(await menu.evaluate(element => document.activeElement === element), true)
    await page.evaluate(() => scrollTo(0, 180))
    await compact(page, true)
    await shot(page, 'mobile-compact')
    console.log('mobile non-input CLS:', await page.evaluate(() => layoutShifts.reduce((sum, value) => sum + value, 0)))
    await page.close()
  }

  {
    const { page } = await setup(390, 844, true)
    const input = page.getByRole('searchbox')
    await input.fill('MS636DT2#XW')
    await page.getByText('Đang tìm sản phẩm…').waitFor()
    await page.locator('#search-results a').first().waitFor()
    await shot(page, 'mobile-search')
    assert.equal(await page.locator('#search-results a small').first().textContent(), 'MS636DT2#XW')
    await input.press('ArrowDown')
    assert.equal(await page.locator('#search-results a').first().evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Escape')
    await page.locator('#suggestions').waitFor({ state: 'hidden' })
    await input.fill('MS636DT2#XW')
    await input.press('Enter')
    await page.waitForURL(url => url.pathname === '/tim-kiem' && url.searchParams.get('q') === 'MS636DT2#XW')
    await page.locator('#submitted-results a').first().waitFor()
    await page.getByRole('link', { name: 'Giỏ hàng', exact: true }).tap()
    await page.getByRole('button', { name: 'Thử với 2 sản phẩm' }).tap()
    assert.equal(await page.getByRole('link', { name: 'Giỏ hàng (2 sản phẩm)' }).isVisible(), true)
    await page.getByRole('button', { name: 'Xóa dữ liệu thử' }).tap()
    assert.equal(await page.getByRole('link', { name: 'Giỏ hàng', exact: true }).isVisible(), true)
    await input.fill('zzzz497')
    await page.getByText('Không tìm thấy sản phẩm. Thử tên hoặc mã SKU khác.').waitFor()
    let oldFinished = false
    await page.route('**/api/search?*', async route => {
      const query = new URL(route.request().url()).searchParams.get('q')
      if (query === 'old') {
        await new Promise(resolve => setTimeout(resolve, 700))
        await route.fulfill({ json: { results: [snapshot.products[0]], source: 'snapshot' } }).catch(() => {})
        oldFinished = true
      } else if (query === 'broken') {
        await route.fulfill({ status: 503 })
      } else {
        await route.continue()
      }
    })
    await input.fill('old')
    await page.waitForRequest(request => request.url().includes('q=old'))
    await input.fill('broken')
    await page.getByRole('button', { name: 'Thử lại' }).waitFor()
    while (!oldFinished) await page.waitForTimeout(40)
    assert.equal(await page.locator('#search-results a').count(), 0)
    await page.unroute('**/api/search?*')
    await page.getByRole('button', { name: 'Thử lại' }).tap()
    await page.getByText('Không tìm thấy sản phẩm. Thử tên hoặc mã SKU khác.').waitFor()
    await page.close()
  }

  assert.deepEqual(errors, [])
  console.log('PASS: 8 viewport checks, 20 data mappings, hover, keyboard, pointer, touch, scroll, search and cart.')
} finally {
  await browser.close()
}
