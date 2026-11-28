# test-pilot-sandbox (TEST only, DPG-47 03.9 pilot preparation)
Reviewed plan for the existing #511 TEST lane (`m3-admin-api-deploy.yml`, `operation=release-check|release-apply`). `test-` id + `test_only`: runnable only on the TEST project, never Production scope.
- **Step `create-sandbox` (S2, privileged, additive):** schema `dpg_pilot`; roles `dpg_pilot_rw` and `dpg_pilot_ro` (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT; USAGE on `dpg_pilot` only); tables `dpg_pilot.pilot_object` (registry) and `dpg_pilot.pilot_baseline` (catalog fingerprint of everything else).
- **Never:** data load (S3), function, default privilege, grant on a pre-existing object, PUBLIC exposure, login, secret.
- **Precheck:** single synthetic target contract (`production_*` false), no `dpg_pilot*` schema/role, executor may create roles, size + 2 MiB + 15 MiB reserve <= min(350 MiB, contract ceiling).
- **Postcheck:** roles/ACL/ownership exactly as above AND the fingerprint of every non-pilot object equals the baseline taken in the same transaction.
- **Rollback (S4, separate approval, destructive):** removes only registered pilot objects; refuses on unregistered relations/functions/roles, foreign dependents (views, FKs, triggers, policies) or role dependencies outside the sandbox.
- Disk usage is not observable from SQL; the 70 % disk stop is an Owner-dashboard fact recorded outside this plan.
