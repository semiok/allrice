# DSH journal contract corpus (session format v4)

Synthetic journals written by the production AllRice stdio adapter with the
installed DSH generation, one directory per journal contract version
(`NATIVE_JOURNAL_CONTRACT` in `packages/contracts/src/native-journal-contract.ts`,
MET-221). The model is a local HTTP fixture; there are no tenant conversations,
provider credentials or private data. Only the disposable cwd was normalized to
`/allrice/journal-fixture`, in file contents and in the directory name DSH derives
from it. Rows, ids, timestamps and private event payloads are kept as written.
`manifest.json` records the capture (commit, DSH version, contract, platform and
the native artifact ID of that platform), the SHA-256 of every file and the facts
the replay needs.

| Scenario              | Captured state                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| `ordinary-tool`       | Completed Broker tool callback and the final answer                           |
| `parked-question`     | `allrice/wait/checkpoint` after the native cancel and flush                   |
| `answered-question`   | Same journal after the typed answer (`allrice/input/request` and `/answered`) |
| `continued-question`  | Same journal after `allrice/wait/continued` and the completed continuation    |
| `bootstrap-reference` | A prompt carrying `allriceBootstrap` and `allriceSessionReference`, completed |

`apps/worker/test/p25/dsh-journal-replay.test.ts` installs every corpus whose
contract version is at least `readsFrom` into the installed runtime, recovers it
and continues it; it requires one corpus per readable version.

When `current` is raised for a breaking change, capture a new corpus with
`TSX_TSCONFIG_PATH=tsconfig.base.json pnpm exec tsx scripts/acceptance/runtime/capture-dsh-journal-v4.ts`
(it writes `contract-<current>/` and refuses an existing directory). Never
regenerate or edit a committed corpus; a build must read the old bytes as they are.
