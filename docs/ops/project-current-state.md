# Current checkpoint — M3 paused for quota

Last accepted Agent report: [Issue #309 / 6944468351](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309#issuecomment-6944468351), 2026-11-17 VN. Latest decisions: [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306) and [active M3 #309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309). Verify newer comments/current branch before action.

## Status

- M1 DONE / OWNER UAT PASS on 15 Nov, [#307](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/307); Production Public PostgreSQL, reported 5,362 listing products and 10 published Blog posts. Prior severe failures preserved in closed issue; do not claim root cause of every incident was proven.
- M2 DONE / OWNER UAT PASS on 17 Nov, [#308](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/308#issuecomment-6940948568); fixed Preview Public parity. Chromium acceptance passed; historical mobile WebKit 503 remains unresolved and automated rerun UNKNOWN.
- M3 ACTIVE / PAUSED. M4 and M5 queued. Owner may resume the same agent or hand off to Claude; no other lane.

## Source to resume

Branch `feat/m3-legacy-admin-preview`; Codex implementation checkpoint `867379b5f9797e441c91b5f10887accd2c6f6e1b`. The subsequent documentation-normalization commit must preserve this ancestor. Use branch HEAD, not main checkout for implementation. At checkpoint branch was pushed, clean, 10 commits ahead of main `00914b73fe6eed8dd78a8e8d8884bfa475c60870` and no PR. Local combined build/typecheck PASS at `6c03426c627855fbe4d4baf11d44c995f805c562`; focused regressions 26/26 PASS; Workerd local login/logout and Product/Blog persistence PASS on that artifact with harness fix `b4183ab`. Provenance preserved. WASM fixes `7ce0f72` / `9e6a136`, Blog raw writes `f20b5f6`. No hosted UAT or production change. These are Agent-reported prior local results, not tests on every later commit.

## Environment (last verified/reported, recheck before writes)

- Production Worker `dongphugia-v1-public-production`, source `87a0e4b6cd9997be8e195ce2bd9a6647608ee253`, deployment `ae4ddd11-df03-4462-8268-2af4d20b6084`, version `93b44508-afa2-42f8-b02b-acaeec7990f7`, domain https://www.dongphugia.vn. M3 must not change it.
- M2 fixed Preview `staging`: https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev, deployment `ab789db6-fc80-4c81-a884-fdcbe6e6bfcb`, source `00914b73fe6eed8dd78a8e8d8884bfa475c60870`, snapshot checkpoint `fe25b6966d912ffb360a06962fcafe642a1eab18`. No M3 deployed.
- Supabase Free organization `ymjvuwefhqqlymwlocqn`: Production `dongphugia-production` / `bonxyxluzlxfkdetryoo`; TEST `dongphugia-staging` / `uybumsnyqpwcidjxmfsv`. Both ACTIVE_HEALTHY in Singapore on 17 Nov; no hosted writes by M3.
- TEST read-only inventory: 20,166,323 bytes DB; actual disk/WAL usage UNKNOWN. `dpg_app` 68 tables, `dpg_v1` 36, `dpg_control` 3; prior rows/grants/RLS; active Edge `order-intake` v7. Dedicated `dpg_admin_m3_test` and `dpg_public_m3_test` absent. Internal target contract still contains former display label: not a reason to mutate. **Shared schema reuse and write isolation NOT proven.** No verified dedicated Hyperdrive IDs or Preview Bunny destination.
- Denylisted historical database ref `tlmgudfhsyzayiazuugf` is neither of the approved targets. Do not use it.

## Immediate next work (after Owner resume)

1. Confirm branch/head and latest #309 decision, preserve M2 recovery below; check Claude Cloud access to only required repo/TEST and GitHub Actions. Read-only identity/consumer assessment before any hosted action. Do not repeat local Workerd proof solely because agent changed.
2. Resolve TEST namespace/role compatibility without reset, separate Public/Admin least-privilege grants, public/synthetic seed only, verify existing Auth/Edge/Worker consumers. Never reuse Production table/credential. Verify zero incremental cost, isolated Preview Hyperdrive/secrets/Access, query redaction and Bunny media destination. If destructive reset or incompatible reuse is necessary, stop that mutation and report minimal Owner decision.
3. Finish one M3 integration PR, relevant CI, exact-source combined artifact and verified staging publisher; apply accepted gates, then deploy same fixed Preview only, no Production release.
4. Hosted Admin login/logout, role denials, module CRUD/read-back, Public freshness using same TEST data, Public/mobile regression, media isolation and rollback evidence. Report PASS/FAIL/UNKNOWN, Owner UAT. M4 only after eligible GO.

## M2 recovery — time-sensitive

[Artifact #14253475719](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/actions/runs/43918034548/artifacts/14253475719), 37,736,963 bytes, SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`; reported expiry 23 Nov 2026. Codex private workspace copy `/workspace/m2-recovery/m2-fixed-preview-00914b73.zip` verified by Agent; not necessarily accessible to Claude. Preserve/verifiably download to private storage available to Owner before expiry, never upload to public repo. See [M2 rollback runbook](../deploy/m2-fixed-preview-runbook.md). Re-upload is staging only; no automatic Production rollback.
