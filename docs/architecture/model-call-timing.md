# Model call phase timing

AllRice records bounded, structured operator logs for governed native model calls,
including successful requests. Search Worker stdout for `[AllRice:model-timing]`
and the exact `runId` / `callId`; `callId` is the existing durable admission ID.
The root Run, product Session, native Session, model, attempt and generation are
separate fields. Native retries receive distinct admission IDs. Compaction calls
use the same governance/observation path. No new retry, model loop or monitoring
service is introduced.

A successful prepare emits `prepared`. Calls entering the streaming/finally path
emit their first `first_content` if any, one `waiting` notice at most, and
`completed` or `failed`. Rejections before streaming can have no record or only
`prepared`; absence of a final record is never interpreted as success. Native streaming and the existing 60-second notice,
5-minute idle protection, cancellation and native retry limits are unchanged.
A throwing or rejected log sink never changes admission or model settlement.
A missing log is not proof of a zero duration or a successful execution.

All millisecond offsets use one monotonic origin at native model preparation:

- `preparationMs` includes checkpoint/write completion and model-prepare admission;
  `ledgerPreparationMs` is the latter bridge call, not credential-read time.
- `serializationMs` covers the existing input-byte/digest serialization. `inputBytes`
  describes that native envelope, not provider tokens or exact wire-body bytes.
  `toolCount` records the actual exposed tool count, without schemas or contents.
- `admissionMs` covers the existing model-dispatch bridge. The interval before the
  first HTTP request includes native/provider preparation and, where applicable,
  WebSocket setup/fallback. It must not be attributed solely to authentication.
- `httpRequests` retains the first eight HTTP attempts only. Each has start,
  connection-start/ready, body-sent, response-header, first-byte/event and close
  offsets where observable. Connection events are request-scoped Node diagnostics;
  pooled reuse may have no new connection observation. DNS/TCP/TLS are not separately
  timed. Response-body first-byte/event means the first consumption observed by our
  reader, not a physical packet timestamp. Heartbeats count as bytes, not content.
- `firstChunkMs` includes native framing; `firstContentMs` is the first actual
  reasoning/text/tool output. Text, reasoning and tool deltas have separate offsets.
  These are distinct from the final assistant message or the first visible answer.
- `settlementMs` covers the existing model-settle bridge and acknowledgement.

`authorizationReadMs` remains null: the pinned provider does not expose an exact
per-request credential-read interval. WebSocket attempt counts come from pi-ai's
public session-scoped diagnostics. WS handshake/frame timings are not invented;
WS-only calls can have no HTTP request entries. A later SSE fallback is identifiable
by both WS and HTTP observations, without claiming the reason for the fallback.
`requestsTruncated` explicitly flags more than eight HTTP attempts.

Only numeric metadata, allowlisted status/error codes and correlation IDs cross the
strict notification schema. URLs, headers, bodies, credentials, error text, model
answers and hidden reasoning are never logged. Invalid or duplicate timing frames
are ignored. Logs remain in the existing Worker logging system; they are not chat
messages, permissions, cost records or success/cleanup receipts. Apply the existing
operator log access and retention policy; do not build an additional raw-payload log.

The original 64.805-second first response in MET184 simple-finance has no such
historical timing and remains unattributed. Instrumentation cannot recover missing
past events. The next distinct real task verifies these observations; it does not
rerun the original task or constitute proof of a speedup.
