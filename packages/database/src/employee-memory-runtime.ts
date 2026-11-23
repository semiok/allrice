/** Memory-owned native operations. Workflow's original dedicated caller owns
 * begin/commit/rollback/end; its private source binding owns G5 join/cleanup.
 * No SQL/tx/registry/factory is exported through the business port. Production
 * assembly is absent; the complete path is exercised with explicit owner
 * contract fixtures, never claimed as a real module/B/native producer. */
import {
  ActualNativeCallSelectorProjectionSchema,
  ActualNativeExecutionSelectorProjectionSchema,
  AdoptedHumanSourceProjectionSchema,
  CurrentEmployeeBusinessProjectionSchema,
  BuiltinEmployeeModuleRequirementProjectionSchema,
  LogicalExecutionBindingProjectionSchema,
  OrdinaryOriginClassificationProjectionSchema,
  PersonalMemoryPairSchema,
  RememberPersonalMemoryInputSchema,
  RunMemoryContextV2StateSchema,
  StoredHumanSourceSelectorProjectionSchema,
  UuidSchema,
  memoryIndexPolicy,
  type CurrentEmployeeBusinessProjection,
  type EmployeeBusinessTargetProjection,
  type RequestContext,
} from '@allrice/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { getDatabase } from './core/client.ts';
import {
  bindCallerSourceQueries,
  closeCallerSourceQueries,
  withDedicatedCallerTransaction,
} from './business-runtime/caller-transaction.ts';
import { DataAccessError } from './data.ts';
import { lockEmployeeMemoryOrder } from './employee-memory-management.ts';
import { renderNativeMemoryIndexV2 } from './memory-context-render.ts';
import {
  issueMemoryContextStorage,
  readMemoryContextStorageOrdinal,
  type MemoryContextStorageDraft,
} from './memory-context-store.ts';
import {
  memoryBusinessScope,
  nativeMemoryMetadataKey,
  nativeMemorySource,
  requireStoredNativeMemorySource,
  sameMemoryBusinessScope,
  sourceMetadata,
  type NativeMemorySource,
} from './memory-native-source.ts';
import {
  MemoryRuntimeModuleOriginSchema,
  requireMemoryRuntimeAssembly,
  type MemoryRuntimeExecution,
  type MemoryRuntimeOwnerReads,
} from './memory-runtime-binding.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import { MemoryContextError } from './run-memory-context.ts';
import {
  EmployeeMemoryContractChanged,
  employeeMemoryScope,
  memoryContentDigest,
  memoryOperation,
  type EmployeeMemoryScope,
} from './workspace/employee-memory.ts';
import {
  memoryPairDigest,
  memoryScopePredicate,
} from './workspace/employee-memory-primitives.ts';
import { insertEmployeeMemoryPair } from './workspace/employee-memory-mutation.ts';

/** Host selector only, never model input or transferable authority. Builtin
 * availability is application policy, not an independently released module.
 * Original current rights and actual config/execution remain separate facts. */
const memoryModule = BuiltinEmployeeModuleRequirementProjectionSchema.extend({
  moduleId: z.literal('employee-memory'),
}).strict();
export const NativeMemoryTargetSchema =
  ActualNativeExecutionSelectorProjectionSchema.extend({
    module: memoryModule,
  }).strict();
export type NativeMemoryTarget = z.input<typeof NativeMemoryTargetSchema>;
export const NativeMemoryReconcileTargetSchema =
  StoredHumanSourceSelectorProjectionSchema.extend({
    module: memoryModule,
  }).strict();
export type NativeMemoryReconcileTarget = z.input<
  typeof NativeMemoryReconcileTargetSchema
>;

const CandidateReceiptSchema = z
  .object({
    id: UuidSchema,
    revision: z.number().int().positive(),
    pairDigest: z.string(),
    summary: PersonalMemoryPairSchema.shape.summary,
    memoryClass: RememberPersonalMemoryInputSchema.shape.memoryClass,
    state: z.literal('pending'),
    requiresConfirmation: z.literal(true),
  })
  .strict();
const denied = (): never => {
  throw new DataAccessError('authorization_denied');
};
const unavailable = (): never => {
  throw new MemoryContextError('MEMORY_CONTEXT_UNAVAILABLE');
};
const ExecutionFactSchema = z
  .object({
    binding: LogicalExecutionBindingProjectionSchema,
    nativeOwnerRef: z.string().min(1),
    nativeProfileRef: z.string().min(1),
    nativeSessionRef: z.string().min(1),
    parentSessionRef: z.string().min(1).nullable(),
    moduleConfigRevisionRef: z.string().min(1),
    moduleOrigin: MemoryRuntimeModuleOriginSchema,
  })
  .strict();

