export const PUBLIC_NAVIGATION_START = 'dpg:public-navigation-start'

export type PublicNavigationStart = CustomEvent<{
    href: string
    type: 'push' | 'replace' | 'traverse'
}>

export function publicRouteKey(pathname: string, search: string) {
    // Match the router's URLSearchParams serialization (e.g. spaces and %20).
    const query = new URLSearchParams(search).toString()
    return query ? `${pathname}?${query}` : pathname
}

export function publicPageUrl(href: string) {
    let url: URL
    try {
        url = new URL(href, window.location.href)
    } catch {
        return null
    }
    if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) return null
    if (/^\/(?:api|admin|_next|images)(?:\/|$)/.test(url.pathname)) return null
    if (/\.[^/]+$/.test(url.pathname)) return null
    return url
}
