import { createHash } from 'node:crypto';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalServiceEventSchema,
  RuntimeLocalServiceInputSchema,
  UuidSchema,
  canonicalRuntimeBridgeJson,
  runtimeContractEqual,
  type RuntimeLocalServiceEvent,
  type RuntimeOperationSnapshot,
  type RequestContext,
  type ExecutionContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  RuntimeLedgerError,
  type RuntimeLedgerTransaction,
} from './runtime-ledger/types.ts';
import { RuntimePolicyError } from './runtime-policy.ts';
import { ownedLocalCommandRun } from './local-command-service.ts';

type Tx = RuntimeLedgerTransaction;
type Database = ReturnType<typeof getDatabase>;
type ServiceActor = Pick<
  RequestContext,
  'organizationId' | 'workspaceId' | 'actor'
>;
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
export const localServiceFeatureEnabled = () =>
  process.env.ALLRICE_LOCAL_SERVICE_ENABLED === '1';
interface ServiceRow {
  operation_id: string;
  hard_deadline_at: Date;
  container_id: string | null;
  ready: boolean;
  state: 'starting' | 'ready' | 'waiting_input' | 'stopping';
  last_sequence: number;
  stop_requested: boolean;
}

/** Called only under the ledger's canonical root -> operation lock and lease check. */
export async function exchangeLocalServiceLocked(
  tx: Tx,
  input: {
    snapshot: RuntimeOperationSnapshot;
    payload: unknown;
    rootDeadlineAt: Date;
    events: RuntimeLocalServiceEvent[];
    allowed: boolean;
    deliveryOnly: boolean;
    now: Date;
  },
) {
  const { snapshot, now } = input;
  const operationId = snapshot.binding.attempt.operationId;
  const config = RuntimeLocalCommandSchema.parse(input.payload).arguments
    .background;
  if (!config || !localServiceFeatureEnabled())
    throw new RuntimeLedgerError('unavailable');
  let [service] = await tx<
    ServiceRow[]
  >`select * from allrice_local_services where operation_id=${operationId} for update`;
  if (!service) {
    if (!input.allowed || input.deliveryOnly)
      throw new RuntimeLedgerError('unavailable');
    await tx`select pg_advisory_xact_lock(hashtextextended(${snapshot.binding.execution.deviceId},809))`;
    const [active] = await tx<
      { n: number; same_run: number }[]
    >`select count(*)::int as n,count(*) filter(where o.run_id=${snapshot.binding.task.runId})::int as same_run from allrice_local_services s
      join allrice_runtime_operations o on o.id=s.operation_id
      where o.device_id=${snapshot.binding.execution.deviceId} and s.hard_deadline_at>clock_timestamp()
        and o.snapshot->>'status' in ('running','dispatched','cancel_requested')`;
    if ((active?.n ?? 0) >= 2 || (active?.same_run ?? 0) >= 1)
      throw new RuntimeLedgerError('unavailable');
    const deadline = new Date(
      Math.min(
        input.rootDeadlineAt.getTime(),
        now.getTime() + config.durationMs,
      ),
    );
    [service] = await tx<
      ServiceRow[]
    >`insert into allrice_local_services(operation_id,hard_deadline_at)
      values(${operationId},${deadline}) returning *`;
  }
  if (!service) throw new RuntimeLedgerError('unavailable');
  const stopRequested =
    !input.allowed || service.stop_requested || service.hard_deadline_at <= now;
  if (stopRequested) {
    await tx`update allrice_local_services set stop_requested=true,state='stopping' where operation_id=${operationId}`;
    service.stop_requested = true;
  }
  for (const raw of input.events) {
    const event = RuntimeLocalServiceEventSchema.parse(raw);
    if (
      event.processId !== operationId ||
      event.attemptId !== snapshot.binding.attempt.attemptId
    )
      throw new RuntimeLedgerError('scope_mismatch');
    const [prior] = await tx<
      { payload: unknown }[]
    >`select payload from allrice_local_service_events
      where operation_id=${operationId} and sequence=${event.sequence}`;
    if (prior) {
      if (!runtimeContractEqual(prior.payload, event))
        throw new RuntimeLedgerError('receipt_conflict');
      continue;
    }
    if (event.sequence !== service.last_sequence + 1)
      throw new RuntimeLedgerError('receipt_conflict');
    // Preserve late ordered facts so an earlier ready/prompt cannot block a
    // following pipe-delivery receipt. Never revive state or create new input.
    if (
      (stopRequested || input.deliveryOnly) &&
      event.type !== 'input_delivered'
    ) {
      if (
        event.type === 'starting' &&
        (event.hardDeadlineAt !== service.hard_deadline_at.toISOString() ||
          event.sequence !== 0)
      )
        throw new RuntimeLedgerError('receipt_conflict');
      if (event.type === 'ready' && event.port !== config.readiness.port)
        throw new RuntimeLedgerError('receipt_conflict');
      await tx`insert into allrice_local_service_events(operation_id,sequence,payload) values(${operationId},${event.sequence},${json(tx, event)})`;
      service.last_sequence = event.sequence;
      await tx`update allrice_local_services set last_sequence=${event.sequence} where operation_id=${operationId}`;
      continue;
    }
    if (event.type === 'starting') {
      if (
        service.container_id ||
        event.sequence !== 0 ||
        event.hardDeadlineAt !== service.hard_deadline_at.toISOString()
      )
        throw new RuntimeLedgerError('receipt_conflict');
      service.container_id = event.containerId;
      await tx`update allrice_local_services set container_id=${event.containerId} where operation_id=${operationId}`;
    } else if (event.type === 'ready') {
      if (
        !service.container_id ||
        event.port !== config.readiness.port ||
        service.ready
      )
        throw new RuntimeLedgerError('invalid_state');
      service.ready = true;
      service.state =
        service.state === 'waiting_input' ? 'waiting_input' : 'ready';
      await tx`update allrice_local_services set ready=true,state=${service.state} where operation_id=${operationId}`;
    } else if (event.type === 'input_request') {
      const request = event.request;
      const [count] = await tx<
        { n: number }[]
      >`select count(*)::int as n from allrice_local_service_inputs where operation_id=${operationId}`;
      const [pending] =
        await tx`select request_id from allrice_local_service_inputs where operation_id=${operationId}
        and delivery is null and (request->>'expiresAt')::timestamptz>clock_timestamp() limit 1`;
      if (
        !service.container_id ||
        config.stdin.mode !== 'requests-v1' ||
        pending ||
        request.sequence !== (count?.n ?? 0) ||
        request.sequence >= config.stdin.maxRequests ||
        request.maxBytes > config.stdin.maxBytes ||
        Date.parse(request.expiresAt) <= now.getTime() ||
        Date.parse(request.expiresAt) > service.hard_deadline_at.getTime() ||
        Date.parse(request.expiresAt) >
          now.getTime() + config.stdin.requestTimeoutMs + 1000
      )
        throw new RuntimeLedgerError('invalid_state');
      await tx`insert into allrice_local_service_inputs(operation_id,request_id,sequence,request)
        values(${operationId},${request.requestId},${request.sequence},${json(tx, request)})`;
      service.state = 'waiting_input';
      await tx`update allrice_local_services set state='waiting_input' where operation_id=${operationId}`;
    } else {
      const [row] = await tx<
        { input_payload: unknown; delivery: unknown }[]
      >`select input_payload,delivery from allrice_local_service_inputs
        where operation_id=${operationId} and request_id=${event.requestId} for update`;
      const delivered = RuntimeLocalServiceInputSchema.safeParse(
        row?.input_payload,
      );
      if (
        !delivered.success ||
        delivered.data.inputId !== event.inputId ||
        delivered.data.sequence !== event.inputSequence ||
        delivered.data.digest !== event.digest ||
        delivered.data.kind !== event.kind
      )
        throw new RuntimeLedgerError('receipt_conflict');
      await tx`update allrice_local_service_inputs set delivery=${json(tx, event)} where operation_id=${operationId} and request_id=${event.requestId}`;
      if (!stopRequested && !input.deliveryOnly) {
        service.state = service.ready ? 'ready' : 'starting';
        await tx`update allrice_local_services set state=${service.state} where operation_id=${operationId}`;
      }
    }
    await tx`insert into allrice_local_service_events(operation_id,sequence,payload) values(${operationId},${event.sequence},${json(tx, event)})`;
    service.last_sequence = event.sequence;
    await tx`update allrice_local_services set last_sequence=${event.sequence} where operation_id=${operationId}`;
  }
  const pending =
    stopRequested || input.deliveryOnly
      ? []
      : await tx<
          { input_payload: unknown }[]
        >`select input_payload from allrice_local_service_inputs
    where operation_id=${operationId} and input_payload is not null and delivery is null
      and (input_payload->>'expiresAt')::timestamptz>clock_timestamp() order by sequence`;
  return {
    hardDeadlineAt: service.hard_deadline_at.toISOString(),
    acceptedSequence: service.last_sequence,
    stopRequested,
    inputs: pending.map((r) =>
      RuntimeLocalServiceInputSchema.parse(r.input_payload),
    ),
  };
}

