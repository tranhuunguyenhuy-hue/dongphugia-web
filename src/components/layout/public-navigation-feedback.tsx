'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
    createContext, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode,
} from 'react'
import { PUBLIC_NAVIGATION_START, publicPageUrl, publicRouteKey, type PublicNavigationStart } from './public-navigation-event'

const LOADING_MESSAGE_MS = 12_000

type Navigation = {
    href: string
    key: string
    supersededKeys: ReadonlySet<string>
    variant: boolean
    document: boolean
    status: 'pending' | 'slow' | 'offline'
}

const NavigationContext = createContext<Navigation | null>(null)

export function PublicContent({ children }: { children: ReactNode }) {
    const navigation = useContext(NavigationContext)
    return (
        <main id="main-content" tabIndex={-1} aria-busy={navigation?.status === 'pending' || undefined}
            className="flex-1 pt-[72px] lg:pt-[88px]">
            {children}
        </main>
    )
}

function RouteCommit({ onCommit }: { onCommit: (key: string) => void }) {
    const pathname = usePathname()
    const search = useSearchParams()?.toString() ?? ''
    useLayoutEffect(() => {
        if (pathname) onCommit(publicRouteKey(pathname, search))
    }, [onCommit, pathname, search])
    return null
}

function activatedPageLink(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return null
    return publicPageUrl(link.href)
}

export function PublicNavigationFeedback({ children }: { children: ReactNode }) {
    const [navigation, setNavigation] = useState<Navigation | null>(null)
    const active = useRef<Navigation | null>(null)
    const committedRoute = useRef<string | null>(null)
    const timer = useRef<number | undefined>(undefined)

    const update = useCallback((next: Navigation | null) => {
        window.clearTimeout(timer.current)
        active.current = next
        setNavigation(next)
        if (next?.status === 'pending') {
            timer.current = window.setTimeout(() => {
                const slow = { ...next, status: 'slow' } as const
                active.current = slow
                setNavigation(slow)
            }, LOADING_MESSAGE_MS)
        }
    }, [])

    const onCommit = useCallback((key: string) => {
        const routeChanged = committedRoute.current !== null && committedRoute.current !== key
        committedRoute.current = key
        const latest = active.current
        if (!routeChanged || !latest) return
        // An earlier render can commit after the next intent starts. A different
        // destination outside that chain can be the current router's redirect.
        if (key === latest.key || !latest.supersededKeys.has(key)) update(null)
    }, [update])

    useEffect(() => {
        const currentKey = () => committedRoute.current ?? publicRouteKey(window.location.pathname, window.location.search)
        const start = (url: URL, isDocument: boolean) => {
            const key = publicRouteKey(url.pathname, url.search)
            if (key === currentKey()) {
                update(null)
                return
            }
            const previous = active.current
            const supersededKeys = new Set(previous?.supersededKeys)
            if (previous && previous.key !== key) supersededKeys.add(previous.key)
            const variant = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-public-variant]'))
                .some(link => publicRouteKey(link.pathname, link.search) === key)
            update({ href: url.href, key, supersededKeys, variant, document: isDocument, status: navigator.onLine ? 'pending' : 'offline' })
        }
        const onRouterStart = (event: Event) => {
            const { href } = (event as PublicNavigationStart).detail
            const url = publicPageUrl(href)
            if (url) start(url, false)
            else update(null)
        }
        const onClickCapture = (event: MouseEvent) => {
            const url = activatedPageLink(event)
            if (!url) return
            const key = publicRouteKey(url.pathname, url.search)
            if (key === currentKey()) return
            if (!navigator.onLine) {
                event.preventDefault()
                start(url, false)
            } else if (active.current?.status === 'pending' && active.current.key === key) {
                event.preventDefault()
            }
        }
        const onDocumentLink = (event: MouseEvent) => {
            // Link's router handler has already prevented the native action.
            const url = activatedPageLink(event)
            if (url && publicRouteKey(url.pathname, url.search) !== currentKey()) start(url, true)
        }
        const onOffline = () => {
            if (active.current?.status === 'pending') update({ ...active.current, status: 'offline' })
        }
        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted) update(null)
        }

        window.addEventListener(PUBLIC_NAVIGATION_START, onRouterStart)
        document.addEventListener('click', onClickCapture, true)
        window.addEventListener('click', onDocumentLink)
        window.addEventListener('offline', onOffline)
        window.addEventListener('pageshow', onPageShow)
        return () => {
            window.clearTimeout(timer.current)
            window.removeEventListener(PUBLIC_NAVIGATION_START, onRouterStart)
            document.removeEventListener('click', onClickCapture, true)
            window.removeEventListener('click', onDocumentLink)
            window.removeEventListener('offline', onOffline)
            window.removeEventListener('pageshow', onPageShow)
        }
    }, [update])

    const pending = navigation?.status === 'pending'
    let message = ''
    if (navigation?.status === 'pending') message = navigation.variant ? 'Đang tải biến thể…' : 'Đang tải trang…'
    if (navigation?.status === 'offline') message = 'Bạn đang ngoại tuyến.'
    if (navigation?.status === 'slow') message = 'Trang đang mất nhiều thời gian để tải.'
    const retryClass = 'rounded px-2 py-1 font-semibold text-brand-700 underline focus-visible:outline focus-visible:outline-2'

    return (
        <NavigationContext.Provider value={navigation}>
            <Suspense fallback={null}><RouteCommit onCommit={onCommit} /></Suspense>
            {children}
            <div className="pointer-events-none fixed inset-x-0 top-0 z-[110]">
                {pending && <div aria-hidden="true" className="h-1 bg-brand-700 motion-safe:animate-pulse" />}
                <div className={navigation
                    ? `fixed bottom-4 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 shadow-md ${pending ? '' : 'pointer-events-auto'}`
                    : 'sr-only'}>
                    <span role="status">{message}</span>
                    {navigation && !pending && (navigation.document
                        ? <a href={navigation.href} className={retryClass}>Thử lại</a>
                        : <Link href={navigation.href} prefetch={false} className={retryClass}>Thử lại</Link>)}
                </div>
            </div>
        </NavigationContext.Provider>
    )
}

export function ProductVariantLink({ href, current, className, children }: {
    href: string
    current: boolean
    className: string
    children: ReactNode
}) {
    const navigation = useContext(NavigationContext)
    const pending = !current && navigation?.status === 'pending' && navigation.variant && navigation.key === publicRouteKey(href, '')
    return (
        <Link href={href} prefetch={false} data-public-variant aria-busy={pending || undefined}
            aria-current={current ? 'page' : undefined}
            className={pending ? `${className} ring-2 ring-brand-700 ring-offset-2` : className}>
            {children}
        </Link>
    )
}
