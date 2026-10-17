# DSH upstream governance

AllRice consumes DeepSeek Harness as a thin, isolated runtime distribution. It
does not use the DSH Web Host as a tenant-facing backend and does not store
AllRice product customizations in upstream packages.

## Distribution facts

- `installedGeneration`: the composition actually pinned by this build.
- `declaredPromotedGeneration`: the recorded manual promotion decision. This
  declaration is not proof of the current Dev or Prod process version.
- `upgradeCandidateGeneration`: a fixed composition under evaluation. It is
  excluded from frozen employee profiles until explicitly approved and pinned.
- `missingFrozenGeneration`: the pre-upgrade compatibility meaning of an absent
  historical profile field. It never follows a new installed default and does
  not identify an original journal writer.

The pointers select unique records in `apps/worker/dsh/distribution.json`.
`pnpm dsh:generate` derives the committed shared constants; `pnpm dsh:verify`
rejects drift and checks the installed dependency lock and physical patches.
The Worker guard and new employee publications consume those constants. The
native adapter reports actual public package metadata for its loaded boot,
loop, Session and SDK, rather than echoing `DSH_DISTRIBUTION_VERSION`.

Live Dev acceptance remains in the verified deployment record and actual
service build identities. Production promotion is always manual. Frozen
historical values and checksums are not rewritten by this foundation. The
immutable native-root/artifact binding and two-generation routing remain a
separate MET192 gate; the declaration alone does not implement or prove them.

## Update procedure

1. Review the upstream release, license and breaking-change notes. Update the
   [reuse and replacement decisions](../architecture/dsh-reuse-and-replacement.md)
   for every existing adapter and newly relevant upstream capability. The
   [MET-154 rc.3 assessment](../architecture/dsh-upgrades/met154-rc3-baseline.md)
   is a research baseline, not an approved runtime distribution.
2. Verify the exact source commit and source archive SHA-256. Research-only PRs
   leave the current distribution and dependency lock untouched; update
   `upstream.json` with the corresponding implementation and compatibility work.
3. Pin available `@deepseek-ai/dsh-*` packages to the exact candidate and audit
   removed packages, replacement compositions and their complete transitive/peer
   dependency graph. Supporting libraries have independent version numbers.
   Verify Worker and DSH Admin together, including `pnpm-workspace.yaml` patches.
4. Preserve the restricted profile and tenant-frozen tool allowlist. Existing
   governed subagents, browser and MCP facades still go through AllRice authority;
   installing an upstream bundle never authorizes its shell or other tools.
5. Record every unavoidable downstream adapter in `patch-ledger.json` and every
   source patch in `pnpm-workspace.yaml`; link both from the reuse decisions. Prefer an
   AllRice plugin, profile overlay or adapter change over a source patch.
6. Run `pnpm dsh:golden-replay`, explicit PostgreSQL/Worker recovery and
   tenant-boundary tests, and the MET-62 evaluation suite. Test old journal copies
   before migration and preserve original bytes. Unknown private events and
   missing migration/rollback evidence block promotion; never mark them ignorable
   to bypass a reader. A format-only probe is not full runtime acceptance.
7. Canary the candidate by employee and tenant only after native-root binding,
   artifact identity, permission and journal gates pass. Update the installed
   and declared-promotion pointers explicitly; retain all still-referenced
   compatibility artifacts. A failed new reader must not retry an old reader
   after dispatch, and an old reader must not open new-format data.

## Failure policy

An identity mismatch, version mismatch, malformed JSON-RPC frame, permission
escape or failed release gate blocks promotion. Runtime failure may route a new
turn to an explicitly approved fallback, but never grants broader capabilities.
Codex subscription traffic uses DSH's `openai-codex` Provider plugin and the
same restricted runtime boundary as every other model route. A DSH candidate
cannot be promoted unless that OAuth Provider passes replay and refresh tests.

## Native artifact content and deployment approval

`scripts/dev-release/prepare-identity.mjs` prepares the existing service identity
and a separate `.local/dsh-native-artifact.json`. The latter measures production
AllRice native modules, both approved profiles, public ESM import targets, the
resolved dependency/optional/peer graph, package bytes, contracts dist, and
lock/patch evidence. Peer contexts are physical package instances. Missing
optional edges remain explicit; required missing edges, nearer native or nested
package module overrides, package file links and paths outside the release fail.
Profile `!!js` values are never evaluated while measuring.

The content ID excludes the absolute release root, time and source provenance;
unchanged relative layouts can move without changing it. It includes Node ABI,
platform and architecture prerequisites. Different installation layouts may
produce different IDs. The operating system, external programs, credentials,
evaluated environment, personal Skill content and Session data are outside this
content claim. This is a measured declared runtime graph, not a general proof of
all possible JavaScript dynamic behavior or native child execution outcomes.

Preparation is not approval. The deployment operator reviews the prepared ID
alongside the frozen source/CI/build, then sets
`ALLRICE_DSH_NATIVE_ARTIFACT_ID` to that exact approved value in the Worker
environment. The Worker remeasures before starting producers; a missing,
unapproved or mismatched manifest prevents startup. The pool checks its actual
command, entrypoint and profile against the verified artifact even on reuse.
Only immutable release directories may use this per-Worker verification cache.
Standalone offline protocol fixtures carry no verified artifact or Worker
authority; they are not evidence that a production release was approved.

The Worker Docker build also writes the content file through
`apps/worker/scripts/prepare-native-artifact.mjs --root=/app`. Its build output
prints the ID with `approvalGranted=false`. Image deployment must pass the
reviewed image's ID through the same environment setting; do not auto-approve a
runtime-generated file or read the expected ID back from the file during boot.
The existing service manifest and release acceptance keep their original roles.
The disposable Compose smoke test separately builds, verifies and approves only
its own newly built fixture image before starting its isolated Worker. This
test-only script does not approve or change a shared Dev/Prod deployment.
This slice does not create immutable native root bindings, migrate journals,
select another generation, or implement automatic release ACK/publishing.
