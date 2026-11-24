// Declarative Admin resources (M3 G4). ONE definition drives: request validation (validation.ts), parameterised SQL
// (resource-handlers.ts), RBAC, audit, the form metadata served to the SPA (/schema) and the TEST/Production
// column-level grants + RLS policies (grants.ts -> supabase/m3-test/005_*.sql). Identifiers below are static code;
// request data only ever travels as bind parameters.
import { ApiError, type Context, type Db } from './core.ts'
import type { Permission } from './permissions.ts'

export type FieldKind = 'text' | 'textarea' | 'html' | 'int' | 'bool' | 'enum' | 'link' | 'media' | 'datetime' | 'strings' | 'ref' | 'json' | 'password' | 'money' | 'email' | 'url'
export interface FieldDef {
  name: string
  label: string
  kind: FieldKind
  /** Must be supplied on create and can never be null. */
  required?: boolean
  max?: number
  min?: number
  options?: readonly string[]
  /** Resource key whose rows are offered as options (kind 'ref'). */
  ref?: string
  /** Returned to the client but never written by the API. */
  readOnly?: boolean
  /** Writable on create only (identity fields such as SKU and slug never change afterwards). */
  createOnly?: boolean
  /** Input-only property that is not a column (e.g. `password`): never selected, granted or audited by name. */
  virtual?: boolean
  /** Shown as a list column. */
  list?: boolean
  /** NULL allowed (default: yes for text-like/media/link/strings/datetime, no for int/bool/enum/ref). */
  nullable?: boolean
  /** Form hint: derive this slug from another field while creating. */
  slugFrom?: string
  /** Extra permission needed (on top of the resource write permission) to change this field. */
  permission?: Permission
  /** Column privileges come from a separate reviewed migration (e.g. supabase/m3-test/007_*), not from the generated resource grants. */
  externalGrant?: boolean
  /** Form hint for new rows. */
  initial?: unknown
  /** Media fields: legacy upload route parameters (folder + processing profile). */
  upload?: { folder: string; profile: 'product' | 'editorial' | 'hero' }
}
export interface RelationDef {
  /** Input/output property, e.g. `tag_ids`. */
  input: string
  label: string
  table: string
  owner: string
  target: string
  ref: string
  max: number
  /** Maintain a denormalised counter on the target table. */
  recount?: { table: string; column: string }
}
export type Row = Record<string, unknown>
export type SqlRaw = { raw: string }
export interface HookServices { hashPassword(plain: string): Promise<string> }
export interface HookArgs { tx: Db; mode: 'create' | 'update' | 'delete'; existing?: Row; input: Row; ctx: Context; services: HookServices }
export interface HookResult {
  /** Extra columns written together with the request input (values are bind parameters unless `{ raw }`). */
  set?: Record<string, unknown | SqlRaw>
  /** For `delete`: update these columns instead of removing the row. */
  instead?: Record<string, unknown | SqlRaw>
}
export type WriteHook = (args: HookArgs) => Promise<HookResult | void> | HookResult | void

export interface ResourceDef {
  key: string
  label: string
  group: string
  table: string
  read: Permission
  /** Omitted = read-only resource. */
  write?: Permission
  /** Permission for delete (defaults to `write`). */
  remove?: Permission
  fields: FieldDef[]
  relations?: RelationDef[]
  search: string[]
  orderBy: string
  /** Column used as the human label in option lists. */
  optionLabel: string
  filters?: { name: string; label: string; kind: 'bool' | 'int' | 'enum'; options?: readonly string[] }[]
  versioned?: boolean
  requireVersion?: boolean
  /** The table has no `updated_at` column (product_sub_types, spec_options). */
  noUpdatedAt?: boolean
  /** Rows belong to a parent record and are edited from the parent's screen (documents, spec values, ...). */
  childOf?: { parent: string; column: string }
  /** Edited from inside another screen (e.g. product gallery) rather than from the navigation. */
  hideFromNav?: boolean
  /** Dev-managed shared master data (#309 scope decision): Admin roles only read id/label options for the product forms.
   * No list/get/create/update/delete is served and the resource is omitted from /schema, for every role. */
  lookup?: boolean
  create?: boolean
  /** Rows can be edited (default true when `write` is set). */
  update?: boolean
  /** 'soft' clears `is_active`; 'hard' removes the row; absent = no delete. */
  delete?: 'hard' | 'soft'
  /** Legacy behaviour: slug generated server-side once, on create (slugify(source) + '-' + epoch ms). */
  autoSlug?: { column: string; from: string }
  /** Columns that hooks write (need an UPDATE grant) and columns hooks read from the existing row. */
  hookColumns?: string[]
  /** Columns the hook sets on create (INSERT grant). */
  createColumns?: string[]
  existingColumns?: string[]
  hook?: WriteHook
}

const RAW_NOW: SqlRaw = { raw: 'now()' }
const SCHEDULE_RESET = {
  scheduled_for: null, scheduled_timezone: null, scheduled_version: null,
  schedule_blocked_code: null, schedule_blocked_at: null, schedule_last_attempt_at: null,
}

/** Blog post lifecycle (mirrors src/lib/blog-actions.ts): published_at only moves on a real publish, drafts clear it,
 * a human edit cancels any schedule, and content/media of Publishing-Agent posts stay behind the Publishing API. */
const blogPostHook: WriteHook = ({ mode, existing, input }) => {
  if (mode === 'create') {
    return input.status === 'published' ? { set: { published_at: RAW_NOW, first_published_at: RAW_NOW } } : undefined
  }
  const managed = Boolean(existing?.publishing_identity_id)
  if (mode === 'delete') {
    if (!managed) return undefined
    return { instead: { status: 'draft', published_at: null, ...SCHEDULE_RESET } }
  }
  if (managed) {
    if (existing?.status === 'scheduled' || existing?.status === 'schedule_blocked') throw new ApiError(409, 'PUBLISHING_MANAGED')
    for (const field of ['content', 'thumbnail_url', 'cover_image_url']) {
      if (field in input && (input[field] ?? null) !== (existing?.[field] ?? null)) throw new ApiError(409, 'PUBLISHING_MANAGED')
    }
  }
  const set: Record<string, unknown | SqlRaw> = { ...SCHEDULE_RESET }
  if ('status' in input) {
    if (input.status === 'published') {
      if (existing?.status !== 'published') set.published_at = RAW_NOW
      if (!existing?.first_published_at) set.first_published_at = RAW_NOW
    } else set.published_at = null
  }
  return { set }
}