function currentTarget(
  target:
    | z.output<typeof NativeMemoryTargetSchema>
    | z.output<typeof NativeMemoryReconcileTargetSchema>,
): EmployeeBusinessTargetProjection {
  return {
    workspaceId:
      'scope' in target ? target.scope.workspaceId : target.workspaceId,
    employeeInstanceId:
      'scope' in target
        ? target.scope.employeeInstanceId
        : target.employeeInstanceId,
    threadId: target.threadId,
    access: 'execute',
    module: target.module,
  };
}
function requireCurrent(
  context: RequestContext,
  target: EmployeeBusinessTargetProjection,
  input: unknown,
) {
  const fact = CurrentEmployeeBusinessProjectionSchema.parse(input);
  if (
    context.actor.type !== 'user' ||
    fact.scope.organizationId !== context.organizationId.toLowerCase() ||
    fact.scope.ownerId !== context.actor.id.toLowerCase() ||
    (context.workspaceId !== null &&
      fact.scope.workspaceId !== context.workspaceId.toLowerCase()) ||
    fact.scope.workspaceId !== target.workspaceId ||
    fact.scope.employeeInstanceId !== target.employeeInstanceId ||
    fact.threadId !== target.threadId ||
    fact.access !== 'execute' ||
    fact.executionGeneration !== '4.0' ||
    fact.module.kind !== 'builtin' ||
    target.module.kind !== 'builtin' ||
    fact.module.moduleId !== 'employee-memory' ||
    target.module.moduleId !== fact.module.moduleId
  )
    return denied();
  return fact;
}
function requireExecution(
  scope: EmployeeMemoryScope,
  target: EmployeeBusinessTargetProjection,
  input: MemoryRuntimeExecution,
) {
  const execution = ExecutionFactSchema.parse(input),
    binding = execution.binding;
  if (
    !sameMemoryBusinessScope(binding.scope, memoryBusinessScope(scope)) ||
    binding.threadId !== target.threadId ||
    (binding.nativeCall !== null &&
      (binding.nativeCall.sessionRef !== execution.nativeSessionRef ||
        binding.nativeCall.parentSessionRef !== execution.parentSessionRef))
  )
    return denied();
  return execution;
}
function callSelector(execution: MemoryRuntimeExecution) {
  const binding = execution.binding;
  if (!binding.nativeCall || binding.nativeCall.toolId !== 'memory_remember')
    return denied();
  return ActualNativeCallSelectorProjectionSchema.parse({
    scope: binding.scope,
    threadId: binding.threadId,
    b: binding.b,
    executionBoundaryRef: binding.executionBoundaryRef,
    rootOriginRef: binding.rootOriginRef,
    nativeCall: binding.nativeCall,
  });
}
function requireSource(
  selector: z.output<typeof ActualNativeCallSelectorProjectionSchema>,
  input: unknown,
) {
  const source = AdoptedHumanSourceProjectionSchema.parse(input);
  const observed = ActualNativeCallSelectorProjectionSchema.parse({
    scope: source.scope,
    threadId: source.threadId,
    b: source.b,
    executionBoundaryRef: source.executionBoundaryRef,
    rootOriginRef: source.rootOriginRef,
    nativeCall: source.nativeCall,
  });
  const expected = ActualNativeCallSelectorProjectionSchema.parse({
    scope: selector.scope,
    threadId: selector.threadId,
    b: selector.b,
    executionBoundaryRef: selector.executionBoundaryRef,
    rootOriginRef: selector.rootOriginRef,
    nativeCall: selector.nativeCall,
  });
  if (JSON.stringify(observed) !== JSON.stringify(expected)) return denied();
  return source;
}

/** Independent native namespace. Content, source proof and current revisions
 * do not change this original-call key. Opaque original refs retain all bytes.
 * This is memory's operation identity, not a claimed producer key format. */
export function nativeMemoryOperationKey(source: NativeMemorySource) {
  const c = source.nativeCall;
  return `candidate:native:v1:${memoryContentDigest(
    JSON.stringify([
      source.canonicalTool,
      source.b,
      source.nativeOwnerRef,
      source.nativeProfileRef,
      source.threadId,
      source.executionBoundaryRef,
      source.rootOriginRef,
      c.rootSessionRef,
      c.parentSessionRef,
      c.sessionRef,
      c.callRef,
      c.toolId,
      c.toolVersion,
    ]),
  )}`;
}

