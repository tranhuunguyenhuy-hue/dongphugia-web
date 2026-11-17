const EXACT_ADMIN_PATHS = new Set([
    '/admin',
    '/admin/login',
])

const ADMIN_MODULE_PATHS = [
    '/admin/products',
    '/admin/blog',
    '/admin/orders',
    '/admin/customers',
    '/admin/quote-requests',
    '/admin/banners',
    '/admin/content',
    '/admin/categories',
    '/admin/pim',
    '/admin/doi-tac',
    '/admin/du-an',
    '/admin/users',
] as const

export type AdminLaunchModule =
    | 'products'
    | 'blog-posts'
    | 'orders'
    | 'customers'
    | 'quote-requests'
    | 'dashboard'
    | 'banners'
    | 'categories'
    | 'pim'
    | 'partners'
    | 'projects'
    | 'users'
    | 'blog-tags'

const ENABLED_ADMIN_LAUNCH_MODULES = new Set<AdminLaunchModule>([
    'products',
    'blog-posts',
    'orders',
    'customers',
    'quote-requests',
    'dashboard',
    'banners',
    'categories',
    'pim',
    'partners',
    'projects',
    'users',
    'blog-tags',
])

export function assertAdminLaunchModuleEnabled(module: AdminLaunchModule) {
    if (!ENABLED_ADMIN_LAUNCH_MODULES.has(module)) {
        throw new Error('ADMIN_LAUNCH_SCOPE_DENIED')
    }
}

function normalizePath(pathname: string) {
    const withoutTrailingSlashes = pathname.replace(/\/+$/, '')
    return withoutTrailingSlashes || '/'
}

export function isAdminLaunchPathAllowed(pathname: string) {
    const path = normalizePath(pathname)
    return EXACT_ADMIN_PATHS.has(path)
        || ADMIN_MODULE_PATHS.some((base) => path === base || path.startsWith(`${base}/`))
}
