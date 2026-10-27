# Native contexts bind to the DSH generation

A release has exactly one native executor: its verified primary artifact
(`ALLRICE_DSH_NATIVE_ARTIFACT_ID`). Within one DSH generation every native
context (chat, employee preview, internal task, schedule control) is continued
by the current primary. Changing the artifact does not require rebuilding,
migrating or retaining old code (MET-221).

## What a context records

- The artifact IDs on business origins, native pins, Run execution bindings,
  final-delivery policies and schedule control references are **provenance**:
  which release created or first wrote them. They are written once and never
  rewritten; nothing selects code by them.
- Execution compares the DSH generation, profile, root seed and storage scope.
  `launch()` rejects pins from another generation, contexts without a business
  origin with the non-retryable
  `DSH_NATIVE_CONTEXT_INCOMPATIBLE`. In the Worker pipeline, existing pins first
  pass through DB re-admission: a missing origin or
  a generation mismatch between the pin and origin is rejected earlier with the
  non-retryable `NATIVE_SESSION_ADMISSION_DENIED`. Origins of another generation
  also fail earlier when their literal-generation schema is parsed; the Worker
  maps those parse errors to `NATIVE_SESSION_ADMISSION_DENIED`. Mapping these
  incompatibility-related DB admission and schema parsing failures to
  `DSH_NATIVE_CONTEXT_INCOMPATIBLE` remains a MET-221 follow-up.
- Journals follow the journal contract (`NATIVE_JOURNAL_CONTRACT` in
  `@allrice/contracts`). Each Worker records its `current` as the database's
  monotonic high-water (`allrice_runtime_metadata` key `dsh-journal-contract`)
  and refuses to start above or below its readable range.

## Storage roots

All journals live under `ALLRICE_DSH_RUNTIME_ROOT`; moving it detaches every
session. Existing employee previews may have an immutable pin under
`ALLRICE_EXECUTION_ROOT/platform-employee-tests/<test-id>` rather than the shared
chat root. Launch preserves only that exact registered layout, the same test ID
and tenant/owner suffix; neither arbitrary execution subdirectories nor chat
pins gain this exception. Missing original journals fail closed.

Platform diagnostics and experience consolidation use the same persistent
runtime root and the original tenant/owner/context namespace. Their business
`workDirectory` and the diagnostic Broker's `storageRoot` remain the disposable
attempt directory; attempt cleanup never removes the journal or changes the pin.

## Release check

`deploy-dev` runs the candidate's own
`scripts/dev-release/verify-native-retention.mjs --root=<release>
--release-sha=<sha>` before stopping services (the path and arguments are fixed
for installed tools). It remeasures and launch-checks the primary, then
`checkNativeReleaseCandidate` checks the generation, that the contract range
covers the recorded high-water, that every pin is under this deployment's
storage roots, and that every ready control session's journal is readable by the
candidate. It writes nothing and reads no close observations. Failures carry the
`DSH_NATIVE_` prefix.

Retained artifact slots, origin readers and portable artifact copies were removed
in MET-221. A non-empty `ALLRICE_DSH_RETAINED_*` or `ALLRICE_DSH_ORIGIN_READER_*`
setting refuses the Worker start instead of being ignored.

## Schema-v2 execution content

Both native preparation commands explicitly produce schema v2. Verification
dispatches from the approved manifest's version and rejects unknown versions;
it never retries a failed v2 verification as v1. The measurement API retains
its v1 default for callers checking historical manifests.

V2 measures native modules and profiles, the JavaScript closure reached through
`@allrice/contracts/native-runtime`, and the actual resolved production package
closure. The contracts entry exports only values used by native adapters and
does not re-export the general contracts barrel. Executed files remain fully
hashed: this is a module boundary, not symbol-level tree shaking. An otherwise
unrelated edit inside an imported JavaScript file still changes the content ID.

The native schedule factory declares its literal module map. The verifier and
approved loader use the same roots, including controller-local CJS resolution,
metadata imports, profile-only dependencies and the effective native loader
platform package. Unknown dynamic imports or unresolved required dependencies
fail closed. Third-party package contents remain conservatively measured in
full; optional and peer dependency resolution is retained.

Employee settings, business data, unrelated Web/source files, unreachable
contracts modules, declarations/maps and unused installation metadata are not
native code authority. V2 projects the selected distribution and necessary
loader-installation facts rather than hashing whole workspace/lock/governance
files. Applied patches are measured through their installed execution bytes.
Full service-build identity separately seals the raw governance files and
patch recipes; it is not relaxed by native content equivalence. Install and
verify the selected dependencies before preparing a new native manifest.

Run the existing native-artifact, v2, loader and service-build regression tests
when changing this boundary: unrelated inputs must retain the ID, while executed
modules, required contracts and installed dependencies must change it. Service
source SHA/tree may change while the native ID stays the same.
