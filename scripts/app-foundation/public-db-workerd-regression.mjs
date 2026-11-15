// Run after npm ci --prefix apps/public. Executes actual read boundary in workerd.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
const requireWorker = createRequire(new URL('../../apps/public/package.json', import.meta.url))
const { Miniflare, convertV4MiniflareOptions } = requireWorker('miniflare')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const baseline = process.env.M1_REGRESSION_BASELINE === 'true'
const db = baseline ? execFileSync('git', ['show', '5d3588c1948e2bca5786b13e04c1ded6322e15fd:apps/public/src/runtime/public-db.ts'], { encoding: 'utf8' })
  : readFileSync('apps/public/src/runtime/public-db.ts', 'utf8')
const scope = readFileSync('apps/public/src/runtime/public-read-scope.ts', 'utf8')
const modules = [
  { type: 'ESModule', path: 'db.js', contents: compile(db).replaceAll("'./public-read-scope'", "'./scope.js'").replaceAll("import('pg')", "import('./pg.js')") },
  { type: 'ESModule', path: 'scope.js', contents: compile(scope) },
  { type: 'ESModule', path: 'pg.js', contents: `
    export class Client {
      connect(){return Promise.resolve()}
      query(sql,values){return new Promise((resolve,reject)=>{
        this.reject=reject;
        this.timer=setTimeout(()=>values[0]==='fail'?reject(new Error('simulated read failure')):resolve({rows:[{id:7}]}),40);
      })}
      end(){clearTimeout(this.timer);this.reject?.(new Error('closed'));return Promise.resolve()}
    }` },
  { type: 'ESModule', path: 'worker.js', contents: `
    import {readPublicRows} from './db.js';
    import {withPublicReadScope,publicReadScope} from './scope.js';
    export default {fetch(request){
      const controller=new AbortController();
      const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});
      return withPublicReadScope(controller.signal,async()=>{
        const url=new URL(request.url);
        if(url.pathname==='/stream')return new Response(new ReadableStream({async start(stream){
          await new Promise(resolve=>setTimeout(resolve,10));
          await Promise.all(Array.from({length:12},()=>readPublicRows('SELECT id FROM dpg_app.products')));
          const scope=publicReadScope();
          stream.enqueue(new TextEncoder().encode(JSON.stringify({fulfilled:12,active:scope.active,peak:scope.peak,queued:scope.waiters.length})));stream.close();
        }}),{headers:{'Content-Type':'text/html'}});
        const timer=url.pathname==='/cancel'?setTimeout(abort,10):undefined;
        const results=await Promise.allSettled(Array.from({length:url.pathname==='/capacity'?40:12},()=>
          readPublicRows('SELECT id FROM dpg_app.products WHERE sku = $1',[url.pathname==='/error'?'fail':'ok'])));
        clearTimeout(timer);request.signal.removeEventListener('abort',abort);
        const scope=publicReadScope();
        const body=JSON.stringify({fulfilled:results.filter(r=>r.status==='fulfilled').length,
          errors:results.filter(r=>r.status==='rejected').map(r=>r.reason.message),
          active:scope.active,peak:scope.peak,queued:scope.waiters.length});
        return new Response(body,{headers:{'Content-Type':request.headers.get('rsc')?'text/x-component':'text/html'}});
      });
    }};` },
]
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false,
  workers: [{ name: 'read-regression', modules: [modules[3], ...modules.slice(0, 3)], modulesRoot: '/',
    compatibilityDate: '2026-08-30', compatibilityFlags: ['nodejs_compat'],
    bindings: { PUBLIC_CATALOGUE_SOURCE: 'postgresql', PUBLIC_DB: { connectionString: 'postgresql://test.invalid/test' } },
  }],
}))
async function probe(path, rsc = false) {
  const response = await mf.dispatchFetch('http://local' + path, { headers: rsc ? {
    RSC: '1', 'Next-Router-Prefetch': '1', 'Next-Router-Segment-Prefetch': '1', 'Next-URL': '/thiet-bi-ve-sinh/bon-cau.',
  } : {} })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  assert.match(response.headers.get('content-type'), rsc ? /text\/x-component/ : /text\/html/)
  const data = JSON.parse(text)
  assert.equal(data.active, 0)
  assert.equal(data.queued, 0)
  assert.equal(data.peak, 4)
  return data
}
try {
  await mf.ready
  const concurrent = await Promise.all(['/gach-op-lat', '/thiet-bi-ve-sinh', '/cancel', '/error', '/thiet-bi-ve-sinh/bon-cau.'].map((path, i) => probe(path, i % 2 === 0)))
  assert.equal(concurrent[0].fulfilled, 12)
  assert.equal(concurrent[1].fulfilled, 12)
  assert.equal(concurrent[2].fulfilled, 0)
  assert.equal(concurrent[2].errors.length, 12)
  assert.equal(concurrent[3].errors.length, 12)
  assert.equal(concurrent[4].fulfilled, 12)
  assert.equal((await probe('/stream')).fulfilled, 12)
  const capacity = await probe('/capacity')
  assert.equal(capacity.fulfilled, 36)
  assert.deepEqual(capacity.errors, Array(4).fill('PUBLIC_DATABASE_READ_CAPACITY_EXCEEDED'))
  // Real HTTP disconnect, in addition to the deterministic in-flight abort above.
  const endpoint = await mf.ready
  const canceled = fetch(new URL('/gach-op-lat', endpoint), { signal: AbortSignal.timeout(20) }).catch(() => undefined)
  await canceled
  const subsequent = await probe('/independent', true)
  assert.equal(subsequent.fulfilled, 12)
  console.log('PUBLIC_DB_WORKERD_REGRESSION PASS concurrent=5 cancelled=2 error_cleanup=PASS peak_per_request=4 queued_limit=32 subsequent=PASS')
} finally {
  await mf.dispose()
}
