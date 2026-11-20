// @prisma/client@5.22.0 (wasm build): LibraryEngine#stop() calls engine.disconnect() but never
// engine.free(). wasm-bindgen only releases a QueryEngine through a FinalizationRegistry, and V8
// cannot see the WebAssembly linear memory that backs it, so garbage collection is not triggered by
// that pressure. A PrismaClient created per request therefore leaves one parsed-schema engine behind
// per request until the isolate reaches its memory limit and Cloudflare returns 1102/exceededResources.
//
// Free the engine explicitly once the request-scoped client has disconnected. The handle is an
// internal of the pinned Prisma version, so every access is optional and a missing handle is a no-op.
type WasmEngineHandle = { free?: () => void; __wbg_ptr?: number }

export function releasePrismaWasmEngine(client: unknown): boolean {
  const engine = (client as { _engine?: { engine?: WasmEngineHandle } } | null | undefined)?._engine?.engine
  if (!engine || typeof engine.free !== 'function') return false
  // wasm-bindgen zeroes the pointer after free(); never free twice.
  if (engine.__wbg_ptr === 0) return false
  engine.free()
  return true
}
