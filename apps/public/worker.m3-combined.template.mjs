import { createCombinedM3Worker } from './m3-combined-dispatch.mjs'

// Lazy server modules. The Admin bundle (~9 MB JS + Prisma/resvg WASM) and the Public bundle are loaded on the
// first request that needs them, inside request CPU limits, instead of at Worker startup: statically importing both
// made cold isolates intermittently exceed startup/resource limits (Cloudflare 1102) in the combined Worker.
function lazyWorker(load) {
  let loading = null
  return {
    async fetch(request, environment, context) {
      loading ??= load().then((module) => module.default, (error) => { loading = null; throw error })
      return (await loading).fetch(request, environment, context)
    },
  }
}
const publicWorker = lazyWorker(() => import('./public/server/index.js'))
const adminWorker = lazyWorker(() => import('./admin/server/index.mjs'))

export default createCombinedM3Worker({ publicWorker, adminWorker })
