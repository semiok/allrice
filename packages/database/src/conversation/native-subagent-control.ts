import {
  NativeSubagentControlInputSchema,
  NativeSubagentControlRequestSchema,
  NativeSubagentControlResultSchema,
  UuidSchema,
  runtimeContractEqual,
  type NativeSubagentControlInput,
  type NativeSubagentControlRequest,
  type NativeSubagentControlResult,
  type NativeSubagentControlTicket,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { assertWorkbenchSession } from '../artifact-review.ts';
import {
  assertNativeRunAuthorityTransaction,
  type RunDeliveryAuthority,
} from '../run-delivery-authority.ts';
import { readSessionNativeSubagentTarget } from './native-subagent-query.ts';

type Reader = Parameters<typeof assertWorkbenchSession>[0];
type Principal = Parameters<typeof assertWorkbenchSession>[1];
interface CommandRow {
  id: string;
  native_input: unknown;
  native_proof: unknown;
  state: string;
  error_code: string | null;
}
function unavailable(): never {
  throw Error('CHILD_CONTROL_UNAVAILABLE');
}
function conflict(): never {
  throw Error('CHILD_CONTROL_CONFLICT');
}
function ticket(row: CommandRow): NativeSubagentControlTicket {
  const request = NativeSubagentControlRequestSchema.parse(row.native_input);
  const result = row.native_proof
    ? NativeSubagentControlResultSchema.parse(row.native_proof)
    : row.state === 'pending'
      ? { status: 'recorded' as const }
      : row.state === 'claimed' || row.error_code === 'INPUT_OUTCOME_UNKNOWN'
        ? { status: 'unknown' as const }
        : {
            status: 'rejected' as const,
            code: row.error_code ?? 'CHILD_CONTROL_UNAVAILABLE',
          };
  return { requestId: row.id, kind: request.input.kind, result };
}
async function readCommand(
  db: Reader,
  context: Principal,
  sessionId: string,
  requestId: string,
) {
  await assertWorkbenchSession(db, context, sessionId, false, false);
  const [row] = await db<
    CommandRow[]
  >`select * from allrice_conversation_commands
    where id=${UuidSchema.parse(requestId)} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId} and session_id=${sessionId}
      and owner_id=${context.actor.id} and command_type in ('child_prompt','child_interrupt')`;
  return row;
}

/** Internal reader: Web may expose ticket only, never the frozen storage pin. */
export async function getNativeSubagentControl(
  context: Principal,
  sessionId: string,
  requestId: string,
) {
  const row = await readCommand(getDatabase(), context, sessionId, requestId);
  return row
    ? {
        request: NativeSubagentControlRequestSchema.parse(row.native_input),
        ticket: ticket(row),
      }
    : null;
}

export async function enqueueNativeSubagentControl(
  context: Principal,
  sessionId: string,
  expected: {
    rootRunId: string;
    generation: number;
    input: NativeSubagentControlInput;
  },
): Promise<NativeSubagentControlTicket> {
  const input = NativeSubagentControlInputSchema.parse(expected.input);
  const rootRunId = UuidSchema.parse(expected.rootRunId).toLowerCase();
  return getDatabase().begin(async (tx) => {
    const reuse = (row: CommandRow) => {
      const saved = NativeSubagentControlRequestSchema.parse(row.native_input);
      if (
        saved.scope.rootRunId !== rootRunId ||
        saved.scope.generation !== expected.generation ||
        !runtimeContractEqual(saved.input, input)
      )
        conflict();
      return ticket(row);
    };
    const existing = await readCommand(tx, context, sessionId, input.requestId);
    if (existing) return reuse(existing);
    // Resolve incarnation on the server. The shared predicate subsequently
    // locks Job -> user -> Run/runtime and checks again after lock waits.
    const [job] =
      await tx`select j.id,j.worker_id,j.lease_token,j.attempt,r.project_id
      from allrice_conversation_runtimes c
      join allrice_jobs j on j.run_id=c.active_run_id and j.worker_id=c.worker_id
      join allrice_runs r on r.id=j.run_id
      where c.session_id=${sessionId} and c.organization_id=${context.organizationId}
        and c.workspace_id=${context.workspaceId} and c.owner_id=${context.actor.id}
        and c.active_run_id=${rootRunId} and c.thread_generation=${expected.generation}
        and c.state='running' and j.status='running'`;
    if (!job) unavailable();
    const authority = {
      scope: {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId!,
        projectId: job.project_id,
      },
      rootRunId,
      worker: {
        jobId: job.id,
        workerId: job.worker_id,
        leaseToken: job.lease_token,
        generation: expected.generation,
        attempt: job.attempt,
      },
    };
    await assertNativeRunAuthorityTransaction(tx, authority);
    const pin = await readSessionNativeSubagentTarget(tx, {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId!,
      ownerId: context.actor.id,
      sessionId,
    });
    const request = NativeSubagentControlRequestSchema.parse({
      input,
      scope: {
        rootRunId,
        generation: expected.generation,
        jobId: job.id,
        jobAttempt: job.attempt,
        nativeRootId: pin.descriptor.nativeSessionId,
        rootOriginDigest: pin.rootOriginDigest,
        storageNamespace: pin.descriptor.storageNamespace,
      },
    });
    await tx`insert into allrice_conversation_commands
      (id,organization_id,workspace_id,session_id,owner_id,command_type,expected_generation,target_run_id,native_input)
      values(${input.requestId},${context.organizationId},${context.workspaceId},${sessionId},${context.actor.id},
        ${'child_' + input.kind},${expected.generation},${rootRunId},${tx.json(request)})
      on conflict(id) do nothing`;
    const row = await readCommand(tx, context, sessionId, input.requestId);
    if (!row) unavailable();
    await assertNativeRunAuthorityTransaction(tx, authority);
    return reuse(row);
  });
}

/** First claim only. No stale reclaim, defer, followup or native dispatch. */
export async function claimNativeSubagentControl(
  input: RunDeliveryAuthority,
): Promise<NativeSubagentControlRequest | null> {
  return getDatabase().begin(async (tx) => {
    const authority = await assertNativeRunAuthorityTransaction(tx, input);
    const pin = await readSessionNativeSubagentTarget(tx, {
      organizationId: input.scope.organizationId,
      workspaceId: input.scope.workspaceId,
      ownerId: authority.ownerId,
      sessionId: authority.task.chatSessionId!,
    });
    const rows = await tx<
      CommandRow[]
    >`update allrice_conversation_commands set state='claimed',
      worker_id=${input.worker.workerId},claimed_at=clock_timestamp(),updated_at=clock_timestamp(),delivery_attempts=1
      where id=(select id from allrice_conversation_commands
        where organization_id=${input.scope.organizationId} and workspace_id=${input.scope.workspaceId}
          and session_id=${authority.task.chatSessionId} and target_run_id=${input.rootRunId}
          and expected_generation=${input.worker.generation} and state='pending' and delivery_attempts=0
          and command_type in ('child_prompt','child_interrupt')
          and native_input#>>'{scope,jobId}'=${input.worker.jobId.toLowerCase()}
          and native_input#>>'{scope,jobAttempt}'=${String(input.worker.attempt)}
          and native_input#>>'{scope,nativeRootId}'=${authority.nativeSessionId}
          and native_input#>>'{scope,rootOriginDigest}'=${pin.rootOriginDigest}
          and native_input#>>'{scope,storageNamespace}'=${pin.descriptor.storageNamespace}
        order by created_at,id for update skip locked limit 1)
      returning *`;
    // The row lock can wait too: do not issue a ticket past a deadline.
    await assertNativeRunAuthorityTransaction(tx, input);
    return rows[0]
      ? NativeSubagentControlRequestSchema.parse(rows[0].native_input)
      : null;
  });
}

/** Trusted native observer only; never bind result from HTTP/user JSON.
 * Read authority and the immutable original request permit late positive
 * evidence after root closure. This operation grants no execution permission. */
export async function recordNativeSubagentControlResult(
  context: Principal,
  sessionId: string,
  expected: NativeSubagentControlRequest,
  observation: NativeSubagentControlResult,
) {
  const request = NativeSubagentControlRequestSchema.parse(expected);
  const result = NativeSubagentControlResultSchema.parse(observation);
  if (
    result.status === 'accepted' &&
    (result.acceptance.kind !== request.input.kind ||
      (result.source.kind === 'user_rpc' &&
        (result.acceptance.kind !== 'prompt' ||
          result.source.rpcId !== request.input.requestId)))
  )
    conflict();
  return getDatabase().begin(async (tx) => {
    const original = await readCommand(
      tx,
      context,
      sessionId,
      request.input.requestId,
    );
    if (!original || !runtimeContractEqual(original.native_input, request))
      conflict();
    const [row] = await tx<
      CommandRow[]
    >`select * from allrice_conversation_commands
      where id=${request.input.requestId} for update`;
    if (!row || !runtimeContractEqual(row.native_input, request)) conflict();
    if (row.native_proof) {
      const prior = NativeSubagentControlResultSchema.parse(row.native_proof);
      if (
        result.status === 'accepted' &&
        prior.status === 'accepted' &&
        !runtimeContractEqual(prior.acceptance, result.acceptance)
      )
        conflict();
      return ticket(row);
    }
    if (
      row.state !== 'claimed' &&
      !(
        row.state === 'rejected' &&
        row.error_code === 'INPUT_OUTCOME_UNKNOWN' &&
        result.status === 'accepted'
      )
    )
      return ticket(row);
    const [saved] = await tx<CommandRow[]>`update allrice_conversation_commands
      set state=${result.status === 'accepted' ? 'consumed' : 'rejected'},
        native_proof=${result.status === 'accepted' ? tx.json(result) : null},
        error_code=${result.status === 'accepted' ? null : result.status === 'unknown' ? 'INPUT_OUTCOME_UNKNOWN' : result.code},
        consumed_at=${result.status === 'accepted' ? tx`clock_timestamp()` : tx`null`},updated_at=clock_timestamp()
      where id=${row.id} returning *`;
    return ticket(saved!);
  });
}
