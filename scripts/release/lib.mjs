// #505 Lean Release Pipeline: tiny shared helpers. No dependencies, so release gates run before `npm ci` (fail fast).
// Every helper fails closed: a missing token, HTTP error or unexpected shape throws instead of returning a default.
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { DEFAULT_REPOSITORY, OWNER } from '../lib/repository-identity.mjs'

export { DEFAULT_REPOSITORY, OWNER }
export const SHA = /^[0-9a-f]{40}$/
export const WORKER = 'dongphugia-v1-public-production'
export const ACCOUNT_ID = 'd54f3402b9d112ab64d6135e0e3f1fb1'
export const M4_WORKFLOW = '.github/workflows/m4-production-admin-release.yml'
export const STAGING_WORKFLOW = '.github/workflows/v1-fixed-preview.yml'
export const QUALITY_WORKFLOW = '.github/workflows/quality.yml'
export const SQL_WORKFLOW = '.github/workflows/m6-production-sql-apply.yml'
export const FUNCTION_WORKFLOW = '.github/workflows/m4-production-function-deploy.yml'
// Parent Worker id that owns the fixed `staging` preview (same constant as publish-m3-fixed-preview.mjs).
export const STAGING_PARENT_WORKER_ID = 'e50647603f1b4e73bed14e2e79c15d26'

// Lines of a Markdown comment that may carry directives. Directives must start at column 0, so indented lines (indented code,
// nested list items) never count; fenced blocks (up to 3 leading spaces, ``` or ~~~, closed by the same or longer run), quotes and
// HTML comments are dropped. Trailing whitespace is trimmed; leading whitespace is kept so the column-0 rule can apply.
export function plainLines(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '')
  const lines = []
  let fence = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null; continue }
    if (marker) { fence = marker; continue }
    if (/^ {0,3}>/.test(line) || /^( {4}|\t)/.test(line)) continue
    lines.push(line)
  }
  return lines
}

export const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : Number(a.id) - Number(b.id))

export const isOwnerComment = (c) => c?.author_association === 'OWNER' && c?.user?.login === OWNER

export function writeOutputs(outputs, env = process.env) {
  const text = Object.entries(outputs).map(([key, value]) => {
    const v = String(value ?? '')
    if (/[\r\n]/.test(v)) throw new Error(`OUTPUT_MULTILINE_${key}`)
    return `${key}=${v}`
  }).join('\n') + '\n'
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
}

export function appendSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  else process.stdout.write(`${markdown}\n`)
}

export function github({ token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  return async function request(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'dpg-release-gate' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method, headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`GITHUB_API_${response.status}`)
    return response.status === 204 ? null : response.json()
  }
}

// Paginate a GitHub list endpoint (bounded: release evidence never needs more than maxPages * 100 items).
export async function githubList(request, path, { maxPages = 10, key } = {}) {
  const items = []
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const data = await request(`${path}${sep}per_page=100&page=${page}`)
    const list = key ? data?.[key] : data
    if (!Array.isArray(list)) throw new Error('GITHUB_LIST_SHAPE')
    items.push(...list)
    if (list.length < 100) return items
  }
  throw new Error('GITHUB_LIST_TOO_LONG')
}

export function cloudflare({ token = process.env.CLOUDFLARE_API_TOKEN, accountId = process.env.CLOUDFLARE_ACCOUNT_ID, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('CLOUDFLARE_TOKEN_MISSING')
  if (accountId !== ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_MISMATCH')
  return async function request(path) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
    })
    const json = await response.json().catch(() => null)
    if (!response.ok || json?.success !== true) throw new Error(`CLOUDFLARE_API_${response.status}`)
    return json.result
  }
}

// The single version serving 100% of the latest deployment, plus its bindings. Anything else (split traffic, no deployment) is UNKNOWN.
export function activeVersionId(deploymentsResult) {
  const list = Array.isArray(deploymentsResult) ? deploymentsResult : deploymentsResult?.deployments
  if (!Array.isArray(list) || !list.length) throw new Error('ACTIVE_VERSION_UNKNOWN')
  const current = list.reduce((latest, item) => !latest || item.created_on > latest.created_on ? item : latest, null)
  const active = (current?.versions ?? []).filter((v) => v.percentage === 100)
  if (active.length !== 1 || !/^[a-f0-9-]{36}$/.test(active[0].version_id ?? '')) throw new Error('ACTIVE_VERSION_UNKNOWN')
  return active[0].version_id
}

export function versionBindings(versionResult) {
  const bindings = (versionResult?.version ?? versionResult?.result ?? versionResult)?.resources?.bindings
  if (!Array.isArray(bindings)) throw new Error('VERSION_BINDINGS_UNKNOWN')
  return bindings
}

export async function readActiveProduction(request) {
  const versionId = activeVersionId(await request(`/workers/scripts/${WORKER}/deployments`))
  const bindings = versionBindings(await request(`/workers/scripts/${WORKER}/versions/${versionId}`))
  return { versionId, bindings }
}

export async function currentMainHead(request, repo = DEFAULT_REPOSITORY) {
  const ref = await request(`/repos/${repo}/git/ref/heads/main`)
  const sha = ref?.object?.sha
  if (!SHA.test(sha ?? '')) throw new Error('MAIN_HEAD_UNKNOWN')
  return sha
}

export function isMain(module) {
  return Boolean(process.argv[1]) && module === pathToFileURL(process.argv[1]).href
}

// Live identity of fixed Staging: the `workers/tag` (source SHA set by both publishers) of the newest deployment of the
// `staging` preview. Read-only; anything unexpected is UNKNOWN (throws).
export async function liveStagingSha(request, previewName = 'staging') {
  const previews = await request(`/workers/workers/${STAGING_PARENT_WORKER_ID}/previews`)
  const matches = (Array.isArray(previews) ? previews : []).filter((p) => p.name === previewName)
  if (matches.length !== 1) throw new Error('STAGING_PREVIEW_UNKNOWN')
  const deployments = await request(`/workers/workers/${STAGING_PARENT_WORKER_ID}/previews/${matches[0].id}/deployments`)
  const latest = (Array.isArray(deployments) ? deployments : []).reduce((a, d) => (!a || d.created_on > a.created_on ? d : a), null)
  const tag = latest?.annotations?.['workers/tag']
  if (!SHA.test(tag ?? '')) throw new Error('STAGING_IDENTITY_UNKNOWN')
  return { sha: tag, deploymentId: latest.id, createdOn: latest.created_on }
}
