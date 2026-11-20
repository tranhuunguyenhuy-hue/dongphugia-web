# Đông Phú Gia V1

Operation and development of https://www.dongphugia.vn. **Start:** [AGENTS.md](AGENTS.md) · your assigned GitHub issue · [technical handbook](docs/PROJECT.md). Codex and Claude Code use the same policy. The M1–M5 restoration is complete; those issues are history.

Production and Staging run within the existing Cloudflare Worker `dongphugia-v1-public-production`; the named Preview is `staging`. Supabase `dongphugia-production` (`bonxyxluzlxfkdetryoo`) and `dongphugia-staging` (`uybumsnyqpwcidjxmfsv`) are distinct projects. Bunny is the media provider. GitHub Actions is the release authority. Infrastructure budget: $0 incremental.

- `apps/public/`: canonical Worker runtime; `src/app/(public)/` and `src/components/`: UI.
- `src/app/admin/`: canonical Admin; `apps/admin/` is not the target.
- Production build: `npm run build:m3-combined-worker` (combined Public+Admin Worker), after verifying Node 24.13.0/npm 11.6.2 and installing locked dependencies.
- `prisma/`, `db/`, `supabase/`: schema/migration source; do not apply blindly.
- [Release lane](docs/ops/v1-fast-release.md), [DB security](docs/deploy/supabase-runtime-security-boundary.md), [backup/recovery](docs/deploy/runtime-backup-recovery.md).

Merged is not deployed: check the live Worker deployment in Cloudflare (read-only) before claiming what is live. Do not deploy Production from an unrelated push.
