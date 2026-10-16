# MET189: managed dependency resolution

`workspace.project resolve` fills the gap between public dependency declarations
and the existing immutable project installer. The caller declares `pnpm` or `uv`
and 1–32 exact public package names/versions. It supplies no source directory,
registry configuration, executable, URL or credential.

The platform admits one canonical cloud operation under the frozen
`workspace.project` and `cloud.process.execute` permissions, current Worker
lease, scoped outbound grant and frozen 10/30/60-minute sandbox ceiling. The
fixed resolver uses the existing execution budget renewal and physical guard;
it does not replay the whole request when a deadline expires. Approval,
revocation, cancellation and uncertain-outcome recovery use the existing ledger.
The stored original user message is checked on admission and replay; an explicit
local-only instruction prevents cloud resolution even with a valid grant.

The Node controller downloads the pinned pnpm archive and requests a lock only,
with scripts/config hooks disabled. The Python controller downloads pinned uv,
resolves binary wheels for the actual Linux image and selects a compatible
wheel whose hash was independently included in the resolution. Both run inside
gVisor with no tenant source or host credentials. Public-registry network access
uses the scoped HTTPS proxy. The fixed resolver has a bounded 256 MiB executable
temporary filesystem for uv; ordinary scripts retain their original 32 MiB
non-executable temporary filesystem. The physical guard checks the resolver's
exact supervisor, profile, privilege and lease rather than accepting its label
alone.

An independent parser checks the complete lock and reuses the existing
installer's source/lock/SRI validator before publishing a new immutable project.
Standard Node and Python projects retain a 128-package ceiling. Explicit Node
`web-development` projects permit 256 locked packages in cloud execution. The
existing Bridge v1 installer stays capped at 128: selection and direct admission
both reject larger local dispatch. A real user local-only requirement or absent
cloud permission still prevents cloud fallback.

Resolution returns `status: resolved`, `installed: false`, exact `project` and
`projectPreparation`. Only the existing isolated `execute` can prove that the
dependencies install and the verification program works. An `apply` must use
the resulting new source digest; a later Run restores the exact saved source.
The host environment and the original source are not modified by installation.

Failures preserve the package manager's real exit code and bounded, redacted
diagnostics. A malformed or oversized lock fails independent validation even if
the package manager exited zero. Diagnostic artifacts are published only after
confirmed failure and physical cleanup, for the exact Run owner, with current
authority rechecked at publication. Missing/conflicting receipts remain
uncertain. Ordinary tenant scripts do not gain permission to declare an external
effect absent by returning a similar JSON file.

Verification covers declaration/lock rejection, profile and legacy-client
limits, scoped grants and revocation, same-call identity, receipt forgery,
diagnostic ownership/publication, native DSH transport and physical gVisor
resolution/install/reuse. Component native scripts use synthetic identities and
owned cache volumes; they are separate from ordinary-account Dev acceptance.

The resolver remains separate from ordinary project execution. Cloud command and
project adapters use the shared finite budget and controlled-egress contracts;
the corresponding Bridge authority, physical control and rollout gates are
described in [MET188 sandbox control](met188-bridge-sandbox-control.md). An older
Bridge retains its prior restrictions until a verified new client advertises
the required features. Package resolution does not grant runtime network access.
