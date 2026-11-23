import { describe, expect, it } from 'vitest'
import { probeAdminShell, shellAccepted } from './m3-admin-shell-probe.mjs'

const html = '<html><head><meta name="robots" content="noindex, nofollow" /></head></html>'
const reply = (status, body = html, headers = {}) => () => Promise.resolve(new Response(body, { status, headers }))
const noSleep = { sleep: () => Promise.resolve(), delayMs: 0 }

describe('Admin shell probe (#447)', () => {
  it('accepts 200 with the noindex meta on the first attempt', async () => {
    const result = await probeAdminShell(reply(200), noSleep)
    expect(result.ok).toBe(true)
    expect(result.attempts).toHaveLength(1)
  })
  it('retries a transient non-200 and records every attempt', async () => {
    const queue = [reply(404, 'nf'), reply(200)]
    const result = await probeAdminShell(() => queue.shift()(), noSleep)
    expect(result.ok).toBe(true)
    expect(result.attempts.map(a => a.status)).toEqual([404, 200])
  })
  it('never accepts a 200 without noindex', async () => {
    const result = await probeAdminShell(reply(200, '<html></html>'), { ...noSleep, attempts: 3 })
    expect(result.ok).toBe(false)
    expect(result.attempts).toHaveLength(3)
    expect(shellAccepted(result.attempts[0])).toBe(false)
  })
  it('never accepts a persistent non-200 (gate is not weakened)', async () => {
    const result = await probeAdminShell(reply(502, 'bad'), { ...noSleep, attempts: 2 })
    expect(result.ok).toBe(false)
    expect(result.attempts.every(a => a.status === 502)).toBe(true)
  })
  it('stores only sanitized facts: no body text, redirect target reduced to host and path', async () => {
    const result = await probeAdminShell(reply(302, 'secret-body', { location: 'https://x.cloudflareaccess.com/cdn-cgi/access/login?kid=SECRET&redirect_url=%2F' }), { ...noSleep, attempts: 1 })
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain('secret-body')
    expect(serialised).not.toContain('SECRET')
    expect(result.attempts[0].location).toBe('x.cloudflareaccess.com/cdn-cgi/access/login')
  })
})
