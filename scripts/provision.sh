#!/usr/bin/env bash
# Provision Cloudflare resources, deploy, and register the Telegram webhook
# (plan.md §5, Constitution art. VIII). Idempotent: safe to re-run.
#
# Reads credentials from the environment, or from secrets.env if present.
# CLOUDFLARE_API_TOKEN is optional: without it, wrangler uses `wrangler login`.
# Never prints secret values. Each run rotates WEBHOOK_SECRET_TOKEN and
# WEBHOOK_PATH_SEGMENT and re-registers the webhook with the new pair.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f secrets.env ]]; then set -a; . ./secrets.env; set +a; fi
for v in CLOUDFLARE_ACCOUNT_ID TELEGRAM_BOT_TOKEN OWNER_TELEGRAM_USER_ID GEMINI_API_KEY; do
  [[ -n "${!v:-}" ]] || { echo "error: $v is not set" >&2; exit 1; }
done
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && export CLOUDFLARE_API_TOKEN || unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID CI=true

W=(npx --no-install wrangler)
step() { printf '\n== %s\n' "$*"; }

# Run a create command; treat "already exists" as success.
ensure() {
  local out
  if out=$("${W[@]}" "$@" 2>&1); then
    echo "created: $*"
  elif grep -qiE 'already exists|already taken|already in use|already have a' <<<"$out"; then
    echo "exists:  $*"
  else
    echo "$out" >&2
    return 1
  fi
}

step "Account"
"${W[@]}" whoami

step "Queues"
ensure queues create voicescribe-jobs
ensure queues create voicescribe-dlq

step "KV namespace (audio + transcripts; 30-day TTL is set per key, FR-050)"
ensure kv namespace create voicescribe
kv_id=$("${W[@]}" kv namespace list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s.slice(s.indexOf("[")));console.log((n.find(x=>x.title==="voicescribe")||{}).id||"")})')
[[ "$kv_id" =~ ^[0-9a-f]{32}$ ]] || { echo "error: could not read the KV namespace ID" >&2; exit 1; }
sed -i.bak -E "s/\"id\": \"[0-9a-f]{32}\"/\"id\": \"$kv_id\"/" wrangler.jsonc && rm wrangler.jsonc.bak
echo "kv id: $kv_id (written to wrangler.jsonc — commit it)"

step "D1 database + migrations"
ensure d1 create voicescribe
db_id=$("${W[@]}" d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s.slice(s.indexOf("[")));console.log((n.find(x=>x.name==="voicescribe")||{}).uuid||"")})')
[[ "$db_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "error: could not read the D1 database ID" >&2; exit 1; }
sed -i.bak -E "s/\"database_id\": \"[0-9a-f-]{36}\"/\"database_id\": \"$db_id\"/" wrangler.jsonc && rm wrangler.jsonc.bak
echo "database_id: $db_id (written to wrangler.jsonc — commit it)"
"${W[@]}" d1 migrations apply voicescribe --remote

step "Deploy"
deploy_out=$("${W[@]}" deploy 2>&1) || { echo "$deploy_out" >&2; exit 1; }
echo "$deploy_out" | tail -15
worker_url=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$deploy_out" | head -1)
[[ -n "$worker_url" ]] || { echo "error: no workers.dev URL in deploy output (register a workers.dev subdomain in the dashboard)" >&2; exit 1; }

step "Secrets (values hidden)"
WEBHOOK_SECRET_TOKEN=$(openssl rand -hex 32)
WEBHOOK_PATH_SEGMENT=$(openssl rand -hex 24)
export WEBHOOK_SECRET_TOKEN WEBHOOK_PATH_SEGMENT
node -e 'const k=["TELEGRAM_BOT_TOKEN","OWNER_TELEGRAM_USER_ID","GEMINI_API_KEY","WEBHOOK_SECRET_TOKEN","WEBHOOK_PATH_SEGMENT"];process.stdout.write(JSON.stringify(Object.fromEntries(k.map(n=>[n,process.env[n].trim()]))))' \
  | "${W[@]}" secret bulk

step "Telegram webhook"
npx --no-install tsx scripts/set-webhook.ts "$worker_url"

step "Done"
echo "Worker: $worker_url"
