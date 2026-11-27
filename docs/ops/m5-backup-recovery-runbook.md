# Production backup and recovery runbook (M5)

## What the scheduled backup contains
- `m4-production-backup.yml`, daily 19:41 UTC (02:41 Vietnam): `pg_dump --format=custom` of the reviewed scope in
  `scripts/backup/backup-scope.json`. Scope v2 (DPG-42) = `dpg_app`, `dpg_control`, `dpg_commerce` (orders, quotes, events). Bundles
  made before DPG-42 have no `scope.json`: they are **scope v1 = `dpg_app` + `dpg_control` only, `dpg_commerce` NOT covered**,
  and every restore of them prints `coverage=limited`.
  Data, schema, RLS enable/force flags, policies, GRANTs, default privileges and ownership are in the archive. Age-encrypted to
  the repository recipient; `SHA256SUMS`, `scope.json`, row counts, the schema/ACL/definition manifest (`objects.txt`),
  ownership (`owners.txt`), the per-object security inventory (`security.txt`: table/column/function/schema/default ACL with
  grantor and grant option, RLS enable/force, column defaults, sequence and view definitions, extensions) and the referenced
  roles with attributes and memberships (`roles.txt`) travel with it. Per-table content digests are encrypted too
  (`content.txt.age`). Everything, including `pg_dump --snapshot`, reads one exported snapshot
  (`scripts/backup/m4-backup-dump.sh`); after the dump the schema set is re-checked live and the archive's TABLE DATA
  inventory must equal the row-count inventory. Sequence values are non-transactional; the restore proves every owned
  sequence's next value is safe (above its restored column maximum) instead; descending/cycling sequences fail as unsupported.
- Before any dump the probe fails closed (`scripts/backup/m4-scope-preflight.sh`) if a `dpg_*` schema with tables is not in the
  scope (a future `dpg_core` must be added to `backup-scope.json` before its first row), or unless the connection is exactly
  `dpg_backup_reader` with the 001 attributes and no memberships, can read the whole scope, and has no write, CREATE,
  sequence USAGE/UPDATE, grant-option or SECURITY DEFINER EXECUTE path. There is **no owner-credential PASS** for scope v2.
  Retention is 14 days (GitHub artifact). For a copy that outlives retention, download the encrypted artifact and keep it
  offline: it is useless without the age private key.
- Every run restores into a scratch PostgreSQL (`scripts/backup/m4-restore-rehearsal.sh`, usable for any bundle directory;
  labelled container, no network). For v2 the single gate is one **ownership-preserving** restore into database `restored`:
  roles are bootstrapped from `roles.txt` (attributes and memberships), scratch platform prerequisites
  (`scripts/backup/scratch-platform-prereqs.sql`) are applied first, then `pg_restore --exit-on-error`. The gate
  (`scripts/backup/m5-restore-gate.mjs`) hard-fails on any restore error or on any difference in row counts, content digests,
  schema objects, definitions, ACLs, ownership/SECURITY DEFINER, the security inventory or roles. It prints only fixed error
  classes and object labels, never values. An unreviewed or tampered `scope.json` fails the restore.
- The scratch platform stubs (`auth` schema, `auth.uid()/role()/jwt()`) and bootstrapped roles exist **only** in the
  rehearsal. Never create them in a real Supabase project, which already provides `auth`.
- **M6 caveat:** the M6 release gate recognises a backup run by job and step name, so it also accepts a scope-v1 run. Until
  DPG-42 is rolled out and a scope-v2 run is independently verified, a v1 bundle is **not** commerce recovery evidence: any
  release that depends on `dpg_commerce` recovery must cite an approved scope-v2 run (`scope_version=2`, `coverage=full`).

## Credential
- Target state: `dpg_backup_reader`, created by `supabase/m5-production/001_backup_reader_role.sql`. It has LOGIN and
  BYPASSRLS (required because of FORCE RLS), USAGE and SELECT only on `dpg_app`/`dpg_control` tables, views and sequences,
  connection limit 2, `default_transaction_read_only = on`, no memberships and no write privileges. Each rehearsal proves
  that this exact file can dump everything and cannot write, and that it fails without BYPASSRLS.
- Scope v2 also needs `supabase/m5-production/002_backup_reader_commerce_scope.sql` (USAGE + SELECT on `dpg_commerce`
  tables/sequences, default SELECT for `dpg_commerce_owner`; no DML, no sequence USAGE/UPDATE, no EXECUTE). It is a reviewed
  artifact that runs only after a separate Owner GO and **before** the scope-v2 workflow is merged, otherwise the scheduled
  backup fails closed. Exact rollback: `002_backup_reader_commerce_scope_rollback.sql`. The rehearsal applies 002 in scratch only.
- Local proof without any hosted target: `bash scripts/backup/m4-commerce-coverage.local-test.sh` (synthetic data, throwaway key);
  digest/dump timing on production-shaped synthetic volume: `bash scripts/backup/m4-digest-perf.local-test.sh`.
- 002 is applied with `psql -X -v ON_ERROR_STOP=1 -v target_ref=bonxyxluzlxfkdetryoo -v approved_sha=<reviewed sha>`. It
  asserts target, contract, reader attributes, memberships and ownership before granting, and verifies the exact reader ACL,
  unchanged non-reader ACLs and memberships in the same transaction; it prints `DPG42_GRANT_VERIFIED`. The rollback refuses
  if the reader's privileges differ from what 002 granted (intervening change: review manually).
- The workflow still selects `M4_BACKUP_READER_DATABASE_URL` when present, otherwise `M4_BACKUP_DATABASE_URL`; with scope v2
  the owner fallback fails at the preflight. Remove the fallback secret only after a successful reader run.

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
