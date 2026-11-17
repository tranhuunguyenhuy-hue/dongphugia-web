# Backup role bootstrap constraints — reference for recovered DB

The old empty-target/two-migration bootstrap is **not the current execution path**. Do not dispatch it for M3 or M4 just because the file/workflow exists. The recovered Production project `dongphugia-production` (`bonxyxluzlxfkdetryoo`) already has data and roles. For current backup planning use [existing-state-backup.md](existing-state-backup.md) and verify schema/ACLs, exact target, approval and a recoverable backup.

The retained bootstrap source and tests protect exactly `20260828183000_leo542_backup_role_prerequisite.sql`, `20260828183200_leo540_backup_coverage_prerequisite.sql` and `dpg_control.runtime_migration_ledger`. It uses `BACKUP-BOOTSTRAP-EXECUTE`, an exact Owner approval and comment ID and nonce; a claim can never be reused; workflow re-runs are rejected. It scans all direct ACL catalogs and does not create `dpg_backup_login`, grant credentials or activate Phase 2. Preserve these protections even if future recovery uses an alternative. No permission to rerun this obsolete bootstrap is granted.

If the separately approved read-only Management preflight is relevant, its scope is Organization Settings (Read) and Organization Projects (Read); it does not need account-wide project access or database permissions. It validates a `projects` array and `pagination` object. The preflight never reads a database URL, connects to Postgres, consumes a bootstrap approval, or applies migrations. Do not expose secrets or loosen exact-target checks.

A fresh encrypted backup, checksum/private-copy verification, and restore rehearsal are required before approved live schema/data work. Use the [current backup reference](runtime-backup-recovery.md); confirm M4 authorization separately.
