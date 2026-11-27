# Production backup and recovery runbook (M5)

## What the scheduled backup contains
- `m4-production-backup.yml`, daily 19:41 UTC (02:41 Vietnam): `pg_dump --format=custom` of the reviewed scope in
  `scripts/backup/backup-scope.json`. Scope v2 (DPG-42) = `dpg_app`, `dpg_control`, `dpg_commerce` (orders, quotes, events). Bundles
  made before DPG-42 have no `scope.json`: they are **scope v1 = `dpg_app` + `dpg_control` only, `dpg_commerce` NOT covered**,
  and every restore of them prints `coverage=limited`.
  Data, schema, RLS enable/force flags, policies, GRANTs, default privileges and ownership are in the archive. Age-encrypted to
  the repository recipient; `SHA256SUMS`, `scope.json`, row counts, per-table content digests (`content.txt`), a
  schema/ACL/definition manifest (`objects.txt`) and ownership (`owners.txt`) travel with it. All of them and the dump read
  one exported snapshot (`scripts/backup/m4-backup-dump.sh`). Sequence values are non-transactional; the restore proves
  every owned sequence is at or beyond its restored column maximum instead.
- Before any dump the probe fails closed (`scripts/backup/m4-scope-preflight.sh`) if a `dpg_*` schema with tables is not in the
  scope (a future `dpg_core` must be added to `backup-scope.json` before its first row), or if the reader cannot read the whole
  scope or has any write path. Retention is 14 days (GitHub
  artifact). For a copy that outlives retention, download the encrypted artifact and keep it offline: it is useless without
  the age private key.
- Every run restores into a scratch PostgreSQL (`scripts/backup/m4-restore-rehearsal.sh`, usable for any bundle directory).
  The gate (`scripts/backup/m5-restore-gate.mjs`) hard-fails on a non-zero `pg_restore` exit, on any restore error, or on any
  row-count, schema-object or ACL difference; for v2 also on content-digest, definition-hash or ownership differences (a second,
  ownership-preserving restore keeps SECURITY DEFINER functions owned by `dpg_commerce_owner`). An unreviewed `scope.json`
  fails the restore.
- The scratch database stubs the referenced roles (NOLOGIN) and `auth.uid()/role()/jwt()`. These stubs exist **only** in
  the rehearsal. Never create them in a real Supabase project, which already provides `auth`.

## Credential
- Target state: `dpg_backup_reader`, created by `supabase/m5-production/001_backup_reader_role.sql`. It has LOGIN and
  BYPASSRLS (required because of FORCE RLS), USAGE and SELECT only on `dpg_app`/`dpg_control` tables, views and sequences,
  connection limit 2, `default_transaction_read_only = on`, no memberships and no write privileges. Each rehearsal proves
  that this exact file can dump everything and cannot write, and that it fails without BYPASSRLS.
- Scope v2 also needs `supabase/m5-production/002_backup_reader_commerce_scope.sql` (USAGE + SELECT on `dpg_commerce`
  tables/sequences, default SELECT for `dpg_commerce_owner`; no DML, no sequence USAGE/UPDATE, no EXECUTE). It is a reviewed
  artifact that runs only after a separate Owner GO and **before** the scope-v2 workflow is merged, otherwise the scheduled
  backup fails closed. Exact rollback: `002_backup_reader_commerce_scope_rollback.sql`. The rehearsal applies 002 in scratch only.
- Local proof without any hosted target: `bash scripts/backup/m4-commerce-coverage.local-test.sh` (synthetic data, throwaway key).
- The workflow uses `M4_BACKUP_READER_DATABASE_URL` when present, otherwise `M4_BACKUP_DATABASE_URL` (owner fallback).
  Remove the fallback secret only after a successful reader run.

## Recovery into Production (data loss only; Owner-approved)
1. Freeze writes: set `dpg_control.target_contract.production_writes_allowed = false` and add its CHECK back.
2. Pick the artifact. Verify `sha256sum --check SHA256SUMS`, decrypt with the age identity, and check `plaintext_dump_sha256`.
3. Roles must exist before the restore. They already do in the Production project; for a new project, re-apply
   `supabase/migrations` and `supabase/m4-production/001`/`002` first so roles, grants and RLS come from the reviewed
   migrations.
4. Restore the affected tables only (`pg_restore --data-only --table=…`), or the full schemas into an empty project, as the
   project owner. Use `--no-owner`, then reassign ownership to `dpg_migration` as in the migrations.
5. Compare against the artifact's `row-counts.txt` and `objects.txt` (run `scripts/backup/m5-manifest.sql`). Then run the
   Public and Admin smokes (`public-postgres-release-smoke.mjs`, `scripts/m4/admin-smoke.mjs`) and reopen writes.

Worker rollback (`wrangler rollback <version>`) is independent and never restores data.
