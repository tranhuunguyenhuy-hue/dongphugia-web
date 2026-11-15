import { isExpectedPublicNotFound, publicRouteFailureSummary } from './src/runtime/public-route-diagnostics'

const ROUTES = new Set(['/', '/[categorySlug]', '/[categorySlug]/[subcategorySlug]', '/[categorySlug]/[subcategorySlug]/[productSlug]', '/blog', '/blog/[categorySlug]', '/blog/[categorySlug]/[slug]', '/tim-kiem'])

/** Synchronous render diagnostics: never log request headers, SQL or error text. */
export function onRequestError(
  error: unknown,
  _request: unknown,
  context: { routePath?: string; routeType?: string },
) {
  if (isExpectedPublicNotFound(error)) return
  console.error(JSON.stringify({
    event: 'PUBLIC_REQUEST_RENDER_ERROR',
    utc: new Date().toISOString(),
    route: context.routePath && ROUTES.has(context.routePath) ? context.routePath : 'other',
    routeType: context.routeType === 'render' || context.routeType === 'route' ? context.routeType : 'other',
    ...publicRouteFailureSummary(error),
  }))
}
