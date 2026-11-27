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
  roles are bootstrapped from `roles.txt` (attributes, memberships, role-level settings), scratch platform prerequisites
  (`scripts/backup/scratch-platform-prereqs.sql`) are applied first, then `pg_restore --exit-on-error`. The gate
  (`scripts/backup/m5-restore-gate.mjs`) hard-fails on any restore error or on any difference in row counts, content digests,
  schema objects, definitions, ACLs, ownership/SECURITY DEFINER, the security inventory or roles. It prints only fixed error
  classes and object labels, never values. An unreviewed or tampered `scope.json` fails the restore.
- **Role recovery (what `roles.txt` covers).** Required set = roles the scope references (owners, ACL grantees/grantors, policy and
  default-ACL roles) + the reviewed runtime roles in `backup-scope.json` (v2: `dpg_order_intake_login`) + the closure of both over
  memberships in either direction restricted to this project's `dpg_*` roles, so a login that is only a *member* of a group role
  (the intake login in `dpg_commerce_intake`, provisioned by `scripts/m6/production-sql-apply.mjs provisionIntake`) is included even
  though it is not an ACL grantee. Recorded per role: attributes (LOGIN, INHERIT, CREATEROLE, BYPASSRLS, connection limit, ...),
  memberships with ADMIN/INHERIT/SET, and global role settings (`statement_timeout`, `idle_in_transaction_session_timeout`, ...).
  The restore refuses a bundle that does not record each reviewed runtime role, records it inconsistently, or whose login/membership
  policy differs from the reviewed one (login, NOINHERIT, member of `dpg_commerce_intake` with SET and without INHERIT/ADMIN, no
  CREATEROLE/BYPASSRLS/SUPERUSER); a role recorded `absent` must leave no trace. After the restore the real login -> group path is
  exercised (direct table read and EXECUTE without `SET ROLE` are denied with SQLSTATE 42501, `SET ROLE dpg_commerce_intake` works,
  the owner role is unreachable). **Passwords are never backed up**: a login recovered from a bundle has no usable password and is
  re-provisioned through the existing approved provisioning (new password + Hyperdrive). **Not covered (documented platform
  prerequisites, to be verified separately):** roles outside `dpg_*` (`postgres`, `authenticator`, `supabase_*`, `anon`,
  `authenticated`, `service_role`) and their memberships, per-database role settings, Hyperdrive/Cloudflare configuration, and
  any `dpg_*` login that is neither an ACL role, a reviewed runtime role nor linked to one by membership.
- Every raw tool log and decrypted/derived digest file in the rehearsal workspace (`restore.log`, `bootstrap.err`, `prereq.err`,
  `restored-content.txt`, `content.txt`, `production.dump`, `seq-safety.txt`, `toc.txt`) is shredded on every exit path, success
  or failure; failures print only a fixed reason class. The backup job uploads the artifact only after the dump step succeeds; the
  rehearsal job uploads nothing.
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
- **Verify the execution target externally before any GO** (read-only, separately authorized; the variables passed to 002 are a
  last-line guard, **not evidence**): (1) project ref and URL confirmed from the platform tooling (not from the file or the
  caller) as `bonxyxluzlxfkdetryoo`; (2) `sha256sum` of the exact `002_backup_reader_commerce_scope.sql` and its rollback equals
  the reviewed checksums recorded in the GO package, and the file comes from the approved SHA; (3) the executing role's actual
  privileges (owner membership of `dpg_commerce_owner`, ADMIN option) and the owner of every `dpg_commerce` object; (4) the
  platform prerequisites and the real role inventory reconciled against `roles.txt` expectations. This reconciliation is **not**
  done by this patch: it needs its own read-only precheck after TL review.
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
