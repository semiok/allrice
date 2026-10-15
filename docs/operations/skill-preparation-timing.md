# Skill preparation timing

Skill readiness means the frozen directory was registered, not that the model
read every Skill. On a fresh DSH host, AllRice persists one
`allrice/skill-readiness` event containing the eligible Skill count and each
Skill's ID, name and checksum (plus catalog version when available). Its short
summary can be truncated; the structured identities remain complete. An
unchanged warm host does not repeat this announcement. Existing authorization
filtering and unavailable-Skill receipts are unchanged.

Each successful preparation emits one `allrice/runtime-preparation` event before
the first prompt. Both events are persisted as `harness.native`; inspect
`payload.nativePayload` in the Run event log. This replaces N readiness writes
with one readiness write plus one timing receipt on a cold host; a warm host
adds only the timing receipt. The receipt includes the existing Run, Worker,
attempt, generation and native thread correlation and a `runtimeId`.

| Field                                          | Meaning                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cache` / `reason`                             | `hit/reused`, `miss/not_resident`, or `miss/configuration_changed`                                                                        |
| `changedFields`                                | Names of changed reuse-key fields; never their values or hashes                                                                           |
| `credentialResolutionMs`                       | Platform credential location/resolution and grant metadata lookup                                                                         |
| `previousRuntimeCloseMs`                       | Waiting for a mismatched existing runtime to close                                                                                        |
| `initializeMs`                                 | Child startup and initialize RPC, including Skill registration                                                                            |
| `skillRegistrationMs`                          | Native snapshot validation and provider registration inside the AllRice DSH host wrapper; excludes later directory listing and body reads |
| `acquireMs`                                    | Entire runtime pool acquisition, including the credential, close and initialize phases                                                    |
| `skillEligibilityMs`                           | Filtering the frozen Skills against authorized and active tools                                                                           |
| `threadBindingMs`                              | Binding the Run to its native thread before acquisition                                                                                   |
| `runtimeBindingMs`                             | Configuring current Run/controller authority after acquisition                                                                            |
| `skillEventsPersistenceMs` / `skillEventCount` | Awaited readiness/unavailable-event emission and persistence, including the last write; zero if none                                      |
| `registeredSkillCount`                         | Eligible directory size, including on cache hits                                                                                          |
| `preparationMs`                                | Adapter entry to timing-receipt emission, excluding that receipt's own persistence, queueing, later prompt delivery and model execution   |

Durations use monotonic clocks in the measuring process. Nested stages must not
be added to their parent totals. `skillRegistrationMs: null` means an older or
unmeasured host; `0` on a cache hit means registration was not needed. Failed
preparation before this boundary has no success receipt: do not treat absence as
zero duration. `not_resident` means only that this native thread was absent from
this Worker's pool; it does not claim a Worker restart or explain an earlier
eviction. Compare Worker IDs, native context generations and preceding failures
before attributing such a miss.

Actual native `skill` completion/failure events retain their frozen identity and
add `skillLoadMs`, the interval between DSH's source call/result timestamps when
valid. This includes the native tool execution interval, not model thinking or
AllRice's subsequent event-persistence time. Raw Skill contents, arguments,
results, credential material and hidden model reasoning remain excluded.

The reuse fingerprint and lifecycle policy are unchanged. This step neither
shares processes between native contexts nor changes DSH dependencies. Compare
cold, ordinary continuation and necessary-rebuild runs separately; fewer
readiness rows alone do not establish a whole-Run latency improvement.
