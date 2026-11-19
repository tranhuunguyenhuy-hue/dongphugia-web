// Production Admin media upload (M4). A dedicated Worker-native path: it never touches the legacy Next/Prisma Admin.
// Flow: same-origin check -> session validated by a signed call to the Admin API (the caller passes `authorize`) -> the
// session must hold the permission of the target folder -> strict content/size validation -> Cloudflare Images binding
// transform -> Bunny Storage (Production zone only). Fails closed on any missing configuration. No secrets are logged.
// Source is concatenated into the Production worker by the builder; it has no imports.

export const UPLOAD_PATH = '/api/upload-image'
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024
const UPLOAD_MAX_BODY_BYTES = UPLOAD_MAX_BYTES + 256 * 1024 // multipart framing overhead
const UPLOAD_MAX_PIXELS = 40_000_000
const UPLOAD_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const UPLOAD_RASTER_FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp'])
// Mirrors src/lib/media/media-profiles.ts (a test asserts the two stay identical).
export const UPLOAD_PROFILES = {
  product: { widths: [320, 640], quality: 80 },
  editorial: { widths: [640, 960], quality: 80 },
  hero: { widths: [720, 1280, 1600], quality: 82 },
}
// Folder -> permission required to upload into it. Folders match the `upload` hints of the Admin resource registry.
export const UPLOAD_FOLDERS = { products: 'products:write', brands: 'products:write', blog: 'blog:write', banners: '*', partners: '*', projects: '*' }

const json = (status, body, sourceSha) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', ...(sourceSha ? { 'x-dpg-source-sha': sourceSha } : {}) },
})
const hasPermission = (permissions, needed) => Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(needed))

class FormatError extends Error {}
class TransformError extends Error {}

const toStream = (bytes) => new Blob([bytes]).stream()

async function readInfo(images, bytes) {
  try {
    const info = await images.info(toStream(bytes))
    if (!info.width || !info.height) throw new FormatError()
    if (info.width * info.height > UPLOAD_MAX_PIXELS) throw new FormatError()
    return info
  } catch (error) {
    if (error instanceof FormatError) throw error
    if (error?.code === 9412) throw new FormatError() // not an image: the declared MIME was wrong
    throw new TransformError()
  }
}

async function putToBunny(config, path, bytes, contentType) {
  const response = await fetch(`https://${config.storageHost}/${config.storageZone}/${path}`, {
    method: 'PUT', headers: { AccessKey: config.apiKey, 'Content-Type': contentType }, body: bytes,
  })
  if (!response.ok) throw new Error('MEDIA_STORAGE_REJECTED')
}
const deleteFromBunny = (config, path) =>
  fetch(`https://${config.storageHost}/${config.storageZone}/${path}`, { method: 'DELETE', headers: { AccessKey: config.apiKey } }).catch(() => undefined)

/**
 * @param request   the browser request (POST multipart)
 * @param options   { media: { storageZone, apiKey, storageHost, cdnHost } | null, images, origin, authorize(request) -> {status, permissions}, sourceSha }
 */
