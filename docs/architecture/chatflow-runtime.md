# AllRice ChatFlow 3.0 Runtime

> Authority: [MET-88](https://linear.app/metasnowsky/issue/MET-88)

**AllRice ChatFlow is the tenant-safe SaaS conversation control plane above
DSH. It manages Session, Run, durable event delivery, context recovery,
authorization and Provider routing. DSH is the single execution Harness.**

ChatFlow is not a Harness and does not implement model inference, an agent
loop, token generation or a second tool planner. Codex subscription, MiniMax
and future APIs are Providers inside DSH.

```text
AllRice SaaS Platform
└── ChatFlow 3.0
    ├── Session / Run / Turn authority
    ├── tenant policy and Tool Broker
    ├── durable native-event gateway
    ├── context checkpoint and recovery
    └── DSH Adapter
        └── DSH Provider Router
            ├── openai-codex
            ├── openai-compatible
            └── deepseek-official
```

## Ownership

| ChatFlow owns                               | DSH owns                               |
| ------------------------------------------- | -------------------------------------- |
| Product Session, Run and tenant identity    | Native session execution               |
| Frozen employee and Provider policy         | Model inference and agent loop         |
| Tool authorization, isolation and audit     | Authorized tool selection              |
| Durable event order, replay and browser SSE | Native streaming event production      |
| Cross-Worker checkpoint and recovery        | Live-session context                   |
| Quota, circuit breaker and Provider routing | Provider protocol and token generation |

The browser never connects directly to DSH. DSH may request a capability, but
AllRice decides whether the tenant, employee and actor may execute it. The
authorized read-only tool set is visible to DSH on every turn; side-effecting
and secret-bearing operations still require explicit AllRice policy.

## Native experience contract

DSH's `session.event` order is the source of the user-facing work process.
ChatFlow 3.0 stores two complementary fields:

- normalized fields for tenant governance, Run state, usage and auditing;
- a sanitized `sourceEvent` projection for DSH Context, Think, Search, Tool,
  Todo and Compaction presentation.

System prompts, credentials, raw tool arguments/results and hidden reasoning
text are never copied into the tenant event stream. Only safe labels, state,
model route metadata and approved summaries are retained. Assistant text is
stored in the canonical assistant events.

The Run event endpoint exposes only the ChatFlow 3.0 envelope. The browser
renders native events in source order and updates the same block in place as
its state changes. The completed
view and replayed view use the same projector, so finishing a turn does not
replace the working UI or erase its process.

There is no ChatFlow 2.0 product track, legacy event projector or keyword-based
capability pre-router. Historical runs without native events remain readable as
answer-only transcript entries.

## Delivery and recovery

PostgreSQL RunEvent rows are authoritative. The Worker commits events before
the Web delivers them. PostgreSQL `LISTEN/NOTIFY` wakes the SSE gateway; the
gateway then reads rows by `run_id` and sequence. `Last-Event-ID`, durable
cursors and Event ID deduplication restore an interrupted browser stream.

The short polling waiter is retained only as an infrastructure failure fallback
for missed notifications, not as an alternative product experience. When
measured fan-out or independent-consumer requirements outgrow PostgreSQL,
notifications may be replaced by Redis Streams or NATS without changing the
ChatFlow 3.0 event contract or PostgreSQL business-data authority.

## Release safety

ChatFlow 3.0 is a single product path. Safety comes from normal operational
controls: tested database migrations, immutable container images, Git release
rollback, Provider circuit breakers and durable replay. It does not come from
shipping two conversation experiences or keeping the old UI selectable.

## Non-goals

- creating another Harness;
- exposing DSH, shell or host filesystem access directly to tenants;
- storing raw chain-of-thought, prompts, credentials or unrestricted tool IO;
- letting the browser bypass AllRice authorization;
- replacing PostgreSQL Session, Run, RunEvent or audit authority with Redis or
  NATS.
