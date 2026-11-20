# Production backup and recovery runbook (M5)

## What the scheduled backup contains
- `m4-production-backup.yml`, daily 19:41 UTC (02:41 Vietnam): `pg_dump --format=custom --no-owner` of `dpg_app` and `dpg_control`.
  Data, schema, RLS enable/force flags, policies and GRANTs are included. Ownership is not included. Age-encrypted to the
  repository recipient; `SHA256SUMS`, row counts and a schema/ACL manifest travel with it. Retention is 14 days (GitHub
  artifact). For a copy that outlives retention, download the encrypted artifact and keep it offline: it is useless without
  the age private key.
- Every run restores into a scratch PostgreSQL. The gate (`scripts/backup/m5-restore-gate.mjs`) hard-fails on a non-zero
  `pg_restore` exit, on any restore error, or on any row-count, schema-object or ACL difference.
- The scratch database stubs the referenced roles (NOLOGIN) and `auth.uid()/role()/jwt()`. These stubs exist **only** in
  the rehearsal. Never create them in a real Supabase project, which already provides `auth`.

## Credential
- Target state: `dpg_backup_reader`, created by `supabase/m5-production/001_backup_reader_role.sql`. It has LOGIN and
  BYPASSRLS (required because of FORCE RLS), USAGE and SELECT only on `dpg_app`/`dpg_control` tables, views and sequences,
  connection limit 2, `default_transaction_read_only = on`, no memberships and no write privileges. Each rehearsal proves
  that this exact file can dump everything and cannot write, and that it fails without BYPASSRLS.
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
