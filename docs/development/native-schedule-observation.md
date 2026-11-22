# Native schedule observation source

Worker entry: `apps/worker/src/native-schedule-observation.ts`.

Allowed exports are `readNativeScheduleObservations`,
`NativeScheduleObservation`, and `NativeScheduleObservationBatch`. The function
accepts `Pick<ScheduleService, 'catalog'>` and an `AbortSignal`; it returns a
complete batch of native `id`, `sessionId`, `status`, `scheduledAt`, and content
fingerprints. It performs a real `catalog()` read. It does not own the Host.

## Native behavior and AllRice projection

DSH owns rules, committed targets, missed occurrences, delivery, and original
Session bindings. The locked `@deepseek-ai/dsh-schedule@0.2.1-rc.2` root exports
`ScheduleService`, `ScheduleCatalogEntry`, `decodeScheduleRecord`, and
`scheduleDomain`. This source reuses the public record decoder and the public
task value schema for metadata/receipt validation; it does not open or read the
domain. No package, engines, profile, or DSH implementation changes are needed.

AllRice adds only a source for a one-way ledger projection. `scheduledAt` is
copied unchanged: it is the committed next target while active, and the final
target while inactive. An inactive observation is never a wake instruction.
`lastDelivery` describes acknowledged inbox persistence, not execution completion.

Each row fingerprint is SHA-256 of the **complete original catalog row**, using
JSON with recursively sorted object keys and unchanged array order. Unknown
fields, non-JSON values, sparse/extended arrays, accessors, symbols, defaults, or
normalization cannot silently disappear: native decoding/schema validation must
reconstruct the exact original row. In particular, title, prompt, timing fields,
status, original Session binding, and all receipt fields affect the fingerprint.
Only the fingerprint and four native identity/status/target fields leave this
source; no title, prompt, timing rule, or receipt is exported.

Batch items sort by native task ID using code-point comparison. Duplicate IDs
reject the entire read. The batch fingerprint hashes the canonical JSON of all
observation items. Results are detached and frozen. A fingerprint is neither a
native commit version, a freshness proof, an authorization, nor a host save ACK.

`catalog()` does not activate Sessions or read their history. It has no signal
parameter. Pre-canceled calls do not start; cancellation during a read waits for
that actual Promise to settle, then suppresses the result. An actual read failure
is preserved, including when cancellation also arrived. No race, timer, listener,
polling loop, queue, or background resource is created. Failures never become an
empty successful batch. Absence in a new successful complete batch is merely an
observation; this source does not delete a projection or authorize a wake.

## Composition still required

Production must supply the actual trusted native Host service. A same-shaped
browser/guest object cannot establish origin, person, VM, or employee authority.
This source is implemented but is not mounted as production transport/ingress.
The real Host composition, trusted current identity and release binding,
authenticated projection receiver, durable invalidation/recovery, current
qualification/budget, and `PersonVmPort.start(context, signal)` composition remain
separate owner dependencies. Missing dependencies stay unavailable; there is no
default allow, empty successful receiver, or prompt replay.

Later native `schedule/changed` notifications contain no payload and can only
trigger a fresh catalog read. The external wake layer may save native committed
targets and trusted binding/content observations, recheck current authority, and
request the same person's VM start. It must not calculate cron/monthly dates,
create occurrences, send prompts, or treat start ACK as inbox delivery.

271's formal source `3dcde5079ede7c023c466073828ff8c612e3e046` owns browser child
write refusal and trusted native ancestry/current admission. It is reused by its
owner; this source does not copy the guard or alter native parent controls.
272 v1 `13c1b201da4f04acdf35359785f59b4f0cedd3f8` has only
`referenceRead`, `memoryRead`, and `deliverableCreate`; this work adds no callback,
MCP server, registry, HTTP route, or guest tool.

The locked public schedule API has no pause/resume/runNow/newEachRun equivalent.
Same-ID updates require the complete observed native record. Monthly/DST/late
delivery equivalence and old writer handover need separate decisions/evidence.
Existing 3.x services/data remain intact; no delete-and-create ID replacement or
second scheduler is introduced. UI, native-web, and PersonVm remain owner work.

## Verification scope

The full new `native-schedule-observation.test.ts` covers exact native shapes,
complete fingerprints, failed reads, and deferred cancellation. Its unconditional
public Host case reuses `native-schedule-host-factory.mjs`, isolated in-memory
storage, a temporary state root, and the real `ScheduleService.catalog`. It uses
a far-future stored task, initializes no Agent, permanently denies model/tool
execution, and awaits actual Schedule/SDK/root disposal before storage/temp cleanup.
This is native composition coverage, not production identity, durable SQL, or wake
acceptance. Execution status belongs to the fixed-head gate receipt, not this doc.
