# Personal Skill exact package source

`createPostgresPersonalSkillPackageSource` reads the existing private Skill
installation/binding/version data. DSH still owns Skill loading and execution.
This source has no production identity/provider mount, registry, MCP tool,
catalog, resource reader, scheduler or background process.

## Owner boundary and public surface

The capability allowlist is the concrete factory plus the
`PersonalSkillPackageRead` DTO. Its only method is
`readPackage(pin: unknown, signal: AbortSignal)`. The database barrel exports
only those two names; internal helpers are not public.

The caller retains its SQL client and supplies trusted `context`, an existing
`EmployeeModuleScopeSchema` scope, and a required host-only
`requireCurrent(signal): Promise<void>` closure. The closure must bind the same
RC/employee/workspace to MET-273's reviewed
`currentEmployeeBusiness(sources, RC, target, signal)` at source
`caae6cc54edf9f5eed90ae7adf67e77c6369683a`. Access, thread, module release and
current configuration remain that owner's decision. A pin, parsed projection
or guest header cannot establish authority. Missing current fails closed.
Contract substitutes in tests do not prove production authority; the real
current/config and native provider sources remain unavailable, with no mount.

SQL reads only `allrice_personal_skill_bindings`,
`allrice_personal_skill_installations` and `allrice_personal_skill_versions`.
The compact query is shared with the existing 3.x guard, whose outer employee
authorization and hash/null checks stay intact. An exact version need not be
the installation's current pointer: ordinary updates retain authorized pins,
while uninstall, disable and binding epoch changes still revoke them.

Current authority is checked before and after the body read. The final binding
check uses a new read-only transaction, so it can see intervening revocation.
All actual query promises and transaction completion/rollback are joined.
Cancellation cancels pending SQL and suppresses bytes; it never detaches work.
Distinct query/callback, rollback and cancellation failures are retained, with
the original business failure first. No retry or custom timeout is added.

The result preserves the normalized definition, installation version and exact
pin. `bodyBytes` are UTF-8 bytes of `definition.content`; `bodyChecksum` hashes
those bytes. The pin's definition checksum hashes the complete canonical
definition; manifest checksum and package version checksum keep their existing
meanings. Schema, body checksum and package digests are verified. Legacy
definition-only versions return `manifest: null` and retain absent package pins.

The manifest is metadata, not resource bytes. Archive objects, paths, scripts,
source originals, install approval and history are neither opened nor changed.
Storage owner authorization/bytes and the native provider must be handed off
before resource/native integration; the reviewed MCP v1 has no capability
callback and is not extended here. Existing limits/permissions remain in place.
