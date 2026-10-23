# Exact native artifact retention

An immutable native pin or first-business origin selects a content ID, not
“whatever has the same DSH version.” Updating the primary or closing new births
does not revoke an already approved reader. Missing approval or original storage
fails before a prompt; it never creates an empty replacement history.

## Deployment order

1. Read the served artifact's original manifest, source SHA/tree, storage root,
   pins and all four origin tables. Preserve archived and terminal references.
2. If replacing its full release directory, run
   `scripts/dev-release/copy-native-artifact.mjs` with explicit `--root`,
   `--target`, `--expected-id`, `--source-sha` and `--source-tree` values. The
   destination must not exist. This copies measured files, actual package
   instances and resolver links; it does not reinstall, copy Web builds,
   credentials or Session data, change provenance, or grant execution approval.
   This compact copy is limited to the measured 0.2.1 generation. The legacy
   0.1.5 v1 identity omits a dynamic loader platform edge; its original approved
   full release remains protected. A same-ID copy failed actual isolated native
   loading, so copying that reader is explicitly rejected, without changing its
   historical ID or borrowing a new reader.
3. Independently review/register the exact copy and prove native cold recovery
   with the original full source unavailable. Keep the original storage root;
   a content-equivalent code directory is not a storage migration.
4. Configure the finite approved set below. With the **candidate deployment
   environment**, run `scripts/dev-release/verify-native-retention.mjs
--root=<candidate> --release-sha=<exact-source-sha>` before stopping services.
   It remeasures every configured code root and reads real durable references.
   A missing artifact, wrong generation/storage root, missing provenance or full
   slots blocks the switch. No automatic eviction, rebinding or fallback occurs.
5. The consuming Worker repeats this check before producers start. Existing
   Job/lease/current-authority/CAS checks still run for each execution. This
   reference check is not a maintenance barrier or release ACK.

## Finite configuration

Each `ALLRICE_DSH_RETAINED_<slot>_` entry uses `ROOT`, `ARTIFACT_ID` and
`STORAGE_ROOT`. Additional slots require the served artifact's original
`SOURCE_SHA` and `SOURCE_TREE`; these are separately checked against its manifest.
Primary provenance remains checked by the existing service-build identity.

Existing employee previews may have an immutable pin under
`ALLRICE_EXECUTION_ROOT/platform-employee-tests/<test-id>` rather than the shared
chat root. Coverage and launch preserve only that exact registered layout, the
same test ID and tenant/owner suffix; neither arbitrary execution subdirectories
nor chat pins gain this exception. Moving the configured execution root still
blocks those histories. Missing original journals continue to fail closed.

- Slot 1 remains the exact approved `dsh-0.1.5-rc.3-a4c74a9` legacy reader.
  Its existing, explicit `FROZEN_PROFILES` tuples may permit only the historical
  `dsh-0.1.1-rc.2-b150a55`/profile relationship. Source fields are optional only
  for this pre-existing slot; if supplied, both must be complete and match.
- Slots 2–7 may retain independently approved exact artifacts from that legacy
  generation or `dsh-0.2.1-rc.2-687f282`. The legacy frozen-profile exception is
  never granted to a current-generation artifact.
- An eighth slot, unknown generation, duplicate ID or incomplete tuple fails.
  If all slots are referenced, stop the next switch and report the references.
  Do not silently remove an artifact to make room. The finite limit is seven
  historical readers beside one primary; another distinct promotion blocks
  until its exact reference and capacity policy is independently reviewed.

The existing sixth and seventh retained slots came from the MET184 quality
and MET194 brand-content transitions. This compatibility slice adds no slot.
Preserve every original storage root, source and approval; full pre-stop and
startup validation remain required for every configured package. These finite
transition slots are neither a general growth rule nor MET195 completion.
The approved sequence brings one exact unbound-origin retirement forward,
then resumes MET192 scheduling before the remaining MET195 migrations. Each
old execution requirement must be removed under a reference/lease fence. Historical writer
identities, logs and artifacts remain. The final steady state is one current
execution package; more slots, deferred checks or cold archives do not meet it.