/** Admin account rules (mirrors src/app/admin/(dashboard)/users/actions.ts): passwords are hashed server-side with
 * bcrypt, a password change or deactivation revokes the account's sessions, and the last active admin is protected. */
const userHook: WriteHook = async ({ mode, existing, input, ctx, tx, services }) => {
  if (mode === 'delete') return undefined
  const actor = ctx.session!
  if (actor.role !== 'admin' && (input.role === 'admin' || existing?.role === 'admin')) throw new ApiError(403, 'FORBIDDEN')
  const set: Record<string, unknown> = {}
  if (typeof input.password === 'string') set.password_hash = await services.hashPassword(input.password)
  if (mode === 'update' && existing) {
    const losesAdmin = existing.role === 'admin' && existing.is_active === true && (input.is_active === false || (input.role !== undefined && input.role !== 'admin'))
    if (losesAdmin) {
      const admins = await tx.query('select id from dpg_app.admin_users where role = $1 and is_active = true for update', ['admin'])
      if (admins.length <= 1) throw new ApiError(409, 'LAST_ADMIN')
    }
    if (typeof input.password === 'string' || input.is_active === false) await tx.query('delete from dpg_app.admin_sessions where user_id = $1', [existing.id])
  }
  return { set }
}
/** Legacy addProductRelationship: a new relation goes to the end of the parent's list for that type. */
const relationshipHook: WriteHook = async ({ mode, tx, input }) => {
  if (mode !== 'create' || input.sort_order !== undefined) return undefined
  const rows = await tx.query<{ n: string }>('select count(*) as n from dpg_app.product_relationships where parent_id = $1 and relationship_type = $2', [input.parent_id, input.relationship_type ?? 'component'])
  return { set: { sort_order: Number(rows[0].n) } }
}
const customerHook: WriteHook = ({ mode }) => (mode === 'create' ? { set: { last_interacted_at: RAW_NOW } } : undefined)

/** Product rules (mirrors src/lib/product-actions.ts): a sale price needs a higher list price, and a product can only be
 * activated with a price (unless it is "contact for quote") and a main image. Identity (sku/slug) is create-only. */
const PRICE_FIELDS = ['price', 'list_price', 'sale_price', 'regular_price_vnd', 'stock_status', 'image_main_url', 'is_active']
const asNumber = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value))
/** #446 canonical Hita price contract (category-agnostic validation; scope to thiet-bi-ve-sinh is a data/import rule).
 * Whole positive VND: 0 < promotional < regular; 0 < voucher < (promotional ?? regular); promotional/voucher need a regular price. */
export const CANONICAL_PRICE_FIELDS = ['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd'] as const
export function assertCanonicalPrices(final: Record<string, unknown>): void {
  const read = (name: string): number | null => {
    const value = final[name]
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 1) throw new ApiError(400, 'PRICE_RELATION_INVALID', [name])
    return n
  }
  const regular = read('regular_price_vnd'), promo = read('promotional_price_vnd'), voucher = read('online_voucher_amount_vnd')
  if (promo !== null && (regular === null || promo >= regular)) throw new ApiError(400, 'PRICE_RELATION_INVALID', ['promotional_price_vnd', 'regular_price_vnd'])
  if (voucher !== null && (regular === null || voucher >= (promo ?? regular))) throw new ApiError(400, 'VOUCHER_INVALID', ['online_voucher_amount_vnd'])
}
/** #470 scope of the canonical price rules: sanitary x approved brands (equals CANONICAL_APPROVED_BRANDS in src/lib/canonical-price.ts; asserted by a test).
 * Other brands/categories keep managing prices exactly as before (legacy fields). */
