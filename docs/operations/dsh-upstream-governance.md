# DSH upstream governance

AllRice consumes DeepSeek Harness as a thin, isolated runtime distribution. It
does not use the DSH Web Host as a tenant-facing backend and does not store
AllRice product customizations in upstream packages.

**One generation (MET-221, 2026-10-25).** The workspace depends on exactly one
DSH version. An upgrade moves every `@deepseek-ai/dsh-*` package at once; no
older package, patched package or separately versioned DSH service is kept.
`pnpm dsh:verify` enforces this in CI. Historical journals either move forward
through DSH's own format migrators or are not carried over; old data that would
need an older generation is test data and is deleted (owner decision,
2026-10-25). Known exceptions still being removed are listed in the repository
`AGENTS.md`.

## Distribution facts

- `installedGeneration`: the composition actually pinned by this build.
- `upgradeCandidateGeneration`: the recorded upgrade candidate; it currently
  points to the same sole installed composition. It does not keep an older
  generation available for execution.
- Frozen employee profiles must explicitly name the installed generation. Missing
  or historical generations are not executable. Read-only revision views expose
  an unavailable runtime profile, and tenant catalogs mark it as not assignable;
  they do not rewrite saved profiles or checksums.

The pointers select the sole record in `apps/worker/dsh/distribution.json`.
`pnpm dsh:generate` derives the committed shared constants; `pnpm dsh:verify`
rejects drift, a second DSH version anywhere in the manifests or lockfile, any
DSH source patch, and private DSH subpath imports missing from
`compatibility.json`.
The Worker guard and new employee publications consume those constants. The
native adapter reports actual public package metadata for its loaded boot,
loop, Session and SDK, rather than echoing `DSH_DISTRIBUTION_VERSION`.

Live Dev acceptance remains in the verified deployment record and actual
service build identities. Production promotion is always manual. Frozen
historical values and checksums are not rewritten by this foundation. The
per-context native artifact binding described below is being replaced by a
generation binding (MET-221); until then a changed artifact still blocks deploys
that have pinned contexts.

## Update procedure

1. Review the upstream release, license and breaking-change notes. Update the
   [reuse and replacement decisions](../architecture/dsh-reuse-and-replacement.md)
   for every existing adapter and newly relevant upstream capability. The
   [MET-154 rc.3 assessment](../architecture/dsh-upgrades/met154-rc3-baseline.md)
   is a research baseline, not an approved runtime distribution.
2. Verify the exact source commit and source archive SHA-256. Research-only PRs
   leave the current distribution and dependency lock untouched; update
   `upstream.json` with the corresponding implementation and compatibility work.
3. In one change, move every place that names the DSH version to the exact
   candidate: each `@deepseek-ai/dsh-*` dependency in every workspace
   `package.json`; `upstream.json`; the installed generation in
   `distribution.json` (then `pnpm dsh:generate`); each `packageExtensions` entry
   and each `overrides` selector keyed by a DSH version in `pnpm-workspace.yaml`
   (delete an extension once upstream declares the dependency); the
   `upstreamVersion` of every `patch-ledger.json` entry and of every
   `compatibility.json` `privateInterfaces` entry; and `compatibility.json`
   `sessionFormat`. Then run `pnpm install` and `pnpm dsh:verify`: the lockfile
   must contain the candidate only. Audit removed packages, replacement
   compositions and their complete transitive/peer dependency graph. Supporting
   libraries have independent version numbers.
4. Preserve the restricted profile and tenant-frozen tool allowlist. Existing
   governed subagents, browser and MCP facades still go through AllRice authority;
   installing an upstream bundle never authorizes its shell or other tools.
5. Re-review every downstream adapter in `patch-ledger.json` against the
   candidate and keep its entry in the reuse decisions. DSH packages are never
   patched: use a public seam (plugin, profile overlay, adapter) or wait for
   upstream. Do not add private DSH subpath imports; the existing ones are listed
   in `compatibility.json` `privateInterfaces` (the gate fails on an unlisted
   one) and a new one needs explicit approval and a removal plan.
6. Run `pnpm dsh:golden-replay`, explicit PostgreSQL/Worker recovery and
   tenant-boundary tests, and the MET-62 evaluation suite. Test old journal copies
   with the candidate's official migrators and preserve original bytes. Never mark
   unknown private events ignorable to make a journal migrate; journals the
   candidate refuses are not carried forward. A format-only probe is not full
   runtime acceptance.
7. Deploy the candidate to Dev only after artifact identity, permission and
   journal gates pass. Do not keep the previous generation running beside it:
   contexts the candidate cannot read are deleted or not imported. An old reader
   must never open new-format data.

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
Artifact verification alone does not migrate journals, select another
generation, or implement automatic release ACK/publishing.

## Generation binding and storage

Every same-generation native context runs on the release's verified primary;
artifact IDs recorded on contexts are provenance only. Retained artifact slots
and origin readers were removed in MET-221: a non-empty `ALLRICE_DSH_RETAINED_*`
or `ALLRICE_DSH_ORIGIN_READER_*` setting refuses the Worker start. See
[native contexts bind to the DSH generation](../architecture/dsh-native-generation-binding.md).

Existing pins, durable legacy thread adoption and retries require the target
stored Session, not merely a parent directory. Before first binding a known
history, the primary's public persistence `stat` checks its identity
without a writer, model, credentials or directory creation. Cold acquisition
then uses the existing native resume-only `session/recover` path so disappearance
after that check cannot silently create an empty same-ID history. Warm matching
hosts are reused without re-opening them. A pin committed before an interrupted
first materialization remains a visible recovery failure; absence is never used
to infer permission to recreate it. Final binding and pre-prompt checks still
re-admit the real Job lease, owner, subject and chat CAS.

## Native Session identity and current Job authority

`allrice_native_session_bindings` preserves an immutable native root ID,
organization/workspace/owner, authoritative subject, approved artifact/profile,
and exact Session storage namespace. The first Run/Job/attempt are durable facts
without short-lived Run/Job/test foreign keys. An ordinary binding call cannot
delete, rebind or overwrite the identity. Archiving or revoking access retains
the pin and prevents execution; a pin is not permission to restore a task.

All five Harness execute paths use the same trusted Worker closure: ordinary
employee runs, Workflow steps, platform technical diagnostics, private experience
consolidation, and platform draft/method/experience tests. Only the closure holds
the real worker/Job/token/attempt. No lease token is passed to the kernel,
native process environment, events or tool schema. The transaction reuses
703/root/clock/Job ordering, rejects any cancel/drain/expired authority, and
rechecks the database clock after CAS/lock waits. Chat pointer updates commit
atomically with the pin. Same-ID admission preserves the active turn and usage.
Preview tests use their real test subject rather than a fabricated chat Session;
the binder does not lock their Run/test rows in reverse finalizer order.

The adapter commits the binding before acquiring a process and re-admits after
initialization before each AllRice prompt, including cached hosts. Other tenant,
profile or storage identities cannot replace a resident host. Existing model,
content, assistant and Broker authorization remains mandatory.

There is no blanket historical backfill or fallback to an empty/new log root.
Keep the configured runtime root stable and preserve the binding table together
with its native storage in backups. Short-term Run/Job/test cleanup retains the
pin. Whole-tenant destruction also requires retirement of its private namespace;
there is no ordinary product endpoint that deletes and recreates bindings.
A missing or different namespace, or another generation, fails closed; do not
solve it with an UPDATE to the pin or an automatic retry.
