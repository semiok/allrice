import {
  memoryInstanceForRun,
  memoryScopeForRun,
  memoryPairDigest,
} from './workspace/employee-memory.ts';
import { personalMemoryIndexReadPredicate } from './workspace/employee-memory-read.ts';
import type postgres from 'postgres';
import {
  RunMemoryContextV2StateSchema,
  EmployeeDocumentsV2Schema,
  PersonalMemoryPairSchema,
  MemoryOrdinalInputSchema,
  hasMemoryIndexReadTool,
  renderMemoryDetailV2,
  type RunMemoryContextV2State,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { employeeAccessTransaction } from './employees/employee-access-cancellation.ts';
import { resolveEmployeeSessionInstance } from './employees/employee-instances.ts';
import {
  assertMemoryWorker,
  MemoryWorkerAuthorityError,
  type MemoryRunScope,
  type MemoryWorker,
} from './memory-worker-authority.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

export class MemoryContextError extends Error {
  constructor(
    public readonly code:
      'MEMORY_CONTEXT_UNAVAILABLE' | 'MEMORY_CONTEXT_BUDGET_EXHAUSTED',
  ) {
    super(code);
  }
}
const unavailable = (): never => {
  throw new MemoryContextError('MEMORY_CONTEXT_UNAVAILABLE');
};
function parseState(raw: unknown) {
  const indexed = RunMemoryContextV2StateSchema.safeParse(raw);
  if (indexed.success) {
    if (runtimePolicyDigest(indexed.data.pins) !== indexed.data.initial.digest)
      return unavailable();
    return indexed.data;
  }
  return unavailable();
}
type Tx = postgres.TransactionSql;
export type RunMemoryAuthority = {
  scope: MemoryRunScope;
  worker: MemoryWorker;
};

/** Reuse the existing access transaction/lease guard. Serialize on the Run row
 * before reading accounting; no independent scheduler, lock service or ledger. */
async function withRun<T>(
  auth: RunMemoryAuthority,
  read: (tx: Tx, state: unknown) => Promise<T>,
) {
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await tx`set local statement_timeout='5s'`;
    await assertMemoryWorker(tx, auth.scope, auth.worker, true);
    const who = {
      actor: { type: 'user' as const, id: auth.scope.ownerId },
      organizationId: auth.scope.organizationId,
      workspaceId: auth.scope.workspaceId,
    };
    if (!(await readContentPrincipal(who, tx, true))) return unavailable();
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${who.organizationId}`},0))`;
    const [row] =
      await tx`select er.memory_context_state,er.employee_assignment_id,s.employee_instance_id,
        coalesce((er.execution_snapshot->'persona'->'source') ? 'task',false) task_source
      from allrice_employee_runs er join allrice_chat_sessions s on s.id=er.session_id
      and s.organization_id=er.organization_id and s.workspace_id=er.workspace_id and s.owner_id=er.owner_id
      where er.run_id=${auth.scope.runId} and s.archived_at is null`;
    if (!row || row.task_source) return unavailable();
    await resolveEmployeeSessionInstance(
      who,
      row.employee_assignment_id,
      row.employee_instance_id ?? undefined,
      tx,
    );
    const result = await read(tx, row.memory_context_state);
    await assertMemoryWorker(tx, auth.scope, auth.worker, true);
    return result;
  }).catch((error: unknown) => {
    // Keep the public memory refusal contract when the memory-owned lease
    // guard rejects; callers need not know about the retired experience guard.
    if (error instanceof MemoryWorkerAuthorityError) return unavailable();
    throw error;
  });
}

async function save(tx: Tx, runId: string, state: RunMemoryContextV2State) {
  parseState(state);
  await tx`update allrice_employee_runs set memory_context_state=${tx.json(state)} where run_id=${runId}`;
}

/** Initial assembly is frozen once. A resumed Worker cannot reset tool spend or
 * replace selected content with a new, unaccounted set. Current auth still runs. */
