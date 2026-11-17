// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
    MediaFormatError,
    MediaTransformUnavailableError,
    assertGifImage,
    processImageWithImagesBinding,
    readImageInfo,
    type ImagesBindingLike,
} from '@/lib/media/process-image-worker'

// Behavioural contract tests with a fake binding. These are NOT hosted proof of Cloudflare Images;
// real transform, quota and CPU evidence come from the hosted Preview UAT.
function fakeImages(options: { width?: number; height?: number; fail?: 'transform' | 'info' } = {}): ImagesBindingLike & { widths: number[] } {
    const widths: number[] = []
    const source = { width: options.width ?? 2000, height: options.height ?? 1000 }
    return {
        widths,
        async info(stream) {
            if (options.fail === 'info') throw new Error('9422')
            const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
            // Output files carry their width in the first byte pair; source files are 'SRC'.
            if (bytes[0] === 0x57) return { format: 'image/webp', width: bytes[1] * 10, height: bytes[1] * 5 }
            return { format: 'image/jpeg', ...source }
        },
        input() {
            let target = 0
            const chain = {
                transform(opts: { width: number }) { target = opts.width; widths.push(target); return chain },
                // Official API: output() is async and resolves to an object with response().
                async output() {
                    if (options.fail === 'transform') throw Object.assign(new Error('quota'), { code: 9422 })
                    return { response: () => new Response(new Uint8Array([0x57, target / 10])) }
                },
            }
            return chain as never
        },
    }
}

describe('Images binding adapter (Worker upload path)', () => {
    it('produces the profile widths without upscaling and reports produced dimensions', async () => {
        const images = fakeImages({ width: 500, height: 250 })
        const processed = await processImageWithImagesBinding(images, new Uint8Array([1, 2, 3]), 'product')
        expect(images.widths).toEqual([320, 500])
        expect(processed.sourceWidth).toBe(500)
        expect(processed.variants.map((variant) => variant.width)).toEqual([320, 500])
        expect(processed.variants.every((variant) => variant.bytes === 2)).toBe(true)
    })

    it('rejects oversized pixel counts before any transform', async () => {
        const images = fakeImages({ width: 10000, height: 5000 })
        await expect(processImageWithImagesBinding(images, new Uint8Array([1]), 'product')).rejects.toThrow('độ phân giải')
        expect(images.widths).toEqual([])
    })

    it('rejects non-raster or mismatched source formats and non-GIF pass-through input', async () => {
        const gif = { ...fakeImages(), async info() { return { format: 'image/gif', width: 10, height: 10 } } } as ImagesBindingLike
        await expect(processImageWithImagesBinding(gif, new Uint8Array([1]), 'product')).rejects.toBeInstanceOf(MediaFormatError)
        await expect(assertGifImage(fakeImages(), new Uint8Array([1]))).rejects.toBeInstanceOf(MediaFormatError)
        await expect(assertGifImage(gif, new Uint8Array([1]))).resolves.toMatchObject({ format: 'image/gif' })
        const notImage = { ...fakeImages(), async info() { throw Object.assign(new Error('x'), { code: 9412 }) } } as ImagesBindingLike
        await expect(readImageInfo(notImage, new Uint8Array([1]))).rejects.toBeInstanceOf(MediaFormatError)
    })

    it('fails closed with a sanitized error when the binding rejects (quota or unavailable)', async () => {
        await expect(processImageWithImagesBinding(fakeImages({ fail: 'transform' }), new Uint8Array([1]), 'product'))
            .rejects.toBeInstanceOf(MediaTransformUnavailableError)
        await expect(readImageInfo(fakeImages({ fail: 'info' }), new Uint8Array([1])))
            .rejects.toBeInstanceOf(MediaTransformUnavailableError)
    })
})
