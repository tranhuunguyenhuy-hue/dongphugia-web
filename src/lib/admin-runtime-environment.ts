import { AsyncLocalStorage } from 'node:async_hooks'

export interface AdminRuntimeEnvironment {
    APP_ENV?: string
    APP_ORIGIN?: string
    PREVIEW_MEDIA_TARGET_ISOLATED?: string
    BUNNY_STORAGE_ZONE_NAME?: string
    BUNNY_STORAGE_API_KEY?: string
    BUNNY_STORAGE_HOSTNAME?: string
    BUNNY_CDN_HOSTNAME?: string
    REVALIDATE_SECRET?: string
    IMAGES?: unknown
}

const requestAdminEnvironment = new AsyncLocalStorage<AdminRuntimeEnvironment>()

export function withAdminRuntimeEnvironment<T>(environment: AdminRuntimeEnvironment, callback: () => T): T {
    return requestAdminEnvironment.run(environment, callback)
}

export function getAdminRuntimeEnvironment() {
    return requestAdminEnvironment.getStore()
}
