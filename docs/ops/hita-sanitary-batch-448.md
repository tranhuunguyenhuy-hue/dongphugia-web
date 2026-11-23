# #448 — Hita sanitary price batch (TEST / Fixed Staging only)

Scope: category `thiet-bi-ve-sinh` of the isolated TEST project. Production is never touched by these tools
(the importer refuses any origin except the Fixed Staging Worker). Hita EXACT SKU is the only source of the three canonical
prices; legacy DPG prices are never a fallback.

## Pieces (`scripts/hita-price-audit/`)
| File | Role |
|---|---|
| `inventory/test-sanitary-20261123.json` | 136 SKUs of the TEST sanitary category (from the Admin API, matches SQL: 136 / 132 active). 64 are synthetic fixtures (`FX-*`, `UAT-*`), 72 real (20 pilot + 52 not yet loaded). |
| `batch.mts` + `crawl-engine.mts` | Polite crawler (1 request/s, honest User-Agent), checkpoint + resume + TTL. Stops the run on 401/403/429/503 or a Cloudflare challenge; never retries around a block. Emits `prices.json`, `exceptions.json/csv`. |
| `pricing-policy.mts` | EXACT → 3 values (consistency-checked, else QUARANTINE). CONTACT/DISCONTINUED/NOT_FOUND/AMBIGUOUS → all NULL ("Liên hệ báo giá", SKU never hidden/deleted). BLOCKED/UNKNOWN → no write. |
| `import-prices.mts` + `import-core.mts` | Writes only the 3 columns through the audited Admin API with the optimistic version lock; dry-run by default; ledger (before/after); read-back after each write; fail-fast; idempotent; rollback from the ledger. |

## Run (from a machine where Hita is reachable)
```
npx tsx scripts/hita-price-audit/batch.mts --inventory scripts/hita-price-audit/inventory/test-sanitary-20261123.json --output out/hita
# resume after a stop: run the same command again (fresh terminal results are reused for --ttl-hours, default 6)
```
Import (needs `CF_ACCESS_CLIENT_ID/SECRET` and `DPG_E2E_EMAIL/PASSWORD` in the environment; never commit them):
```
npx tsx scripts/hita-price-audit/import-prices.mts --inventory <inventory.json> --results out/hita/prices.json                      # dry-run
npx tsx scripts/hita-price-audit/import-prices.mts ... --mode apply --ledger out/ledger.jsonl --batch-size 10 [--max-writes 10]    # write
npx tsx scripts/hita-price-audit/import-prices.mts ... --mode rollback --ledger out/ledger.jsonl                                   # undo
```
Re-crawl immediately before importing (prices and voucher deadlines move). A rollback skips any product edited after the import.

## Exceptions
`exceptions.csv/json` columns: `dpg_id, sku, category, url, timestamp_utc, reason` (NOT_FOUND / AMBIGUOUS / CONTACT /
DISCONTINUED / BLOCKED / UNKNOWN / SYNTHETIC_FIXTURE, or an EXACT row's voucher exception). They are the input of backlog #451; nothing is deleted or hidden.
