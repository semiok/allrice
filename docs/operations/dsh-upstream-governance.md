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
