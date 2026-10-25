# DSH journal contract corpus (session format v4)

Synthetic journals written by the production AllRice stdio adapter with the
installed DSH generation, one directory per journal contract version
(`NATIVE_JOURNAL_CONTRACT` in `packages/contracts/src/native-journal-contract.ts`,
MET-221). The model is a local HTTP fixture; there are no tenant conversations,
provider credentials or private data. Only the disposable cwd was normalized to
`/allrice/journal-fixture`: in file contents, and as the project directory DSH
derives from it (`--allrice-journal-fixture--`). Rows, ids, timestamps and
private event payloads are kept as written. DSH's empty `session.lock` is not
kept; DSH creates it on open. `manifest.json` records the capture (commit and
anything uncommitted, DSH version, contract, platform and that platform's
native artifact ID), the SHA-256 of every file and the facts the replay needs.

| Scenario              | Captured state                                                                         |
| --------------------- | -------------------------------------------------------------------------------------- |
| `ordinary-tool`       | Completed Broker tool callback and the final answer                                    |
| `parked-question`     | `allrice/wait/checkpoint` after the native cancel and flush                            |
| `answered-question`   | Same journal after the typed answer (`allrice/input/request` and `/answered`)          |
| `continued-question`  | Same journal after `allrice/wait/continued` and the completed continuation             |
| `bootstrap-reference` | A prompt carrying `allriceBootstrap` (with a checkpoint) and `allriceSessionReference` |

`apps/worker/test/p25/dsh-journal-replay.test.ts` installs every corpus into the
installed runtime with the tools it was recorded with, recovers it, continues
it, and recovers it again in a new process. It requires exactly one corpus per
readable version (`readsFrom` to `current`).

- **Raising `current`** (a breaking change): run `pnpm dsh:journal-contract -u`
  to add the new descriptor, commit the runtime, then capture a corpus with
  `TSX_TSCONFIG_PATH=tsconfig.base.json pnpm exec tsx scripts/acceptance/runtime/capture-dsh-journal-v4.ts`.
  It writes `contract-<current>/` and refuses an existing directory.
- **Raising `readsFrom`**: delete the `contract-<n>/` directories below it and
  run `pnpm dsh:journal-contract -u`, which drops their descriptors.

Never regenerate or edit a committed corpus; a build must read the old bytes as
they are.
