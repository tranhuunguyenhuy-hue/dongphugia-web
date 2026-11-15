import { describe, expect, it, vi } from 'vitest'
import { validatePublicNavigationResponse } from './public-navigation-response.mjs'

function response({ navigation = false, status = 200, source = 'a'.repeat(40), mime = 'text/x-component', text = async () => '' } = {}) {
  return {
    url: () => 'https://public.example/thiet-bi-ve-sinh/bon-cau',
    request: () => ({ isNavigationRequest: () => navigation, headers: () => navigation ? {} : { rsc: '1' } }),
    status: () => status,
    headers: () => ({ 'x-dpg-source-sha': source, 'content-type': mime }),
    text,
  }
}

describe('public browser navigation response checks', () => {
  it('checks HTTP and source for browser-owned RSC without asking Chromium for an evicted stream body', async () => {
    const text = vi.fn(async () => { throw new Error('No data found for resource with given identifier') })
    await expect(validatePublicNavigationResponse(response({ text }), {
      origin: 'https://public.example', sha: 'a'.repeat(40),
    })).resolves.toBe(true)
    expect(text).not.toHaveBeenCalled()
  })

  it('still checks full document bodies for server error responses', async () => {
    await expect(validatePublicNavigationResponse(response({
      navigation: true, text: async () => 'Worker exceeded resource limits',
    }), { origin: 'https://public.example', sha: 'a'.repeat(40) })).rejects.toThrow('error body')
  })

  it('rejects bad RSC status or a response from another source SHA', async () => {
    await expect(validatePublicNavigationResponse(response({ mime: 'text/html' }), {
      origin: 'https://public.example', sha: 'a'.repeat(40),
    })).rejects.toThrow('Flight MIME')
    await expect(validatePublicNavigationResponse(response({ status: 503 }), {
      origin: 'https://public.example', sha: 'a'.repeat(40),
    })).rejects.toThrow('HTTP 503')
    await expect(validatePublicNavigationResponse(response({ source: 'b'.repeat(40) }), {
      origin: 'https://public.example', sha: 'a'.repeat(40),
    })).rejects.toThrow('SHA')
  })
})
