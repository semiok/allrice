# AllRice framework rollout

The MET-74 UI and runtime presentation layer is guarded independently from the
Codex and DSH runtime routes. `ALLRICE_FRAMEWORK_V2=0` is the emergency visual
rollback. It does not alter employee snapshots or migrate active sessions.

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
2. Development environment with replayed Codex and DSH sessions.
3. Internal organization or employee revision.
4. One production tenant.
5. Default-enabled production after MET-62 quality and security gates.

Do not use the UI flag to change a Harness or DSH generation. Harness routing
is frozen in the employee execution snapshot; DSH generation promotion follows
`dsh-upstream-governance.md`.
