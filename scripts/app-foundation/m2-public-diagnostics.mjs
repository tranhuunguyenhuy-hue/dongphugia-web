/** Closed vocabulary only: database errors can embed credentials or returned rows. */
export function diagnoseM2CaptureFailure(error) {
  const reasons = new Set([
    'M2_SELECT_SECRET_MISSING','M2_PUBLIC_SELECT_SECRET_MISSING','M2_SELECT_CA_MISSING','INVALID_CONNECTION','WRONG_PROJECT',
    'M2_PUBLIC_ROLE_IDENTITY_REQUIRED','M2_PUBLIC_READ_ONLY_RLS_REQUIRED','M2_PUBLIC_ROLE_TABLE_BOUNDARY',
    'M2_PUBLIC_ROLE_TABLE_RLS_REQUIRED','M2_PUBLIC_ROLE_TABLE_SET','M2_PUBLIC_ROLE_AUTHORITY_BOUNDARY',
    'CA_REQUIRED','SESSION_CONNECTION_REQUIRED','CONNECTION_OPTIONS_FORBIDDEN','ADMIN_CREDENTIAL_FORBIDDEN',
    'ROLE_ATTRIBUTES','ROLE_TABLE_BOUNDARY','ROLE_TABLE_SET','ROLE_AUTHORITY_BOUNDARY','ROLE_SEQUENCE_BOUNDARY',
    'READ_ONLY_TLS_REQUIRED','CLIENT_TLS_REQUIRED','READ_ONLY_TRANSACTION_REQUIRED','PRODUCTION_SQL_COUNTS_MISMATCH','M2_CAPTURE_PARITY_MISMATCH',
    'M2_PRODUCTION_CHANGED_DURING_CAPTURE','M2_PUBLIC_ASSET_TOO_LARGE','M2_PUBLIC_SNAPSHOT_BUDGET',
  ])
  const networkCodes = new Set(['ENOTFOUND','EAI_AGAIN','ENETUNREACH','ECONNREFUSED','ECONNRESET','ETIMEDOUT',
    'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'])
  const message = error instanceof Error ? error.message : ''
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return {
    reason: reasons.has(message) ? message : 'M2_PROTECTED_CAPTURE_FAILED',
    ...(/^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {}),
    ...(networkCodes.has(code) ? { connectionCode: code } : {}),
    ...(message === 'Connection terminated due to connection timeout' ? { connectionCode: 'CONNECTION_TIMEOUT' } : {}),
  }
}

const m2CloudflareEndpointTemplates = [
  [/^\/workers\/workers\/[^/]+\/previews\/[^/]+\/deployments\/[^/]+$/, '/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments/{deployment_id}'],
  [/^\/workers\/workers\/[^/]+\/previews\/[^/]+$/, '/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}'],
  [/^\/workers\/workers\/[^/]+$/, '/accounts/{account_id}/workers/workers/{worker_id}'],
  [/^\/workers\/scripts\/[^/]+\/deployments$/, '/accounts/{account_id}/workers/scripts/{script_name}/deployments'],
  [/^\/workers\/scripts\/[^/]+\/settings$/, '/accounts/{account_id}/workers/scripts/{script_name}/settings'],
  [/^\/workers\/scripts\/[^/]+\/subdomain$/, '/accounts/{account_id}/workers/scripts/{script_name}/subdomain'],
  [/^\/access\/apps\/[^/]+\/policies\/[^/]+$/, '/accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}'],
  [/^\/access\/apps\/[^/]+\/policies$/, '/accounts/{account_id}/access/apps/{app_id}/policies'],
  [/^\/access\/apps\/[^/]+$/, '/accounts/{account_id}/access/apps/{app_id}'],
  [/^\/access\/service_tokens\/[^/]+$/, '/accounts/{account_id}/access/service_tokens/{service_token_id}'],
  [/^\/access\/service_tokens$/, '/accounts/{account_id}/access/service_tokens'],
]

/**
 * Record enough Cloudflare API failure context to identify a denied permission,
 * while excluding account, Worker, app, policy, preview, and token identifiers.
 */
export function sanitizeM2CloudflareApiFailure(method, path, status, errors) {
  const endpoint = m2CloudflareEndpointTemplates.find(([pattern]) => pattern.test(String(path)))?.[1]
    || '/accounts/{account_id}/{unclassified_endpoint}'
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  const verb = String(method || '').toUpperCase()
  const cloudflareErrorCodes = Array.isArray(errors)
    ? errors.slice(0, 10).flatMap(error => Number.isInteger(error?.code) ? [error.code] : [])
    : []
  return {
    method: allowedMethods.has(verb) ? verb : 'UNKNOWN',
    endpoint,
    status: Number.isInteger(status) ? status : null,
    cloudflareErrorCodes,
  }
}

/** Keep useful assertion/route failures without credential headers, JWTs or query strings. */
export function sanitizeM2CommandFailure(text, secrets = []) {
  let safe = String(text)
  for (const value of secrets) if (value) safe = safe.split(value).join('[REDACTED]')
  return safe.split('\n').filter(line => !/authorization|cookie|cf-access|client_secret|api[_-]?token/i.test(line))
    .map(line => line.replace(/https?:\/\/[^\s"'<>]+/g, raw => {
      try { const url = new URL(raw); return url.origin + url.pathname } catch { return '[URL]' }
    }).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]')
      .replace(/[A-Za-z0-9+/_=-]{100,}/g, '[LONG_VALUE]'))
    .slice(-60).join('\n').slice(-12000)
}
