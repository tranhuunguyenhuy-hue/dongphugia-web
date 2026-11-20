#!/usr/bin/env bash
# Owner-run alternative to the m3-admin-api-deploy workflow. TEST project only.
# usage: M3_ADMIN_API_HMAC_SECRET=$(openssl rand -hex 32) ./scripts/m3/deploy-admin-api-test.sh   (after `supabase login`)
set -euo pipefail
REF=uybumsnyqpwcidjxmfsv
test "$REF" != "bonxyxluzlxfkdetryoo"
test "${#M3_ADMIN_API_HMAC_SECRET}" -ge 32 || { echo 'set M3_ADMIN_API_HMAC_SECRET (>=32 chars)'; exit 1; }
cd "$(dirname "$0")/../.."
supabase functions deploy admin-api --project-ref "$REF" --no-verify-jwt --use-api --yes
supabase secrets set --yes --project-ref "$REF" \
  "ADMIN_API_HMAC_SECRET=$M3_ADMIN_API_HMAC_SECRET" \
  "ADMIN_API_ALLOWED_ORIGIN=https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev" \
  "ADMIN_API_MEDIA_HOSTS=dpg-media-staging.b-cdn.net"
echo "Also store the SAME value as GitHub repository secret M3_ADMIN_API_HMAC_SECRET for the staging publisher."
