export const FIXED_PREVIEW_WORKER = 'dongphugia-v1-public-production'
export const FIXED_PREVIEW_NAME = 'staging'
export const FIXED_PREVIEW_ORIGIN = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
// Cloudflare Preview deployment IDs are UUIDs; routable deployment URLs use
// their short identifier (documented example), compact identifier, or full UUID.
const DEPLOYMENT_HOST = /^(?:[a-f0-9]{8}|[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-dongphugia-v1-public-production\.tranhuunguyenhuy\.workers\.dev$/
/** @param {string} hostname */
export function isFixedPreviewDeploymentHost(hostname) { return DEPLOYMENT_HOST.test(hostname) }
