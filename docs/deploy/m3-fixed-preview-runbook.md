# M3 fixed Preview — publish, evidence and recovery

Scope: combined Public+Admin Worker into **only** named Preview `staging` of `dongphugia-v1-public-production`. Never Production deploy, traffic, DNS, bindings or secrets. Authority: Issue #309.

## Publish (main only)
1. Tech Lead reviews and merges PR #356 (source merge is not acceptance and triggers no deploy: only `quality.yml` runs on push to `main`).
2. Run workflow **M2 fixed Preview** (`v1-fixed-preview.yml`) manually on `main` with the exact merged `approved_source_sha`: `prepare-m3` builds `npm run build:m3-combined-worker`, assembles the artifact with TEST Hyperdrives (`9f81135c…` Admin, `948e4215…` Public; Production `905f5791…` excluded) and the approved media target; `publish-m3` re-validates the artifact and publishes with `wrangler preview --name staging`.
3. Environment `cloudflare-staging` supplies variables `M3_PREVIEW_MEDIA_ZONE_ID`, `M3_PRODUCTION_MEDIA_ZONE_ID` (=1454608), `M3_PREVIEW_MEDIA_ZONE_NAME` (=`dpg-media-staging`), `M3_PREVIEW_MEDIA_STORAGE_HOSTNAME` (=`sg.storage.bunnycdn.com`), `M3_PREVIEW_MEDIA_CDN_HOSTNAME` (=`dpg-media-staging*.b-cdn.net`) and secret `M3_PREVIEW_BUNNY_STORAGE_API_KEY` (zone password of the staging zone only). Any other value fails validation before a secret is used.

## Evidence
`m3-fixed-preview-<sha>` (30 days) and `m3-hosted-evidence-<sha>`: deployment/preview IDs, Production before/after state, binding readback (Hyperdrive IDs asserted when exposed), unauthenticated Admin denial and forged-cookie denial.

## Recovery
- **Code (Preview only):** re-upload the preserved accepted M2 artifact `m2-fixed-preview-00914b73…` (run 43918034548; SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`; Owner holds a durable copy, expiry of the GitHub copy 2026-11-23) to the same Preview per [M2 runbook](m2-fixed-preview-runbook.md). This is not a Production rollback.
- **TEST database:** `supabase/m3-test/002_m3_test_narrow_grants_rollback.sql` restores the exact 001 baseline; `001_m3_test_roles_rollback.sql` removes the M3 roles/policies. Both are guarded by the TEST signature plus operator verification of project ref `uybumsnyqpwcidjxmfsv` via a trusted tool. 002 was applied through the Supabase SQL Editor, so Supabase's migration ledger has no entry; these files are the ledger.
- Worker code rollback and PostgreSQL rollback are separate.
