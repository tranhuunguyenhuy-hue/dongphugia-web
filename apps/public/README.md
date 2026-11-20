# Public Worker

`apps/public/worker.ts` is the canonical Public runtime. Preserve canonical UI from `src/app/(public)/` and `src/components/`; Production serves PostgreSQL via the dedicated read-only Hyperdrive and retains snapshot fallback. M1 and M2 accepted; M3 restores full legacy Admin in the same named fixed Preview `staging` with isolated TEST PostgreSQL.

For M3 use `npm run build:m3-combined-worker` and the reviewed M3 artifact/publisher. Do not substitute a root Next.js build, change Public routing, reuse Production writable data or deploy separate staging. See [AGENTS.md](../../AGENTS.md), [current checkpoint](../../docs/ops/project-current-state.md) and [fixed Preview runbook](../../docs/deploy/cloudflare-fixed-preview-production.md).
