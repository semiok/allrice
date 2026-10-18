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

- Slot 1 remains the exact approved `dsh-0.1.5-rc.3-a4c74a9` legacy reader.
  Its existing, explicit `FROZEN_PROFILES` tuples may permit only the historical
  `dsh-0.1.1-rc.2-b150a55`/profile relationship. Source fields are optional only
  for this pre-existing slot; if supplied, both must be complete and match.
- Slots 2–4 may retain independently approved exact artifacts from that legacy
  generation or `dsh-0.2.1-rc.2-687f282`. The legacy frozen-profile exception is
  never granted to a current-generation artifact.
- A fifth slot, unknown generation, duplicate ID or incomplete tuple fails.
  If all slots are referenced, stop the next switch and report the references.
  Do not silently remove an artifact to make room.

The primary `ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID` switch governs only the first
business INSERT. Existing origins are fulfilled from their own approved ID;
retries preserve their original family. No pin/origin means the existing legacy
policy, not permission to issue a new origin during execution.

## Cleanup and limits

Keep explicit absolute code/storage paths in launchd/environment configuration
so the existing cleanup tool protects running and retained roots. Retained
compact code also carries `.KEEP`; remove it only after a fresh complete
reference check and explicit lifecycle retirement. Retaining the latest three
Web/Worker builds is an additional policy and does not supersede native history
references. No automatic history retirement or compaction is implemented here.

Schema-v1 content IDs, exact old IDs, source provenance and original storage
namespaces remain unchanged. A lock-only edit currently can produce a different
ID; it must follow the same A→B procedure. Cross-platform/Node-ABI history
execution is not promised. No second Worker, AgentLoop or scheduler is added.
