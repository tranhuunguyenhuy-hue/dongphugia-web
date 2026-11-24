// #470 commerce v1: the ONLY way the commerce flag and the order-intake Hyperdrive binding reach the Production Worker: written into the
// release wrangler config by the protected M4 lane (input `commerce`, default off). Never set on the Worker by hand: the next deploy would drop it.
// The intake binding is a SEPARATE Hyperdrive (login role dpg_order_intake_login, caching disabled); it is never PUBLIC_DB and never an Admin credential.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HYPERDRIVE_ID = /^[0-9a-f]{32}$/

export function applyCommerce(cfg, mode, intakeHyperdriveId = '', publicHyperdriveId = '') {
  if (cfg?.name !== 'dongphugia-v1-public-production') throw new Error('WRONG_WORKER_TARGET')
  if (!['off', 'on'].includes(mode)) throw new Error('COMMERCE_MODE_INVALID')
  const vars = { ...(cfg.vars ?? {}) }
  delete vars.PUBLIC_COMMERCE
  const hyperdrive = (cfg.hyperdrive ?? []).filter(item => item.binding !== 'ORDER_INTAKE_DB')
  if (mode === 'on') {
    if (!HYPERDRIVE_ID.test(String(intakeHyperdriveId))) throw new Error('COMMERCE_INTAKE_HYPERDRIVE_MISSING')
    if (publicHyperdriveId && intakeHyperdriveId === publicHyperdriveId) throw new Error('COMMERCE_INTAKE_MUST_NOT_REUSE_PUBLIC_HYPERDRIVE')
    vars.PUBLIC_COMMERCE = 'on'
    hyperdrive.push({ binding: 'ORDER_INTAKE_DB', id: intakeHyperdriveId })
  }
  return { ...cfg, vars, hyperdrive }
}

export function assertCommerceConfig(cfg, mode, intakeHyperdriveId = '') {
  const bindings = (cfg?.hyperdrive ?? []).filter(item => item.binding === 'ORDER_INTAKE_DB')
  if (mode === 'off') return cfg?.vars?.PUBLIC_COMMERCE === undefined && bindings.length === 0
  return cfg?.vars?.PUBLIC_COMMERCE === 'on' && bindings.length === 1 && bindings[0].id === intakeHyperdriveId
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [path, mode, intakeId, publicId] = process.argv.slice(2)
  const next = applyCommerce(JSON.parse(readFileSync(path, 'utf8')), mode, intakeId, publicId)
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8')
  console.log(`M4_COMMERCE mode=${mode}`)
}