export async function readLocalService(
  operationId: string,
  database: Database = getDatabase(),
) {
  const [row] = await database<
    (ServiceRow & { snapshot: RuntimeOperationSnapshot })[]
  >`select s.*,o.snapshot from allrice_local_services s
    join allrice_runtime_operations o on o.id=s.operation_id where s.operation_id=${operationId}`;
  if (!row) return null;
  const requests = await database<
    { request: unknown; submitted: boolean; delivered: boolean }[]
  >`select request,input_payload is not null as submitted,
    delivery is not null as delivered from allrice_local_service_inputs where operation_id=${operationId} order by sequence`;
  const status = row.snapshot.status;
  const state = ['canceled', 'succeeded'].includes(status)
    ? 'stopped'
    : status === 'failed'
      ? 'failed'
      : status === 'unknown'
        ? 'unknown'
        : row.stop_requested || row.hard_deadline_at.getTime() <= Date.now()
          ? 'stopping'
          : row.state;
  return {
    processId: operationId,
    attemptId: row.snapshot.binding.attempt.attemptId,
    state,
    hardDeadlineAt: row.hard_deadline_at.toISOString(),
    containerId: row.container_id,
    visibility: 'container_only',
    ready: row.ready,
    stopRequested: row.stop_requested,
    requests,
  };
}

