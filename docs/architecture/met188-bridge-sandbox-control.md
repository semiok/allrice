# MET188: Bridge sandbox execution and network authority

Bridge command, saved project, and managed `python.execute` adapters share the
cloud execution budget algorithm. An explicit `execution` request is bound to
the Run's immutable sandbox policy. The administrator's 10/30/60 minute ceiling
is separate from the whole Run's active time limit; the stricter deadline wins.
Preparation uses the original clock. Compute starts with a short slice and
renews only with physical progress; install/build receives the policy's longer
initial slice. Neither model output nor a heartbeat creates a fresh budget.
Manager and dependency downloads supply measured cumulative I/O before the
container exists. Their renewal is bounded and serialized with lease checks;
the same byte counters and original clock carry into container execution.
An interrupted download retains the actual authority or budget failure.

The trusted PID 1 supervisor also requires a private five-second control lease.
Its immutable hard deadline cannot be raised. Missing control, authority loss,
or an expired slice terminates the entire container namespace, including detached
children. Python's watchdog runs independently of preparation and tenant output.
The host confirms physical exit before collecting outputs. Existing Office,
PDF, MCP, background services, and requests without `execution` retain their
prior contracts and deadlines.

## Explicit network permission

`设置 → 我的电脑 → 沙箱联网` belongs to the user who paired that device. The
setting is initially disabled. The owner selects exact HTTPS origins and
separately permits input-file transfer. A folder grant, local browser login,
managed runtime probe, or device credential never creates this permission.
The model can request only a subset of the configured origins. A request must
also have the frozen employee's outbound capability, a finite execution budget,
the current ordinary allow/ask/deny decision, and the exact original tool call.
Unrelated users, organizations, and workspaces cannot read or modify the grant.

Changing or disabling settings increments the grant version. The payload freezes
its ID, version and digest; admission, dispatch, heartbeat, and network setup
recheck live authority. Account, membership, Run, device, and grant revocation
fence the original attempt. The operation cannot silently adopt a new grant.
Old clients cannot claim the new payloads. The opt-in feature markers are
`sandbox_execution_v1`, `sandbox_network_v1`, and the corresponding managed
Python profile versions.

Asset-backed inputs retain exact storage-object/artifact/project-snapshot refs
in transfer scopes. Local folder inputs retain the existing manifest checksums,
working-directory digest and folder grant, and additionally require the
independent network grant's input-transfer permission. They are not invented
cloud storage objects. Runtime output must not be presented as proof that no
external request was sent.

## Physical transport

Containers remain on `NetworkMode: none`. A fixed helper binds only container
loopback; its private Docker exec stdio connects to the shared host-side transport.
No host listener, host credential, personal browser or unrestricted Docker network
is exposed. HTTPS CONNECT destinations, public DNS answers and TLS SNI are
checked independently. Private, loopback, metadata and direct-IP destinations,
ungranted hosts, and unsupported protocols are rejected. Connection count, total
bytes, outstanding frames and buffers are bounded. The managed Python image uses
a standard-library helper instead of assuming Node is installed.

A private PID 1 gate prevents tenant startup before the helper is ready. Saved
project installers remain offline and use the existing pinned archives/cache;
their runtime gate opens only after installation. Per-attempt package installs
requested by tenant code run inside the isolated sandbox under the explicit
network and time permissions. Failed setup never falls back to another network,
target or whole-task retry.

Transport revocation closes sockets immediately and stops the process. A normal
container exit can close exec before the wait notification; a bounded physical
check distinguishes that case from a lost helper. Network failure or cancellation
after bytes were sent remains uncertain even after confirmed process exit.
Recovery may stop an orphan but must not reclassify such an external outcome as
success or rerun it. Stored results include bounded traffic observations and
typed network errors, not raw credentials or remote response bodies.

## Rollout and evidence

Server gates are `ALLRICE_SANDBOX_EXECUTION_V1_ENABLED` and
`ALLRICE_SANDBOX_NETWORK_ENABLED`. The verified new Bridge advertises these features by default after successful
physical preflight. Operators can disable either with
`ALLRICE_BRIDGE_SANDBOX_EXECUTION_V1_ENABLED=0` or
`ALLRICE_BRIDGE_SANDBOX_NETWORK_V1_ENABLED=0`. Advertisement alone grants nothing.
An older installed app remains eligible only for its existing offline contracts.

Release acceptance requires database identity/revocation checks, legacy
compatibility, real Intel and ARM runner tests, explicit ordinary-owner settings,
and deployment verification. Synthetic native component checks are distinct from
ordinary-account Dev acceptance. No DSH core or upstream package is modified.
