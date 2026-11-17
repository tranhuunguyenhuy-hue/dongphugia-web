// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth/get-current-user'
import { withAdminRuntimeEnvironment } from '@/lib/admin-runtime-environment'
import { POST } from '@/app/api/upload-image/route'

vi.mock('@/lib/auth/get-current-user', () => ({
    getCurrentUser: vi.fn(),
}))

const mockedGetCurrentUser = vi.mocked(getCurrentUser)

describe('POST /api/upload-image', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.stubEnv('APP_ENV', 'test')
        vi.stubEnv('BUNNY_STORAGE_ZONE_NAME', 'test-zone')
        vi.stubEnv('BUNNY_STORAGE_API_KEY', 'test-key')
        vi.stubEnv('BUNNY_STORAGE_HOSTNAME', 'storage.example.com')
        vi.stubEnv('BUNNY_CDN_HOSTNAME', 'cdn.example.com')
        mockedGetCurrentUser.mockResolvedValue({ id: 1, role: 'admin' } as never)
    })

    it('processes and uploads every responsive variant', async () => {
        const input = await sharp({
            create: {
                width: 800,
                height: 400,
                channels: 3,
                background: '#25738e',
            },
        })
            .jpeg()
            .toBuffer()
        const formData = new FormData()
        formData.append(
            'file',
            new File([new Uint8Array(input)], 'product.jpg', {
                type: 'image/jpeg',
            }),
        )
        formData.append('folder', 'products')
        formData.append('profile', 'product')
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(null, { status: 201 }))

        const response = await POST(
            new NextRequest('http://localhost/api/upload-image', {
                method: 'POST',
                body: formData,
            }),
        )
        const payload = await response.json()

        expect(response.status).toBe(200)
        expect(payload.profile).toBe('product')
        expect(payload.variants).toHaveLength(2)
        expect(payload.url).toMatch(/\.product\.w640\.webp$/)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            method: 'PUT',
            headers: {
                AccessKey: 'test-key',
                'Content-Type': 'image/webp',
            },
        })
    })

    it('rejects unauthenticated uploads before reading the file', async () => {
        mockedGetCurrentUser.mockResolvedValue(null)
        const response = await POST(
            new NextRequest('http://localhost/api/upload-image', {
                method: 'POST',
            }),
        )

        expect(response.status).toBe(401)
    })

    it('rejects uploads from an authenticated role without write permission', async () => {
        mockedGetCurrentUser.mockResolvedValue({ id: 2, role: 'sale' } as never)
        const fetchMock = vi.spyOn(globalThis, 'fetch')
        const response = await POST(
            new NextRequest('http://localhost/api/upload-image', { method: 'POST' }),
        )

        expect(response.status).toBe(403)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('fails closed for Preview without an isolated media target and does not disclose credentials', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch')
        const request = new NextRequest('http://localhost/api/upload-image', { method: 'POST' })
        const response = await withAdminRuntimeEnvironment({
            APP_ENV: 'preview',
            PREVIEW_MEDIA_TARGET_ISOLATED: 'false',
            BUNNY_STORAGE_ZONE_NAME: 'test-zone',
            BUNNY_STORAGE_API_KEY: 'test-key',
            BUNNY_STORAGE_HOSTNAME: 'storage.example.com',
            BUNNY_CDN_HOSTNAME: 'cdn.example.com',
        }, () => POST(request))
        const payload = await response.json()

        expect(response.status).toBe(503)
        expect(JSON.stringify(payload)).not.toContain('test-key')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects the Production media CDN as a Preview upload target', async () => {
        const request = new NextRequest('http://localhost/api/upload-image', { method: 'POST' })
        const response = await withAdminRuntimeEnvironment({
            APP_ENV: 'preview',
            PREVIEW_MEDIA_TARGET_ISOLATED: 'true',
            BUNNY_STORAGE_ZONE_NAME: 'test-zone',
            BUNNY_STORAGE_API_KEY: 'test-key',
            BUNNY_STORAGE_HOSTNAME: 'storage.example.com',
            BUNNY_CDN_HOSTNAME: 'cdn.dongphugia.com.vn',
        }, () => POST(request))

        expect(response.status).toBe(503)
        expect(JSON.stringify(await response.json())).not.toContain('test-key')
    })
})
