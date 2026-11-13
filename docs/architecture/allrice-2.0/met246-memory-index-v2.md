# MET-246 PR2: complete index and ordinal reads

This implements the approved 2026-11-10 memory read design, not its acceptance result.
PR1 supplies the summary/details pair and historical revisions.
This source overlays PR4's ordinary-memory predicate and PR3's frozen document version/candidate contract.
No UI, quota/list implementation or C/#788 consolidation is included here.

The existing `allrice-employee-documents-v1` public DSH adapter remains the only document provider.
`systemPrompt.context` owns literal required context, supersession, clearing and recovery.
Native child composition, fork history, tool registration and approvals remain DSH-owned.
AllRice adds only scoped storage projection, authorization, existing Run accounting and lease checks.
The same frozen document version selects Host initialization, its compatibility fingerprint,
the explicit v2 capability receipt, run/begin validation and candidate writer shape.
The read grant controls only ordinal disclosure; it never selects a writer version.

The PERSONA combination retains strict V1/V2 documents, both with the same optional
16384-byte PERSONA field and independent renderer. USER remains2048bytes; V1 memory
remains6000bytes and the V2 initial index remains18303bytes. The complete PERSONA
still enters the model input estimate, while only MEMORY bytes enter the existing
24000-byte memory ledger. A present PERSONA never grants memory eligibility.
Only explicit human `employeeDocuments=true` selects the new index; persona-only
and scheduled producers preserve their original source, tools and V1 accounting.
Admitted children receive current PERSONA only. DSH fork history may still contain
completed root USER/MEMORY snapshots, without injecting them as current context.

Memory storage migration is `0236_employee_memory_pairs.sql`, after PERSONA's
`0235_persona_runtime_package_compatibility.sql`. Their SQL objects do not overlap:
the latter updates the existing version-compatibility function, while0236 adds
memory pair columns, checks, preflight and audit backfill. Forward recovery and
ordinary backup/restore preserve both migrations and their existing semantics.

New ordinary Run admission freezes one row set into `employeeDocuments.schemaVersion=2` and pins.
The queue's first INSERT stores this already charged state in its existing `memory_context_state` JSON.
The index includes every active ordinary summary, ordered by last edit and ID descending, up to100.
Each Run owns continuous ordinals1..N; an ordinal is neither a database ID nor a permission.
Pins retain ID, revision, pair digest and detail presence, with no copied detail text.
V2 `promptSnapshot.memories` is empty; legacy common/experience memory is not an alternate input.

| Contract               | Persisted v1                                   | Newly admitted v2                               |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Initial memory         | Existing whole-item6000-byte/20-item selection | Full index, structural maximum18303bytes        |
| Single successful read | Existing8000-byte JSON envelope                | Complete decoded native text, at most10000bytes |
| Run total / reads      | Existing24000bytes /12                         | Same24000bytes including index /12              |
| Reader                 | Existing search and source handles             | Explicit `workspace.memory.read({number})`      |

One shared renderer emits summary and complete detail with no inner JSON serialization.
Its structural maximum is40×4+2000×4+68=8228bytes; outer RPC escaping is not model text.
The maximal index leaves5697bytes, so a maximal detail must fail wholly on remaining budget.
Short complete results can still succeed; no512-byte threshold, partial text, chunks or auto retry.
Successful rereads consume another read and their actual text bytes under the existing Run row lock.
No memory result enters generic truncation, fullResult, file spill or static export.

The new tool requires an explicit frozen memory-read grant; broad storage capability is insufficient.
V2 removes the legacy search/source surfaces and their server-side entrypoints refuse v2 state.
Present owner/member/instance/confirmation and original issued revision pair are rechecked.
Deleting any indexed identity invalidates that old context; independent confirmed memories stay active.
An ordinary later edit does not replace a previously issued historical pair.
No deletion lineage hard block, time cutoff, semantic matcher or new source authority is introduced.

V1/NULL/pending records are never upgraded or given a fresh allowance on prepare/resume/duplicate input.
The verified execution package must contain the v2 parser, manifest and native tool render together.
An incompatible old carrier fails before disclosure; v2 cannot fall back to a generic envelope.
Rollback must stop new admission and preserve/drain existing v2 Runs on a compatible package.
Do not down-convert their JSON, reset counters, rewrite pins/revisions or treat a binary revert as data rollback.

Deterministic test source covers queue admission, historical pairs, current withdrawal, accounting races,
real DSH/JSON-RPC decoded text, root/child/fork, clear and cold recovery with synthetic model adapters.
Tests are deferred to the coordinated M5 gates; no token, provider latency or real-model read-rate claim is made.
