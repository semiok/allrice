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

AllRice runs one DSH generation (MET-221), so these journals are kept only as
refusal evidence: `apps/worker/test/p25/dsh-legacy-replay.test.ts` installs each
file, plus future-format and unknown-required-event mutations of a disposable
copy, into the installed runtime and requires a refusal that leaves the bytes
unchanged, writes no migrated copy and dispatches no model. The 0.1.x reader and
the capture utility that produced them were removed with that generation.

Do not regenerate or edit these files; historical bytes must never be
overwritten to make a candidate pass.