type BoundMemory = {
  tx: Sql;
  scope: EmployeeMemoryScope;
  reads: MemoryRuntimeOwnerReads;
  sources: ReturnType<typeof bindCallerSourceQueries>;
  current: CurrentEmployeeBusinessProjection;
};
async function caller<T>(
  context: RequestContext,
  target: EmployeeBusinessTargetProjection,
  signal: AbortSignal,
  work: (bound: BoundMemory) => Promise<T>,
) {
  signal.throwIfAborted();
  const assembly = requireMemoryRuntimeAssembly();
  // No business SQL is started if the real external module/current producer
  // is unavailable. A DTO precheck is not used as the transaction's authority.
  requireCurrent(
    context,
    target,
    await assembly.current(context, target, signal),
  );
  signal.throwIfAborted();
  return withDedicatedCallerTransaction(
    getDatabase(),
    async (tx) => {
      const scope = await employeeMemoryScope(
        context,
        target.workspaceId,
        target.employeeInstanceId,
        tx,
        true,
      );
      const reads = await assembly.bind(tx, context, target, signal);
      const current = requireCurrent(context, target, await reads.current());
      if (!sameMemoryBusinessScope(current.scope, memoryBusinessScope(scope)))
        return denied();
      signal.throwIfAborted();
      // Preserve foreground scope -> memory order -> context/source -> receipt
      // -> m/r order. All locks survive until Workflow's outer commit/rollback.
      await lockEmployeeMemoryOrder(tx, scope);
      const sources = bindCallerSourceQueries(tx, scope, signal);
      let failure: { error: unknown } | null = null;
      try {
        return await work({ tx, scope, reads, sources, current });
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeCallerSourceQueries(sources, failure);
      }
    },
    signal,
  );
}
function qualifier(bound: BoundMemory, signal: AbortSignal) {
  return async (origin: {
    source_type: string;
    source_id: string | null;
    metadata: unknown;
  }) => {
    const fact = OrdinaryOriginClassificationProjectionSchema.parse(
      await bound.sources.classifyMemoryOrigin({
        sourceType: origin.source_type,
        sourceId: origin.source_id,
      }),
    );
    signal.throwIfAborted();
    if (
      fact.sourceCheck !==
      (['message', 'checkpoint'].includes(origin.source_type)
        ? 'checked'
        : 'not-applicable')
    )
      return denied();
    if (fact.excludedByMethodAuthoring) return false;
    if (nativeMemorySource(origin.metadata))
      await requireStoredNativeMemorySource(
        bound.reads,
        bound.scope,
        origin,
        signal,
      );
    return true;
  };
}
async function executionFor(
  bound: BoundMemory,
  target: z.output<typeof NativeMemoryTargetSchema>,
  signal: AbortSignal,
) {
  const selector = ActualNativeExecutionSelectorProjectionSchema.parse({
    workspaceId: target.workspaceId,
    employeeInstanceId: target.employeeInstanceId,
    threadId: target.threadId,
    nativeRequestRef: target.nativeRequestRef,
  });
  const execution = requireExecution(
    bound.scope,
    currentTarget(target),
    await bound.reads.actual(selector),
  );
  signal.throwIfAborted();
  return execution;
}
function storageKey(bound: BoundMemory, execution: MemoryRuntimeExecution) {
  return {
    ...bound.scope,
    threadId: execution.binding.threadId,
    budgetRef: execution.binding.b,
  };
}
async function draft(
  bound: BoundMemory,
  execution: MemoryRuntimeExecution,
  signal: AbortSignal,
): Promise<MemoryContextStorageDraft> {
  const rows = await bound.tx<
    {
      id: string;
      revision: number;
      summary: string | null;
      details: string | null;
      source_type: string;
      source_id: string | null;
      metadata: unknown;
    }[]
  >`select m.id,m.revision,m.summary,m.details,m.source_type,m.source_id,m.metadata
    from allrice_memories m where ${memoryScopePredicate(bound.tx, bound.scope)}
      and m.archived_at is null and m.lifecycle_state='durable' and m.trust_level='user_confirmed'
      and (m.expires_at is null or m.expires_at>clock_timestamp())
    order by m.updated_at desc,m.id desc for share of m`;
  const qualify = qualifier(bound, signal),
    ordinary = [];
  for (const row of rows) if (await qualify(row)) ordinary.push(row);
  if (ordinary.length > 100) return unavailable();
  const pairs = ordinary.map((row) => {
    const pair = PersonalMemoryPairSchema.parse({
      summary: row.summary,
      details: row.details,
    });
    if (pair.summary !== row.summary || pair.details !== row.details)
      return unavailable();
    return pair;
  });
  const pins = ordinary.map((row, i) => ({
    number: i + 1,
    id: row.id,
    revision: row.revision,
    pairDigest: memoryPairDigest(pairs[i]!),
    hasDetails: row.details !== null,
  }));
  const document = renderNativeMemoryIndexV2(
    pairs.map((pair) => ({
      summary: pair.summary,
      hasDetails: pair.details !== null,
    })),
  );
  const bytes = Buffer.byteLength(document, 'utf8');
  if (bound.current.module.kind !== 'builtin') return denied();
  return {
    origin: {
      executionGeneration: '4.0',
      nativeOwnerRef: execution.nativeOwnerRef,
      nativeProfileRef: execution.nativeProfileRef,
      rootNativeSessionRef: execution.binding.rootSessionRef,
      moduleRelease: execution.moduleOrigin,
      moduleConfigRevisionRef: execution.moduleConfigRevisionRef,
    },
    document,
    state: RunMemoryContextV2StateSchema.parse({
      schemaVersion: 2,
      meter: 'utf8_bytes',
      limits: memoryIndexPolicy,
      initial: {
        digest: runtimePolicyDigest(pins),
        documentDigest: runtimePolicyDigest(document),
        bytes,
      },
      pins,
      spentBytes: bytes,
      toolReads: 0,
    }),
  };
}

