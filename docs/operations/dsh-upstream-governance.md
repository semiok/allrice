# DSH upstream governance

AllRice consumes DeepSeek Harness as a thin, isolated runtime distribution. It
does not use the DSH Web Host as a tenant-facing backend and does not store
AllRice product customizations in upstream packages.

## Distribution channels

- `current`: the only DSH generation eligible for normal traffic.
- `candidate`: an exact version under contract replay, security and MET-62
  release-gate evaluation.
- `rollback`: the previous approved generation retained until promotion is
  proven stable.

The channels are declared in `apps/worker/dsh/distribution.json`. Production
promotion is always manual. A chat session remains bound to its frozen employee
and runtime generation; an in-flight session is never silently migrated.

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
7. Canary the candidate by employee and tenant. Promote it to `current` only
   after approval, moving the previous current generation to `rollback`.

## Failure policy

An identity mismatch, version mismatch, malformed JSON-RPC frame, permission
escape or failed release gate blocks promotion. Runtime failure may route a new
turn to an explicitly approved fallback, but never grants broader capabilities.
Codex subscription traffic uses DSH's `openai-codex` Provider plugin and the
same restricted runtime boundary as every other model route. A DSH candidate
cannot be promoted unless that OAuth Provider passes replay and refresh tests.
