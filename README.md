# Đông Phú Gia V1

Restoration and operation of https://www.dongphugia.vn. **Start:** [AGENTS.md](AGENTS.md) · [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306) · [current checkpoint](docs/ops/project-current-state.md) · [technical handbook](docs/PROJECT.md). Codex and Claude Code use the same policy.

One milestone at a time: M1 Public Production → M2 fixed Public Preview → M3 legacy Admin on that Preview → M4 Admin Production → M5 audit. Read the current milestone issue, not archived tickets.

Production and Staging run within the existing Cloudflare Worker `dongphugia-v1-public-production`; the named Preview is `staging`. Supabase `dongphugia-production` (`bonxyxluzlxfkdetryoo`) and `dongphugia-staging` (`uybumsnyqpwcidjxmfsv`) are distinct projects. Bunny is the media provider. GitHub Actions is the release authority. Infrastructure budget: $0 incremental.

- `apps/public/`: canonical Worker runtime; `src/app/(public)/` and `src/components/`: UI.
- `src/app/admin/`: canonical legacy Admin; `apps/admin/` is not the target.
- M3 combined build: `npm run build:m3-combined-worker`, after verifying Node 24.13.0/npm 11.6.2 and installing locked dependencies according to current source.
- `prisma/`, `db/`, `supabase/`: schema/migration source; do not apply blindly.
- [Deployment](docs/deploy/cloudflare-fixed-preview-production.md), [DB security](docs/deploy/supabase-runtime-security-boundary.md), [backup/recovery](docs/deploy/runtime-backup-recovery.md).

The current checkpoint and Issue #309 contain the next step. Do not deploy Production from an unrelated push or restart completed work.