export async function issueNativeEmployeeMemoryContext(
  context: RequestContext,
  input: NativeMemoryTarget,
  signal: AbortSignal,
) {
  const target = NativeMemoryTargetSchema.parse(input);
  const document = await caller(
    context,
    currentTarget(target),
    signal,
    async (bound) => {
      const execution = await executionFor(bound, target, signal);
      if (
        execution.parentSessionRef !== null ||
        execution.nativeSessionRef !== execution.binding.rootSessionRef
      )
        return denied();
      const saved = await issueMemoryContextStorage(
        bound.tx,
        storageKey(bound, execution),
        () => draft(bound, execution, signal),
        signal,
        qualifier(bound, signal),
      );
      if (
        saved.origin.nativeOwnerRef !== execution.nativeOwnerRef ||
        saved.origin.nativeProfileRef !== execution.nativeProfileRef ||
        saved.origin.rootNativeSessionRef !== execution.binding.rootSessionRef
      )
        return unavailable();
      return saved.document;
    },
  );
  signal.throwIfAborted();
  return document;
}
export async function readNativeEmployeeMemoryOrdinal(
  context: RequestContext,
  input: NativeMemoryTarget,
  ordinal: unknown,
  signal: AbortSignal,
) {
  const target = NativeMemoryTargetSchema.parse(input);
  const text = await caller(
    context,
    currentTarget(target),
    signal,
    async (bound) => {
      const execution = await executionFor(bound, target, signal);
      if (execution.binding.nativeCall?.toolId !== 'memory_read')
        return denied();
      return readMemoryContextStorageOrdinal(
        bound.tx,
        storageKey(bound, execution),
        ordinal,
        signal,
        qualifier(bound, signal),
        {
          nativeOwnerRef: execution.nativeOwnerRef,
          nativeProfileRef: execution.nativeProfileRef,
          rootNativeSessionRef: execution.binding.rootSessionRef,
        },
      );
    },
  );
  signal.throwIfAborted();
  return text;
}
export async function rememberNativeEmployeeMemory(
  context: RequestContext,
  input: NativeMemoryTarget,
  content: unknown,
  signal: AbortSignal,
) {
  const target = NativeMemoryTargetSchema.parse(input),
    pair = RememberPersonalMemoryInputSchema.parse(content);
  return caller(context, currentTarget(target), signal, async (bound) => {
    const execution = await executionFor(bound, target, signal);
    const selector = callSelector(execution);
    const source = requireSource(selector, await bound.reads.adopted(selector));
    signal.throwIfAborted();
    const metadata = sourceMetadata(source, execution);
    const qualify = qualifier(bound, signal);
    const origin = {
      source_type: 'message',
      source_id: null,
      metadata: { [nativeMemoryMetadataKey]: metadata },
    };
    if (!(await qualify(origin))) return denied();
    return memoryOperation(
      bound.tx,
      bound.scope,
      'create',
      nativeMemoryOperationKey(metadata),
      {
        version: 1,
        canonicalTool: metadata.canonicalTool,
        pair: { summary: pair.summary, details: pair.details },
        memoryClass: pair.memoryClass,
        source: metadata,
      },
      async () => {
        const row = await insertEmployeeMemoryPair(
          bound.tx,
          context,
          bound.scope,
          pair,
          {
            sourceType: 'message',
            sourceId: null,
            sourceLabel: '模型提取候选',
            trust: 'derived',
            confidence: 0.8,
            lifecycleState: 'candidate',
            memoryClass: pair.memoryClass,
            metadata: origin.metadata,
          },
        );
        return CandidateReceiptSchema.parse({
          id: row.id,
          revision: row.revision,
          pairDigest: memoryPairDigest(pair),
          summary: pair.summary,
          memoryClass: pair.memoryClass,
          state: 'pending',
          requiresConfirmation: true,
        });
      },
      CandidateReceiptSchema,
      qualify,
    );
  });
}

