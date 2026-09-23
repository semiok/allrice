# Frozen DSH v0 replay corpus

These are synthetic journals emitted by the production Allrice stdio adapter
and DSH `0.1.1-rc.2` at Allrice `a77c640`. The model is a local HTTP fixture;
there are no real tenant conversations, provider credentials or private data.
Only the temporary cwd was normalized to `/allrice/legacy-fixture`. Physical
rows, ids, timestamps and event payloads are retained. `manifest.json` pins the
source versions, answer identity and SHA-256 of every file.

| File                       | Captured state                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `ordinary-tool.jsonl`      | Completed Broker search callback and final model answer                 |
| `parked-question.jsonl`    | Quiescent question checkpoint followed by native cancellation/flush     |
| `answered-question.jsonl`  | Same journal after exact typed answer adoption, before continuation     |
| `continued-question.jsonl` | Same journal after persisted continuation intent and completed new turn |

Run `pnpm dsh:golden-replay` or
`pnpm exec vitest run apps/worker/test/p25/dsh-legacy-replay.test.ts`.
Each test verifies the checksum and copies the historical bytes into a fresh
temporary root before starting a real native process. It uses the existing P24
loopback model fixture; PostgreSQL/Worker lease recovery remains covered by the
separate MET-153 integration suites. Future-format and unknown-required-event
negative cases mutate only disposable copies and require byte-preserving refusal.

Do not regenerate these files during an upgrade. To capture an additional corpus
from the original runtime, check out the compatible baseline plus the capture
utility and choose a **new** output directory:

```bash
TSX_TSCONFIG_PATH=tsconfig.base.json pnpm exec tsx \
  scripts/acceptance/runtime/capture-dsh-legacy-fixtures.ts \
  .local/new-legacy-corpus
```

The utility refuses another DSH version or an existing output directory. Generated
ids and timestamps vary, so the frozen corpus is retained even after adding new
samples. Historical bytes must never be overwritten to make a candidate pass.

The isolated candidate format probe is documented in the
[MET-154 baseline](../../../../../../docs/architecture/dsh-upgrades/met154-rc3-baseline.md).
It is read-only and returns nonzero on migration refusal. Passing format decoding
alone is not evidence of successful model execution, tenant authorization or a
safe production rollback.
