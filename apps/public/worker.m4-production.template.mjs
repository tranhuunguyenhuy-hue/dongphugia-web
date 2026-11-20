import { createProductionAdminWorker } from './m4-production-dispatch.mjs'

// Production entry (M4). The canonical Public Worker bundle is loaded lazily on the first Public request so the Admin
// surfaces (tiny) never pay its startup cost, and Public behaviour is exactly the already-released bundle.
function lazyWorker(load) {
  let loading = null
  return {
    async fetch(request, environment, context) {
      loading ??= load().then((module) => module.default, (error) => { loading = null; throw error })
      return (await loading).fetch(request, environment, context)
    },
  }
}
const publicWorker = lazyWorker(() => import('./index.js'))

export default createProductionAdminWorker({ publicWorker, sourceSha: '__M4_BUILD_SOURCE_SHA__' })
