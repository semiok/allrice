# AllRice ChatFlow Runtime

> Status: planned convergence under
> [MET-79](https://linear.app/metasnowsky/issue/MET-79/allrice-chatflow-runtime多-harness-对话控制平面收敛与双轨迁移).

**AllRice ChatFlow is the multi-Harness SaaS conversation control plane. It
manages Session, Run, event delivery, context recovery, authorization and
Harness routing.**

ChatFlow Runtime is not a Harness. It does not implement model inference, an
agent loop, token generation or a provider's internal tool planner. Codex, DSH
and future Harnesses retain their native sessions, agent loops, streaming
events and execution semantics. ChatFlow turns those capabilities into one
tenant-safe, durable and recoverable AllRice product experience.

```text
AllRice SaaS Platform
└── ChatFlow Runtime
    ├── Session / Run / Turn Controller
    ├── Realtime Event Gateway
    ├── Context & Checkpoint
    ├── Tenant Policy / Tool Broker
    └── Harness Router
        ├── CodexHarnessAdapter
        ├── DshHarnessAdapter
        └── FutureHarnessAdapter
```

## Ownership

| ChatFlow Runtime owns                        | Harness owns                              |
| -------------------------------------------- | ----------------------------------------- |
| Product Session, Run and Turn identity       | Native thread/session execution           |
| Tenant authorization and frozen run policy   | Model inference and agent loop            |
| Tool Broker enforcement and audit            | Tool selection and native tool events     |
| Durable RunEvent order and replay            | Native streaming event production         |
| Browser delivery, reconnect and backpressure | Provider protocol and token generation    |
| Cross-Worker/Harness recovery checkpoints    | Live-session context while runtime exists |
| Harness routing, fallback and capabilities   | Capability-specific execution semantics   |

The browser never connects directly to a Harness runtime. A Harness may request
an operation, but AllRice remains the authority that decides whether the
tenant, employee and actor may execute it.

## Current path

Codex App Server and the DSH SDK runtime already emit native deltas. Their
adapters normalize those events, and the Worker batches assistant deltas for up
to 80 ms or 512 characters before persisting ordered RunEvents. The Web SSE
route currently discovers new durable events by polling PostgreSQL every 150
ms. Last-Event-ID and the RunEvent sequence provide replay after reconnect.

This is real Harness streaming, not a final answer split into synthetic token
chunks. The convergence work removes avoidable transport latency and duplicate
runtime responsibilities without discarding the durable recovery path.

## Non-negotiable migration rule

**Do not perform a big-bang replacement. ChatFlow must migrate on dual tracks.**

```text
Harness native event
├── durable track  → PostgreSQL RunEvent (source of truth)
└── realtime track → event notification → SSE Gateway → browser
```

1. Existing durable RunEvents and resumable SSE remain available until the new
   realtime path has passed the exit gates.
2. Every native event enters both the durable and realtime paths. Realtime
   delivery never becomes the only copy of an event.
3. A realtime failure, browser reconnect or Worker restart must recover from
   PostgreSQL using the last durable sequence.
4. Rollout is gated by Harness, employee and workspace, with an emergency-off
   switch that returns traffic to the current path.
5. Duplicate logic is removed only after event integrity, recovery and latency
   targets remain healthy through canary and rollback drills.
6. ChatFlow does not simulate token streaming, reimplement an agent loop, or
   compact the same context independently while a Harness is already doing so.

## Realtime infrastructure path

The first realtime implementation should use PostgreSQL `LISTEN/NOTIFY`. It
fits the current modular-monolith deployment and avoids adding infrastructure
before the traffic requires it. A notification is only a wake-up signal: the
SSE Gateway reads the authoritative RunEvent rows by `run_id` and `sequence`.

When fan-out, throughput or independent consumer requirements outgrow
PostgreSQL notifications, the realtime distribution layer may move to Redis
Streams or NATS. That migration must preserve the ChatFlow Event Contract and
must not replace PostgreSQL authority for Session, Run, RunEvent, audit or
context checkpoints.

## Three-stage convergence

### Stage 1 — native event contract, no UX change

- Freeze ChatFlow terminology, ownership and the canonical event contract.
- Preserve Harness source identity, source event ID, generation, attempt, turn,
  order and timestamp when normalizing Codex and DSH events.
- Add replay fixtures and conformance tests from real Codex App Server and DSH
  SDK event sequences.
- Drive UI actions from the Harness Capability Matrix; never emulate an
  unsupported capability.
- Prohibit synthetic streaming from a completed answer.
- Prefer native context management while a Harness runtime is live; reserve
  AllRice checkpoints for cross-Worker, cross-Harness and disaster recovery.
- Record baseline latency, recovery, event-integrity and database-load metrics.

The existing PostgreSQL plus SSE path remains unchanged in this stage.

### Stage 2 — dual-track realtime gateway

- Add PostgreSQL `LISTEN/NOTIFY` after the durable event boundary.
- Wake the SSE Gateway and read authoritative events by sequence.
- Keep the existing 150 ms polling loop as an automatic fallback.
- Complete Last-Event-ID reconnect, gap fill, deduplication, strict ordering,
  heartbeat, batching, backpressure and slow-client handling.
- Emit acknowledged stop/cancel events.
- Add runtime affinity and cross-replica recovery constraints.
- Canary by workspace, employee and Harness with emergency-off.

The realtime track is successful only if losing it does not interrupt the
conversation and the durable track can reconstruct the exact transcript.

### Stage 3 — unified experience and controlled retirement

- Render common thinking/working, tool, approval, compaction, recovery and
  routing states through one ChatFlow event registry.
- Preserve Harness differences: Codex may expose active-turn steer while a DSH
  session without steer queues the next message.
- Prefer native structured tool events and retire the DSH text tool envelope
  only after the upstream protocol and Tool Broker bridge pass conformance.
- Introduce unified observability and evaluation dashboards.
- Retire polling and duplicate context logic one reversible step at a time.
- Move realtime fan-out to Redis Streams or NATS only when measured scale
  requires it.

## Exit gates

The old path cannot be retired until canary and rollback exercises demonstrate
acceptable first-token latency, inter-delta latency, stop latency, zero event
loss and reordering, bounded duplication, successful reconnect and Session
recovery, stable tool completion, Codex/DSH contract conformance and acceptable
database connection/query load.

## Non-goals

- creating another Harness;
- copying the Codex or DSH Web UI;
- allowing browsers to connect directly to Harness runtimes;
- replacing durable business data with Redis or NATS;
- enabling shell or host filesystem access outside the Tool Broker/sandbox
  policy;
- replacing the current conversation system in one release.
