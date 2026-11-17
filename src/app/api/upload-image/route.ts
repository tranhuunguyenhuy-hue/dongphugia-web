import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/get-current-user'
import { can } from '@/lib/auth/permissions'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import {
    MEDIA_PROFILES,
    createMediaFileName,
    isMediaProfile,
    type MediaUploadResult,
    type MediaVariant,
} from '@/lib/media/media-profiles'
import { processImage } from '@/lib/media/process-image'
import { getWriteFreezeMessage, isWriteFreezeError, requireWritesAllowed, WRITE_FREEZE_ERROR_CODE } from '@/lib/write-freeze'
import { getAdminRuntimeEnvironment } from '@/lib/admin-runtime-environment'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

type BunnyConfig = {
    storageZone: string
    apiKey: string
    storageHost: string
    cdnHost: string
}

function getBunnyConfig(): BunnyConfig {
    const requestEnvironment = getAdminRuntimeEnvironment()
    const environment = requestEnvironment ?? process.env
    const storageZone = environment.BUNNY_STORAGE_ZONE_NAME
    const apiKey = environment.BUNNY_STORAGE_API_KEY
    const storageHost = environment.BUNNY_STORAGE_HOSTNAME
    const cdnHost = environment.BUNNY_CDN_HOSTNAME
    const isPreview = environment.APP_ENV === 'preview' || environment.APP_ENV === 'staging'

    if (!storageZone || !apiKey || (isPreview && (
        environment.PREVIEW_MEDIA_TARGET_ISOLATED !== 'true'
        || !storageHost
        || !cdnHost
        || ['cdn.dongphugia.com.vn', 'cdn.dongphugia.vn'].includes(cdnHost.toLowerCase())
    ))) {
        throw new Error(isPreview ? 'PREVIEW_MEDIA_TARGET_REQUIRED' : 'MEDIA_TARGET_NOT_CONFIGURED')
    }

    return {
        storageZone,
        apiKey,
        storageHost: storageHost || 'sg.storage.bunnycdn.com',
        cdnHost: cdnHost || 'cdn.dongphugia.com.vn',
    }
}

async function uploadToBunny(
    config: BunnyConfig,
    filePath: string,
    buffer: Buffer,
    contentType: string,
) {
    const uploadUrl =
        `https://${config.storageHost}/${config.storageZone}/${filePath}`
    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            AccessKey: config.apiKey,
            'Content-Type': contentType,
        },
        body: new Uint8Array(buffer),
    })

    if (!uploadRes.ok) {
        throw new Error('MEDIA_STORAGE_REJECTED')
    }
}

async function deleteFromBunny(config: BunnyConfig, filePath: string) {
    const deleteUrl =
        `https://${config.storageHost}/${config.storageZone}/${filePath}`
    await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { AccessKey: config.apiKey },
    }).catch(() => undefined)
}

export async function POST(request: NextRequest) {
    try {
        requireWritesAllowed('api.upload-image')

        // Auth guard — only authenticated admin users can upload
        const user = await getCurrentUser()
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (!can(user.role, 'products:write')) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const config = getBunnyConfig()

        const formData = await request.formData()
        const file = formData.get('file') as File | null
        const folder = (formData.get('folder') as string) || 'blog'
        const profileValue = (formData.get('profile') as string | null) || 'product'

        if (!file) {
            return NextResponse.json({ error: 'Không tìm thấy file' }, { status: 400 })
        }

        if (!isMediaProfile(profileValue)) {
            return NextResponse.json(
                { error: 'Profile ảnh không hợp lệ' },
                { status: 400 },
            )
        }

        // Validate type
        if (!ALLOWED_TYPES.includes(file.type)) {
            return NextResponse.json(
                { error: 'Chỉ hỗ trợ JPG, PNG, WebP, GIF' },
                { status: 400 }
            )
        }

        // Validate size
        if (file.size > MAX_SIZE_BYTES) {
            return NextResponse.json(
                { error: 'File quá lớn (Max 5MB)' },
                { status: 400 }
            )
        }

        // Sanitize folder — only allow alphanumeric + hyphens
        const safeFolder = folder.replace(/[^a-z0-9-]/gi, '').substring(0, 50) || 'misc'

        const arrayBuffer = await file.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const id = `${Date.now()}-${randomUUID().slice(0, 8)}`

        if (file.type === 'image/gif') {
            const metadata = await sharp(buffer, {
                animated: true,
                limitInputPixels: 40_000_000,
            }).metadata()
            const filePath = `${safeFolder}/${id}.gif`
            await uploadToBunny(config, filePath, buffer, 'image/gif')

            return NextResponse.json(
                {
                    url: `https://${config.cdnHost}/${filePath}`,
                    width: metadata.width ?? 0,
                    height: metadata.height ?? 0,
                    profile: profileValue,
                    variants: [],
                } satisfies MediaUploadResult,
                { status: 200 },
            )
        }

        const processed = await processImage(buffer, profileValue)
        const widths = MEDIA_PROFILES[profileValue].widths
        const uploadedPaths: string[] = []

        try {
            const variants: MediaVariant[] = []
            for (let index = 0; index < processed.variants.length; index += 1) {
                const targetWidth = widths[index]
                const processedVariant = processed.variants[index]
                const fileName = createMediaFileName(
                    id,
                    profileValue,
                    targetWidth,
                )
                const filePath = `${safeFolder}/${fileName}`
                await uploadToBunny(
                    config,
                    filePath,
                    processedVariant.buffer,
                    'image/webp',
                )
                uploadedPaths.push(filePath)
                variants.push({
                    url: `https://${config.cdnHost}/${filePath}`,
                    width: processedVariant.width,
                    height: processedVariant.height,
                    bytes: processedVariant.bytes,
                    format: 'webp',
                })
            }

            const primary = variants.at(-1)
            if (!primary) throw new Error('Không tạo được ảnh tối ưu')

            return NextResponse.json(
                {
                    url: primary.url,
                    width: primary.width,
                    height: primary.height,
                    profile: profileValue,
                    variants,
                } satisfies MediaUploadResult,
                { status: 200 },
            )
        } catch (error) {
            await Promise.all(
                uploadedPaths.map((filePath) =>
                    deleteFromBunny(config, filePath),
                ),
            )
            throw error
        }
    } catch (error: unknown) {
        if (isWriteFreezeError(error)) {
            return NextResponse.json(
                {
                    error: getWriteFreezeMessage(),
                    code: WRITE_FREEZE_ERROR_CODE,
                },
                { status: 503 },
            )
        }

        const code = error instanceof Error && error.message === 'PREVIEW_MEDIA_TARGET_REQUIRED'
            ? error.message
            : 'ADMIN_MEDIA_UPLOAD_FAILED'
        console.error(JSON.stringify({ event: 'ADMIN_MEDIA_UPLOAD_FAILURE', code }))
        return NextResponse.json(
            { error: code === 'PREVIEW_MEDIA_TARGET_REQUIRED' ? 'Preview chưa được cấu hình media TEST.' : 'Không thể tải ảnh lúc này.' },
            { status: code === 'PREVIEW_MEDIA_TARGET_REQUIRED' ? 503 : 500 }
        )
    }
}
