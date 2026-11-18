import { z } from 'zod'

const SLUG_HOST = /^[a-z0-9.-]+$/i
export function parseAllowedMediaHosts(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => h && SLUG_HOST.test(h))
}

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
}).strict()

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
})

/** Editable product projection for the pilot slice. Price/identity/taxonomy fields are intentionally absent. */
export function productPatchSchema(allowedMediaHosts: readonly string[]) {
  const imageUrl = z.string().max(1000).refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && allowedMediaHosts.includes(url.hostname.toLowerCase())
    } catch { return false }
  }, 'MEDIA_HOST_NOT_ALLOWED')
  return z.object({
    expected_version: z.number().int().min(0).optional(),
    input: z.object({
      name: z.string().trim().min(1).max(500).optional(),
      display_name: z.string().trim().max(500).nullable().optional(),
      description: z.string().max(100000).nullable().optional(),
      image_main_url: imageUrl.nullable().optional(),
      is_active: z.boolean().optional(),
      is_featured: z.boolean().optional(),
      publication_status: z.enum(['draft', 'public']).optional(),
      pdp_visibility: z.enum(['public', 'hidden']).optional(),
      listing_visibility: z.enum(['default', 'low_priority', 'hidden']).optional(),
      seo_title: z.string().trim().max(200).nullable().optional(),
      seo_description: z.string().trim().max(500).nullable().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0, 'EMPTY_PATCH'),
  }).strict()
}

/** Fields that change what the public sees need the visibility permission on top of products:write. */
export const VISIBILITY_FIELDS = ['is_active', 'publication_status', 'pdp_visibility', 'listing_visibility'] as const

// ---------------------------------------------------------------------------------------------------------------
// Resource schemas (built from resources.ts definitions). Everything is .strict(): unknown keys are rejected.
import type { FieldDef, ResourceDef } from './resources.ts'

const UNSAFE_HTML = /<\s*script|javascript\s*:|<\s*iframe|\son[a-z]+\s*=/i
const INT_MIN = -2_147_483_648, INT_MAX = 2_147_483_647

function mediaUrl(allowedMediaHosts: readonly string[], max: number) {
  return z.string().max(max).refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && allowedMediaHosts.includes(url.hostname.toLowerCase())
    } catch { return false }
  }, 'MEDIA_HOST_NOT_ALLOWED')
}
export function isSafeLink(value: string): boolean {
  if (/^\/(?!\/)[^\s\\]*$/.test(value)) return true
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password } catch { return false }
}

const isTextLike = (kind: FieldDef['kind']) => kind === 'text' || kind === 'textarea' || kind === 'html' || kind === 'link' || kind === 'media' || kind === 'email'
export const allowsNull = (field: FieldDef) => field.required ? false : field.nullable ?? (isTextLike(field.kind) || field.kind === 'strings' || field.kind === 'datetime')

/** Value schema for one writable field (before optional/nullable wrapping). */
function valueSchema(field: FieldDef, allowedMediaHosts: readonly string[]): z.ZodType {
  switch (field.kind) {
    case 'text': case 'textarea': case 'html': case 'link': case 'media': {
      const max = field.max ?? (field.kind === 'text' ? 500 : 20000)
      let schema: z.ZodType = field.kind === 'media' ? mediaUrl(allowedMediaHosts, max) : z.string().max(max)
      if (field.kind === 'text' || field.kind === 'link') schema = (schema as z.ZodString).trim()
      if (field.kind === 'html') schema = (schema as z.ZodString).refine((v) => !UNSAFE_HTML.test(v), 'UNSAFE_HTML')
      if (field.kind === 'link') schema = (schema as z.ZodString).refine(isSafeLink, 'LINK_NOT_ALLOWED')
      if (field.required || (field.min ?? 0) > 0) schema = (schema as z.ZodString).min(Math.max(1, field.min ?? 1))
      return schema
    }
    case 'email': return z.string().trim().toLowerCase().email().max(field.max ?? 200)
    case 'int': return z.number().int().min(field.min ?? INT_MIN).max(field.max ?? INT_MAX)
    case 'bool': return z.boolean()
    case 'enum': return z.enum([...(field.options ?? [])] as [string, ...string[]])
    case 'datetime': return z.string().datetime({ offset: true })
    case 'strings': return z.array(z.string().trim().min(1).max(100)).max(field.max ?? 30)
    case 'ref': return z.number().int().min(1).max(INT_MAX)
    case 'json': return z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 20000, 'JSON_TOO_LARGE')
    case 'password': return z.string().min(8).max(200)
    case 'money': return z.number().finite().min(field.min ?? 0).max(field.max ?? 999_999_999_999)
  }
}

function fieldSchema(field: FieldDef, allowedMediaHosts: readonly string[], mode: 'create' | 'update'): z.ZodType {
  let schema = valueSchema(field, allowedMediaHosts)
  const nullable = allowsNull(field)
  if (nullable) {
    schema = schema.nullable()
    // The forms send '' for a cleared optional text field; the column stores NULL.
    if (isTextLike(field.kind)) schema = z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), schema)
  }
  return field.required && mode === 'create' ? schema : schema.optional()
}

export function resourceBodySchemas(def: ResourceDef, allowedMediaHosts: readonly string[]) {
  const build = (mode: 'create' | 'update') => {
    const shape: Record<string, z.ZodType> = {}
    for (const field of def.fields) if (!field.readOnly) shape[field.name] = fieldSchema(field, allowedMediaHosts, mode)
    for (const relation of def.relations ?? []) shape[relation.input] = z.array(z.number().int().min(1).max(INT_MAX)).max(relation.max).optional()
    return z.object(shape).strict()
  }
  const version = def.requireVersion ? z.number().int().min(0) : z.number().int().min(0).optional()
  return {
    create: z.object({ input: build('create') }).strict(),
    update: z.object({ expected_version: version, input: build('update').refine((value) => Object.keys(value).length > 0, 'EMPTY_PATCH') }).strict(),
    remove: z.object({ expected_version: version }).strict(),
  }
}

export function resourceQuerySchema(def: ResourceDef) {
  const shape: Record<string, z.ZodType> = {
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }
  for (const filter of def.filters ?? []) {
    shape[filter.name] = (filter.kind === 'bool'
      ? z.enum(['true', 'false']).transform((v) => v === 'true')
      : filter.kind === 'int' ? z.coerce.number().int().min(0).max(INT_MAX)
        : z.enum([...(filter.options ?? [])] as [string, ...string[]])).optional()
  }
  return z.object(shape).strict()
}
