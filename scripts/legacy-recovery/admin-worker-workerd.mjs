#!/usr/bin/env node
// Local-only synthetic regression for the combined M3 Admin/Public Worker.
// It rejects non-loopback endpoints and reads the disposable DB URL only from
// Wrangler's local Hyperdrive binding; it never targets a hosted database.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import bcrypt from 'bcryptjs'
import { chromium } from 'playwright'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const workerConfigPath = path.resolve(process.env.ADMIN_WORKER_LOCAL_CONFIG ?? path.join(repoRoot, 'apps/public/wrangler.m3-local.jsonc'))
const baseUrl = new URL(process.env.ADMIN_WORKER_LOCAL_URL ?? 'http://127.0.0.1:8789')
const stageName = { value: 'configuration' }
const syntheticPassword = 'Synthetic-M3-Worker-Password-Only'
const ADMIN_MODULE_PATHS = [
  '/admin',
  '/admin/products',
  '/admin/blog/posts',
  '/admin/blog/tags',
  '/admin/orders',
  '/admin/customers',
  '/admin/quote-requests',
  '/admin/banners',
  '/admin/content/banners',
  '/admin/categories',
  '/admin/pim',
  '/admin/pim/brands',
  '/admin/pim/types',
  '/admin/pim/specifications',
  '/admin/pim/taxonomy',
  '/admin/pim/pilot',
  '/admin/doi-tac',
  '/admin/du-an',
  '/admin/users',
]

function assertLoopbackTarget(url) {
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '8789')
}

function readLocalDatabaseUrl(configText) {
  const config = JSON.parse(configText)
  const binding = config.hyperdrive?.find((entry) => entry.binding === 'HYPERDRIVE_ADMIN_NO_CACHE')
  assert.ok(binding?.localConnectionString, 'local Wrangler config must include a disposable Admin localConnectionString')
  const url = new URL(binding.localConnectionString)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '55439')
  assert.equal(url.pathname, '/dpg_m3_test')
  assert.equal(url.searchParams.get('sslmode'), 'disable')
  return url.toString()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function localUrl(pathname) {
  return new URL(pathname, baseUrl).toString()
}

