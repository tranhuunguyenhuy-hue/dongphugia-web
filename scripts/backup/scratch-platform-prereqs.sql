-- DPG-42: Supabase platform objects that restored policies/functions may reference, created in the scratch target database
-- BEFORE pg_restore (repo evidence: 36 policy uses of auth.uid(), auth.jwt()). SCRATCH ONLY: a real recovery restores into a
-- Supabase project that already provides the auth schema; never create these stubs there (docs/ops/m5-backup-recovery-runbook.md).
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
create or replace function auth.role() returns text language sql stable as 'select null::text';
create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