export const CANONICAL_ADMIN_BRANDS = ['toto', 'inax'] as const
const CANONICAL_ADMIN_CATEGORY = 'thiet-bi-ve-sinh'
/** Policy constant (Owner to confirm): a verified price older than this must be re-verified/re-entered before the SKU is re-activated. */
export const CANONICAL_REACTIVATION_MAX_AGE_MS = 7 * 24 * 3600_000
async function inCanonicalAdminScope(tx: Db, final: Row): Promise<boolean> {
  const rows = await tx.query<{ brand: string | null; category: string | null }>(
    'select (select slug from dpg_app.brands where id = $1) as brand, (select slug from dpg_app.categories where id = $2) as category', [final.brand_id ?? null, final.category_id ?? null])
  const row = rows[0]
  return Boolean(row && row.category === CANONICAL_ADMIN_CATEGORY && row.brand && (CANONICAL_ADMIN_BRANDS as readonly string[]).includes(row.brand))
}
const productHook: WriteHook = async ({ tx, mode, existing, input }) => {
  if (mode === 'delete') return undefined
  const final: Record<string, unknown> = { ...(existing ?? {}), ...input }
  if (CANONICAL_PRICE_FIELDS.some((field) => field in input) || 'canonical_price_status' in input) assertCanonicalPrices(final)
  // #470: Production adds `canonical_price_status` with a CHECK (prices only with PRICE_VERIFIED). Admins edit prices, not the
  // status, so the status follows the prices: any price present => PRICE_VERIFIED (verified by the admin), none => the
  // status is cleared (price hidden, "cần liên hệ"). A non-price status combined with a price is rejected before the CHECK.
  // Fail-safe: databases without the column (TEST fixed Preview today) never see this write.
  // The status write is collected here and returned only AFTER every legacy guard below has run (#470 TL review: no early return).
  let statusSet: Record<string, unknown> | undefined
  if (externalColumns.has('canonical_price_status')) {
    const hasPrice = CANONICAL_PRICE_FIELDS.some((field) => final[field] !== null && final[field] !== undefined && final[field] !== '')
    const priceInRequest = CANONICAL_PRICE_FIELDS.some((field) => field in input)
    // Canonical prices are only for approved brands: any other sanitary brand keeps the legacy price management untouched.
    if (hasPrice && priceInRequest && !(await inCanonicalAdminScope(tx, final))) throw new ApiError(400, 'PRICE_SCOPE_INVALID', ['brand_id'])
    // Re-activating a SKU whose verified price is stale (or has no check time) needs a fresh price in the same request.
    const activating = input.is_active === true && existing?.is_active !== true
    if (activating && !priceInRequest && final.canonical_price_status === 'PRICE_VERIFIED' && await inCanonicalAdminScope(tx, final)) {
      const checked = Date.parse(String(final.canonical_price_checked_at ?? ''))
      if (!Number.isFinite(checked) || Date.now() - checked > CANONICAL_REACTIVATION_MAX_AGE_MS) throw new ApiError(400, 'PRICE_REVERIFY_REQUIRED', ['regular_price_vnd'])
    }
    const requested = input.canonical_price_status as string | null | undefined
    if (hasPrice && requested !== undefined && requested !== null && requested !== 'PRICE_VERIFIED') throw new ApiError(400, 'PRICE_STATUS_INVALID', ['canonical_price_status'])
    if (CANONICAL_PRICE_FIELDS.some((field) => field in input)) {
      const next = hasPrice ? 'PRICE_VERIFIED' : (final.canonical_price_status === 'PRICE_VERIFIED' ? null : (final.canonical_price_status ?? null))
      statusSet = { canonical_price_status: next, canonical_price_checked_at: RAW_NOW }
    }
  }
  const list = asNumber(final.list_price), sale = asNumber(final.sale_price)
  if (sale !== null && (list === null || sale >= list)) throw new ApiError(400, 'SALE_PRICE_INVALID', ['sale_price', 'list_price'])
  if (final.is_active === true && (mode === 'create' || PRICE_FIELDS.some((field) => field in input))) {
    if (final.stock_status !== 'contact' && !asNumber(final.price) && !list && !sale && !asNumber(final.regular_price_vnd)) throw new ApiError(400, 'PRICE_REQUIRED', ['price'])
    if (typeof final.image_main_url !== 'string' || final.image_main_url.trim() === '') throw new ApiError(400, 'IMAGE_REQUIRED', ['image_main_url'])
  }
  return statusSet ? { set: statusSet } : undefined
}