The primary `ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID` switch governs only the first
business INSERT. Existing origins are fulfilled from their own approved ID;
retries preserve their original family. No pin/origin means the existing legacy
policy, not permission to issue a new origin during execution.

### Current employee execution binding (MET195 B1)

New ordinary employee chats use an explicit schema-v2 business origin. The
immutable employee version remains their **source**; the independently approved
native artifact is their **executor**. Changing employee content does not create
a new native package or rewrite a historical source checksum. New births require
`ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID` to equal the approved primary
`ALLRICE_DSH_NATIVE_ARTIFACT_ID`; missing or conflicting approval fails closed.

The reviewed source family accepts schema-v2 employee definitions with either no
content package, or a verified schema-v1/v2 published package declaring the known
0.1.5 or current 0.2.1 generation. The existing publisher emits schema v1 for
plain-text Skills or no Skills and schema v2 for bundled resources; both retain
their original format. Schema v1 cannot contain bundles. Original configuration/package checksums,
Skill resources, governance, tool declarations and capability fingerprints are
validated. The original raw manifest also gets a canonical digest. An absent
package stays absent. Unsupported schemas, generations and damaged sources are
rejected rather than translated into invented packages.

Each admitted Run atomically stores a private, immutable
`allrice_employee_runs.native_execution_binding` with its original execution
snapshot. It records the exact tenant/owner/session/Run, per-Run source, birth
origin digest and executor tuple. Admission, resolution, leased preparation,
binding and Worker recovery all verify the fact; it grants no additional tool
or user authority. The Worker keeps the source kernel unchanged and selects the
executor through the existing approved-artifact ports. Run IDs and binding
digests do not enter the runtime reuse fingerprint.

Subsequent employee versions may change within this reviewed family. The new
Run records that version while the chat retains its original birth source.
Assignment, publication/canary and tenant roster synchronization share the
existing version-compatibility predicate. Historical NULL/v1 chats and queued
Runs are not backfilled or rebound; v1 reader approvals cannot authorize v2
births. Migration 0209 adds only the private nullable column and guards.

Business chats created by the existing quality/repair entrypoints follow the
same admission checks. This slice does not migrate separate internal
preview/consolidation/diagnostic native-root issuers,
retire historical code, or complete single-package convergence. Those remain
separate verified steps. The SQL/Worker protocol tests use explicit synthetic
approval seams and do not count as real native or Dev acceptance.

## Cleanup and limits

### Exact unbound chat adoption (MET195 prerequisite)

An explicitly approved chat that has **never acquired an old writer** can use
an independently verified target package for its first execution. This is not
an alias for a whole generation and does not migrate an existing native pin.
The immutable business origin remains the old source; the new pin records the
actual target writer and `origin_reader_approval_digest`. Every later content
generation retains that proof and the original tenant/owner/context namespace.

The operator supplies a strict data-only JSON approval using
`ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH`, its independently reviewed
`ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256`, and the original explicit
`ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT`. The file names one exact source,
one exact target, the DSH generation/profile/session format/Node ABI, an evidence
digest and at most 64 exact tenant/workspace/owner/origin tuples. It grants no
user permission. The normal Job, lease, owner, cancellation and binding CAS
checks still run. Missing approval, another context, an earlier source pin,
wrong storage or modified proof fails closed.

Additional independently reviewed sources can use the fixed optional groups
2 through 8: `ALLRICE_DSH_ORIGIN_READER_<n>_APPROVAL_PATH`,
`ALLRICE_DSH_ORIGIN_READER_<n>_APPROVAL_SHA256`, and
`ALLRICE_DSH_ORIGIN_READER_<n>_STORAGE_ROOT`. Configured groups must form a
complete contiguous prefix starting with the original unnumbered tuple.
The original groups' bytes, proof digests and targets are unchanged. All groups
share the original total limits of 64 contexts and 256 KiB of policy data.
Partial or blank extra tuples, gaps, unknown or aliased keys (including `_1_`,
`_02_` and `_9_`), duplicate sources/contexts/namespaces, and source-to-target
chains or cycles are rejected together; a bad policy never falls back to
earlier groups. Multiple sources may share a target. Every file is rehashed on
every load; group order and other approvals never enter an existing proof.
Each target must still be covered by
the existing checked package and reference validation. This adds no execution
retention slot or automatic retirement authority. Each additional policy remains
disabled until its own format, provenance, fence and actual continuation
evidence passes the same activation procedure below.

