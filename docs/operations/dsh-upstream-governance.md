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

1. Review the upstream release, license and breaking-change notes.
2. Verify the source archive SHA-256 and update `upstream.json`.
3. Pin every `@deepseek-ai/dsh-*` package to the exact candidate version.
4. Keep the restricted Cordis profile closed to arbitrary shell, filesystem,
   browser, network, MCP, subagent and dynamic-plugin capabilities.
5. Record every unavoidable downstream patch in `patch-ledger.json`. Prefer an
   AllRice plugin, profile overlay or adapter change over a source patch.
6. Run `pnpm dsh:verify`, contract tests, replay fixtures, tenant-boundary tests
   and the MET-62 evaluation suite.
7. Canary the candidate by employee and tenant. Promote it to `current` only
   after approval, moving the previous current generation to `rollback`.

## Failure policy

An identity mismatch, version mismatch, malformed JSON-RPC frame, permission
escape or failed release gate blocks promotion. Runtime failure may route a new
turn to an explicitly approved fallback, but never grants broader capabilities.
Codex subscription traffic uses DSH's `openai-codex` Provider plugin and the
same restricted runtime boundary as every other model route. A DSH candidate
cannot be promoted unless that OAuth Provider passes replay and refresh tests.