export const RESOURCES: ResourceDef[] = [
  {
    key: 'blog-categories', label: 'Chuyên mục blog', group: 'Nội dung', table: 'blog_categories',
    read: 'blog:read', search: ['name', 'slug'], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', max: 100, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 100, list: true, readOnly: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', readOnly: true },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, readOnly: true },
    ],
  },
  {
    key: 'blog-tags', label: 'Tag blog', group: 'Nội dung', table: 'blog_tags',
    read: 'blog:read', write: 'blog:write', create: true, update: false, delete: 'soft',
    search: ['name', 'slug'], orderBy: 'name asc, id asc', optionLabel: 'name',
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }],
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 50, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 50, list: true, slugFrom: 'name' },
      { name: 'description', label: 'Mô tả', kind: 'textarea', max: 2000 },
      { name: 'post_count', label: 'Số bài', kind: 'int', readOnly: true, list: true },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', readOnly: true, list: true },
    ],
  },
  {
    key: 'blog-posts', label: 'Bài viết', group: 'Nội dung', table: 'blog_posts',
    read: 'blog:read', write: 'blog:write', create: true, delete: 'hard',
    search: ['title', 'slug'], orderBy: 'id desc', optionLabel: 'title',
    versioned: true, requireVersion: true, hook: blogPostHook,
    hookColumns: ['published_at', 'first_published_at', ...Object.keys(SCHEDULE_RESET)],
    createColumns: ['published_at', 'first_published_at'],
    existingColumns: ['publishing_identity_id', 'first_published_at', 'external_id'],
    filters: [
      { name: 'status', label: 'Trạng thái', kind: 'enum', options: ['draft', 'published', 'scheduled', 'schedule_blocked'] },
      { name: 'category_id', label: 'Chuyên mục', kind: 'int' },
    ],
    relations: [{ input: 'tag_ids', label: 'Tag', table: 'blog_post_tags', owner: 'post_id', target: 'tag_id', ref: 'blog-tags', max: 50, recount: { table: 'blog_tags', column: 'post_count' } }],
    fields: [
      { name: 'title', label: 'Tiêu đề', kind: 'text', required: true, max: 300, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 300, list: true, slugFrom: 'title' },
      { name: 'category_id', label: 'Chuyên mục', kind: 'ref', ref: 'blog-categories', required: true, list: true },
      { name: 'status', label: 'Trạng thái', kind: 'enum', options: ['draft', 'published'], list: true, initial: 'draft' },
      { name: 'excerpt', label: 'Tóm tắt', kind: 'textarea', max: 5000 },
      { name: 'content', label: 'Nội dung', kind: 'html', max: 400000, nullable: false },
      { name: 'thumbnail_url', label: 'Ảnh đại diện', kind: 'media', upload: { folder: 'blog', profile: 'editorial' } },
      { name: 'cover_image_url', label: 'Ảnh bìa', kind: 'media', upload: { folder: 'blog', profile: 'editorial' } },
      { name: 'author_name', label: 'Tác giả', kind: 'text', max: 100, min: 1, nullable: false, initial: 'Ban Biên Tập Đông Phú Gia' },
      { name: 'author_avatar', label: 'Ảnh tác giả', kind: 'media', upload: { folder: 'blog', profile: 'editorial' } },
      { name: 'reading_time', label: 'Thời gian đọc (phút)', kind: 'int', min: 0, max: 600, nullable: true },
      { name: 'is_featured', label: 'Nổi bật', kind: 'bool' },
      { name: 'is_pinned', label: 'Ghim', kind: 'bool' },
      { name: 'seo_title', label: 'SEO title', kind: 'text', max: 200 },
      { name: 'seo_description', label: 'SEO description', kind: 'textarea', max: 500 },
      { name: 'seo_keywords', label: 'SEO keywords', kind: 'text', max: 500 },
      { name: 'view_count', label: 'Lượt xem', kind: 'int', readOnly: true },
      { name: 'published_at', label: 'Xuất bản lúc', kind: 'datetime', readOnly: true, list: true },
      { name: 'updated_at', label: 'Cập nhật', kind: 'datetime', readOnly: true },
      { name: 'version', label: 'Phiên bản', kind: 'int', readOnly: true },
    ],
  },
  {
    key: 'banners', label: 'Banner', group: 'Nội dung', table: 'banners',
    read: 'blog:read', write: 'blog:write', create: true, delete: 'hard',
    search: ['title', 'link_url'], orderBy: 'sort_order asc, id asc', optionLabel: 'title',
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }],
    fields: [
      { name: 'title', label: 'Tiêu đề', kind: 'text', max: 200, list: true },
      { name: 'image_url', label: 'Ảnh', kind: 'media', required: true, max: 500, list: true, upload: { folder: 'banners', profile: 'hero' } },
      { name: 'link_url', label: 'Liên kết', kind: 'link', max: 500, list: true },
      { name: 'is_active', label: 'Hiển thị', kind: 'bool', list: true, initial: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, list: true, initial: 0 },
    ],
  },
  {
    key: 'partners', label: 'Đối tác', group: 'Đối tác & Dự án', table: 'partners',
    read: 'blog:read', write: 'blog:write', create: true, delete: 'hard',
    search: ['name', 'slug'], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    autoSlug: { column: 'slug', from: 'name' },
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }],
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 200, readOnly: true, list: true },
      { name: 'logo_url', label: 'Logo', kind: 'media', max: 500, upload: { folder: 'partners', profile: 'product' } },
      { name: 'description', label: 'Mô tả', kind: 'textarea', max: 5000 },
      { name: 'tier', label: 'Hạng', kind: 'text', max: 50, list: true, initial: 'Vàng' },
      { name: 'gradient_class', label: 'Lớp gradient', kind: 'text', max: 100 },
      { name: 'link_url', label: 'Liên kết', kind: 'link', max: 500 },
      { name: 'is_active', label: 'Hiển thị', kind: 'bool', list: true, initial: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, list: true, initial: 0 },
    ],
  },
  {
    key: 'projects', label: 'Dự án', group: 'Đối tác & Dự án', table: 'projects',
    read: 'blog:read', write: 'blog:write', create: true, delete: 'hard',
    search: ['title', 'slug', 'location'], orderBy: 'sort_order asc, id asc', optionLabel: 'title',
    autoSlug: { column: 'slug', from: 'title' },
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }, { name: 'is_featured', label: 'Nổi bật', kind: 'bool' }],
    fields: [
      { name: 'title', label: 'Tiêu đề', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 200, readOnly: true, list: true },
      { name: 'location', label: 'Địa điểm', kind: 'text', max: 200, list: true },
      { name: 'thumbnail_url', label: 'Ảnh', kind: 'media', max: 500, upload: { folder: 'projects', profile: 'editorial' } },
      { name: 'description', label: 'Mô tả', kind: 'textarea', max: 20000 },
      { name: 'category', label: 'Loại', kind: 'text', max: 100 },
      { name: 'tags', label: 'Tag (cách nhau bằng dấu phẩy)', kind: 'strings' },
      { name: 'is_featured', label: 'Nổi bật', kind: 'bool', list: true },
      { name: 'is_active', label: 'Hiển thị', kind: 'bool', list: true, initial: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, list: true, initial: 0 },
    ],
  },
  {
    key: 'categories', label: 'Danh mục (banner nội dung)', group: 'Sản phẩm', table: 'categories',
    lookup: true, hideFromNav: true, read: 'categories:read', search: ['name', 'slug'], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', max: 100, list: true, readOnly: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 100, list: true, readOnly: true },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, readOnly: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', readOnly: true },
    ],
  },
  {
    key: 'subcategories', label: 'Danh mục con', group: 'Sản phẩm', table: 'subcategories',
    lookup: true, hideFromNav: true, read: 'categories:read', search: ['name', 'slug'], orderBy: 'category_id asc, sort_order asc, id asc', optionLabel: 'name',
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 200, list: true },
      { name: 'category_id', label: 'Danh mục', kind: 'ref', ref: 'categories', list: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', readOnly: true },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, readOnly: true },
    ],
  },
  {
    key: 'brands', label: 'Thương hiệu', group: 'Sản phẩm', table: 'brands',
    lookup: true, hideFromNav: true, read: 'brands:read',
    search: ['name', 'slug'], orderBy: 'name asc, id asc', optionLabel: 'name',
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }, { name: 'is_featured', label: 'Nổi bật', kind: 'bool' }],
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 200, list: true, slugFrom: 'name' },
      { name: 'logo_url', label: 'Logo', kind: 'media', max: 1000, upload: { folder: 'brands', profile: 'product' } },
      { name: 'description', label: 'Mô tả', kind: 'textarea', max: 10000 },
      { name: 'origin_country', label: 'Xuất xứ', kind: 'text', max: 100, list: true },
      { name: 'website_url', label: 'Website', kind: 'link', max: 500 },
      { name: 'is_active', label: 'Hiển thị', kind: 'bool', list: true, initial: true },
      { name: 'is_featured', label: 'Nổi bật', kind: 'bool', list: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, list: true, initial: 0 },
    ],
  },
  {
    key: 'catalog-taxons', label: 'Phân loại (taxonomy)', group: 'Sản phẩm', table: 'catalog_taxons',
    lookup: true, hideFromNav: true, read: 'taxonomy:read',
    search: ['name', 'slug', 'canonical_path'], orderBy: 'canonical_path asc, id asc', optionLabel: 'canonical_path',
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }],
    fields: [
      { name: 'parent_id', label: 'Phân loại cha', kind: 'ref', ref: 'catalog-taxons', nullable: true },
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 200, list: true, slugFrom: 'name' },
      { name: 'canonical_path', label: 'Đường dẫn chuẩn', kind: 'text', required: true, max: 500, list: true },
      { name: 'depth', label: 'Cấp', kind: 'int', min: 0, max: 10, list: true, initial: 0 },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
      { name: 'kind', label: 'Loại', kind: 'text', max: 40, nullable: false, min: 1, initial: 'type' },
      { name: 'status', label: 'Trạng thái nội dung', kind: 'text', max: 40, nullable: false, min: 1, initial: 'active' },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, initial: true },
      { name: 'is_indexable', label: 'Cho phép index', kind: 'bool', initial: true },
      { name: 'is_listing_enabled', label: 'Hiện trong danh sách', kind: 'bool', initial: true },
      { name: 'seo_title', label: 'SEO title', kind: 'text', max: 200 },
      { name: 'seo_description', label: 'SEO description', kind: 'textarea', max: 500 },
    ],
  },
  {
    key: 'product-types', label: 'Loại sản phẩm', group: 'Sản phẩm', table: 'product_types',
    lookup: true, hideFromNav: true, read: 'product_types:read',
    search: ['name', 'slug'], orderBy: 'subcategory_id asc, sort_order asc, id asc', optionLabel: 'name',
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }, { name: 'subcategory_id', label: 'Danh mục con', kind: 'int' }],
    fields: [
      { name: 'subcategory_id', label: 'Danh mục con', kind: 'ref', ref: 'subcategories', required: true, list: true },
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 100, list: true, slugFrom: 'name' },
      { name: 'description', label: 'Mô tả', kind: 'textarea', max: 10000 },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, initial: true },
      { name: 'filter_policy', label: 'Chính sách bộ lọc (JSON)', kind: 'json', initial: {} },
    ],
  },
  {
    key: 'product-sub-types', label: 'Phân loại phụ sản phẩm', group: 'Sản phẩm', table: 'product_sub_types', noUpdatedAt: true,
    lookup: true, hideFromNav: true, read: 'product_types:read',
    search: ['name', 'slug'], orderBy: 'product_type_id asc, sort_order asc, id asc', optionLabel: 'name',
    filters: [{ name: 'is_active', label: 'Trạng thái', kind: 'bool' }, { name: 'product_type_id', label: 'Loại sản phẩm', kind: 'int' }],
    fields: [
      { name: 'product_type_id', label: 'Loại sản phẩm', kind: 'ref', ref: 'product-types', required: true, list: true },
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 100, list: true, slugFrom: 'name' },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, initial: true },
    ],
  },
  {
    key: 'spec-definitions', label: 'Thông số kỹ thuật', group: 'Sản phẩm', table: 'spec_definitions',
    lookup: true, hideFromNav: true, read: 'specifications:read',
    search: ['key', 'label'], orderBy: 'sort_order asc, id asc', optionLabel: 'label',
    fields: [
      { name: 'key', label: 'Khóa', kind: 'text', required: true, max: 120, list: true },
      { name: 'label', label: 'Nhãn', kind: 'text', required: true, max: 200, list: true },
      { name: 'data_type', label: 'Kiểu dữ liệu', kind: 'text', max: 30, nullable: false, min: 1, list: true, initial: 'text' },
      { name: 'unit', label: 'Đơn vị', kind: 'text', max: 30 },
      { name: 'is_filterable', label: 'Dùng làm bộ lọc', kind: 'bool', list: true },
      { name: 'is_pdp_visible', label: 'Hiện ở trang sản phẩm', kind: 'bool', initial: true },
      { name: 'is_reserved', label: 'Dành riêng', kind: 'bool' },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
      { name: 'normalize_rule', label: 'Quy tắc chuẩn hóa (JSON)', kind: 'json', initial: {} },
    ],
  },
  {
    key: 'spec-options', label: 'Giá trị thông số', group: 'Sản phẩm', table: 'spec_options', noUpdatedAt: true,
    lookup: true, hideFromNav: true, read: 'specifications:read',
    search: ['value', 'slug'], orderBy: 'spec_definition_id asc, sort_order asc, id asc', optionLabel: 'value',
    filters: [{ name: 'spec_definition_id', label: 'Thông số', kind: 'int' }],
    fields: [
      { name: 'spec_definition_id', label: 'Thông số', kind: 'ref', ref: 'spec-definitions', required: true, list: true },
      { name: 'value', label: 'Giá trị', kind: 'text', required: true, max: 200, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', required: true, max: 160, list: true, slugFrom: 'value' },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
      { name: 'aliases', label: 'Tên gọi khác (cách nhau bằng dấu phẩy)', kind: 'strings', nullable: false, initial: [] },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, initial: true },
    ],
  },
  {
    key: 'customers', label: 'Khách hàng', group: 'Kinh doanh', table: 'customers',
    read: 'customers:read', write: 'customers:write', create: true, hook: customerHook, createColumns: ['last_interacted_at'],
    search: ['full_name', 'phone', 'email'], orderBy: 'id desc', optionLabel: 'full_name',
    fields: [
      { name: 'full_name', label: 'Họ tên', kind: 'text', required: true, max: 200, list: true },
      { name: 'phone', label: 'Số điện thoại', kind: 'text', required: true, max: 20, list: true },
      { name: 'email', label: 'Email', kind: 'text', max: 200, list: true },
      { name: 'source', label: 'Nguồn', kind: 'text', max: 50, list: true, initial: 'MANUAL' },
      { name: 'notes', label: 'Ghi chú', kind: 'textarea', max: 20000 },
      { name: 'last_interacted_at', label: 'Tương tác gần nhất', kind: 'datetime', readOnly: true, list: true },
      { name: 'created_at', label: 'Tạo lúc', kind: 'datetime', readOnly: true },
    ],
  },
  {
    key: 'users', label: 'Người dùng', group: 'Hệ thống', table: 'admin_users',
    read: 'users:read', write: 'users:write', create: true, hook: userHook, createColumns: ['password_hash'], hookColumns: ['password_hash'],
    search: ['email', 'name', 'username'], orderBy: 'id asc', optionLabel: 'name',
    filters: [{ name: 'role', label: 'Vai trò', kind: 'enum', options: ['admin', 'sale_manager', 'sale'] }, { name: 'is_active', label: 'Trạng thái', kind: 'bool' }],
    fields: [
      { name: 'email', label: 'Email', kind: 'email', required: true, max: 200, list: true },
      { name: 'name', label: 'Tên', kind: 'text', required: true, max: 100, list: true },
      { name: 'username', label: 'Tên đăng nhập', kind: 'text', max: 100, list: true },
      { name: 'role', label: 'Vai trò', kind: 'enum', options: ['admin', 'sale_manager', 'sale'], list: true, initial: 'sale' },
      { name: 'is_active', label: 'Hoạt động', kind: 'bool', list: true, initial: true },
      { name: 'password', label: 'Mật khẩu (bắt buộc khi tạo; để trống khi sửa nếu không đổi)', kind: 'password', required: true, virtual: true },
      { name: 'last_login_at', label: 'Đăng nhập gần nhất', kind: 'datetime', readOnly: true, list: true },
    ],
  },

  { lookup: true, hideFromNav: true, key: 'origins', label: 'Xuất xứ', group: 'Sản phẩm', table: 'origins', read: 'products:read', search: ['name'], orderBy: 'name asc, id asc', optionLabel: 'name',
    fields: [{ name: 'name', label: 'Tên', kind: 'text', max: 100, list: true }, { name: 'slug', label: 'Slug', kind: 'text', max: 100 }] },
  { lookup: true, hideFromNav: true, key: 'colors', label: 'Màu sắc', group: 'Sản phẩm', table: 'colors', read: 'products:read', search: ['name'], orderBy: 'name asc, id asc', optionLabel: 'name',
    fields: [{ name: 'name', label: 'Tên', kind: 'text', max: 50, list: true }, { name: 'slug', label: 'Slug', kind: 'text', max: 50 }, { name: 'hex_code', label: 'Mã màu', kind: 'text', max: 7 }] },
  { lookup: true, hideFromNav: true, key: 'materials', label: 'Chất liệu', group: 'Sản phẩm', table: 'materials', read: 'products:read', search: ['name'], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    fields: [{ name: 'name', label: 'Tên', kind: 'text', max: 100, list: true }, { name: 'slug', label: 'Slug', kind: 'text', max: 100 }, { name: 'sort_order', label: 'Thứ tự', kind: 'int' }] },
  {
    key: 'products', label: 'Sản phẩm', group: 'Sản phẩm', table: 'products',
    read: 'products:read', write: 'products:write', remove: 'products:delete', create: true, delete: 'hard', versioned: true, requireVersion: true, hook: productHook,
    search: ['name', 'sku', 'slug'], orderBy: 'id desc', optionLabel: 'name',
    filters: [
      { name: 'is_active', label: 'Đang bán', kind: 'bool' }, { name: 'is_featured', label: 'Nổi bật', kind: 'bool' }, { name: 'category_id', label: 'Danh mục', kind: 'int' },
      { name: 'brand_id', label: 'Thương hiệu', kind: 'int' }, { name: 'publication_status', label: 'Xuất bản', kind: 'enum', options: ['draft', 'public'] },
    ],
    fields: [
      { name: 'sku', label: 'SKU', kind: 'text', required: true, max: 100, list: true, createOnly: true },
      { name: 'name', label: 'Tên sản phẩm', kind: 'text', required: true, max: 500, list: true },
      { name: 'display_name', label: 'Tên hiển thị', kind: 'text', max: 500 },
      { name: 'slug', label: 'Slug (không đổi sau khi tạo)', kind: 'text', required: true, max: 500, createOnly: true, slugFrom: 'name' },
      { name: 'category_id', label: 'Danh mục', kind: 'ref', ref: 'categories', required: true, list: true },
      { name: 'subcategory_id', label: 'Danh mục con', kind: 'ref', ref: 'subcategories', nullable: true },
      { name: 'brand_id', label: 'Thương hiệu', kind: 'ref', ref: 'brands', nullable: true, list: true },
      { name: 'origin_id', label: 'Xuất xứ', kind: 'ref', ref: 'origins', nullable: true },
      { name: 'color_id', label: 'Màu sắc', kind: 'ref', ref: 'colors', nullable: true },
      { name: 'material_id', label: 'Chất liệu', kind: 'ref', ref: 'materials', nullable: true },
      { name: 'product_type_id', label: 'Loại sản phẩm', kind: 'ref', ref: 'product-types', nullable: true },
      { name: 'product_sub_type_id', label: 'Phân loại phụ', kind: 'ref', ref: 'product-sub-types', nullable: true },
      { name: 'product_type', label: 'Loại (văn bản cũ)', kind: 'text', max: 50 },
      { name: 'product_sub_type', label: 'Phân loại phụ (văn bản cũ)', kind: 'text', max: 50 },
      { name: 'price', label: 'Giá bán', kind: 'money', nullable: true, permission: 'commerce:write' },
      { name: 'price_display', label: 'Hiển thị giá', kind: 'text', max: 50, nullable: false, min: 1, list: true, initial: 'Liên hệ báo giá', permission: 'commerce:write' },
      { name: 'original_price', label: 'Giá gốc', kind: 'money', min: 0.01, nullable: true, permission: 'commerce:write' },
      { name: 'list_price', label: 'Giá niêm yết', kind: 'money', min: 0.01, nullable: true, permission: 'commerce:write' },
      { name: 'sale_price', label: 'Giá khuyến mãi', kind: 'money', min: 0.01, nullable: true, permission: 'commerce:write' },
      { name: 'online_discount_amount', label: 'Giảm giá online', kind: 'money', nullable: true, permission: 'commerce:write' },
      { name: 'regular_price_vnd', label: 'Giá gốc (VNĐ)', kind: 'money', min: 1, max: 9_999_999_999_999, nullable: true, permission: 'commerce:write', externalGrant: true },
      { name: 'promotional_price_vnd', label: 'Giá khuyến mãi (VNĐ)', kind: 'money', min: 1, max: 9_999_999_999_999, nullable: true, permission: 'commerce:write', externalGrant: true },
      { name: 'online_voucher_amount_vnd', label: 'Voucher online (VNĐ/sản phẩm)', kind: 'money', min: 1, max: 9_999_999_999_999, nullable: true, permission: 'commerce:write', externalGrant: true },
      { name: 'canonical_price_checked_at', label: 'Giá kiểm lúc', kind: 'datetime', nullable: true, readOnly: true, permission: 'commerce:write', externalGrant: true },
      { name: 'canonical_price_status', label: 'Trạng thái giá (Hita)', kind: 'enum', options: ['PRICE_VERIFIED', 'CONTACT_VERIFIED', 'UNRESOLVED', 'NOT_FOUND', 'DISCONTINUED'], nullable: true, readOnly: true, permission: 'commerce:write', externalGrant: true },
      { name: 'stock_status', label: 'Tồn kho', kind: 'enum', options: ['in_stock', 'out_of_stock', 'discontinued', 'pre_order', 'contact'], initial: 'in_stock' },
      { name: 'warranty_months', label: 'Bảo hành (tháng)', kind: 'int', min: 1, max: 600, nullable: true },
      { name: 'image_main_url', label: 'Ảnh chính', kind: 'media', max: 1000, upload: { folder: 'products', profile: 'product' } },
      { name: 'description', label: 'Mô tả', kind: 'html', max: 200000 },
      { name: 'features', label: 'Đặc điểm nổi bật', kind: 'html', max: 100000 },
      { name: 'specs', label: 'Thông số (JSON)', kind: 'json', initial: {} },
      { name: 'is_active', label: 'Đang bán', kind: 'bool', list: true, initial: true, permission: 'visibility:write' },
      { name: 'is_featured', label: 'Nổi bật', kind: 'bool', list: true },
      { name: 'is_home_featured', label: 'Nổi bật trang chủ', kind: 'bool' },
      { name: 'is_promotion', label: 'Khuyến mãi', kind: 'bool' },
      { name: 'is_combo', label: 'Combo', kind: 'bool' },
      { name: 'is_master', label: 'Sản phẩm chính', kind: 'bool', initial: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
      { name: 'publication_status', label: 'Xuất bản', kind: 'enum', options: ['draft', 'public'], list: true, permission: 'visibility:write' },
      { name: 'pdp_visibility', label: 'Trang sản phẩm', kind: 'enum', options: ['public', 'hidden'], permission: 'visibility:write' },
      { name: 'listing_visibility', label: 'Danh sách', kind: 'enum', options: ['default', 'low_priority', 'hidden'], permission: 'visibility:write' },
      { name: 'search_visibility', label: 'Tìm kiếm', kind: 'enum', options: ['visible', 'hidden'], permission: 'visibility:write' },
      { name: 'sellable_status', label: 'Trạng thái bán', kind: 'enum', options: ['sellable', 'not_sellable', 'discontinued'], permission: 'visibility:write' },
      { name: 'seo_indexing', label: 'Index SEO', kind: 'enum', options: ['index', 'noindex'], permission: 'seo:write' },
      { name: 'sitemap_include', label: 'Đưa vào sitemap', kind: 'bool', permission: 'seo:write' },
      { name: 'source_url', label: 'URL nguồn', kind: 'link', max: 1000 },
      { name: 'hita_product_id', label: 'Mã Hita', kind: 'text', max: 100 },
      { name: 'seo_title', label: 'SEO title', kind: 'text', max: 200, permission: 'seo:write' },
      { name: 'seo_description', label: 'SEO description', kind: 'textarea', max: 500, permission: 'seo:write' },
      { name: 'updated_at', label: 'Cập nhật', kind: 'datetime', readOnly: true, list: true },
      { name: 'version', label: 'Phiên bản', kind: 'int', readOnly: true },
    ],
  },
  {
    key: 'product-images', label: 'Ảnh sản phẩm', group: 'Sản phẩm', table: 'product_images', noUpdatedAt: true, hideFromNav: true,
    read: 'products:read', write: 'products:write', create: true, delete: 'hard', search: [], orderBy: 'sort_order asc, id asc', optionLabel: 'image_url',
    filters: [{ name: 'product_id', label: 'Sản phẩm', kind: 'int' }],
    fields: [
      { name: 'product_id', label: 'Sản phẩm', kind: 'int', required: true, createOnly: true, min: 1 },
      { name: 'image_url', label: 'Ảnh', kind: 'media', required: true, max: 1000, list: true, upload: { folder: 'products', profile: 'product' } },
      { name: 'alt_text', label: 'Mô tả ảnh', kind: 'text', max: 300 },
      { name: 'image_type', label: 'Loại ảnh', kind: 'text', max: 20, nullable: false, min: 1, initial: 'gallery' },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, list: true, initial: 0 },
    ],
  },

  {
    key: 'product-documents', label: 'Tài liệu sản phẩm', group: 'Sản phẩm', table: 'product_documents', noUpdatedAt: true, hideFromNav: true, childOf: { parent: 'products', column: 'product_id' },
    read: 'products:read', write: 'documents:write', create: true, delete: 'hard', search: [], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    filters: [{ name: 'product_id', label: 'Sản phẩm', kind: 'int' }],
    fields: [
      { name: 'product_id', label: 'Sản phẩm', kind: 'int', required: true, createOnly: true, min: 1 },
      { name: 'name', label: 'Tên tài liệu', kind: 'text', required: true, max: 200, list: true },
      { name: 'url', label: 'Đường dẫn (https)', kind: 'url', required: true, max: 1000, list: true },
      { name: 'source_url', label: 'Nguồn (https)', kind: 'url', max: 1000 },
      { name: 'document_type', label: 'Loại', kind: 'text', max: 30, nullable: false, min: 1, list: true, initial: 'DOCUMENT' },
      { name: 'file_ext', label: 'Định dạng', kind: 'text', max: 20 },
      { name: 'file_size', label: 'Dung lượng (byte)', kind: 'int', min: 0, nullable: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
    ],
  },
  {
    key: 'product-spec-values', label: 'Thông số của sản phẩm', group: 'Sản phẩm', table: 'product_spec_values', hideFromNav: true, childOf: { parent: 'products', column: 'product_id' },
    read: 'products:read', write: 'specifications:write', create: true, delete: 'hard', search: [], orderBy: 'sort_order asc, id asc', optionLabel: 'raw_key',
    filters: [{ name: 'product_id', label: 'Sản phẩm', kind: 'int' }],
    fields: [
      { name: 'product_id', label: 'Sản phẩm', kind: 'int', required: true, createOnly: true, min: 1 },
      { name: 'spec_definition_id', label: 'Thông số', kind: 'ref', ref: 'spec-definitions', required: true, list: true },
      { name: 'option_id', label: 'Giá trị chọn sẵn', kind: 'ref', ref: 'spec-options', nullable: true, list: true },
      { name: 'value_text', label: 'Giá trị (chữ)', kind: 'text', max: 500, list: true },
      { name: 'value_number', label: 'Giá trị (số)', kind: 'money', min: -999_999_999, nullable: true },
      { name: 'value_json', label: 'Giá trị (JSON)', kind: 'json', nullable: true },
      { name: 'raw_key', label: 'Khóa gốc', kind: 'text', max: 200 },
      { name: 'raw_value', label: 'Giá trị gốc', kind: 'textarea', max: 10000 },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
    ],
  },
  {
    key: 'product-taxon-assignments', label: 'Phân loại của sản phẩm', group: 'Sản phẩm', table: 'product_taxon_assignments', hideFromNav: true, childOf: { parent: 'products', column: 'product_id' },
    read: 'products:read', write: 'taxonomy:write', create: true, delete: 'hard', search: [], orderBy: 'sort_order asc, id asc', optionLabel: 'taxon_id',
    filters: [{ name: 'product_id', label: 'Sản phẩm', kind: 'int' }],
    fields: [
      { name: 'product_id', label: 'Sản phẩm', kind: 'int', required: true, createOnly: true, min: 1 },
      { name: 'taxon_id', label: 'Phân loại', kind: 'ref', ref: 'catalog-taxons', required: true, list: true },
      { name: 'is_primary', label: 'Phân loại chính', kind: 'bool', list: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000, initial: 0 },
    ],
  },
  {
    key: 'product-relationships', label: 'Sản phẩm liên kết', group: 'Sản phẩm', table: 'product_relationships', noUpdatedAt: true, hideFromNav: true, childOf: { parent: 'products', column: 'parent_id' }, hook: relationshipHook,
    read: 'products:read', write: 'products:write', create: true, delete: 'hard', search: [], orderBy: 'sort_order asc, id asc', optionLabel: 'child_sku',
    filters: [{ name: 'parent_id', label: 'Sản phẩm cha', kind: 'int' }],
    fields: [
      { name: 'parent_id', label: 'Sản phẩm cha', kind: 'int', required: true, createOnly: true, min: 1 },
      { name: 'child_id', label: 'ID sản phẩm con', kind: 'int', min: 1, nullable: true, list: true },
      { name: 'child_sku', label: 'SKU sản phẩm con', kind: 'text', required: true, max: 200, list: true },
      { name: 'relationship_type', label: 'Kiểu liên kết', kind: 'text', max: 50, nullable: false, min: 1, list: true, initial: 'component' },
      { name: 'component_type', label: 'Loại thành phần', kind: 'text', max: 30, nullable: false, min: 1, initial: 'component' },
      { name: 'quantity', label: 'Số lượng', kind: 'int', min: 1, max: 100000, nullable: true, list: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', min: -100000, max: 100000 },
      { name: 'resolution_status', label: 'Trạng thái liên kết', kind: 'text', max: 30, readOnly: true },
    ],
  },
]

const REGISTRY = new Map(RESOURCES.map((resource) => [resource.key, resource]))
export const resourceByKey = (key: string): ResourceDef | undefined => REGISTRY.get(key)
/** Columns of `externalGrant` fields that exist AND are visible to the API role (probed per request window, see
 * probeExternalColumns). Fail-safe default is empty, so a database without the #446 price columns (Production until
 * #449) never selects or writes them and the same code runs unchanged there. */
let externalColumns: ReadonlySet<string> = new Set()
export const setExternalColumns = (names: Iterable<string>) => { externalColumns = new Set(names) }
export const activeFields = (def: ResourceDef) => def.fields.filter((field) => !field.externalGrant || externalColumns.has(field.name))
export const writableFields = (def: ResourceDef) => activeFields(def).filter((field) => !field.readOnly && !field.virtual)
export const columnFields = (def: ResourceDef) => activeFields(def).filter((field) => !field.virtual)
