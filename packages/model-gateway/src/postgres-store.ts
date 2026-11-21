import type postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { ModelGatewayError, MODEL_STREAMS_PER_PERSON } from './contract.ts';
import type {
  ModelCallBinding,
  ModelGatewayStore,
  ModelAttemptStart,
  ModelAttemptReceipt,
} from './contract.ts';
import { summarizeAttempts, unknownUsage } from './usage.ts';

const CHANNEL = 'allrice_model_gateway_capacity';
type AttemptRow = {
  id: string;
  call_id: string;
  person_id: string;
  owner_id: string;
  kind: ModelAttemptStart['kind'];
  protocol: ModelAttemptStart['protocol'];
  receipt: ModelAttemptReceipt | null;
};
const fromRow = (r: AttemptRow): ModelAttemptReceipt =>
  r.receipt ?? {
    id: r.id,
    callId: r.call_id,
    personId: r.person_id,
    ownerId: r.owner_id,
    kind: r.kind,
    protocol: r.protocol,
    dispatchObserved: null,
    httpStatus: null,
    terminal: null,
    outcome: 'unknown',
    usage: unknownUsage(),
  };
export function nativeCallKey(binding: ModelCallBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        binding.vm.vmId,
        binding.vm.instanceId,
        binding.vm.leaseEpoch,
        binding.native.instanceId,
        binding.native.sessionId,
        binding.native.callId,
      ]),
    )
    .digest('hex');
}

/** Caller owns the pool and its lifecycle. All SQL touches only this owner's
 * three tables; no joins into identity, employee, Run or billing internals. */
export function createPostgresModelGatewayStore(
  db: postgres.Sql,
): ModelGatewayStore {
  const json = (value: unknown) =>
    db.json(JSON.parse(JSON.stringify(value)) as postgres.JSONValue);
  return {
    async claimCall(binding, requestDigest) {
      const id = randomUUID();
      const rows = await db<
        { id: string }[]
      >`insert into allrice_model_gateway_calls
        (id,native_key,person_id,organization_id,binding,request_digest)
        values(${id},${nativeCallKey(binding)},${binding.vm.personId},${binding.vm.organizationId},
          ${json(binding)},${requestDigest}) on conflict(native_key) do nothing returning id`;
      if (!rows.length) throw new ModelGatewayError('DUPLICATE_CALL');
      return id;
    },
    async watchCapacity(personId, signal) {
      signal.throwIfAborted();
      let notified = false;
      let wake: (() => void) | undefined;
      const pulse = () => {
        notified = true;
        wake?.();
        wake = undefined;
      };
      const listener = await db.listen(
        CHANNEL,
        (person) => {
          if (person === personId) pulse();
        },
        pulse,
      );
      signal.addEventListener('abort', pulse);
      // A disconnect/reconnect loses notifications; postgres' onlisten callback
      // must wake the waiter for an atomic recheck after every reconnect.
      return {
        async wait() {
          signal.throwIfAborted();
          if (!notified)
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (signal.aborted) pulse();
            });
          notified = false;
          signal.throwIfAborted();
        },
        async close() {
          signal.removeEventListener('abort', pulse);
          pulse();
          await listener.unlisten();
        },
      };
    },
    async tryStartAttempt(attempt) {
      return db.begin(async (tx) => {
        // Same global person key across gateways, tenants, Runs and native children.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`model-gateway:${attempt.personId}`},0))`;
        const [call] = await tx<
          { person_id: string }[]
        >`select person_id from allrice_model_gateway_calls where id=${attempt.callId}`;
        if (!call || call.person_id !== attempt.personId)
          throw new ModelGatewayError('BINDING_INVALID');
        let slot: number | null = null;
        if (attempt.kind === 'model') {
          const [free] = await tx<
            { slot: number }[]
          >`select n as slot from generate_series(1,${MODEL_STREAMS_PER_PERSON}) n
            where not exists(select 1 from allrice_model_gateway_slots s where s.person_id=${attempt.personId} and s.slot=n)
            order by n limit 1`;
          if (!free) return false;
          slot = free.slot;
        }
        await tx`insert into allrice_model_gateway_attempts(id,call_id,person_id,owner_id,kind,protocol)
          values(${attempt.id},${attempt.callId},${attempt.personId},${attempt.ownerId},${attempt.kind},${attempt.protocol})`;
        if (slot !== null)
          await tx`insert into allrice_model_gateway_slots(person_id,slot,attempt_id,owner_id)
          values(${attempt.personId},${slot},${attempt.id},${attempt.ownerId})`;
        return true;
      }) as Promise<boolean>;
    },
    async finishAttempt(receipt) {
      await db.begin(async (tx) => {
        const [row] = await tx<
          AttemptRow[]
        >`select * from allrice_model_gateway_attempts where id=${receipt.id} for update`;
        if (
          !row ||
          row.call_id !== receipt.callId ||
          row.person_id !== receipt.personId ||
          row.owner_id !== receipt.ownerId ||
          row.kind !== receipt.kind ||
          row.protocol !== receipt.protocol
        )
          throw new ModelGatewayError('BINDING_INVALID');
        if (row.receipt) {
          const [same] = await tx<
            { same: boolean }[]
          >`select receipt=${json(receipt)} as same from allrice_model_gateway_attempts where id=${receipt.id}`;
          if (!same?.same) throw new ModelGatewayError('LEDGER_UNAVAILABLE');
          return;
        }
        await tx`update allrice_model_gateway_attempts set receipt=${json(receipt)},closed_at=clock_timestamp() where id=${receipt.id}`;
        await tx`delete from allrice_model_gateway_slots where attempt_id=${receipt.id} and owner_id=${receipt.ownerId}`;
        await tx`select pg_notify(${CHANNEL},${receipt.personId})`;
      });
    },
    async attempts(callId) {
      return (
        await db<
          AttemptRow[]
        >`select * from allrice_model_gateway_attempts where call_id=${callId} order by intent_at,id`
      ).map(fromRow);
    },
    async usage(personId, organizationId) {
      return summarizeAttempts(
        (
          await db<
            AttemptRow[]
          >`select a.* from allrice_model_gateway_attempts a
        join allrice_model_gateway_calls c on c.id=a.call_id
        where c.person_id=${personId} and c.organization_id=${organizationId}`
        ).map(fromRow),
      );
    },
    async reconcileOwner(ownerId, evidenceRef) {
      if (!evidenceRef.trim())
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      return db.begin(async (tx) => {
        const rows = await tx<
          AttemptRow[]
        >`select * from allrice_model_gateway_attempts
          where owner_id=${ownerId} and closed_at is null order by id for update`;
        for (const row of rows) {
          const receipt = fromRow(row);
          await tx`update allrice_model_gateway_attempts set receipt=${json(receipt)},closed_at=clock_timestamp(),
            recovery_evidence_ref=${evidenceRef} where id=${row.id}`;
          await tx`delete from allrice_model_gateway_slots where attempt_id=${row.id} and owner_id=${ownerId}`;
          await tx`select pg_notify(${CHANNEL},${row.person_id})`;
        }
        return rows.length;
      }) as Promise<number>;
    },
  };
}
