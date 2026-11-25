import { PUBLIC_NAVIGATION_START } from '../../src/components/layout/public-navigation-event'

export function onRouterTransitionStart(href: string, type: 'push' | 'replace' | 'traverse') {
    window.dispatchEvent(new CustomEvent(PUBLIC_NAVIGATION_START, { detail: { href, type } }))
}