async function ownedService(
  context: ServiceActor,
  runId: string,
  processId: string,
  database: Database,
) {
  UuidSchema.parse(processId);
  await ownedLocalCommandRun(database, context, runId);
  const [row] =
    await database`select id from allrice_runtime_operations where id=${processId} and run_id=${runId}
    and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and bridge_payload->'arguments' ? 'background'`;
  if (!row) throw new RuntimePolicyError('operation_not_found');
}
export async function localServiceUserAction(
  context: ServiceActor,
  runId: string,
  processId: string,
  action: 'status' | 'stop' | 'input',
  input: unknown,
  database: Database = getDatabase(),
) {
  if (!localServiceFeatureEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  await ownedService(context, runId, processId, database);
  if (action === 'stop') {
    await database`update allrice_local_services set stop_requested=true,state='stopping' where operation_id=${processId}`;
  } else if (action === 'input') {
    const data = RuntimeLocalServiceInputSchema.parse(input);
    const digest = `sha256:${createHash('sha256')
      .update(canonicalRuntimeBridgeJson({ kind: data.kind, text: data.text }))
      .digest('hex')}`;
    if (data.digest !== digest) throw new RuntimePolicyError('identity_denied');
    await database.begin(async (tx) => {
      // Same canonical ordering as runtime ledger; user input cannot race cancellation/expiry.
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${runId} for update`;
      const [op] = await tx<
        { snapshot: RuntimeOperationSnapshot }[]
      >`select snapshot from allrice_runtime_operations where id=${processId} for update`;
      const [service] = await tx<
        ServiceRow[]
      >`select * from allrice_local_services where operation_id=${processId} for update`;
      const [r] = await tx<
        {
          request: { expiresAt: string; sequence: number; maxBytes: number };
          input_payload: unknown;
        }[]
      >`select request,input_payload from allrice_local_service_inputs
        where operation_id=${processId} and request_id=${data.requestId} for update`;
      if (r?.input_payload) {
        if (!runtimeContractEqual(r.input_payload, data))
          throw new RuntimePolicyError('identity_denied');
        return;
      }
      const [time] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
      const [activeRun] = await tx`select id from allrice_runs where id=${runId}
        and state in ('queued','running','waiting_approval') for share`;
      if (
        !service ||
        !activeRun ||
        !op ||
        !time ||
        !r ||
        service.stop_requested ||
        service.hard_deadline_at <= time.now ||
        op.snapshot.status !== 'running' ||
        op.snapshot.cancelRequestId ||
        Date.parse(data.expiresAt) <= time.now.getTime() ||
        data.expiresAt !== r.request.expiresAt ||
        data.sequence !== r.request.sequence ||
        Buffer.byteLength(data.text) > r.request.maxBytes
      )
        throw new RuntimePolicyError('operation_not_found');
      await tx`update allrice_local_service_inputs set input_id=${data.inputId},input_payload=${json(tx, data)} where operation_id=${processId} and request_id=${data.requestId}`;
    });
  }
  return readLocalService(processId, database);
}

export async function localServiceWorkerAction(
  context: ExecutionContext,
  processId: string,
  action: 'status' | 'stop',
  database: Database = getDatabase(),
) {
  const [run] =
    await database`select id from allrice_jobs where id=${context.jobId} and run_id=${context.runId}
    and worker_id=${context.worker.id} and status='running' and lease_expires_at>clock_timestamp() and cancel_requested_at is null`;
  if (!run) throw new RuntimePolicyError('operation_not_found');
  return localServiceUserAction(
    {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      actor: { type: 'user', id: context.policySnapshot.subjectId },
    },
    context.runId,
    processId,
    action,
    undefined,
    database,
  );
}
