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
