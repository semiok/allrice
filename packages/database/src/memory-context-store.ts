/** Memory-owned storage primitives, deliberately absent from the public barrel.
 * These locators/drafts are NOT authority or a proposed 271/273 API. A future
 * qualified owner transaction must supply the COMPLETE ordinary active set and
 * source qualification, then retain its current-authority/disclosure fence.
 * No production entrypoint or default qualification is installed here. */
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import {
  EmployeeModuleReleaseSchema,
  MemoryOrdinalInputSchema,
  PersonalMemoryPairSchema,
  RunMemoryContextV2StateSchema,
  UuidSchema,
  renderMemoryDetailV2,
  type RunMemoryContextV2State,
} from '@allrice/contracts';
import { lockEmployeeMemoryOrder } from './employee-memory-management.ts';
import { renderNativeMemoryIndexV2 } from './memory-context-render.ts';
import { MemoryContextError } from './run-memory-context.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import { memoryPairDigest } from './workspace/employee-memory-primitives.ts';

const MemoryContextStorageKeySchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    instanceId: UuidSchema,
    employeeId: UuidSchema,
    threadId: UuidSchema,
    budgetRef: z.string().min(1),
  })
  .strict();
export type MemoryContextStorageKey = z.infer<
  typeof MemoryContextStorageKeySchema
>;

const MemoryContextStorageOriginSchema = z
  .object({
    executionGeneration: z.literal('4.0'),
    nativeOwnerRef: z.string().min(1),
    nativeProfileRef: z.string().min(1),
    rootNativeSessionRef: z.string().min(1),
    moduleRelease: EmployeeModuleReleaseSchema,
    moduleConfigRevisionRef: z.string().min(1),
  })
  .strict();
export type MemoryContextStorageDraft = {
  origin: z.infer<typeof MemoryContextStorageOriginSchema>;
  document: string;
  state: RunMemoryContextV2State;
};
type StoredRow = {
  id: string;
  employee_id: string;
  thread_id: string;
  execution_generation: string;
  native_owner_ref: string;
  native_profile_ref: string;
  root_native_session_ref: string;
  module_release: unknown;
  module_config_revision_ref: string;
  document: string;
  state: unknown;
};

const unavailable = (): never => {
  throw new MemoryContextError('MEMORY_CONTEXT_UNAVAILABLE');
};

function parseState(raw: unknown, document: string) {
  const parsed = RunMemoryContextV2StateSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  const state = parsed.data;
  if (
    runtimePolicyDigest(state.pins) !== state.initial.digest ||
    runtimePolicyDigest(document) !== state.initial.documentDigest ||
    Buffer.byteLength(document, 'utf8') !== state.initial.bytes ||
    (state.toolReads === 0 && state.spentBytes !== state.initial.bytes)
  )
    return unavailable();
  return state;
}

async function lockContext(
  tx: TransactionSql,
  keyInput: MemoryContextStorageKey,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const key = MemoryContextStorageKeySchema.parse(keyInput);
  // Preserve the existing memory mutation lock order before locking any m/r.
  await lockEmployeeMemoryOrder(tx, key);
  signal.throwIfAborted();
  await tx`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
    'employee-memory-context',
    key.organizationId,
    key.workspaceId,
    key.ownerId,
    key.instanceId,
    key.budgetRef,
  ])},0))`;
  signal.throwIfAborted();
  const [row] = await tx<StoredRow[]>`
    select * from allrice_employee_memory_contexts
    where organization_id=${key.organizationId} and workspace_id=${key.workspaceId}
      and owner_id=${key.ownerId} and instance_id=${key.instanceId}
      and budget_ref=${key.budgetRef} for update`;
  signal.throwIfAborted();
  if (
    row &&
    (row.employee_id !== key.employeeId || row.thread_id !== key.threadId)
  )
    return unavailable();
  return { key, row };
}

/** Checks ONLY memory-owned row qualification and every issued historical pair.
 * Ordinary/source classification and current principal/module qualification
 * remain the upstream owner's missing transaction dependency. In particular,
 * this never queries shared Run/checkpoint/identity tables as a substitute. */
async function currentPairs(
  tx: TransactionSql,
  key: MemoryContextStorageKey,
  state: RunMemoryContextV2State,
  document: string,
  signal: AbortSignal,
  issuing = false,
) {
  signal.throwIfAborted();
  const rows = state.pins.length
    ? await tx<
        {
          id: string;
          current_revision: number;
          current_summary: string | null;
          current_details: string | null;
          revision: number;
          summary: string | null;
          details: string | null;
        }[]
      >`select m.id,m.revision current_revision,m.summary current_summary,
          m.details current_details,r.revision,r.summary,r.details
        from unnest(${state.pins.map((pin) => pin.id)}::uuid[],
          ${state.pins.map((pin) => pin.revision)}::integer[]) p(id,revision)
        join allrice_memories m on m.id=p.id
        join allrice_memory_revisions r on r.memory_id=m.id
          and r.organization_id=m.organization_id and r.workspace_id=m.workspace_id
          and r.revision=p.revision
        where m.organization_id=${key.organizationId} and m.workspace_id=${key.workspaceId}
          and m.owner_id=${key.ownerId} and m.instance_id=${key.instanceId}
          and m.employee_id=${key.employeeId} and m.visibility='private'
          and m.archived_at is null and m.lifecycle_state='durable'
          and m.trust_level='user_confirmed'
          and (m.expires_at is null or m.expires_at>clock_timestamp())
        order by m.id for share of m,r`
    : [];
  signal.throwIfAborted();
  if (rows.length !== state.pins.length) return unavailable();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pairs = state.pins.map((pin) => {
    const row = byId.get(pin.id);
    const parsed = PersonalMemoryPairSchema.safeParse(
      row && { summary: row.summary, details: row.details },
    );
    if (
      !row ||
      !parsed.success ||
      parsed.data.summary !== row.summary ||
      parsed.data.details !== row.details ||
      memoryPairDigest(parsed.data) !== pin.pairDigest ||
      (parsed.data.details !== null) !== pin.hasDetails ||
      (issuing &&
        (row.current_revision !== pin.revision ||
          row.current_summary !== row.summary ||
          row.current_details !== row.details))
    )
      return unavailable();
    return parsed.data;
  });
  if (
    renderNativeMemoryIndexV2(
      pairs.map((pair) => ({
        summary: pair.summary,
        hasDetails: pair.details !== null,
      })),
    ) !== document
  )
    return unavailable();
  return pairs;
}

