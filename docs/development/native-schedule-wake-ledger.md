# Native schedule observation receipts

This storage slice includes migration
`0254_native_schedule_observation_receipts.sql` and its database root export. It is
implementation prepared, awaiting fixed-head tests and independent review. It is
not an installed production receiver or a complete external wake chain.

`createPostgresNativeScheduleObservationLedger(db)` is a concrete PostgreSQL
storage implementation. The caller owns the SQL client and trusted composition;
the factory does not authenticate a native Host, create authority, or open a VM.
Its only table is `allrice_native_schedule_observation_receipts`.

The three operations are `commitBatch`, `invalidateReceipts`, and
`readExactReceipt`. Each takes the complete original snapshot/invalidation input
and an optional AbortSignal. Snapshot inputs carry the exact f7 observation batch,
receiptId, observed origin facts, and an explicit set of old snapshot receipt IDs
to invalidate. Explicit invalidation carries a reason evidence reference instead
of a batch. Invalidations cannot target themselves, duplicate references, another
scope, a missing receipt, or an invalidation receipt. Original receipts remain.

Observed origin contains organization/workspace/person, full observed VM binding,
employee instance/revision/version, and the existing host bindingRef. These fields
are provenance only, not current permission, stable native storage identity, or a
producer sequence. Scope matching uses organization/workspace/person/vm/employee
instance; newer observed VM epochs/releases may retire the same scope's older
receipts. The store does not infer their authority to do so.

All DTOs are exact JSON. The batch fingerprint must match canonical complete
observation items sorted by unique native task ID. Canonical JSON sorts object
keys by code point and preserves arrays. It rejects hidden/accessor/symbol or
non-JSON fields rather than certifying a stripped subset. This verifies stored
content consistency, not the underlying native row fingerprint's authenticity.
No native prompt, rule/cron/date computation, or private native store is read.

One transaction validates explicit old snapshot references and appends the complete
new receipt. Same receiptId and exact canonical input are idempotent; changed input
conflicts. The storage ID is not a new native identity or a replay request key.
There is no latest head, due selection, producer ordering, lease, queue or wake
operation. Invalidation links record evidence; they do not authorize a consumer to
choose a latest snapshot or start a task. receivedAt is audit metadata only.

Actual SQL cancellation calls the driver's cancel and waits for query settlement.
The enclosing transaction is awaited through COMMIT/ROLLBACK. Internal COMMIT has
no separate public cancel handle: cancellation joins it and suppresses a late
success. Separately observed SQL/transaction failures and the original cancellation
reason are retained, with a real failure as AggregateError cause. No timeout,
SQLSTATE inference, retry, or automatic write reconciliation is added.

A rejected write does not prove rollback. After the original operation settles,
the caller uses readExactReceipt with its original immutable input. Only an exact
stored receipt proves commit; null means no exact evidence, not a certified absent
write. The caller cannot fix an unknown ACK by generating a new receipt ID.

Migration 0254 adds one append-only table with receipt_id uuid PK;
organization_id/workspace_id/person_id/vm_id/employee_instance_id uuid NOT NULL;
input_digest text NOT NULL; input_payload jsonb NOT NULL; received_at timestamptz
NOT NULL DEFAULT now(). Constraints bind payload receipt/scope to its columns,
validate snapshot/invalidation storage shape, and a trigger forbids UPDATE/DELETE.
Full DTO, canonical digest and exact reference validation remain in the writer.
There are no external-owner foreign keys/cascades or native state columns. No index for due
time/latest or owner sequence is needed. The actual migration is reviewed and
tested with this core, not replaced by test DDL.

The integration file loads the exact allocated 0254 migration and applies it to a
dedicated isolated schema using the existing database guard. Missing migration
fails setup explicitly. It does not copy SQL to simulate migration coverage. Unit tests use scripted SQL
only for input and actual Promise/cancel/commit-join contracts; they are not PG,
authority or runtime evidence. Tests have not been run during implementation.

This module's database root export exposes only the concrete factory and four DTO types:
`NativeScheduleLedgerOrigin`, `NativeScheduleSnapshotReceiptInput`,
`NativeScheduleInvalidationReceiptInput`, and `NativeScheduleObservationReceipt`.
The existing migration runner discovers sorted `.sql` files; the existing CI
inventory discovers this integration file under the database resource rule.
No additional registry or CI file is required.

Still missing: the real native Host producer and trusted background current
identity/employee configuration, native write-to-host invalidation/order/closure
facts, permission/budget decision, an approved due driver, and the existing shared
PersonVm authority/start composition. Missing dependencies stay unavailable. f7
content fingerprints, current schemas, arriving receipts and UUIDs never replace
those facts. No HTTP/MCP/production registration, UI, 271/273/VM or 3.x changes.
