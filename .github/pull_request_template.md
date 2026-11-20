## Issue and lane

- Issue: #
- Lane (UI = Codex / Infra-DB-Ops-Docs = Claude): 
- Files I declared in the issue as touched:
- What changed (no unrelated features):

## Evidence

- Source SHA and changed paths:
- Focused tests + relevant build/typecheck:
- Functional results on localhost (screenshots for UI):
- Preview `staging` URL/deployment ID OR Production URL/Worker version, when applicable:
- Hosted PostgreSQL / read-path / CRUD evidence **if applicable**:
- PASS / FAIL / UNKNOWN (each acceptance criterion in the issue):
- Data/auth risk and rollback (Worker rollback ≠ SQL rollback):

## Scope and release

- [ ] Diff matches only the assigned issue; no unapproved feature or infrastructure cleanup
- [ ] Verified correct Production vs TEST target; no credentials, PII or raw logs committed
- [ ] No destructive DB operation, no unapproved cost, no CI bypass
- [ ] Merged ≠ deployed: no Production release without explicit Owner approval, an exact approved SHA and the documented release lane
- [ ] Exact diff and file list self-reviewed; required CI PASS on the exact head (SHA recorded)
- [ ] Owner UAT (runtime/UI, via fixed staging) and explicit Production approval recorded where required

**PR/CI success alone does not equal runtime acceptance.** See `AGENTS.md`.
