// Declarative Admin resources (M3 G4). ONE definition drives: request validation (validation.ts), parameterised SQL
// (resource-handlers.ts), RBAC, audit, the form metadata served to the SPA (/schema) and the TEST/Production
// column-level grants + RLS policies (grants.ts -> supabase/m3-test/005_*.sql). Identifiers below are static code;
// request data only ever travels as bind parameters.
import { ApiError, type Context, type Db } from './core.ts'
import type { Permission } from './permissions.ts'

export type FieldKind = 'text' | 'textarea' | 'html' | 'int' | 'bool' | 'enum' | 'link' | 'media' | 'datetime' | 'strings' | 'ref'
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
export interface HookArgs { tx: Db; mode: 'create' | 'update' | 'delete'; existing?: Row; input: Row; ctx: Context }
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

export const RESOURCES: ResourceDef[] = [
  {
    key: 'blog-categories', label: 'Chuyên mục blog', group: 'Blog', table: 'blog_categories',
    read: 'blog:read', search: ['name', 'slug'], orderBy: 'sort_order asc, id asc', optionLabel: 'name',
    fields: [
      { name: 'name', label: 'Tên', kind: 'text', max: 100, list: true },
      { name: 'slug', label: 'Slug', kind: 'text', max: 100, list: true, readOnly: true },
      { name: 'is_active', label: 'Đang dùng', kind: 'bool', list: true, readOnly: true },
    ],
  },
  {
    key: 'blog-tags', label: 'Tag blog', group: 'Blog', table: 'blog_tags',
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
    key: 'blog-posts', label: 'Bài viết', group: 'Blog', table: 'blog_posts',
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
    key: 'partners', label: 'Đối tác', group: 'Nội dung', table: 'partners',
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
    key: 'projects', label: 'Dự án', group: 'Nội dung', table: 'projects',
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
]

const REGISTRY = new Map(RESOURCES.map((resource) => [resource.key, resource]))
export const resourceByKey = (key: string): ResourceDef | undefined => REGISTRY.get(key)
export const writableFields = (def: ResourceDef) => def.fields.filter((field) => !field.readOnly)
