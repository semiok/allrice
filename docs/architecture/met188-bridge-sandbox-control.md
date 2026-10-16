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

## Automatic network admission

There is no sandbox-network module or website list in tenant settings. For a
chat task, the model supplies the exact public HTTPS destinations required by
its command. The backend admits them automatically after checking the frozen
employee outbound capability, live owner/device membership, task policy and
website reputation. Existing task confirmation/automation and exact input
permissions remain effective; network admission grants no additional file access.

Cloudflare's malware/phishing-filtering DNS-over-HTTPS endpoint screens only the
hostname (not task text, files, URL paths or credentials). The fixed TLS-verified
endpoint is `https://security.cloudflare-dns.com/dns-query` at `1.1.1.2:443`.
Queries have a four-second deadline and a 16 KiB response limit. Blocked or
private/mixed IP answers are refused. Lookup failures are reported separately
as unavailable and never bypass screening. Positive results are cached for the
shortest DNS TTL, at most 60 seconds; pending checks and the cache are bounded.
This blocks known malicious destinations; it does not claim every unknown site
or package is harmless. The transport below still validates each actual public
connection and pins its destination. See the provider's
[filter behavior](https://developers.cloudflare.com/1.1.1.1/setup/) and
[JSON API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/).

A new Bridge decision freezes the device ID, policy version and digest of the
exact owner/workspace/target/destination request. Different concurrent commands
have independent digests. Admission, dispatch and heartbeat recheck authority
and reputation. Device, membership, Run and feature revocation stop the original
attempt. Old manually configured references keep their original narrower
version, destinations and transfer permissions until their attempt settles;
they cannot silently adopt automatic authority. The old settings GET returns
404 and PATCH returns 410 without reading or modifying grants. Ordinary cloud
execution no longer requires a separate website profile; any explicit
administrator restrictions already installed on a cloud grant still apply.

Asset-backed inputs retain exact storage-object/artifact/project-snapshot refs
in transfer scopes. Local folder inputs retain their manifest checksums,
working-directory digest and folder grant. Approval binds this exact input and
network request; local files are never invented as cloud storage objects.
Client feature markers remain `sandbox_execution_v1`, `sandbox_network_v1` and
the corresponding managed Python profile versions. Unsupported clients fail
explicitly. Runtime output is not proof that no external request was sent.

## Physical transport

Containers remain on `NetworkMode: none`. A fixed helper binds only container
loopback; its private Docker exec stdio connects to the shared host-side transport.
No host listener, host credential, personal browser or unrestricted Docker network
is exposed. HTTPS CONNECT destinations, public DNS answers and TLS SNI are
checked independently. Private, loopback, metadata and direct-IP destinations,
ungranted hosts, and unsupported protocols are rejected. Connection count, total
bytes, outstanding frames and buffers are bounded. The managed Python image uses
a standard-library helper instead of assuming Node is installed.

When system DNS returns only synthetic proxy addresses, concurrent lookups share
one pinned public DNS request. Validated positive answers can be reused for the
shortest returned TTL, capped at 30 seconds and 64 hosts. Every connection still
checks fresh system answers and its caller's address policy. Private/mixed
answers, expired entries and resolver errors never permit a stale fallback.
Only canonical immutable dependency archive GETs retry transient transport/DNS
failures, at most twice with bounded backoff and the original cancellation and
execution deadline. Partial response bodies are discarded; complete archives
still require the pinned integrity check before use. Redirects, private DNS,
certificate errors and installer/tenant/API operations are never retried here.

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
compatibility, real Intel and ARM runner tests, ordinary-owner execution with no manual website configuration,
and deployment verification. Synthetic native component checks are distinct from
ordinary-account Dev acceptance. No DSH core or upstream package is modified.
