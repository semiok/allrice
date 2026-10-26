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

## Schedule control partitions (`contract-<n>/control/`)

A schedule control partition persists in two places: the DSH journals of its
control Sessions under the partition's stateRoot, and the SQL rows its
controller reads through the store. `control/` freezes both, one partition per
control profile, as a release left them after a cold restore: the journals
(normalized like the chat corpus) and `<scenario>/store.json`, what the
production SQL store returned to the next writer (the control rows, stored
Schedule task values and the workspace unit; for recurring, also each
automation's revision configurations; the stateRoot is normalized the same
way). `control/manifest.json` records the capture, each partition's reference
(the artifact it was born under, which the current loader never compares) and
the SHA-256 of every file. `store.json` is excluded from Prettier so its digest
holds.

| Scenario    | Captured state                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `once`      | Three ready controls: a creation refused as already past (blocked, no task), a task delivered under a live Host, a task due after the capture |
| `recurring` | An `every 60s` and an Asia/Shanghai `daily` task, each delivered once                                                                         |

Both were closed and cold restored before they were frozen. There are no
calendar (monthly, experience) controls yet.

`apps/worker/test/p25/dsh-control-journal-replay.test.ts` installs each
partition under a fresh stateRoot and reads every control journal
(`verifyNativeOnceControlHistory`). It then restores the real controller and
public Schedule Host, loaded from this tree's measured primary, over the store
image held in memory; every write is decided by the production state machine
(`prepareNative*Mutation`, `applyNativeOnceWorkspaceWrite`), so a write SQL
would refuse fails the replay. The release comes up at a time derived from the
frozen targets (only `Date` is replaced and it moves with real time), so every
run sees the same due work: the due once task and each missed recurring
occurrence are delivered exactly once, including past DSH's 30-day receipt
retention; pending cancel, rule change and delete commands, written to the rows
as the product APIs write them, apply to the frozen tasks; and a new process
reads back what was appended and changes nothing. It requires a control corpus
in every `contract-<n>/`.

Journals are never edited. `store.json` holds SQL rows: a migration that
rewrites control, task or revision rows applies the same change to every
`store.json` in its PR and records the new digests in the manifest, so the
replay reads them as production would.

- **Raising `current`** (a breaking change): run `pnpm dsh:journal-contract -u`
  to add the new descriptor, commit the runtime, then capture a corpus with
  `TSX_TSCONFIG_PATH=tsconfig.base.json pnpm exec tsx scripts/acceptance/runtime/capture-dsh-journal-v4.ts`.
  It writes `contract-<current>/` and refuses an existing directory. Then
  capture its control partitions against the fixture database with
  `ALLRICE_CAPTURE_CONTROL_CORPUS=1 ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 pnpm exec vitest run apps/worker/test/p25/dsh-control-journal-capture.test.ts`
  (about two and a half minutes of real timers). It writes
  `contract-<current>/control/` and refuses an existing directory.
- **Raising `readsFrom`**: delete the `contract-<n>/` directories below it and
  run `pnpm dsh:journal-contract -u`, which drops their descriptors.

Never regenerate or edit a committed corpus; a build must read the old bytes as
they are.