/** Current authorized original-call query. Waits the SAME operation serial
 * point, never replays a write. Absence is unavailable, never a zero-effect or
 * rollback claim. A changed/confirmed/withdrawn row is reported without the old
 * candidate body or receipt masquerading as current state. */
export async function reconcileNativeEmployeeMemory(
  context: RequestContext,
  input: NativeMemoryReconcileTarget,
  signal: AbortSignal,
) {
  const target = NativeMemoryReconcileTargetSchema.parse(input);
  const result = await caller(
    context,
    currentTarget(target),
    signal,
    async (bound) => {
      const execution = requireExecution(
        bound.scope,
        currentTarget(target),
        await bound.reads.stored({
          workspaceId: target.scope.workspaceId,
          employeeInstanceId: target.scope.employeeInstanceId,
          threadId: target.threadId,
          b: target.b,
        }),
      );
      if (
        execution.binding.b !== target.b ||
        execution.binding.rootOriginRef !== target.rootOriginRef ||
        execution.binding.executionBoundaryRef !==
          target.executionBoundaryRef ||
        execution.binding.rootSessionRef !== target.nativeCall.rootSessionRef ||
        !sameMemoryBusinessScope(target.scope, memoryBusinessScope(bound.scope))
      )
        return denied();
      const selector = StoredHumanSourceSelectorProjectionSchema.parse({
        scope: target.scope,
        threadId: target.threadId,
        b: target.b,
        executionBoundaryRef: target.executionBoundaryRef,
        rootOriginRef: target.rootOriginRef,
        nativeCall: target.nativeCall,
        sourceRef: target.sourceRef,
      });
      const source = requireSource(
        selector,
        await bound.reads.storedSource(selector),
      );
      if (source.sourceRef !== selector.sourceRef) return denied();
      const metadata = sourceMetadata(source, execution),
        key = nativeMemoryOperationKey(metadata),
        s = bound.scope;
      await bound.tx`select pg_advisory_xact_lock(hashtextextended(${`employee-memory:${s.organizationId}:${s.workspaceId}:${s.ownerId}:${s.instanceId}:${key}`},0))`;
      const [row] = await bound.tx<
        {
          id: string;
          revision: number;
          lifecycle_state: string;
          trust_level: string;
          archived_at: Date | null;
          eligible: boolean;
          response: unknown;
          source_type: string;
          source_id: string | null;
          metadata: unknown;
        }[]
      >`select m.id,m.revision,m.lifecycle_state,m.trust_level,m.archived_at,
        (m.expires_at is null or m.expires_at>clock_timestamp()) eligible,op.response,
        m.source_type,m.source_id,m.metadata
      from allrice_employee_memory_operations op join allrice_memories m on m.id=op.memory_id
        and m.organization_id=op.organization_id and m.workspace_id=op.workspace_id
        and m.owner_id=op.owner_id and m.instance_id=op.instance_id
      where op.organization_id=${s.organizationId} and op.workspace_id=${s.workspaceId}
        and op.owner_id=${s.ownerId} and op.instance_id=${s.instanceId} and op.operation_key=${key}
        and ${memoryScopePredicate(bound.tx, s)} for share of m`;
      if (!row) return unavailable();
      if (!row.eligible) return unavailable();
      const stored = nativeMemorySource(row.metadata);
      if (
        !stored ||
        JSON.stringify(stored) !== JSON.stringify(metadata) ||
        !(await qualifier(bound, signal)(row))
      )
        return denied();
      const receipt = CandidateReceiptSchema.safeParse(row.response);
      if (!receipt.success) throw new EmployeeMemoryContractChanged();
      return {
        status: 'recorded' as const,
        id: row.id,
        revision: row.revision,
        state: row.archived_at
          ? ('withdrawn' as const)
          : row.lifecycle_state === 'durable' &&
              row.trust_level === 'user_confirmed'
            ? ('active' as const)
            : ('pending' as const),
        originalReceiptCurrent:
          row.archived_at === null && row.revision === receipt.data.revision,
      };
    },
  );
  signal.throwIfAborted();
  return result;
}
