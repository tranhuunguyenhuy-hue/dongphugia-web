import { AsyncLocalStorage } from 'node:async_hooks'

const MAX_ACTIVE_READS = 4
const MAX_QUEUED_READS = 32
const QUEUE_TIMEOUT_MS = 5000

type Waiter = { grant: () => void; reject: () => void }
type ReadScope = {
  active: number
  peak: number
  waiters: Waiter[]
  signal?: AbortSignal
  /** #457: identical SELECTs of ONE request share one round trip (vinext probes a Flight page before rendering it). */
  reads: Map<string, Promise<unknown>>
}
const scopes = new AsyncLocalStorage<ReadScope>()

/** Keep the scope alive through asynchronous render/stream continuations. */
export function withPublicReadScope<T>(signal: AbortSignal | undefined, render: () => T): T {
  return scopes.run({ active: 0, peak: 0, waiters: [], signal, reads: new Map() }, render)
}

export function publicReadScope() {
  return scopes.getStore()
}

/** No Promise or client is transferred between Worker invocations. */
export async function acquirePublicReadSlot() {
  const scope = scopes.getStore()
  if (!scope) throw new Error('PUBLIC_DATABASE_REQUEST_SCOPE_REQUIRED')
  if (scope.signal?.aborted) throw new Error('PUBLIC_DATABASE_REQUEST_ABORTED')
  if (scope.active >= MAX_ACTIVE_READS) {
    if (scope.waiters.length >= MAX_QUEUED_READS) throw new Error('PUBLIC_DATABASE_READ_CAPACITY_EXCEEDED')
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        scope.signal?.removeEventListener('abort', waiter.reject)
        const index = scope.waiters.indexOf(waiter)
        if (index >= 0) scope.waiters.splice(index, 1)
      }
      const waiter: Waiter = {
        grant: () => { cleanup(); resolve() },
        reject: () => { cleanup(); reject(new Error(scope.signal?.aborted
          ? 'PUBLIC_DATABASE_REQUEST_ABORTED' : 'PUBLIC_DATABASE_READ_QUEUE_TIMEOUT')) },
      }
      // A request-owned timer also ensures queued work has a live runtime event.
      const timer = setTimeout(waiter.reject, QUEUE_TIMEOUT_MS)
      scope.waiters.push(waiter)
      scope.signal?.addEventListener('abort', waiter.reject, { once: true })
    })
  } else {
    scope.active += 1
    scope.peak = Math.max(scope.peak, scope.active)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const next = scope.waiters.shift()
    if (next) next.grant()
    else scope.active -= 1
  }
}
