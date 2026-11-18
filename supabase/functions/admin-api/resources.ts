// Declarative Admin resources (M3 G4). ONE definition drives: request validation (validation.ts), parameterised SQL
// (resource-handlers.ts), RBAC, audit, the form metadata served to the SPA (/schema) and the TEST/Production
// column-level grants + RLS policies (grants.ts -> supabase/m3-test/005_*.sql). Identifiers below are static code;
// request data only ever travels as bind parameters.
import { ApiError, type Context, type Db } from './core.ts'
import type { Permission } from './permissions.ts'

export type FieldKind = 'text' | 'textarea' | 'html' | 'int' | 'bool' | 'enum' | 'link' | 'media' | 'datetime' | 'strings' | 'ref' | 'json' | 'password' | 'money' | 'email'
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
const customerHook: WriteHook = ({ mode }) => (mode === 'create' ? { set: { last_interacted_at: RAW_NOW } } : undefined)

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
    read: 'categories:read', write: 'categories:write', search: ['name', 'slug'], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', max: 100, list: true, readOnly: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 100, list: true, readOnly: true },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, readOnly: true },
      { name: 'sort_order', label: 'Thứ tự', kind: 'int', readOnly: true },
      { name: 'banner_url', label: 'Banner danh mục', kind: 'media', max: 1000, list: true, upload: { folder: 'category-banners', profile: 'hero' } },
    ],
  },
  {
    key: 'subcategories', label: 'Danh mục con', group: 'Sản phẩm', table: 'subcategories',
    read: 'categories:read', search: ['name', 'slug'], orderBy: 'category_id asc, sort_order asc, id asc', optionLabel: 'name',
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
    read: 'brands:read', write: 'brands:write', create: true,
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
    read: 'taxonomy:read', write: 'taxonomy:write', create: true,
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
    read: 'product_types:read', write: 'product_types:write', create: true,
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
    read: 'product_types:read', write: 'product_types:write', create: true,
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
    read: 'specifications:read', write: 'specifications:write', create: true,
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
    read: 'specifications:read', write: 'specifications:write', create: true, update: false,
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
]

const REGISTRY = new Map(RESOURCES.map((resource) => [resource.key, resource]))
export const resourceByKey = (key: string): ResourceDef | undefined => REGISTRY.get(key)
export const writableFields = (def: ResourceDef) => def.fields.filter((field) => !field.readOnly && !field.virtual)
export const columnFields = (def: ResourceDef) => def.fields.filter((field) => !field.virtual)
