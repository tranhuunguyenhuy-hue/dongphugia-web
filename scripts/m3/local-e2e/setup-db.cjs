/* eslint-disable @typescript-eslint/no-require-imports -- local dev harness: Playwright is resolved from the global install */
// Builds the local e2e database: base fixtures + 004 + resource fixtures + generated 005 + seed users/orders/quotes.
const { Client } = require('pg')
const bcrypt = require('bcryptjs')
const fs = require('node:fs')
const root = process.cwd()
const strip = (sql) => sql.replace(/-- guard:begin[\s\S]*?-- guard:end\n/, '')
;(async () => {
  const admin = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' }); await admin.connect()
  await admin.query('drop database if exists dpg_e2e with (force)'); await admin.query('create database dpg_e2e'); await admin.end()
  const db = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/dpg_e2e' }); await db.connect()
  await db.query("do $$ begin if exists (select 1 from pg_roles where rolname='dpg_admin_api_test') then execute 'drop owned by dpg_admin_api_test'; drop role dpg_admin_api_test; end if; end $$").catch(() => {})
  await db.query(fs.readFileSync(`${root}/supabase/functions/admin-api/test-fixtures/base.sql`, 'utf8'))
  const h = (p) => bcrypt.hashSync(p, 4)
  await db.query(`insert into dpg_app.admin_users(email,name,password_hash,role,is_active) values ('admin@example.test','Quản trị',$1,'admin',true),('manager@example.test','Trưởng kinh doanh',$2,'sale_manager',true),('sale@example.test','Nhân viên',$3,'sale',true)`, [h('admin-pass-1'), h('manager-pass-1'), h('sale-pass-1')])
  await db.query(strip(fs.readFileSync(`${root}/supabase/m3-test/004_m3_test_admin_api.sql`, 'utf8')))
  await db.query(fs.readFileSync(`${root}/supabase/functions/admin-api/test-fixtures/resources.sql`, 'utf8'))
  await db.query(strip(fs.readFileSync(`${root}/supabase/m3-test/005_m3_test_admin_resources.sql`, 'utf8')))
  await db.query("alter role dpg_admin_api_test password 'e2e-api-pass'")
  await db.query("update dpg_app.products set image_main_url='https://dpg-media-staging.b-cdn.net/products/seed.webp' where id <= 10")
  const sale = (await db.query("select id from dpg_app.admin_users where email='sale@example.test'")).rows[0].id
  const o = (await db.query("insert into dpg_app.orders(order_number,customer_name,customer_phone,subtotal,total,assigned_to) values ('DPG-E2E-1','Khách E2E','0900111222',3000,3000,$1) returning id", [sale])).rows[0].id
  await db.query("insert into dpg_app.order_items(order_id,product_id,product_name,product_sku,quantity,unit_price,total_price) values ($1,1,'Bồn cầu A','SKU-1',2,1000,2000),($1,2,'Lavabo B','SKU-2',1,1000,1000)", [o])
  const q = (await db.query("insert into dpg_app.quote_requests(quote_number,name,phone,email) values ('BG-E2E-1','Chị E2E','0933444555','e2e@example.test') returning id")).rows[0].id
  await db.query("insert into dpg_app.quote_items(quote_id,product_id,quantity,product_name_snapshot,sale_price_snapshot,snapshot_at) values ($1,1,2,'Bồn cầu A',1500,now())", [q])
  await db.end(); console.log('db ready')
})().catch((e) => { console.error(e); process.exit(1) })
