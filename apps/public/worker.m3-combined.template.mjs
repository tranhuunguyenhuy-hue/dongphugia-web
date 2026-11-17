import publicWorker from './public/server/index.js'
import adminWorker from './admin/server/index.mjs'
import { createCombinedM3Worker } from './m3-combined-dispatch.mjs'

export default createCombinedM3Worker({ publicWorker, adminWorker })
