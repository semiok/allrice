#!/usr/bin/env bash

set -euo pipefail

compose_project="${ALLRICE_COMPOSE_PROJECT:-allrice-met39}"
proxy_port="${ALLRICE_PROXY_PORT:-18080}"
keep_compose="${ALLRICE_KEEP_COMPOSE:-0}"

export ALLRICE_PROXY_PORT="${proxy_port}"
export ALLRICE_STORAGE_SIGNING_SECRET="${ALLRICE_STORAGE_SIGNING_SECRET:-allrice-compose-smoke-signing-secret}"
export ALLRICE_WORKER_POLL_INTERVAL_MS="${ALLRICE_WORKER_POLL_INTERVAL_MS:-250}"
export ALLRICE_WORKER_LEASE_MS="${ALLRICE_WORKER_LEASE_MS:-3000}"
export ALLRICE_WORKER_HEARTBEAT_MS="${ALLRICE_WORKER_HEARTBEAT_MS:-1000}"

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
bootstrap_organization_id="$(printf '%s' "${bootstrap_json}" | jq -r '.organizationId')"
bootstrap_workspace_id="$(printf '%s' "${bootstrap_json}" | jq -r '.workspaceId')"
if [[ -z "${bootstrap_token}" || "${bootstrap_token}" == "null" ]]; then
  echo "Identity bootstrap did not return a token" >&2
  exit 1
fi

second_workspace_id="$({
  docker compose --project-name "${compose_project}" exec -T postgres \
    psql -U "${POSTGRES_USER:-allrice}" -d "${POSTGRES_DB:-allrice}" -Atqc \
    "insert into allrice_workspaces (organization_id, slug, name) values ('${bootstrap_organization_id}', 'restricted-smoke', 'Restricted Smoke') returning id;"
} | tr -d '\r')"
if [[ -z "${second_workspace_id}" ]]; then
  echo "Second workspace setup failed" >&2
  exit 1
fi

identity_output="$(ALLRICE_SMOKE_BASE_URL="http://127.0.0.1:${proxy_port}" \
ALLRICE_SMOKE_INVITATION_TOKEN="${bootstrap_token}" \
ALLRICE_SMOKE_ORGANIZATION_ID="${bootstrap_organization_id}" \
ALLRICE_SMOKE_WORKSPACE_ID="${bootstrap_workspace_id}" \
ALLRICE_SMOKE_SECOND_WORKSPACE_ID="${second_workspace_id}" \
  node scripts/identity-http-smoke.mjs)"
printf '%s\n' "${identity_output}" | sed '/^ALLRICE_SMOKE_STATE=/d'
smoke_state="$(printf '%s\n' "${identity_output}" | sed -n 's/^ALLRICE_SMOKE_STATE=//p')"
if [[ -z "${smoke_state}" ]]; then
  echo "Storage smoke state was not returned" >&2
  exit 1
fi

capability_output="$(ALLRICE_SMOKE_BASE_URL="http://127.0.0.1:${proxy_port}" \
ALLRICE_SMOKE_STATE="${smoke_state}" \
  node scripts/capability-http-smoke.mjs)"
printf '%s\n' "${capability_output}" | sed '/^ALLRICE_CAPABILITY_SMOKE_STATE=/d'
capability_state="$(printf '%s\n' "${capability_output}" | sed -n 's/^ALLRICE_CAPABILITY_SMOKE_STATE=//p')"
if [[ -z "${capability_state}" ]]; then
  echo "Capability smoke state was not returned" >&2
  exit 1
fi
capability_run_id="$(printf '%s' "${capability_state}" | base64 --decode 2>/dev/null | jq -r '.runId')"
capability_member_id="$(printf '%s' "${capability_state}" | base64 --decode 2>/dev/null | jq -r '.memberUserId')"
capability_snapshot="$({
  docker compose --project-name "${compose_project}" exec -T postgres \
    psql -U "${POSTGRES_USER:-allrice}" -d "${POSTGRES_DB:-allrice}" -AtF '|' -c \
    "select execution_snapshot ->> 'schemaVersion', jsonb_array_length(execution_snapshot -> 'capabilitySnapshot' -> 'workflows'), jsonb_array_length(execution_snapshot -> 'capabilitySnapshot' -> 'knowledge'), execution_snapshot -> 'capabilitySnapshot' ->> 'resolvedForActorId' from allrice_employee_runs where run_id = '${capability_run_id}';"
} | tr -d '\r')"
if [[ "${capability_snapshot}" != "2|1|1|${capability_member_id}" ]]; then
  echo "Unexpected MET-68 capability snapshot: ${capability_snapshot}" >&2
  exit 1
fi

execution_output="$(ALLRICE_SMOKE_BASE_URL="http://127.0.0.1:${proxy_port}" \
ALLRICE_SMOKE_STATE="${smoke_state}" \
  node scripts/execution-http-smoke.mjs)"
printf '%s\n' "${execution_output}" | sed '/^ALLRICE_EXECUTION_SMOKE_STATE=/d'
execution_state="$(printf '%s\n' "${execution_output}" | sed -n 's/^ALLRICE_EXECUTION_SMOKE_STATE=//p')"
if [[ -z "${execution_state}" ]]; then
  echo "Execution smoke state was not returned" >&2
  exit 1
fi

# Simulate an ungraceful Worker crash. The expired lease must be recovered by
# the replacement Worker without browser participation.
docker compose --project-name "${compose_project}" kill -s SIGKILL worker
docker compose --project-name "${compose_project}" up --detach --wait --wait-timeout 120 worker
ALLRICE_SMOKE_BASE_URL="http://127.0.0.1:${proxy_port}" \
ALLRICE_SMOKE_STATE="${smoke_state}" \
ALLRICE_EXECUTION_SMOKE_STATE="${execution_state}" \
  node scripts/execution-http-smoke.mjs

# The migrator must be safely repeatable when no new migration is pending.
docker compose --project-name "${compose_project}" run --rm migrate

# Validate that both authoritative stores remain consistent after restart.
docker compose --project-name "${compose_project}" restart postgres web
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${proxy_port}/api/health/ready" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error "http://127.0.0.1:${proxy_port}/api/health/ready" >/dev/null
ALLRICE_SMOKE_BASE_URL="http://127.0.0.1:${proxy_port}" \
ALLRICE_SMOKE_STATE="${smoke_state}" \
  node scripts/storage-restart-smoke.mjs

echo "AllRice Compose smoke passed (migration=${migration}, pgvector=${vector_version})"
