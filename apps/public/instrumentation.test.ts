import { describe, expect, it, vi } from 'vitest'
import { onRequestError } from './instrumentation'

describe('Public render error hook', () => {
  it('excludes request secrets and exception text from structured output', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      onRequestError(Object.assign(new TypeError('PRIVATE_SQL customer@example.test'), { code: '42501' }),
        { path: '/?token=secret', headers: { cookie: 'secret' } }, { routePath: '/', routeType: 'render' })
      const value = JSON.parse(log.mock.calls[0][0])
      expect(value).toMatchObject({ event: 'PUBLIC_REQUEST_RENDER_ERROR', route: '/', errorClass: 'TypeError', sqlState: '42501' })
      expect(JSON.stringify(value)).not.toMatch(/PRIVATE_SQL|customer@|secret|cookie/)
    } finally { log.mockRestore() }
  })
  it('suppresses intentional 404 and restricts route metadata', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      onRequestError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }, {}, {})
      expect(log).not.toHaveBeenCalled()
      onRequestError(new Error('private'), {}, { routePath: '/private?token=secret', routeType: 'unknown' })
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ route: 'other', routeType: 'other' })
    } finally { log.mockRestore() }
  })
})
