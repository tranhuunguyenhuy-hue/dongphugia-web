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
