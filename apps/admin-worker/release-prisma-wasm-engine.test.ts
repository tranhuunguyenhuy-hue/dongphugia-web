import { describe, expect, it, vi } from 'vitest'
import { releasePrismaWasmEngine } from './release-prisma-wasm-engine'

describe('releasePrismaWasmEngine', () => {
  it('frees the underlying wasm engine once', () => {
    const free = vi.fn(function (this: { __wbg_ptr: number }) { this.__wbg_ptr = 0 })
    const client = { _engine: { engine: { free, __wbg_ptr: 1234 } } }
    expect(releasePrismaWasmEngine(client)).toBe(true)
    expect(releasePrismaWasmEngine(client)).toBe(false)
    expect(free).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the engine never started or the internals are absent', () => {
    expect(releasePrismaWasmEngine(undefined)).toBe(false)
    expect(releasePrismaWasmEngine({})).toBe(false)
    expect(releasePrismaWasmEngine({ _engine: {} })).toBe(false)
    expect(releasePrismaWasmEngine({ _engine: { engine: {} } })).toBe(false)
  })
})
