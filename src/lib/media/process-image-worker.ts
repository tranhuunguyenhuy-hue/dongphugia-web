import {
    MEDIA_PROFILES,
    type MediaProfile,
} from '@/lib/media/media-profiles'
import type { ProcessedMedia } from '@/lib/media/process-image'

// Worker-only image adapter backed by the Cloudflare Images binding (Free plan: 5,000 unique
// transformations/month, new transforms are rejected over the limit, `.info()` is free).
// It fails closed: quota exhaustion or a missing binding never falls back to a paid or hidden path.
const MAX_INPUT_PIXELS = 40_000_000

type ImageInfo = { format?: string; width?: number; height?: number }
type ImagesTransformer = {
    transform(options: { width: number; fit: 'scale-down' }): ImagesTransformer
    output(options: { format: 'image/webp'; quality: number }): {
        response(): Response
    }
}
export interface ImagesBindingLike {
    info(stream: ReadableStream<Uint8Array>): Promise<ImageInfo>
    input(stream: ReadableStream<Uint8Array>): ImagesTransformer
}

export class MediaTransformUnavailableError extends Error {
    constructor() {
        super('MEDIA_TRANSFORM_UNAVAILABLE')
    }
}

function stream(buffer: Uint8Array): ReadableStream<Uint8Array> {
    return new Blob([buffer as BlobPart]).stream() as ReadableStream<Uint8Array>
}

export async function readImageInfo(images: ImagesBindingLike, input: Uint8Array) {
    try {
        const info = await images.info(stream(input))
        if (!info.width || !info.height) throw new Error('Không đọc được kích thước ảnh')
        if (info.width * info.height > MAX_INPUT_PIXELS) throw new Error('Ảnh có độ phân giải quá lớn')
        return { width: info.width, height: info.height, format: info.format }
    } catch (error) {
        if (error instanceof Error && /kích thước|độ phân giải/.test(error.message)) throw error
        throw new MediaTransformUnavailableError()
    }
}

export async function processImageWithImagesBinding(
    images: ImagesBindingLike,
    input: Uint8Array,
    profile: MediaProfile,
): Promise<ProcessedMedia> {
    const source = await readImageInfo(images, input)
    const config = MEDIA_PROFILES[profile]
    const variants: ProcessedMedia['variants'] = []

    // Sequential: bounded memory/CPU per request; no per-view transforms (uploads only).
    for (const targetWidth of config.widths) {
        let output: Uint8Array
        try {
            const response = images
                .input(stream(input))
                .transform({ width: Math.min(targetWidth, source.width), fit: 'scale-down' })
                .output({ format: 'image/webp', quality: config.quality })
                .response()
            if (!response.ok) throw new MediaTransformUnavailableError()
            output = new Uint8Array(await response.arrayBuffer())
        } catch {
            throw new MediaTransformUnavailableError()
        }
        // Accurate dimensions come from the produced bytes, never from a computed guess.
        const produced = await readImageInfo(images, output)
        variants.push({
            buffer: Buffer.from(output),
            width: produced.width,
            height: produced.height,
            bytes: output.byteLength,
        })
    }

    return { sourceWidth: source.width, sourceHeight: source.height, variants }
}