export async function prepareRunMemoryContext(
  auth: RunMemoryAuthority,
  document: string,
) {
  return withRun(auth, async (tx, raw) => {
    const state = parseState(raw);
    if (
      runtimePolicyDigest(document) !== state.initial.documentDigest ||
      Buffer.byteLength(document, 'utf8') !== state.initial.bytes
    )
      return unavailable();
    await assertMemoryIndexCurrent(tx, auth.scope, state);
    return [];
  });
}

async function assertMemoryIndexCurrent(
  sql: ReturnType<typeof getDatabase> | Tx,
  scope: MemoryRunScope,
  state: RunMemoryContextV2State,
) {
  const current = await memoryScopeForRun(sql, scope);
  if (!current) return unavailable();
  if (!state.pins.length) return current;
  const rows = await sql<{ id: string }[]>`select m.id from allrice_memories m
    where m.id=any(${state.pins.map((pin) => pin.id)}::uuid[])
      and ${personalMemoryIndexReadPredicate(sql, current)}`;
  if (new Set(rows.map((row) => row.id)).size !== state.pins.length)
    return unavailable();
  return current;
}

/** A single complete decoded text result, admitted atomically on the existing
 * Run ledger. Ordinals never authorize another Run, instance or revision. */
export async function readRunMemoryOrdinal(
  auth: RunMemoryAuthority,
  input: unknown,
) {
  const { number } = MemoryOrdinalInputSchema.parse(input);
  return withRun(auth, async (tx, raw) => {
    const state = parseState(raw);
    const [run] =
      await tx`select execution_snapshot,prompt_snapshot->'employeeDocuments' documents
      from allrice_employee_runs where run_id=${auth.scope.runId}`;
    const documents = EmployeeDocumentsV2Schema.safeParse(run?.documents);
    if (
      !hasMemoryIndexReadTool(run?.execution_snapshot) ||
      !documents.success ||
      runtimePolicyDigest(documents.data.memory) !==
        state.initial.documentDigest ||
      Buffer.byteLength(documents.data.memory, 'utf8') !== state.initial.bytes
    )
      return unavailable();
    const pin = state.pins.find((entry) => entry.number === number);
    if (!pin) return unavailable();
    const current = await assertMemoryIndexCurrent(tx, auth.scope, state);
    const [row] = await tx<
      { summary: string | null; details: string | null }[]
    >`
      select r.summary,r.details from allrice_memories m
      join allrice_memory_revisions r on r.memory_id=m.id and r.organization_id=m.organization_id
        and r.workspace_id=m.workspace_id and r.revision=${pin.revision}
      where m.id=${pin.id} and ${personalMemoryIndexReadPredicate(tx, current)}`;
    const pair = PersonalMemoryPairSchema.safeParse(
      row && { summary: row.summary, details: row.details },
    );
    if (
      !pair.success ||
      pair.data.summary !== row!.summary ||
      pair.data.details !== row!.details ||
      memoryPairDigest(pair.data) !== pin.pairDigest ||
      (pair.data.details !== null) !== pin.hasDetails
    )
      return unavailable();
    const text = renderMemoryDetailV2(number, pair.data);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (
      state.toolReads >= state.limits.maximumToolReads ||
      bytes > state.limits.maximumResponseBytes ||
      state.spentBytes + bytes > state.limits.maximumRunBytes
    )
      throw new MemoryContextError('MEMORY_CONTEXT_BUDGET_EXHAUSTED');
    await save(tx, auth.scope.runId, {
      ...state,
      spentBytes: state.spentBytes + bytes,
      toolReads: state.toolReads + 1,
    });
    return text;
  });
}

/** Read-only companion to the existing live Run/lease admission. An ordinary
 * edit keeps its issued revision; loss of current eligibility stops the Run.
 * No read locks, new allowance, history rewrite or silent snapshot replacement. */
export async function assertRunMemoryContextCurrent(scope: MemoryRunScope) {
  const sql = getDatabase();
  const instanceId = await memoryInstanceForRun(sql, scope);
  if (!instanceId) return unavailable();
  const [run] = await sql`select memory_context_state from allrice_employee_runs
    where run_id=${scope.runId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and session_id=${scope.sessionId}`;
  const state = parseState(run?.memory_context_state);
  await assertMemoryIndexCurrent(sql, scope, state);
}
