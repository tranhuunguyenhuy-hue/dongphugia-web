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

// Trimmed lines of a Markdown comment that are NOT inside a fenced code block and NOT a quote: only these may carry directives.
export function plainLines(body) {
  const lines = []
  let fence = null
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    const marker = line.match(/^(```|~~~)/)?.[1]
    if (marker) { fence = fence === marker ? null : (fence ?? marker); continue }
    if (fence || line.startsWith('>')) continue
    lines.push(line)
  }
  return lines
}

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