async function waitForDatabaseConnections(client, expectedAtMost, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND usename = current_user`,
    )
    if (result.rows[0].count <= expectedAtMost) return
    await sleep(50)
  }
  const result = await client.query(
    `SELECT count(*)::int AS count
     FROM pg_stat_activity
     WHERE datname = current_database() AND usename = current_user`,
  )
  assert.ok(
    result.rows[0].count <= expectedAtMost,
    `Worker database connections remained above baseline (${result.rows[0].count} > ${expectedAtMost})`,
  )
}

async function main() {
  assertLoopbackTarget(baseUrl)
  const configText = await readFile(workerConfigPath, 'utf8')
  const databaseUrl = readLocalDatabaseUrl(configText)
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 })
  let browser
  let context
  let userId
  let productId
  let productCategoryId
  let blogPostId
  let blogCategoryId
  let baselineConnections = 0
  const marker = `workerd-spike-${Date.now()}-${randomBytes(3).toString('hex')}`
  const username = marker
  const email = `${marker}@example.test`
  const productSku = marker.toUpperCase().slice(0, 100)
  const productSlug = `${marker}-product`
  const blogSlug = `${marker}-blog`
  const productName = `${marker} Product`
  const blogTitle = `${marker} Blog`
  const updatedProductName = `${marker} Product Updated`
  const updatedBlogTitle = `${marker} Blog Updated`

  try {
    stageName.value = 'local synthetic fixture setup'
    await client.connect()
    const hash = await bcrypt.hash(syntheticPassword, 12)
    await client.query('BEGIN')
    const category = await client.query(
      `INSERT INTO dpg_app.categories (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${marker} Product Category`, `${marker}-category`],
    )
    productCategoryId = category.rows[0].id
    const blogCategory = await client.query(
      `INSERT INTO dpg_app.blog_categories (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${marker} Blog Category`, `${marker}-blog-category`],
    )
    blogCategoryId = blogCategory.rows[0].id
    const user = await client.query(
      `INSERT INTO dpg_app.admin_users (email, username, name, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'admin', true) RETURNING id`,
      [email, username, `${marker} Admin`, hash],
    )
    userId = user.rows[0].id
    const product = await client.query(
      `INSERT INTO dpg_app.products
         (sku, name, slug, category_id, price, list_price, sale_price,
          image_main_url, is_active, stock_status, price_source, price_confidence,
          publication_status, pdp_visibility, listing_visibility, search_visibility,
          seo_indexing, sitemap_include)
       VALUES ($1, $2, $3, $4, 129000, 129000, NULL,
          'https://synthetic.example.test/admin-worker-spike.jpg', false, 'in_stock',
          'manual_spike_fixture', 'high', 'draft', 'hidden', 'hidden', 'hidden',
          'noindex', false)
       RETURNING id`,
      [productSku, productName, productSlug, productCategoryId],
    )
    productId = product.rows[0].id
    await client.query(
      `INSERT INTO dpg_app.blog_posts (title, slug, content, category_id, status, version)
       VALUES ($1, $2, 'Synthetic Workerd regression content.', $3, 'draft', 1)
       RETURNING id`,
      [blogTitle, blogSlug, blogCategoryId],
    ).then((result) => { blogPostId = result.rows[0].id })
    await client.query('COMMIT')

    const initialProduct = await client.query(
      `SELECT price, list_price, sale_price, price_source, price_confidence,
              publication_status, pdp_visibility, seo_indexing, sitemap_include
       FROM dpg_app.products WHERE id = $1`,
      [productId],
    )
    const productProvenance = initialProduct.rows[0]
    const initialConnectionCount = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user`,
    )
    baselineConnections = initialConnectionCount.rows[0].count

    stageName.value = 'launching headless Playwright against local M3 Workerd'
    browser = await chromium.launch({ headless: true })

    async function signInAndRead() {
      const signedInContext = await browser.newContext()
      const page = await signedInContext.newPage()
      const loginResponse = await page.goto(localUrl('/admin/login'), { waitUntil: 'domcontentloaded' })
      assert.equal(loginResponse?.status(), 200)
      await page.locator('#identifier').fill(username)
      await page.locator('#password').fill(syntheticPassword)
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/admin/products', { timeout: 20000 }),
        page.getByRole('button', { name: 'Đăng nhập' }).click(),
      ])
      const productResponse = await page.goto(localUrl('/admin/products'), { waitUntil: 'domcontentloaded' })
      assert.equal(productResponse?.status(), 200)
      await page.waitForLoadState('networkidle', { timeout: 20000 })
      const blogResponse = await page.goto(localUrl('/admin/blog/posts'), { waitUntil: 'domcontentloaded' })
      assert.equal(blogResponse?.status(), 200)
      return { context: signedInContext, page }
    }

    stageName.value = 'three sequential synthetic login and protected SSR requests'
    const first = await signInAndRead()
    await first.context.close()
    const second = await signInAndRead()
    await second.context.close()
    const third = await signInAndRead()
    context = third.context
    const page = third.page

    stageName.value = 'authenticated SSR for every inventoried Admin module'
    const moduleResponses = await Promise.all(ADMIN_MODULE_PATHS.map(async (pathname) => ({
      pathname,
      status: (await context.request.get(localUrl(pathname))).status(),
    })))
    assert.deepEqual(
      moduleResponses.filter(({ status }) => status !== 200),
      [],
      'Every inventoried Admin module should render for an authorized Admin user',
    )

    stageName.value = 'authenticated Product edit through Worker server action'
    const productEditResponse = await page.goto(
      localUrl(`/admin/products/${productId}`),
      { waitUntil: 'domcontentloaded' },
    )
    assert.equal(productEditResponse?.status(), 200)
    await page.waitForLoadState('networkidle', { timeout: 20000 })
    await page.locator('input[name="name"]').fill(updatedProductName)
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/admin/products', { timeout: 20000 }),
      page.getByRole('button', { name: 'Cập nhật', exact: true }).first().click(),
    ])
    const savedProduct = await client.query(
      `SELECT name, price, list_price, sale_price, price_source, price_confidence,
              publication_status, pdp_visibility, seo_indexing, sitemap_include
       FROM dpg_app.products WHERE id = $1`,
      [productId],
    )
    assert.equal(savedProduct.rows[0].name, updatedProductName)
    assert.deepEqual(
      Object.fromEntries(Object.keys(productProvenance).map((key) => [key, savedProduct.rows[0][key]])),
      productProvenance,
      'Product price provenance and public visibility fields must survive an Admin edit',
    )

    stageName.value = 'authenticated Blog edit through Worker server action'
    const blogEditResponse = await page.goto(
      localUrl(`/admin/blog/posts/${blogPostId}`),
      { waitUntil: 'domcontentloaded' },
    )
    assert.equal(blogEditResponse?.status(), 200)
    await page.waitForLoadState('networkidle', { timeout: 20000 })
    await page.getByPlaceholder('VD: Top 5 xu hướng gạch ốp lát 2026 đẹp nhất').fill(updatedBlogTitle)
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/admin/blog/posts', { timeout: 20000 }),
      page.getByRole('button', { name: 'Cập nhật', exact: true }).click(),
    ])
    const savedBlogPost = await client.query(
      `SELECT title, status, version FROM dpg_app.blog_posts WHERE id = $1`,
      [blogPostId],
    )
    assert.equal(savedBlogPost.rows[0].title, updatedBlogTitle)
    assert.equal(savedBlogPost.rows[0].status, 'draft')
    assert.equal(savedBlogPost.rows[0].version, 2)

    stageName.value = 'same-process concurrent authenticated reads and stream cleanup'
    for (let round = 0; round < 3; round++) {
      const responses = await Promise.all([
        context.request.get(localUrl('/admin/products')),
        context.request.get(localUrl('/admin/blog/posts')),
      ])
      assert.deepEqual(responses.map((response) => response.status()), [200, 200])
    }
    await waitForDatabaseConnections(client, baselineConnections)

    stageName.value = 'Products write denied to sale role'
    await client.query(`UPDATE dpg_app.admin_users SET role = 'sale' WHERE id = $1`, [userId])
    await page.goto(localUrl(`/admin/products/${productId}`), { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20000 })
    await page.locator('input[name="name"]').fill(`${marker} Denied Product Edit`)
    await page.getByRole('button', { name: 'Cập nhật', exact: true }).first().click()
    await page.getByText('Bạn không có quyền cập nhật sản phẩm.', { exact: true }).waitFor({
      state: 'visible',
      timeout: 10000,
    })
    const deniedProduct = await client.query(`SELECT name FROM dpg_app.products WHERE id = $1`, [productId])
    assert.equal(deniedProduct.rows[0].name, updatedProductName)

    stageName.value = 'media upload denied for role without product-write permission'
    const deniedUpload = await page.evaluate(async (url) => {
      const response = await fetch(url, { method: 'POST' })
      return { status: response.status, body: await response.text() }
    }, localUrl('/api/upload-image'))
    assert.equal(deniedUpload.status, 403, `Upload permission-denial response: ${deniedUpload.body}`)

    stageName.value = 'revoked synthetic session denied on protected route'
    await client.query(`DELETE FROM dpg_app.admin_sessions WHERE user_id = $1`, [userId])
    const revokedResponse = await page.goto(localUrl('/admin/products'), { waitUntil: 'domcontentloaded' })
    assert.ok(revokedResponse?.status() === 200 || revokedResponse?.status() === 307)
    assert.equal(new URL(page.url()).pathname, '/admin/login')

    stageName.value = 'Worker route boundary and logout invalidates the test session'
    const unknownAdminResponse = await page.goto(localUrl('/admin/unknown'), { waitUntil: 'domcontentloaded' })
    assert.equal(unknownAdminResponse?.status(), 404)

    // The revoked-session check above intentionally removed the current login.
    // Use a fresh browser context so logout is tested with a clean, valid
    // session after the route-boundary requests above.
    await context.close()
    context = await browser.newContext()
    const logoutPage = await context.newPage()
    const reloginResponse = await logoutPage.goto(localUrl('/admin/login'), { waitUntil: 'domcontentloaded' })
    assert.equal(reloginResponse?.status(), 200)
    await logoutPage.locator('#identifier').fill(username)
    await logoutPage.locator('#password').fill(syntheticPassword)
    await Promise.all([
      logoutPage.waitForURL((url) => url.pathname === '/admin/products', {
        timeout: 20000,
        waitUntil: 'domcontentloaded',
      }),
      logoutPage.getByRole('button', { name: 'Đăng nhập' }).click(),
    ])
    await logoutPage.locator('button[title="Đăng xuất"]:visible').first().waitFor({ state: 'visible', timeout: 10000 })
    const activeSessions = await client.query(
      `SELECT count(*)::int AS count FROM dpg_app.admin_sessions WHERE user_id = $1`,
      [userId],
    )
    assert.equal(activeSessions.rows[0].count, 1)
    await Promise.all([
      logoutPage.waitForURL((url) => url.pathname === '/admin/login', {
        timeout: 10000,
        waitUntil: 'domcontentloaded',
      }),
      logoutPage.locator('button[title="Đăng xuất"]:visible').first().click(),
    ])
    await logoutPage.locator('#identifier').waitFor({ state: 'visible', timeout: 10000 })
    const loggedOutSessions = await client.query(
      `SELECT count(*)::int AS count FROM dpg_app.admin_sessions WHERE user_id = $1`,
      [userId],
    )
    assert.equal(loggedOutSessions.rows[0].count, 0)

    stageName.value = 'stream and database client cleanup'
    await waitForDatabaseConnections(client, baselineConnections)
    console.log('PASS: Workerd login/logout; all inventoried Admin module SSR routes; Product/Blog edits; provenance preserved; role write/upload denies; revoked session denied; invalid route denied; concurrent read rounds; DB connections returned to baseline.')
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    try {
      await client.query('ROLLBACK').catch(() => {})
      if (userId !== undefined) {
        await client.query(`DELETE FROM dpg_app.admin_sessions WHERE user_id = $1`, [userId]).catch(() => {})
        await client.query(`DELETE FROM dpg_app.audit_logs WHERE user_id = $1`, [userId]).catch(() => {})
      }
      if (blogPostId !== undefined) await client.query(`DELETE FROM dpg_app.blog_posts WHERE id = $1`, [blogPostId]).catch(() => {})
      if (productId !== undefined) await client.query(`DELETE FROM dpg_app.products WHERE id = $1`, [productId]).catch(() => {})
      if (blogCategoryId !== undefined) await client.query(`DELETE FROM dpg_app.blog_categories WHERE id = $1`, [blogCategoryId]).catch(() => {})
      if (productCategoryId !== undefined) await client.query(`DELETE FROM dpg_app.categories WHERE id = $1`, [productCategoryId]).catch(() => {})
      if (userId !== undefined) await client.query(`DELETE FROM dpg_app.admin_users WHERE id = $1`, [userId]).catch(() => {})
    } finally {
      await client.end().catch(() => {})
    }
  }
}

main().catch((error) => {
  const code = typeof error?.code === 'string' ? ` (${error.code})` : ''
  const safeMessage = String(error?.message ?? '')
    .replaceAll(syntheticPassword, '[redacted synthetic password]')
    .replace(/postgres(?:ql)?:\/\/[^\s]*/g, '[redacted local database URL]')
    .slice(0, 500)
  console.error(`FAIL: ${stageName.value}: ${error?.name ?? 'Error'}${code}${safeMessage ? `: ${safeMessage}` : ''}`)
  process.exitCode = 1
})
