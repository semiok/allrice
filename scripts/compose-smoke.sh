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

if [[ "${migration}" != "0001_baseline.sql" ]]; then
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

echo "AllRice Compose smoke passed (migration=${migration}, pgvector=${vector_version})"