Activation is a manual, serial release operation:

1. Inventory the exact source's origins, pins, original storage and processes.
   Preserve archived origins. Compare native public formats and validate a
   synthetic old-writer/current-reader journal without editing upstream code.
2. With the candidate environment, run the existing pre-stop verifier. It now
   checks approval scope/origin, every pin, relevant Run/Job/child/tool/wait
   records, and the entire virgin namespace when no writer has been adopted.
   Unknown work is not aged out. This observation is **not** a producer fence.
3. Hold the existing deployment/QA exclusion, stop the old Web and Worker,
   verify their actual processes and relevant native children are stopped, then
   repeat the DB/storage check before enabling the reviewed policy. Any new
   observation invalidates the earlier idle evidence. Do not close historical
   unknown permits to force the check through.
4. Start the candidate Worker, confirm reference and storage checks before its
   producers, then open Web admission. Startup permits an already adopted
   target's ordinary crash recovery; its exact journal is checked by the
   normal per-Job public persistence reader. Planned pre-stop validation also
   checks all adopted journals. No empty substitute history is created.
5. Verify a normal isolated user's first execution and a cold continuation,
   scope rejection, historical reads/downloads, unchanged original origins
   and target pins. Only then retire the source's **code** approval/directory
   through the official cleanup process. Keep source provenance, journal/data,
   history and the approval proof.

The approval target is fixed. A later primary promotion may retain that exact
target under the existing bounded retention policy; it must not rewrite the
proof or reinterpret its pins. `NEW_ROOT_ARTIFACT_ID` must still match that
deployment's primary. The checked-delivery allowlist retains the exact adopted
target. Rollback after adoption requires a compatibility-aware Worker, the
same approval and verified target: a pre-adoption release or removal of the
policy is not a valid rollback. This frees one obsolete source; it does not
finish MET195's final migration of all existing writers to one current package.

Platform diagnostics and experience consolidation use the configured persistent
`ALLRICE_DSH_RUNTIME_ROOT` for native journals, including the original immutable
tenant/owner/context namespace. Their business `workDirectory` and the diagnostic
Broker's `storageRoot` remain the disposable attempt directory. Native home/cwd
follows the persistent namespace; it is not the business scratch directory.
Attempt cleanup, including preparation of another attempt, must not remove the
journal or change the original pin. A service-only release with the same native
content ID keeps the same configured storage root. Missing historical scratch
journals are still rejected; this does not migrate or rebind old histories.

Keep explicit absolute code/storage paths in launchd/environment configuration
so the existing cleanup tool protects running and retained roots. Retained
compact code also carries `.KEEP`; remove it only after a fresh complete
reference check and explicit lifecycle retirement. Retaining the latest three
Web/Worker builds is an additional policy and does not supersede native history
references. No automatic history retirement or compaction is implemented here.

Schema-v1 content IDs, exact old IDs, source provenance and original storage
namespaces remain unchanged. Remeasuring v1 still includes its original broad
inputs, including lock metadata. Cross-platform/Node-ABI history execution is
not promised. No second Worker, AgentLoop or scheduler is added.

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

The portable copy retains the original manifest/source, necessary support
metadata, exact package instances/resolver links and only the measured
contracts JavaScript closure. It re-verifies the destination ID before
reporting success, copies no storage, and grants no deployment approval.

Run the existing native-artifact, v2, loader and service-build regression tests
when changing this boundary. Validate an actual installed closure and portable
copy as well: unrelated inputs must retain the ID, while executed modules,
required contracts and installed dependencies must change it and invalidate
the old approval. Service source SHA/tree may change while the native ID stays
the same. This format does not retire any historical consumer or complete the
single-current-package migration by itself.
