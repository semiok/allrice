# Memory loading growth acceptance

This checks loading scope, intact evidence and loading limits. UTF-8 byte counts
are transport measurements, not billed model tokens or monetary savings.

## Reproducible database test

The existing consolidation integration suite owns a randomly named schema in the
dedicated local/CI fixture database. Its default smoke case checks three supported
adopted identities, ten ordinary memories and ten captured feedback/history rows.
It never connects to an application database or calls a model.

```sh
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 \
pnpm exec vitest run --maxWorkers=1 \
  packages/database/src/experience-consolidation.integration.test.ts \
  -t 'measures bounded memory'
```

The opt-in local release comparison additionally requires:

- `ALLRICE_MEMORY_GROWTH_EVIDENCE_DIR`: output directory.
- `ALLRICE_MEMORY_GROWTH_BASELINE_ROOT` / `_SHA`: a complete retained Dev release
  and its exact 40-character Git SHA.
- `ALLRICE_MEMORY_GROWTH_CANDIDATE_ROOT` / `_SHA`: a complete candidate release
  and its exact Git SHA.

Roots must resolve to a direct child of `/Users/a123/allrice-dev-releases/` and
match their build identity. Native imports retain each release's own contracts;
the Vitest aliases must not substitute new contracts into the baseline. Both
clients use the guarded fixture URL throughout their lifetime and close before
the environment is restored. Run this test alone with one worker.

## Fixtures and assertions

There are only three supported adopted semantic identities per AI instance:
attendance counts, structured report style and concise report style. They are
created through the existing consumer with synthetic valid source evidence.
The two report proofs are produced by the actual baseline consumer, and the
candidate must read the unchanged proofs. This is not evidence of thousands of
adopted rules or thousands of completed model tasks.

Six `(ordinary memories, feedback/history)` cells are measured:
`(10,10)`, `(100,10)`, `(1000,10)`, `(10,100)`, `(10,1000)`, `(1000,1000)`.
Feedback is captured by the real evidence producer from synthetic completed Run
records. Historical collection ticks have empty sources and no invented model
receipt. Measured Runs/messages accumulate between cells; actual table counts
are recorded so changes cannot all be attributed to the two selected variables.

Each arm uses a fresh equivalent authorized Run per sample. One warmup is kept
separately, followed by 30 alternating samples. The first preparation after
explicit projection invalidation is labelled separately; it is not a physical
cold-cache measurement. Exact ordinary facts, complete adopted content, immutable
proofs, the requested source handle, read pin, original source IDs and verbatim
excerpt/digests must match independently frozen source rows.

## Measurements and gates

The result file contains latency samples and p50/p95/max for explicit memory
search, authorized experience preparation plus actual kernel formatting, source
expansion, and the experience overview. The combined initial-loading metric sums
paired search/assembly durations before calculating percentiles. Source expansion
is unsupported on the old arm, not zero-cost.

Every measured SQL statement is counted, including transactions, savepoints,
access locks and control statements. Representative observed SELECTs are replayed
outside the timed samples with EXPLAIN ANALYZE to expose actual returned and
scanned rows. Final search results (three) are distinct from the SQL pool cap
(sixty for `limit:3`) and from the number of database memories.

The fixed local comparison requires candidate warm p95 at most 250 ms and query
count growth at most two for the same selected items. A failed gate writes failed
measurement evidence and fails acceptance. Initial bytes must be at most 6,000,
one source envelope at most 8,000 and cumulative loaded bytes at most 24,000; the
persisted meter must equal the actual rendered/serialized loading plus response.
No resetting an old Run's meter is permitted.

The default CI smoke checks correctness, not a statistically meaningful latency
percentile. Full performance acceptance requires the opt-in 30-sample comparison.

## Boundaries

The explicit search API is measured separately from ordinary automatic recall.
Its results are passed to the real kernel formatter alongside authorized adopted
experience. This is not full DSH dispatch or a Broker memory.search measurement.
Preserving the current paragraph request in the assembled input does not prove a
model obeys it. Actual task accuracy, behavior, paid usage and the AllRice/DSH/
Codex three-arm comparison belong to the separate real-role acceptance phase.

Reuse unchanged exact-version permission, withdrawal, stale proof, invalid Skill,
index fallback, repeat-read and resume-budget regression evidence. Positive
growth data alone must never be reported as those negative boundaries passing.
Only optimize production code after an observed hotspot; do not infer savings
from record omission or convert bytes to paid tokens.
