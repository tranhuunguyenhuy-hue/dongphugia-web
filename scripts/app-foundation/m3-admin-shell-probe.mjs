// #447: the Admin shell gate (HTTP 200 + noindex meta) must never be weakened. This probe only adds (a) a bounded,
// recorded retry for a freshly published Preview and (b) sanitized per-attempt diagnostics, so a failure is explained by
// evidence instead of an opaque assertion. Header values are reduced to non-secret facts; bodies are never stored.
const NOINDEX = /name="robots"[^>]*noindex/i

export function describeShellAttempt(attempt, response, body) {
  let location = ''
  try { const parsed = new URL(response.headers.get('location') || '', 'https://placeholder.invalid'); location = `${parsed.hostname === 'placeholder.invalid' ? '' : parsed.hostname}${parsed.pathname}` } catch { location = 'unparseable' }
  return {
    attempt,
    status: response.status,
    contentType: (response.headers.get('content-type') || '').split(';')[0].slice(0, 60),
    location: location.slice(0, 80),
    xRobotsTag: (response.headers.get('x-robots-tag') || '').slice(0, 40),
    cacheStatus: (response.headers.get('cf-cache-status') || '').slice(0, 20),
    server: (response.headers.get('server') || '').slice(0, 30),
    bodyBytes: body.length,
    noindexMeta: NOINDEX.test(body),
  }
}

export function shellAccepted(record) { return record.status === 200 && record.noindexMeta === true }

// fetchShell(): Promise<Response>. sleep(ms) is injectable for tests. Returns every attempt; ok is true only for 200 + noindex.
export async function probeAdminShell(fetchShell, { attempts = 6, delayMs = 10000, sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const records = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchShell()
    const body = await response.text()
    const record = describeShellAttempt(attempt, response, body)
    records.push(record)
    if (shellAccepted(record)) return { ok: true, attempts: records }
    if (attempt < attempts) await sleep(delayMs)
  }
  return { ok: false, attempts: records }
}