async function validateStored(
  tx: TransactionSql,
  key: MemoryContextStorageKey,
  row: StoredRow,
  signal: AbortSignal,
) {
  const origin = MemoryContextStorageOriginSchema.safeParse({
    executionGeneration: row.execution_generation,
    nativeOwnerRef: row.native_owner_ref,
    nativeProfileRef: row.native_profile_ref,
    rootNativeSessionRef: row.root_native_session_ref,
    moduleRelease: row.module_release,
    moduleConfigRevisionRef: row.module_config_revision_ref,
  });
  if (!origin.success) return unavailable();
  const state = parseState(row.state, row.document);
  const pairs = await currentPairs(tx, key, state, row.document, signal);
  return {
    id: row.id,
    origin: origin.data,
    document: row.document,
    state,
    pairs,
  };
}

/** Insert once, including the empty index. An existing (S,B) ignores a new
 * draft/config/profile and restores the original pins and consumed budget.
 * The caller must await its real transaction commit before disclosing text. */
export async function issueMemoryContextStorage(
  tx: TransactionSql,
  keyInput: MemoryContextStorageKey,
  draft: MemoryContextStorageDraft,
  signal: AbortSignal,
) {
  const { key, row } = await lockContext(tx, keyInput, signal);
  if (row) {
    const { id, origin, document, state } = await validateStored(
      tx,
      key,
      row,
      signal,
    );
    signal.throwIfAborted();
    return { id, origin, document, state };
  }
  const origin = MemoryContextStorageOriginSchema.parse(draft.origin);
  const state = parseState(draft.state, draft.document);
  if (state.toolReads !== 0 || state.spentBytes !== state.initial.bytes)
    return unavailable();
  await currentPairs(tx, key, state, draft.document, signal, true);
  signal.throwIfAborted();
  const [inserted] = await tx<{ id: string }[]>`
    insert into allrice_employee_memory_contexts
      (organization_id,workspace_id,owner_id,instance_id,employee_id,budget_ref,
        thread_id,native_owner_ref,native_profile_ref,root_native_session_ref,
        execution_generation,module_release,module_config_revision_ref,document,state)
    values(${key.organizationId},${key.workspaceId},${key.ownerId},${key.instanceId},
      ${key.employeeId},${key.budgetRef},${key.threadId},${origin.nativeOwnerRef},
      ${origin.nativeProfileRef},${origin.rootNativeSessionRef},${origin.executionGeneration},
      ${tx.json(origin.moduleRelease)},${origin.moduleConfigRevisionRef},${draft.document},${tx.json(state)})
    returning id`;
  signal.throwIfAborted();
  return { id: inserted!.id, origin, document: draft.document, state };
}

/** No implicit issue, repair, reset or alternative budget key on refusal. Every
 * successful repeated ordinal disclosure costs its complete decoded UTF-8 text.
 * tx is internal to memory; this is not a cross-owner participation API. */
export async function readMemoryContextStorageOrdinal(
  tx: TransactionSql,
  keyInput: MemoryContextStorageKey,
  input: unknown,
  signal: AbortSignal,
) {
  const { number } = MemoryOrdinalInputSchema.parse(input);
  const { key, row } = await lockContext(tx, keyInput, signal);
  if (!row) return unavailable();
  const { state, pairs } = await validateStored(tx, key, row, signal);
  const pair = pairs[number - 1];
  if (!pair) return unavailable();
  const text = renderMemoryDetailV2(number, pair);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (
    state.toolReads >= state.limits.maximumToolReads ||
    bytes > state.limits.maximumResponseBytes ||
    state.spentBytes + bytes > state.limits.maximumRunBytes
  )
    throw new MemoryContextError('MEMORY_CONTEXT_BUDGET_EXHAUSTED');
  const next = RunMemoryContextV2StateSchema.parse({
    ...state,
    spentBytes: state.spentBytes + bytes,
    toolReads: state.toolReads + 1,
  });
  signal.throwIfAborted();
  await tx`update allrice_employee_memory_contexts set state=${tx.json(next)}
    where organization_id=${key.organizationId} and workspace_id=${key.workspaceId}
      and owner_id=${key.ownerId} and instance_id=${key.instanceId} and id=${row.id}`;
  signal.throwIfAborted();
  return text;
}
