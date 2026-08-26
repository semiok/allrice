# AllRice framework rollout

The MET-74 UI and runtime presentation layer is guarded independently from DSH
Provider routes. `ALLRICE_FRAMEWORK_V2=0` is the emergency visual
rollback. It does not alter employee snapshots or migrate active sessions.

The independent SaaS UI uses `/chatflow` and `/chatflow/employees`.
`ALLRICE_CHATFLOW_V2_ENABLED=0` returns the conversation entry to the legacy
workspace. `ALLRICE_LEGACY_WORKSPACE_ENABLED=0` retires `/workspace` only after
MET-62 passes; changing either flag never changes a Session model snapshot.

For canaries, set `ALLRICE_FRAMEWORK_V2_ROLLOUT_JSON` to a versioned policy:

```json
{
  "schemaVersion": 1,
  "emergencyOff": false,
  "defaultEnabled": false,
  "organizationIds": ["organization UUID"],
  "workspaceIds": [],
  "employeeVersionIds": [],
  "surfaces": ["workspace"]
}
```

Every non-empty scope must match. An empty scope is unrestricted. Supported
surfaces are `workspace`, `employees`, `automation`, and `skillhub`. Invalid
JSON fails closed to the legacy visual layer.

## Promotion order

1. Local and contract-test fixtures.
2. Development environment with replayed DSH sessions for subscription and API Providers.
3. Internal organization or employee revision.
4. One production tenant.
5. Default-enabled production after MET-62 quality and security gates.

Run `pnpm met62:verify` before steps 3–5. For a deployed canary, set
`ALLRICE_ACCEPTANCE_BASE_URL` so the gate also verifies Web liveness, readiness,
`/chatflow` and `/chatflow/employees`.

Do not use the UI flag to change a Provider or DSH generation. Provider routing
is frozen in the employee execution snapshot; DSH generation promotion follows
`dsh-upstream-governance.md`.
