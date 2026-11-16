# M2 fixed Preview operation

Authority: Issue #308, Owner Gate A comment 6896587821. Target is **only named `staging` inside `dongphugia-v1-public-production`**, account `d54f3402b9d112ab64d6135e0e3f1fb1`. The legacy `dpg-staging` Worker is not a target.

Run **M2 fixed Preview** manually on reviewed `main`, with its exact `approved_source_sha`. `publish` captures once, builds once, preflights that artifact, then publishes it. `prepare-preview` performs the same local acceptance without publication; `capture-snapshot` and `verify-read-access` are read-only diagnostic modes. Never use the Production release workflow to publish this Preview.

The capture job uses `M2_PUBLIC_READ_DATABASE_URL` for the dedicated `dpg_m2_snapshot_read` login and the existing `DIRECT_TARGET_CA` in `catalogue-direct-migration`. The old `DIRECT_TARGET_READ_DATABASE_URL` uses `dpg_direct_read`: its 27-table catalogue boundary excludes Blog and must remain unchanged. The M2 reader requires exactly the 14 Public tables, active RLS, READ ONLY, no bypass/elevated role or writes, and verified client TLS. The publisher uses the existing non-Production `cloudflare-staging` credential environment. Its label does not select a Worker. Only the explicit Worker name and `--name staging` select the runtime. No DB credential, Hyperdrive, service binding or secret enters the Preview. Missing privileges fail closed; do not replace the SELECT role with an admin/service role.

If the M2 reader secret is absent, provision the dedicated `dpg_m2_snapshot_read` login on V1 project `bonxyxluzlxfkdetryoo` with only CONNECT and SELECT on the 14 `dpg_app` Public tables listed in `scripts/app-foundation/m2-public-read-connection.mjs`. Keep it non-superuser, non-owner, non-inheriting, without role/database creation, replication, `BYPASSRLS`, membership, DDL, sequence or write privileges; require RLS and default read-only transactions. Do not alter `dpg_public_catalogue`, its grants/password, Hyperdrive or Production secrets. Store the resulting connection only in `catalogue-direct-migration` → `M2_PUBLIC_READ_DATABASE_URL`; use the V1 session pooler, port 5432/database postgres, username `dpg_m2_snapshot_read.bonxyxluzlxfkdetryoo`, exact pooler host from the project's Connect panel, URL-encode the password and omit URL query parameters (the driver verifies CA/hostname). Keep the value out of chat, Issues, source and logs. Then run `verify-read-access` against the exact current main SHA and inspect its sanitized evidence before M2 publication; do not rerun an older source.

Access app `8f9650b6-faf3-4673-8e1c-70f297648ada` targets only `preview_worker` `e50647603f1b4e73bed14e2e79c15d26`, covering stable and immutable URLs. Owner email allowlist is in #308. CI uses a separate one-hour service token and app-scoped policy, with cleanup. Production domains and Production workers.dev stay public. Preview vars use `APP_ENV=staging`, `PREVIEW_NOINDEX=true`, frozen snapshot mode and its checkpoint. Code SHA, data checkpoint, capture timestamp and actual Production source are separate identities.

Production config keeps `preview_urls:true`; the existing Production identity gate rejects a packaged config which would disable it. Temporary smoke configs intentionally disable Preview URLs. If a release is active or the Production state changes unexpectedly, stop publication/mutations and record the result; never roll back Production automatically.

## Evidence and recovery

Retain the successful run's `m2-fixed-preview-<sha>` artifact plus its GitHub artifact digest/run ID, `m2-artifact.json`, `snapshot-lock.json`, `m2-preflight.json`, local evidence and hosted evidence. The artifact includes the exact Worker modules, Public assets, explicit config and hashes. Gate B requires actual deployment IDs/URLs, UAT and Owner + ChatGPT acceptance; neither an empty Preview record nor a 200 health response is acceptance.

If local preflight fails after assembly, retain the same isolated candidate for local reproduction against its captured data. It has no PASS preflight record and cannot be published: the publish job still requires successful preparation and validates the PASS record itself.

For a failed first candidate with no previously accepted staging version, leave Access protection in place, report recovery **UNKNOWN/not rehearsed**, and preserve evidence. Do not claim rollback PASS or restore Production.

After a previously accepted staging artifact exists, the recovery path is re-uploading that artifact to the same named Preview:

1. Select the recorded **accepted** artifact/run/source/checkpoint and verify its GitHub digest and the Worker/assets/config hashes in `m2-artifact.json`. Reject changed, incomplete, symlinked or untrusted files; inspect config isolation with `validateM2PreviewConfig` from the publisher module.
2. In the existing protected non-Production publisher context, verify V1 identity, current Production deployment/traffic/bindings/health, no active Production release, and Preview-only Access. Keep credential values in the secret store, never in command arguments or logs.
3. Use the locked CLI from the reviewed repo, pointing to the accepted artifact directory. This is a **Preview re-upload**, not a Production rollback:

```bash
GITHUB_SHA="$accepted_source_sha" node tools/m2-preview/node_modules/wrangler/bin/wrangler.js preview \
  --worker-name dongphugia-v1-public-production --name staging \
  --config "$accepted_artifact/wrangler.fixed-preview.json" --ignore-base-config \
  --tag "$accepted_source_sha" --message "Restore accepted M2 staging artifact" --json
```

4. Record the **new** Preview deployment ID and actual URLs; check bindings, source/checkpoint, authorized and anonymous access, real navigation/data/media and unchanged Production. The immutable URL changes; the staging URL remains fixed. Restoration of older data is explicit snapshot staleness, not a database rollback.

The normal publisher accepts the current main artifact only. Older-artifact recovery above is an explicit operator procedure, not an automatic workflow mode. A recovery rehearsal remains UNKNOWN until actually performed and recorded. M3/Admin/TEST DB and Production promotion are outside M2.
