import type { Sql } from 'postgres';
import {
  ApprovalError,
  type ApprovalRecord,
  type ApprovalRef,
  type ApprovalStore,
  type ExternalReceipt,
} from './contract.js';
import { assertApprovalRef } from './gateway.js';

type Row = { record: ApprovalRecord };
/** Dedicated module table; no cross-module SQL or implicit schema installation. */
export function createPostgresApprovalStore(sql: Sql): ApprovalStore {
  async function locked(
    ref: ApprovalRef,
    change: (record: ApprovalRecord, now: string) => ApprovalRecord,
  ) {
    return sql.begin(async (tx) => {
      const rows = await tx<
        Row[]
      >`select record from allrice_outbound_approvals where request_id=${ref.requestId} for update`;
      if (!rows[0]) throw new ApprovalError('DENIED');
      assertApprovalRef(rows[0].record, ref);
      const times = await tx<
        { now: string }[]
      >`select clock_timestamp()::text as now`;
      if (!times[0]) throw new ApprovalError('UNAVAILABLE');
      const record = change(rows[0].record, times[0].now);
      await tx`update allrice_outbound_approvals set record=${tx.json(JSON.parse(JSON.stringify(record)))} where request_id=${ref.requestId}`;
      return record;
    });
  }
  return {
    async stage(record) {
      return sql.begin(async (tx) => {
        await tx`insert into allrice_outbound_approvals(request_id,scope_key,idempotency_key,record)
          values (${record.ref.requestId},${record.scopeKey},${record.idempotencyKey},${tx.json(JSON.parse(JSON.stringify(record)))})
          on conflict(scope_key,idempotency_key) do nothing`;
        const rows = await tx<
          Row[]
        >`select record from allrice_outbound_approvals where scope_key=${record.scopeKey} and idempotency_key=${record.idempotencyKey}`;
        if (!rows[0] || rows[0].record.ref.digest !== record.ref.digest)
          throw new ApprovalError('CONFLICT');
        return rows[0].record;
      });
    },
    async get(id) {
      const rows = await sql<
        Row[]
      >`select record from allrice_outbound_approvals where request_id=${id}`;
      return rows[0]?.record ?? null;
    },
    decide(ref, actorId, decision) {
      return locked(ref, (record, now) => {
        if (record.revoked) throw new ApprovalError('REVOKED');
        if (
          record.intentAt ||
          (record.decision !== 'pending' && record.decision !== decision)
        )
          throw new ApprovalError('CONFLICT');
        if (record.decision === decision) return record;
        return { ...record, decision, decidedBy: actorId, decidedAt: now };
      });
    },
    revoke(ref) {
      return locked(ref, (record) => {
        if (record.intentAt) throw new ApprovalError('CONFLICT');
        return { ...record, revoked: true };
      });
    },
    async claim(ref) {
      let claimed = false;
      const record = await locked(ref, (record, now) => {
        if (record.revoked) throw new ApprovalError('REVOKED');
        if (record.decision !== 'approved')
          throw new ApprovalError('NOT_CONFIRMED');
        if (record.intentAt) return record;
        claimed = true;
        return { ...record, intentAt: now };
      });
      return { claimed, record };
    },
    receive(ref: ApprovalRef, receipt: ExternalReceipt) {
      return locked(ref, (record) => {
        if (!record.intentAt || receipt.digest !== record.ref.digest)
          throw new ApprovalError('CONFLICT');
        if (
          record.receipt &&
          (record.receipt.id !== receipt.id ||
            record.receipt.digest !== receipt.digest)
        )
          throw new ApprovalError('CONFLICT');
        return { ...record, receipt };
      });
    },
  };
}
