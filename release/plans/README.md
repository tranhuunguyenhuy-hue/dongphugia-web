# Release plans (#511 Full Release Pipeline)

A **plan** releases what the Worker-only lane may not: SQL/schema/data changes, a deployable Supabase function, Worker bindings.
It is reviewed in a PR like code; lanes take only `plan_id`, `step_id` and the plan digest (never SQL text, a path or a URL).
Pilot example: [`scripts/release/fixtures/repo/release/plans/pilot-expand-backfill`](../../scripts/release/fixtures/repo/release/plans/pilot-expand-backfill/plan.json).

## Shape — `release/plans/<plan-id>/plan.json` + the SQL files it names (nothing else except a README.md)
- `steps[]`: `sql` (forward SQL, one transaction), `backfill` (idempotent single-statement batch, repeated until it changes
  0 rows, `max_batches`), `function` (`admin-api`), `worker` (at most one; `bindings: true` when a wrangler binding changes).
- Every SQL step has a read-only `precheck` and `postcheck` returning one row with boolean `ok`, and a `rollback` (`sql` file
  or `forward-fix`). `depends_on` forms the DAG. `destructive` / `privileged` must be declared: the linter refuses undeclared
  DROP/TRUNCATE/DELETE/type changes or GRANT/ROLE/POLICY/RLS changes; transaction control and CONCURRENTLY are refused.
- Expand → migrate → contract: if the Worker depends on SQL steps, `compatibility.old_worker_with_new_schema` must be `true`;
  otherwise write a separate maintenance/cutover plan. Contract (destructive) steps come only after the Worker.
- `covers`: function / binding sources and SQL-lane tooling released by this plan. Every full-scope file of the release must be
  in the plan folder or in `covers` (one plan per release).
- Digest: `node scripts/release/plan.mjs digest <plan-id>` (changes with any byte of the plan or its SQL).

## Order — each step on its existing lane; gates refuse anything out of order
1. **TEST chain** on the exact `main` SHA: `m3-admin-api-deploy.yml` `release-apply` per SQL step (needs the Owner-provisioned
   TEST credential `M3_TEST_SQL_DATABASE_URL`), `deploy` with `plan_id`/`step_id` for the function step,
   `v1-fixed-preview.yml` `publish-m3` with `plan_id`/`plan_digest`, then `lock-uat` → **Owner UAT**.
2. **Production read-only preflight**: `m6-production-sql-apply.yml` `release-check` (every SQL step: ready / applied /
   pending-dependency; drift fails) and the automatic M4 verify. A fresh `m4-production-backup.yml` (< 2 h) before SQL steps.
3. **Owner GO** on the release issue, one directive per line: `GO-PROD <sha>` · `PLAN <plan-id> <digest>` ·
   `PREFLIGHT-RUN <release-check run id>` · `LANE full` · `UAT PASS <sha>` (or `UAT-WAIVER <sha> <reason>`). Destructive or
   privileged step: a **separate** comment `STEP-GO <sha> <plan-id> <step-id>`; SQL rollback: separate `ROLLBACK-GO <sha> <plan-id> <step-id>`.
4. **Production steps in DAG order**: M6 `release-apply` per SQL step (`go_comment_id`, `go_prod`), the function lane `deploy`
   with plan inputs, then M4 `publish` (it requires every Worker dependency applied in Production). Contract steps after it.

**Stop rules**: a failed or unknown step blocks everything downstream; re-run only after reconciling (`release-check` shows ledger
and checks; re-running an applied step is a no-op; a changed step after apply is a ledger conflict). `main` must stay at the
candidate SHA for the whole release (a newer merge = new candidate, new GO). Worker rollback ≠ SQL rollback; restoring data from a
backup is never automatic (isolated rehearsal only).
