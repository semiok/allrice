#!/usr/bin/env bash

set -euo pipefail

compose_project="${ALLRICE_COMPOSE_PROJECT:-allrice-met39}"
proxy_port="${ALLRICE_PROXY_PORT:-18080}"
keep_compose="${ALLRICE_KEEP_COMPOSE:-0}"

export ALLRICE_PROXY_PORT="${proxy_port}"

cleanup() {
  if [[ "${keep_compose}" != "1" ]]; then
    docker compose --project-name "${compose_project}" down --volumes --remove-orphans
  fi
}

trap cleanup EXIT

docker compose config --quiet
docker compose --project-name "${compose_project}" up --build --wait --wait-timeout 300

curl --fail --silent --show-error "http://127.0.0.1:${proxy_port}/api/health/live"
curl --fail --silent --show-error "http://127.0.0.1:${proxy_port}/api/health/ready"

docker compose --project-name "${compose_project}" exec -T worker node -e \
  "fetch('http://127.0.0.1:3101/health/ready').then((response) => { if (!response.ok) process.exit(1); return response.text(); }).then(console.log)"

migration="$({
  docker compose --project-name "${compose_project}" exec -T postgres \
    psql -U "${POSTGRES_USER:-allrice}" -d "${POSTGRES_DB:-allrice}" -Atqc \
    "select name from allrice_schema_migrations order by name;"
} | tr -d '\r')"

expected_migrations="$(
  for migration_file in packages/database/migrations/*.sql; do
    basename "${migration_file}"
  done
)"

if [[ "${migration}" != "${expected_migrations}" ]]; then
  echo "Unexpected migration state: ${migration}" >&2
  exit 1
fi

vector_version="$({
  docker compose --project-name "${compose_project}" exec -T postgres \
    psql -U "${POSTGRES_USER:-allrice}" -d "${POSTGRES_DB:-allrice}" -Atqc \
    "select extversion from pg_extension where extname = 'vector';"
} | tr -d '\r')"

if [[ -z "${vector_version}" ]]; then
  echo "pgvector extension is not installed" >&2
  exit 1
fi

bootstrap_json="$(
  docker compose --project-name "${compose_project}" exec -T \
    -e ALLRICE_BOOTSTRAP_ORG_SLUG=phase0-smoke \
    -e ALLRICE_BOOTSTRAP_ORG_NAME='Phase 0 Smoke' \
    -e ALLRICE_BOOTSTRAP_WORKSPACE_SLUG=default \
    -e ALLRICE_BOOTSTRAP_WORKSPACE_NAME=Default \
    -e ALLRICE_BOOTSTRAP_ADMIN_EMAIL=phase0-smoke@example.com \
    worker node packages/database/dist/bootstrap-identity.js
)"
bootstrap_token="$(printf '%s' "${bootstrap_json}" | jq -r '.token')"
if [[ -z "${bootstrap_token}" || "${bootstrap_token}" == "null" ]]; then
  echo "Identity bootstrap did not return a token" >&2
  exit 1
fi

ALLRICE_SMOKE_BASE_URL="http://127.0.0.1:${proxy_port}" \
ALLRICE_SMOKE_INVITATION_TOKEN="${bootstrap_token}" \
  node scripts/identity-http-smoke.mjs

echo "AllRice Compose smoke passed (migration=${migration}, pgvector=${vector_version})"
