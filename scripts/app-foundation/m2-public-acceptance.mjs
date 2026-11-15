import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { navigationTarget, readM2AccessHeaders, applyM2BrowserAccess } from './m2-navigation-context.mjs'

const [artifact, base, sourceSha, ...immutable] = process.argv.slice(2)
const { origin, hosted } = navigationTarget(base)
const folder = process.env.M2_EVIDENCE_DIR
assert.ok(folder, 'M2_EVIDENCE_DIR_REQUIRED')
await mkdir(folder, { recursive: true, mode: 0o700 })
const catalogue = join(artifact, 'assets/__catalogue/v1')
const manifest = JSON.parse(await readFile(join(catalogue, 'manifest.json'), 'utf8'))
const blog = JSON.parse(await readFile(join(catalogue, 'blog.json'), 'utf8'))
assert.equal(manifest.checkpoint, process.env.M2_PUBLIC_SNAPSHOT_CHECKPOINT)
assert.equal(manifest.sourceSha, sourceSha)
assert.equal(blog.posts.length, 10)
const images = new Map(), results = [], report = { sourceSha, checkpoint: manifest.checkpoint, status: 'UNKNOWN', results }
const allowedImageHosts = new Set(['cdn.dongphugia.com.vn','dpg-products.b-cdn.net','cdn.hita.com.vn','hita.com.vn','vietceramics.com','tygjmrhandbffjllxveu.supabase.co'])
const proxyUrl = hosted && process.env.https_proxy ? new URL(process.env.https_proxy) : null
const browser = await chromium.launch({ headless: true, ...(proxyUrl ? { proxy: { server: proxyUrl.origin, username: proxyUrl.username, password: proxyUrl.password } } : {}) })
const errorBody = /This page couldn.t load|Worker exceeded resource|Catalogue temporarily unavailable|Internal Server Error|(?:^|\n)[0-9a-f]+:E\{/
async function anonymousProbe(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) })
  assert.ok([302, 303, 401, 403].includes(response.status), 'M2_ANONYMOUS_ACCESS_NOT_BLOCKED')
  if (response.status < 400) assert.equal(new URL(response.headers.get('location')).hostname, 'cold-mode-bd20.cloudflareaccess.com')
  results.push({ kind: 'anonymous-access', url: new URL(url).origin + new URL(url).pathname, status: response.status })
}
try {
 for (const target of [origin, ...immutable]) {
  const validated = navigationTarget(target)
  const headers = readM2AccessHeaders(validated.origin, process.env.M2_ACCESS_TOKEN_FILE)
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await applyM2BrowserAccess(context, validated.origin, headers)
  const page = await context.newPage()
  const get = async (url, extra = {}) => {
    assert.equal(new URL(url).origin, validated.origin)
    return context.request.get(url, { headers: { ...extra, ...headers }, maxRedirects: 0, timeout: 30000 })
  }
  if (validated.hosted) {
    for (const path of ['/', '/api/health', '/images/logo-icon.svg', '/_next/static/probe.js']) await anonymousProbe(validated.origin + path)
    await anonymousProbe(validated.origin + '/blog', { RSC: '1', 'Next-Router-Prefetch': '1' })
  }
  const health = await get(validated.origin + '/api/health')
  assert.equal(health.status(), 200)
  assert.equal(health.headers()['x-dpg-source-sha'], sourceSha)
  assert.match(health.headers()['x-robots-tag'] || '', /noindex/)
  const value = await health.json()
  assert.equal(value.catalogueMode, 'verified-snapshot')
  assert.equal(value.catalogueCheckpoint, manifest.checkpoint)
  assert.equal(value.publicProducts, manifest.products)
  assert.equal(value.listingProducts, manifest.listingProducts)
  assert.equal(value.publishedBlogs, 10)
  const paths = ['/', '/blog', '/tim-kiem?q=A-LFV-402S-1', '/chinh-sach-bao-mat', '/dieu-kien-giao-dich', '/dieu-kien-kinh-doanh', '/thong-tin-gia', '/thong-tin-hang-hoa', '/van-chuyen-giao-nhan', ...manifest.categories.map(c => '/' + c.slug)]
  for (const c of manifest.categories) {
    assert.ok(c.homeProducts.length > 0)
    paths.push('/' + c.slug + '/' + c.listings[0].slug, c.homeProducts[0].url)
  }
  if (target === origin) paths.push(...blog.posts.map(p => `/blog/${p.category.slug}/${p.slug}`))
  else paths.push(`/blog/${blog.posts[0].category.slug}/${blog.posts[0].slug}`)
  for (const path of paths) {
    report.active = { origin: validated.origin, path, kind: 'html-rsc' }
    const response = await get(validated.origin + path)
    assert.equal(response.status(), 200, path)
    assert.equal(response.headers()['x-dpg-source-sha'], sourceSha, path)
    assert.match(response.headers()['x-robots-tag'] || '', /noindex/)
    assert.ok(!errorBody.test(await response.text()), path)
    const flight = await get(validated.origin + path, { RSC: '1', 'Next-Router-Prefetch': '1', 'Next-URL': path })
    assert.equal(flight.status(), 200, path)
    assert.match(flight.headers()['content-type'] || '', /text\/x-component/)
    assert.equal(flight.headers()['x-dpg-source-sha'], sourceSha)
    assert.ok(!errorBody.test(await flight.text()), path)
    results.push({ kind: 'html-rsc', origin: validated.origin, path, status: 'PASS' })
  }
  for (const path of ['/thiet-bi-ve-sinh/bon-cau.', '/not-a-public-category', '/thiet-bi-ve-sinh/not-a-real-listing', '/thiet-bi-ve-sinh/bon-cau/not-a-real-product']) {
    const response = await get(validated.origin + path)
    assert.equal(response.status(), 404, path)
    assert.equal(response.headers()['x-dpg-source-sha'], sourceSha)
    assert.match(response.headers()['cache-control'] || '', /no-store/)
  }
  if (target === origin) {
    const collectImages = async () => {
      for (const raw of await page.locator('#main-content img').evaluateAll(items => items.map(img => img.currentSrc || img.src))) {
        if (!raw || raw.startsWith('data:')) continue
        let url = new URL(raw, validated.origin)
        report.active = { host: url.hostname, path: url.pathname, kind: 'image' }
        if (images.has(url.href)) continue
        for (let hop = 0; hop < 4; hop++) {
          assert.ok(url.origin === validated.origin || (url.protocol === 'https:' && allowedImageHosts.has(url.hostname)), 'M2_PUBLIC_IMAGE_HOST_REQUIRED')
          assert.ok(!url.username && !url.password)
          const image = await context.request.get(url.href, { headers: url.origin === validated.origin ? headers : {}, maxRedirects: 0, timeout: 30000 })
          if ([301,302,303,307,308].includes(image.status())) { url = new URL(image.headers().location, url); continue }
          assert.equal(image.status(), 200, 'M2_IMAGE_HTTP_REQUIRED')
          const bytes = await image.body()
          assert.match(image.headers()['content-type'] || '', /^image\//)
          assert.ok(bytes.length > 16, 'M2_IMAGE_BYTES_REQUIRED')
          images.set(raw, { host: url.hostname, path: url.pathname, bytes: bytes.length, mime: image.headers()['content-type'].split(';')[0] })
          break
        }
        assert.ok(images.has(raw), 'M2_IMAGE_REDIRECT_LIMIT')
      }
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(validated.origin, { waitUntil: 'networkidle' })
      for (const index of [1, 2, 3]) {
        await page.getByRole('button', { name: `Xem banner ${index}`, exact: true }).click()
        await page.getByRole('group', { name: `${index} trên 3`, exact: true }).getByRole('img').waitFor()
        await collectImages()
      }
      assert.equal(await page.locator('header').count(), 1)
      assert.equal(await page.locator('footer').count(), 1)
      assert.equal(await page.locator('footer').getByRole('link', { name: 'Gọi tư vấn', exact: true }).getAttribute('href'), 'tel:0913865685')
      assert.equal(await page.locator('meta[name="facebook-domain-verification"]').getAttribute('content'), 'gvf51p663wowwajs4hoc2gv2zfiuh7')
      const structured = await page.locator('script[type="application/ld+json"]').allTextContents()
      if (structured.length) assert.ok(structured.join('').includes('https://www.dongphugia.vn'))
      assert.ok(!structured.join('').includes('.workers.dev'))
      await page.screenshot({ path: join(folder, `home-${width}.png`), fullPage: true })
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const category of manifest.categories) {
        report.active = { kind: 'responsive-catalogue', width, category: category.slug }
        const listing = category.listings[0].slug
        await page.goto(validated.origin + '/' + category.slug, { waitUntil: 'networkidle' })
        await page.locator(`#main-content a[href="/${category.slug}/${listing}"]`).first().click()
        await page.waitForURL(validated.origin + '/' + category.slug + '/' + listing)
        const product = page.locator(`#main-content a[href^="/${category.slug}/${listing}/"]`).first()
        await product.waitFor({ state: 'visible' })
        const href = await product.getAttribute('href')
        await product.click()
        await page.waitForURL(validated.origin + href)
        await page.locator('#main-content h1').waitFor()
        assert.ok(!errorBody.test(await page.locator('#main-content').innerText()))
        await collectImages()
        results.push({ kind: 'responsive-catalogue', category: category.slug, width, path: href, status: 'PASS' })
        if (width === 1440) await page.screenshot({ path: join(folder, `pdp-${category.slug}.png`), fullPage: true })
      }
    }
    for (const post of blog.posts) {
      await page.goto(validated.origin + `/blog/${post.category.slug}/${post.slug}`, { waitUntil: 'networkidle' })
      assert.ok((await page.locator('#main-content').innerText()).includes(post.title))
      await collectImages()
      results.push({ kind: 'published-blog', id: post.id, slug: post.slug, status: 'PASS' })
    }
    assert.ok(images.size > 3)
    if (validated.hosted) await anonymousProbe(validated.origin + '/') // Still protected after warm authenticated requests.
  }
  await context.close()
 }
 report.status = 'PASS'; report.images = [...images.values()]
 console.log(JSON.stringify({ status: 'PASS', stage: 'M2_PUBLIC_ACCEPTANCE', sourceSha, checkpoint: manifest.checkpoint, publishedBlogs: 10, verifiedImages: images.size }))
} catch (error) {
 report.status = 'FAIL'
 const message = error instanceof Error ? error.message : ''
 report.reason = /^M2_[A-Z0-9_]+$/.test(message) ? message : 'PUBLIC_ACCEPTANCE_FAILED'
 throw new Error(report.reason)
} finally {
 await browser.close()
 await writeFile(join(folder, 'public-acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
