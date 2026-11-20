# Đông Phú Gia V1 — shared instructions for Codex and Claude Code

This is the only repository agent policy; `CLAUDE.md` imports it. **Status: POST-M5 / ACTIVE DEVELOPMENT.** The V1 restoration (M1–M5, Master [#306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306)) is complete and Owner-accepted; those issues are **history, not instructions**.

## Read in this order — nothing else by default
1. This file.
2. **The GitHub issue the Owner assigned to you**, including its latest comments. The latest explicit Owner/Tech Lead direction in that issue prevails over anything dated in the repository.
3. **`main` and the open PRs**: `git fetch`, compare with `main`, read the PR and its CI. GitHub Issues, PRs and Actions are the only progress record; there is no hand-maintained status file.
4. **Live infrastructure, only when the task needs it**: verify read-only at the source (Cloudflare Worker deployments, Supabase, Bunny), never from memory or an old comment. Merged is not deployed.
5. Only the runbook the task needs, via the [technical handbook](docs/PROJECT.md). Do not load the whole docs tree or old conversation history.

## Who does what
- **Owner**: states needs, decides, and holds final UAT and release authority, including approval of any Production deploy. Not required to know technical detail.
- **ChatGPT = Tech Lead / coordinator**: plans issues (following `.github/ISSUE_TEMPLATE/agent-task.md`), coordinates the agents, and reviews agent outcomes and PRs, recording LGTM / CHANGES REQUESTED in the issue. Anything an agent needs (images, URLs, decisions) must be in the issue or repo, never only in a chat.
- **Claude Code** = implementation agent for the *Infra / Database / Operations / Documentation* lane. It may analyse independently and self-review, but it cannot accept its own PR as Tech Lead.
- **Codex** = implementation agent for the *UI / Frontend* lane (`src/app/(public)/`, `src/components/`, UI tests).
- A task outside your lane needs explicit Owner authorisation in the issue. Never start another agent or thread without Owner direction.

## Authority and scope
- Work only on the issue assigned to you. Open issues and PRs are **not** authorised just because they exist.
- No unapproved features, new architecture, new commerce/checkout, crawler, AWS/Coolify, separate Admin site or infrastructure cleanup/decommissioning. Old source, scripts and workflows may be needed for recovery but carry no work authority.
- A merge, local test, HTTP 200 or deployment record is not acceptance. Record **PASS / FAIL / UNKNOWN** per criterion; the Owner accepts UI and live behaviour.

## Environment and source boundaries
- Source of truth: canonical Public UI `src/app/(public)/` and `src/components/`; deployed Public handler `apps/public/worker.ts`; canonical Admin `src/app/admin/`. Do not extend `apps/admin/` or replace the Public handler. The Production artifact is the combined Public+Admin Worker (see handbook), not root Next.js.
- Cloudflare account `d54f3402b9d112ab64d6135e0e3f1fb1`; one Worker `dongphugia-v1-public-production`; Production `www.dongphugia.vn` and `dongphugia.vn`. Fixed Preview `staging` inside that Worker: https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev. No per-branch Preview, separate staging Worker or new domain. Never use Production `wrangler deploy` for staging.
- Supabase Free organization Đông Phú Gia Runtime: Production `dongphugia-production` ref `bonxyxluzlxfkdetryoo`; Staging/TEST `dongphugia-staging` ref `uybumsnyqpwcidjxmfsv`. Verify immutable ref, schema/roles/grants, consumers and quota before any mutation; healthy/renamed does not prove isolation. Never touch V2 or other projects. Historical ref `tlmgudfhsyzayiazuugf` is a deleted project: do not use.
- Keep Public read-only vs Admin least-privilege roles/Hyperdrive, separate Production vs TEST secrets, Access plus app Auth on Preview, noindex, redacted auth logs, isolated media. Only public/synthetic data in staging.
- Preserve Product/SKU identity, slugs, variants, price provenance, Blog/media and UI. Unknown price = `Liên hệ báo giá`; verified historical price is labelled as reference. Never invent data or stock. Preserve migration ledgers, backups/checksums, rollback and security tests.
- **Never** put secrets, `.env`, private dumps, PII or raw logs in GitHub or chat.
- No destructive data loss or reset. Incremental infrastructure budget **$0**: no paid branching, plan upgrades, VPS or additional paid resource. New costs, destructive changes, DNS/zone/credential changes and Production deploys need explicit Owner approval.

## Workflow
1. **Start**: `git status --short --branch`, fetch, compare with `main`, read the issue's latest comments. Do not discard WIP or restart finished work. If a cloud app created its own branch, keep the branch ancestry and name the continuation branch.
2. **Branch/PR**: one branch and one PR per issue, named `codex/<issue>-<slug>` or `claude/<issue>-<slug>`. Declare in the issue which files you will touch so parallel lanes do not collide. Rebase or merge `main` before opening the PR.
3. **Verify**: run affected tests, typecheck/build and, when applicable, a real hosted smoke. Node 24.13.0, npm 11.6.2, committed lockfiles. Required CI status: `quality` (`.github/workflows/quality.yml`); the docs-only classifier is not a bypass for source changes. On repeated failure change approach and report the exact blocker. Do independent safe work instead of waiting on CI.
4. **Review and accept**: the Tech Lead (ChatGPT) reviews the PR; the Owner gives final UAT of UI/live behaviour. An implementing agent never accepts its own PR. PR/CI success or a deployment record alone is not runtime acceptance.
5. **Release**: Production deploys are **serialized** (one at a time, Owner approval, exact reviewed SHA) because Public and Admin share one Worker. Use only the reviewed lane in the handbook; never publish a stale or Public-only artifact over the Admin; do not dispatch unrelated legacy workflows; do not bypass identity gates or change protected settings to turn CI green. If an actor or scoped credential is missing, state the exact Owner action.
6. **Before hosted writes** confirm target, backup + restore/rollback, schema/permissions, free quota, non-sensitive seed and existing consumers. Worker rollback and PostgreSQL rollback are separate; Worker rollback does not undo SQL.
7. **Handoff** (before stopping or switching agent): commit, push, verify the SHA, then comment in the issue: branch/SHA, completed work, PASS/FAIL/UNKNOWN, next concrete command or blocker, deployment/version if applicable, backup status, Owner action. Never claim local-only state transferred. No merge or deploy solely for handoff. Keep reports short.