export async function handleAdminUpload(request, { media, images, origin, authorize, sourceSha }) {
  if (request.method !== 'POST') return json(405, { error: 'Thao tác không được hỗ trợ.', code: 'METHOD_NOT_ALLOWED' }, sourceSha)
  // CSRF: only a browser request provably issued from the Admin's own origin is accepted.
  const site = request.headers.get('sec-fetch-site')
  if (request.headers.get('origin') !== origin || !(site === null || site === 'same-origin')) return json(403, { error: 'Nguồn yêu cầu không hợp lệ.', code: 'ORIGIN_NOT_ALLOWED' }, sourceSha)

  // Authenticate first: an anonymous caller never reaches the body parser, Images or storage.
  const session = await authorize(request)
  if (session.status === 401) return json(401, { error: 'Phiên đăng nhập đã hết hạn.', code: 'UNAUTHENTICATED' }, sourceSha)
  if (session.status !== 200) return json(503, { error: 'Dịch vụ quản trị tạm thời không khả dụng.', code: 'ADMIN_API_UNAVAILABLE' }, sourceSha)

  if (!media || !media.apiKey || !media.storageZone || !media.storageHost || !media.cdnHost || !images || typeof images.info !== 'function') {
    return json(503, { error: 'Kho ảnh chưa được cấu hình.', code: 'MEDIA_TARGET_NOT_CONFIGURED' }, sourceSha)
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return json(415, { error: 'Định dạng yêu cầu không hợp lệ.', code: 'UNSUPPORTED_MEDIA_TYPE' }, sourceSha)
  const declared = Number(request.headers.get('content-length') ?? '')
  if (!Number.isFinite(declared) || declared <= 0 || declared > UPLOAD_MAX_BODY_BYTES) return json(413, { error: 'File quá lớn (Max 5MB)', code: 'BODY_TOO_LARGE' }, sourceSha)

  let form
  try { form = await request.formData() } catch { return json(400, { error: 'Yêu cầu không hợp lệ.', code: 'BAD_FORM' }, sourceSha) }
  const file = form.get('file')
  const folder = typeof form.get('folder') === 'string' ? form.get('folder') : 'products'
  const profile = typeof form.get('profile') === 'string' ? form.get('profile') : 'product'
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json(400, { error: 'Không tìm thấy file', code: 'FILE_REQUIRED' }, sourceSha)
  if (!Object.hasOwn(UPLOAD_FOLDERS, folder)) return json(400, { error: 'Thư mục ảnh không hợp lệ', code: 'FOLDER_INVALID' }, sourceSha)
  if (!Object.hasOwn(UPLOAD_PROFILES, profile)) return json(400, { error: 'Profile ảnh không hợp lệ', code: 'PROFILE_INVALID' }, sourceSha)
  if (!hasPermission(session.permissions, UPLOAD_FOLDERS[folder])) return json(403, { error: 'Bạn không có quyền tải ảnh lên mục này.', code: 'FORBIDDEN' }, sourceSha)
  if (!UPLOAD_ALLOWED_TYPES.has(file.type)) return json(400, { error: 'Chỉ hỗ trợ JPG, PNG, WebP, GIF', code: 'TYPE_NOT_ALLOWED' }, sourceSha)
  if (file.size <= 0 || file.size > UPLOAD_MAX_BYTES) return json(400, { error: 'File quá lớn (Max 5MB)', code: 'FILE_TOO_LARGE' }, sourceSha)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const uploaded = []
  try {
    if (file.type === 'image/gif') {
      const info = await readInfo(images, bytes)
      if (info.format !== 'image/gif') throw new FormatError()
      const path = `${folder}/${id}.gif`
      await putToBunny(media, path, bytes, 'image/gif')
      return json(200, { url: `https://${media.cdnHost}/${path}`, width: info.width, height: info.height, profile, variants: [] }, sourceSha)
    }
    const source = await readInfo(images, bytes)
    if (!source.format || !UPLOAD_RASTER_FORMATS.has(source.format)) throw new FormatError()
    const { widths, quality } = UPLOAD_PROFILES[profile]
    const variants = []
    for (const target of widths) { // sequential: bounded memory/CPU; uploads only, never per-view transforms
      let produced
      try {
        const result = await images.input(toStream(bytes)).transform({ width: Math.min(target, source.width), fit: 'scale-down' }).output({ format: 'image/webp', quality })
        const response = result.response()
        if (!response.ok) throw new TransformError()
        produced = new Uint8Array(await response.arrayBuffer())
      } catch { throw new TransformError() }
      const info = await readInfo(images, produced)
      const path = `${folder}/${id}.${profile}.w${target}.webp`
      await putToBunny(media, path, produced, 'image/webp')
      uploaded.push(path)
      variants.push({ url: `https://${media.cdnHost}/${path}`, width: info.width, height: info.height, bytes: produced.byteLength, format: 'webp' })
    }
    const primary = variants.at(-1)
    return json(200, { url: primary.url, width: primary.width, height: primary.height, profile, variants }, sourceSha)
  } catch (error) {
    await Promise.all(uploaded.map((path) => deleteFromBunny(media, path)))
    if (error instanceof FormatError) return json(400, { error: 'Chỉ hỗ trợ JPG, PNG, WebP, GIF', code: 'FORMAT_MISMATCH' }, sourceSha)
    if (error instanceof TransformError) {
      console.error(JSON.stringify({ event: 'ADMIN_MEDIA_UPLOAD_FAILURE', code: 'MEDIA_TRANSFORM_UNAVAILABLE' }))
      return json(503, { error: 'Dịch vụ xử lý ảnh tạm thời không khả dụng hoặc đã hết hạn mức.', code: 'MEDIA_TRANSFORM_UNAVAILABLE' }, sourceSha)
    }
    console.error(JSON.stringify({ event: 'ADMIN_MEDIA_UPLOAD_FAILURE', code: 'ADMIN_MEDIA_UPLOAD_FAILED' }))
    return json(502, { error: 'Không tải được ảnh lên. Vui lòng thử lại.', code: 'ADMIN_MEDIA_UPLOAD_FAILED' }, sourceSha)
  }
}
