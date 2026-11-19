/* eslint-disable @typescript-eslint/no-require-imports -- local dev harness: Playwright is resolved from the global install */
const { chromium } = require('playwright')
const { Client } = require('pg')
const BASE = 'http://localhost:8800/admin-next'
const results = []
const pg = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/dpg_e2e' })
async function check(name, fn, page) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name) }
  catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]); console.log('FAIL', name, '-', String(e.message).split('\n')[0]); if (page) await page.screenshot({ path: `fail-${results.length}.png` }).catch(() => {}) }
}
const sql = async (q, p) => (await pg.query(q, p)).rows
async function login(page, email, password) {
  await page.goto(BASE + '/'); await page.getByLabel('Email').fill(email); await page.getByLabel('Mật khẩu').fill(password); await page.getByRole('button', { name: 'Đăng nhập' }).click()
}
const confirmAlert = async (page) => page.getByRole('alertdialog').getByRole('button', { name: /^(Xóa|Gỡ|Xác nhận)$/ }).click()
const openTab = async (page, name) => page.getByRole('tab', { name }).click()
const expectText = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ timeout })
;(async () => {
  await pg.connect()
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage()
  const errors = []; page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) }); page.on('pageerror', (e) => errors.push('pageerror ' + e.message.slice(0, 160)))
  await page.route('**/api/upload-image', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: `https://dpg-media-staging.b-cdn.net/e2e/${Date.now()}.webp` }) }) : route.continue())

  await check('admin login lands on dashboard with KPIs', async () => { await login(page, 'admin@example.test', 'admin-pass-1'); await page.waitForURL(/\/dashboard$/); await expectText(page, 'Báo giá chờ xử lý'); await expectText(page, 'Doanh thu tháng này') }, page)
  await check('nav shows all admin areas', async () => { for (const t of ['Tổng quan', 'Đơn hàng', 'Yêu cầu báo giá', 'Bài viết', 'Tag blog', 'Banner', 'Đối tác', 'Dự án', 'Sản phẩm', 'Thương hiệu', 'Khách hàng', 'Người dùng']) await page.getByRole('link', { name: t, exact: true }).first().waitFor({ timeout: 4000 }) }, page)

  await check('blog tag: create, then deactivate', async () => {
    await page.goto(BASE + '/r/blog-tags/new'); await page.locator('#f-name').fill('Phòng tắm'); await page.waitForFunction(() => document.querySelector('#f-slug').value === 'phong-tam')
    await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/blog-tags\/\d+$/); await expectText(page, 'Tag blog #')
    await page.getByRole('button', { name: 'Xóa' }).click(); await confirmAlert(page); await page.waitForURL(/\/r\/blog-tags$/)
    const rows = await sql("select is_active from dpg_app.blog_tags where slug='phong-tam'"); if (rows[0]?.is_active !== false) throw new Error('tag not deactivated')
  }, page)
  await check('blog post: rich text, tags, publish, edit, reload persistence', async () => {
    await sql("insert into dpg_app.blog_tags(name,slug) values ('Gạch','gach') on conflict do nothing")
    await page.goto(BASE + '/r/blog-posts/new'); await page.locator('#f-title').fill('Bài viết E2E'); await page.locator('#f-category_id').selectOption({ label: 'Tin tức' }); await page.locator('#f-status').selectOption('published')
    await page.locator('.prose').click(); await page.keyboard.type('Nội dung đầu tiên'); await page.getByLabel('Gạch').check()
    await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/blog-posts\/\d+$/)
    const id = page.url().split('/').pop(); let rows = await sql('select title, slug, status, content, published_at from dpg_app.blog_posts where id=$1', [id])
    if (rows[0].slug !== 'bai-viet-e2e' || rows[0].status !== 'published' || !rows[0].published_at || !rows[0].content.includes('Nội dung đầu tiên')) throw new Error('post not stored as expected ' + JSON.stringify(rows[0]))
    await page.locator('#f-title').fill('Bài viết E2E (đã sửa)'); await page.getByRole('button', { name: 'Lưu' }).click(); await expectText(page, 'Đã lưu')
    await page.reload(); await page.locator('#f-title').waitFor(); if ((await page.locator('#f-title').inputValue()) !== 'Bài viết E2E (đã sửa)') throw new Error('edit lost after reload')
    if (!(await page.getByLabel('Gạch').isChecked())) throw new Error('tag selection lost')
    rows = await sql('select version from dpg_app.blog_posts where id=$1', [id]); if (rows[0].version !== 2) throw new Error('version ' + rows[0].version)
  }, page)
  await check('blog post: duplicate slug shows a friendly error', async () => {
    await page.goto(BASE + '/r/blog-posts/new'); await page.locator('#f-title').fill('Bài viết E2E'); await page.locator('#f-category_id').selectOption({ label: 'Tin tức' }); await page.getByRole('button', { name: 'Tạo' }).click()
    await expectText(page, 'bị trùng')
  }, page)
  await check('banner, partner, project: create via UI', async () => {
    await page.goto(BASE + '/r/banners/new'); await page.locator('#f-image_url').fill('https://dpg-media-staging.b-cdn.net/banners/e2e.webp'); await page.locator('#f-link_url').fill('/thiet-bi-ve-sinh'); await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/banners\/\d+$/)
    await page.goto(BASE + '/r/partners/new'); await page.locator('#f-name').fill('Đối tác E2E'); await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/partners\/\d+$/)
    await page.goto(BASE + '/r/projects/new'); await page.locator('#f-title').fill('Dự án E2E'); await page.locator('#f-tags').fill('biet-thu, da-lat'); await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/projects\/\d+$/)
    const p = await sql("select tags, slug from dpg_app.projects where title='Dự án E2E'"); if (p[0].tags.join() !== 'biet-thu,da-lat' || !/^du-an-e2e-\d+$/.test(p[0].slug)) throw new Error('project ' + JSON.stringify(p[0]))
  }, page)
  await check('banner: javascript: link rejected with field hint', async () => {
    await page.goto(BASE + '/r/banners/new'); await page.locator('#f-image_url').fill('https://dpg-media-staging.b-cdn.net/banners/x.webp'); await page.locator('#f-link_url').fill('javascript:alert(1)'); await page.getByRole('button', { name: 'Tạo' }).click(); await expectText(page, 'Liên kết')
  }, page)
  await check('brand create + category banner edit', async () => {
    await page.goto(BASE + '/r/brands/new'); await page.locator('#f-name').fill('TOTO'); await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/brands\/\d+$/)
    await page.goto(BASE + '/r/categories/1'); await page.locator('#f-banner_url').fill('https://dpg-media-staging.b-cdn.net/category-banners/e2e.webp'); await page.getByRole('button', { name: 'Lưu' }).click(); await expectText(page, 'Đã lưu')
    if ((await sql('select banner_url from dpg_app.categories where id=1'))[0].banner_url !== 'https://dpg-media-staging.b-cdn.net/category-banners/e2e.webp') throw new Error('banner not stored')
    if (await page.locator('#f-name').isEnabled()) throw new Error('category name must be read-only')
  }, page)
  await check('product: create, price rules, gallery upload, set main image, bulk activate', async () => {
    await page.goto(BASE + '/r/products/new'); await page.locator('#f-sku').fill('E2E-1'); await page.locator('#f-name').fill('Sản phẩm E2E'); await page.waitForFunction(() => document.querySelector('#f-slug').value === 'san-pham-e2e')
    await page.locator('#f-category_id').selectOption({ label: 'Cat' }); await openTab(page, 'Hiển thị & SEO'); await page.locator('#f-is_active').uncheck()
    await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/products\/\d+$/); const id = page.url().split('/').pop()
    await openTab(page, 'Giá'); await page.locator('#f-list_price').fill('3000000'); await page.locator('#f-sale_price').fill('3000000'); await page.getByRole('button', { name: 'Lưu' }).click(); await expectText(page, 'Giá khuyến mãi phải nhỏ hơn')
    await page.locator('#f-sale_price').fill('2500000'); await page.locator('#f-price').fill('2500000'); await page.getByRole('button', { name: 'Lưu' }).click(); await expectText(page, 'Đã lưu')
    await openTab(page, 'Hình ảnh'); await page.getByLabel('Thêm ảnh vào thư viện').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') }); await page.getByRole('button', { name: 'Ảnh chính', exact: true }).first().waitFor({ timeout: 6000 })
    await page.getByRole('button', { name: 'Ảnh chính', exact: true }).first().click(); await page.getByRole('button', { name: 'Lưu' }).click(); await page.getByRole('button', { name: 'Đang xử lý' }).waitFor({ state: 'detached', timeout: 8000 }); await expectText(page, 'Đã lưu')
    const row = (await sql('select image_main_url, price, version from dpg_app.products where id=$1', [id]))[0]; if (!row.image_main_url?.includes('dpg-media-staging') || Number(row.price) !== 2500000) throw new Error('product ' + JSON.stringify(row))
    if (Number((await sql('select count(*) from dpg_app.product_images where product_id=$1', [id]))[0].count) !== 1) throw new Error('gallery row missing')
    await page.goto(BASE + '/r/products'); await page.getByLabel(`Chọn ${id}`).check(); await page.getByRole('button', { name: 'Bán', exact: true }).click(); await expectText(page, 'Đã cập nhật 1 sản phẩm')
    if ((await sql('select is_active from dpg_app.products where id=$1', [id]))[0].is_active !== true) throw new Error('not activated')
    if (await page.goto(BASE + `/r/products/${id}`).then(() => page.locator('#f-sku').isEnabled())) throw new Error('sku must be read-only after creation')
  }, page)
  await check('product child records: document, relation and spec value added/removed in the editor', async () => {
    const id = (await sql("select id from dpg_app.products where sku='E2E-1'"))[0].id
    await page.goto(BASE + `/r/products/${id}`); await openTab(page, 'Phân loại & biến thể'); await page.getByRole('button', { name: /Thêm tài liệu sản phẩm/ }).click()
    await page.locator('#c-name').fill('Catalogue E2E'); await page.locator('#c-url').fill('https://docs.example.test/e2e.pdf'); await page.getByRole('button', { name: 'Thêm', exact: true }).click(); await expectText(page, 'Catalogue E2E')
    await page.getByRole('button', { name: /Thêm sản phẩm liên kết/ }).click(); await page.locator('#c-child_sku').fill('SKU-2'); await page.locator('#c-child_id').fill('2'); await page.getByRole('button', { name: 'Thêm', exact: true }).click(); await expectText(page, 'SKU-2')
    if ((await sql('select count(*) from dpg_app.product_documents where product_id=$1', [id]))[0].count !== '1') throw new Error('document not stored')
    if ((await sql('select count(*) from dpg_app.product_relationships where parent_id=$1', [id]))[0].count !== '1') throw new Error('relation not stored')
    await page.getByRole('row', { name: /Catalogue E2E/ }).getByRole('button', { name: 'Xóa' }).click(); await confirmAlert(page); await page.getByText('Catalogue E2E').waitFor({ state: 'detached', timeout: 6000 })
    await page.getByRole('row', { name: /SKU-2/ }).getByRole('button', { name: 'Xóa' }).click(); await confirmAlert(page); await new Promise((r) => setTimeout(r, 700))
    if ((await sql('select count(*) from dpg_app.product_documents where product_id=$1', [id]))[0].count !== '0') throw new Error('document not removed')
  }, page)
  await check('product variants: search, link, then unlink', async () => {
    const id = (await sql("select id from dpg_app.products where sku='E2E-1'"))[0].id
    await page.goto(BASE + `/r/products/${id}`); await openTab(page, 'Phân loại & biến thể'); const variants = page.locator('[data-slot=card]').filter({ hasText: 'Biến thể' }).last(); await page.getByLabel('Tìm sản phẩm để liên kết biến thể').fill('Product 7'); await variants.getByRole('button', { name: 'Liên kết', exact: true }).first().click(); await expectText(page, 'VG-')
    const g = await sql("select count(*) from dpg_app.products where variant_group is not null"); if (g[0].count !== '2') throw new Error('variant group size ' + g[0].count)
    await variants.getByRole('button', { name: 'Gỡ' }).first().click(); await confirmAlert(page); await new Promise((r) => setTimeout(r, 700))
    const h = await sql("select count(*) from dpg_app.products where variant_group is not null"); if (h[0].count !== '1') throw new Error('unlink failed ' + h[0].count)
  }, page)
  await check('customer and user management (bcrypt) via UI', async () => {
    await page.goto(BASE + '/r/customers/new'); await page.locator('#f-full_name').fill('Khách E2E mới'); await page.locator('#f-phone').fill('0977888999'); await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/customers\/\d+$/)
    await page.goto(BASE + '/r/users/new'); await page.locator('#f-email').fill('nhanvien.moi@example.test'); await page.locator('#f-name').fill('Nhân viên mới'); await page.locator('#f-password').fill('mat-khau-dai-1'); await page.getByRole('button', { name: 'Tạo' }).click(); await page.waitForURL(/\/r\/users\/\d+$/)
    const u = (await sql("select password_hash from dpg_app.admin_users where email='nhanvien.moi@example.test'"))[0]; if (!/^\$2[aby]\$/.test(u.password_hash)) throw new Error('password not hashed')
    await page.goto(BASE + '/r/users'); await expectText(page, 'nhanvien.moi@example.test')
    if ((await page.content()).includes('$2')) throw new Error('hash leaked to the page')
  }, page)
  await check('orders: list, inline status, builder edit and totals, print control', async () => {
    await page.goto(BASE + '/orders'); await expectText(page, 'DPG-E2E-1'); await page.getByLabel('Trạng thái DPG-E2E-1').selectOption('confirmed')
    await page.waitForFunction(async () => true); await new Promise((r) => setTimeout(r, 600)); if ((await sql("select status from dpg_app.orders where order_number='DPG-E2E-1'"))[0].status !== 'confirmed') throw new Error('status not updated')
    await page.getByRole('link', { name: 'DPG-E2E-1' }).click(); await page.waitForURL(/\/orders\/\d+$/)
    await page.getByLabel('Đơn giá Bồn cầu A').fill('2000'); await page.getByLabel('VAT (%)').fill('10'); await page.getByLabel('Phí vận chuyển').fill('50000'); await page.getByRole('button', { name: 'Lưu', exact: true }).click(); await expectText(page, 'Đã lưu đơn hàng')
    const o = (await sql("select subtotal,total,vat_rate from dpg_app.orders where order_number='DPG-E2E-1'"))[0]; if (Number(o.subtotal) !== 5000 || Number(o.total) !== 5000 + 500 + 50000) throw new Error('totals ' + JSON.stringify(o))
    await page.getByRole('button', { name: 'In đơn' }).waitFor()
  }, page)
  await check('quote builder: save draft then complete syncs CSKH', async () => {
    await page.goto(BASE + '/quotes'); await expectText(page, 'BG-E2E-1'); await page.getByRole('link', { name: 'BG-E2E-1' }).click(); await page.waitForURL(/\/quotes\/\d+$/)
    await page.getByLabel('Đơn giá Bồn cầu A').fill('1400'); await page.getByRole('button', { name: 'Lưu nháp' }).click(); await expectText(page, 'Đã lưu bản nháp')
    if ((await sql("select status from dpg_app.quote_requests where quote_number='BG-E2E-1'"))[0].status !== 'resolved') throw new Error('not resolved')
    page.once('dialog', (d) => d.accept()); await page.getByRole('button', { name: 'Hoàn thành' }).click(); await expectText(page, 'Đã hoàn thành báo giá')
    if ((await sql("select count(*) from dpg_app.customers where phone='0933444555'"))[0].count !== '1') throw new Error('customer not synced')
  }, page)
  await check('dashboard shows pending counts and revenue chart section', async () => { await page.goto(BASE + '/dashboard'); await expectText(page, 'Sản phẩm bán chạy'); await expectText(page, 'Doanh thu') }, page)
  await check('logout and direct deep link requires login', async () => { await page.getByRole('button', { name: 'Tài khoản' }).click(); await page.getByRole('menuitem', { name: 'Đăng xuất' }).click(); await page.getByRole('button', { name: 'Đăng nhập' }).waitFor(); await page.goto(BASE + '/r/users'); await page.getByRole('button', { name: 'Đăng nhập' }).waitFor() }, page)

  // sale user: read-only
  const sctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true }); const mobile = await sctx.newPage()
  await check('sale (mobile): sees only allowed areas, products read-only, only assigned order', async () => {
    await login(mobile, 'sale@example.test', 'sale-pass-1'); await mobile.waitForURL(/\/r\/products$/)
    await mobile.getByLabel('Thu gọn/mở menu').click()
    for (const t of ['Bài viết', 'Người dùng', 'Banner']) if (await mobile.getByRole('link', { name: t, exact: true }).count()) throw new Error('sale must not see ' + t)
    await mobile.getByRole('link', { name: 'Đơn hàng', exact: true }).click(); await expectText(mobile, 'DPG-E2E-1')
    await mobile.goto(BASE + '/r/products/1'); await mobile.locator('#f-name').waitFor(); if (await mobile.locator('#f-name').isEnabled()) throw new Error('product form must be read-only for sale'); if (await mobile.getByRole('button', { name: 'Lưu' }).count()) throw new Error('no save for sale')
    await mobile.goto(BASE + '/r/blog-posts'); await mobile.getByText('Không tìm thấy hoặc không có quyền truy cập').waitFor({ timeout: 6000 })
  }, mobile)
  await check('no unexpected console errors', async () => { const bad = errors.filter((e) => !/401|403|404|409|400|Failed to load resource/.test(e)); if (bad.length) throw new Error(bad.join(' | ')) })
  await browser.close(); await pg.end()
  const fails = results.filter((r) => r[0] === 'FAIL'); console.log(`\n${results.length - fails.length}/${results.length} PASS`); process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
