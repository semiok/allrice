import { posix } from 'node:path';
import {
  type RequestContext,
  type NativeDiagnosticReason,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { getRun, QueueError } from './queue.ts';
import {
  NativeSessionDescriptorSchema,
  type NativeSessionDescriptor,
  type NativeSessionPin,
} from '../conversation/native-session-binding.ts';
import {
  assertEmployeeRunExecutionBinding,
  EmployeeRunExecutionBindingSchema,
  newNativeGeneration,
} from '../conversation/current-execution-binding.ts';
import {
  assertChatTransitionPin,
  readChatExecutorTransition,
  readEffectiveChatExecutorOrigin,
} from '../conversation/native-executor-transition.ts';
import {
  assertTransitionDescriptor,
  executorTransitionRef,
  type ExecutorTransitionRef,
} from '../conversation/native-executor-transition-contract.ts';
import {
  nativeRootDigest,
  NativeRootOriginSchema,
} from '../conversation/native-root-origin.ts';

export interface NativeDiagnosticSourceReceipt {
  seq: number;
  type: string;
  turn: number | null;
}
export interface NativeDiagnosticTargetSlice {
  attempt: number;
  generation: number;
  nativeSessionId: string;
  receipts: NativeDiagnosticSourceReceipt[];
  verifiedTurns: number[];
  reasons: NativeDiagnosticReason[];
  /** The immutable first writer; never relabeled after an executor transition. */
  binding: NativeSessionPin | null;
  /** Actual execution for this Run, proven from its frozen binding when present. */
  execution: NativeSessionDescriptor | null;
}
export interface NativeDiagnosticTarget {
  runId: string;
  running: boolean;
  reasons: NativeDiagnosticReason[];
  slices: NativeDiagnosticTargetSlice[];
}
export interface NativeDiagnosticReceiptRow {
  event_type: string;
  payload: unknown;
  conflicting_turn?: boolean;
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const integer = (v: unknown, min = 0) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : null;

/** Receipts prove identity, never elapsed-time overlap. A turn can be expanded
 * only when this Run owns its recorded start and exactly one attempt cites it. */
export function nativeDiagnosticReceiptSlices(
  rows: NativeDiagnosticReceiptRow[],
) {
  const groups = new Map<string, NativeDiagnosticTargetSlice>();
  const claimed = new Map<string, Set<string>>();
  for (const row of rows) {
    const p = record(row.payload);
    if (
      p.source !== 'dsh' ||
      typeof p.threadId !== 'string' ||
      !/^dsh-[A-Za-z0-9._:-]{1,251}$/.test(p.threadId)
    )
      continue;
    const match =
      typeof p.sourceEventId === 'string'
        ? /^dsh:(\d+)$/.exec(p.sourceEventId)
        : null;
    const attempt = integer(p.attempt, 1),
      generation = integer(p.generation);
    const seq = match ? Number(match[1]) : NaN;
    if (
      attempt === null ||
      generation === null ||
      !Number.isSafeInteger(seq) ||
      typeof p.sourceEventType !== 'string'
    )
      continue;
    const key = `${attempt}:${generation}:${p.threadId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        attempt,
        generation,
        nativeSessionId: p.threadId,
        receipts: [],
        verifiedTurns: [],
        reasons: [],
        binding: null,
        execution: null,
      };
      groups.set(key, group);
    }
    const turn = integer(record(p.nativePayload).turn, 1);
    const prior = group.receipts.find((r) => r.seq === seq);
    if (prior && (prior.type !== p.sourceEventType || prior.turn !== turn))
      group.reasons.push('source_ambiguous');
    if (!prior) group.receipts.push({ seq, type: p.sourceEventType, turn });
    const source = `${p.threadId}:${seq}`;
    const claims = claimed.get(source) ?? new Set<string>();
    claims.add(key);
    claimed.set(source, claims);
  }
  for (const claims of claimed.values())
    if (claims.size > 1)
      for (const key of claims)
        groups.get(key)!.reasons.push('source_ambiguous');
  for (const row of rows) {
    const p = record(row.payload);
    if (
      row.event_type !== 'turn.started' ||
      p.source !== 'dsh' ||
      typeof p.threadId !== 'string' ||
      typeof p.turnId !== 'string'
    )
      continue;
    const prefix = `${p.threadId}:turn:`;
    if (
      !p.turnId.startsWith(prefix) ||
      !/^[1-9]\d*$/.test(p.turnId.slice(prefix.length))
    )
      continue;
    const turn = Number(p.turnId.slice(prefix.length));
    if (!Number.isSafeInteger(turn)) continue;
    const matches = [...groups.values()].filter(
      (g) =>
        g.nativeSessionId === p.threadId &&
        g.generation === p.generation &&
        g.receipts.some((r) => r.turn === turn),
    );
    if (matches.length === 1 && !row.conflicting_turn)
      matches[0]!.verifiedTurns.push(turn);
    else for (const g of matches) g.reasons.push('source_ambiguous');
  }
  return [...groups.values()].map((g) => ({
    ...g,
    receipts: g.receipts.sort((a, b) => a.seq - b.seq),
    verifiedTurns: [...new Set(g.verifiedTurns)],
    reasons: [...new Set(g.reasons)],
  }));
}

interface NativeDiagnosticEmployeeRun {
  session_id: string;
  native_execution_binding: unknown;
  execution_snapshot: unknown;
  native_root_origin: unknown;
  version_id: string | null;
  manifest: unknown;
  config_checksum: string | null;
}
interface NativeDiagnosticRunScope {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  runId: string;
}

/** No lease/admission call: only immutable Run/source facts and the existing
 * committed-chain validators. The exact frozen ref is never replaced by latest.
 * In particular a later NULL-origin adoption cannot supply an older Run's path. */
async function readNativeDiagnosticExecution(
  db: ReturnType<typeof getDatabase>,
  scope: NativeDiagnosticRunScope,
  employee: NativeDiagnosticEmployeeRun,
  binding: Record<string, unknown>,
  descriptor: NativeSessionDescriptor,
): Promise<NativeSessionDescriptor> {
  function unavailable(): never {
    throw Error('NATIVE_DIAGNOSTIC_BINDING_UNAVAILABLE');
  }
  if (
    descriptor.profileId !== 'restricted' ||
    descriptor.storageContextKey !== scope.sessionId ||
    descriptor.storageNamespace.includes('\0') ||
    !posix.isAbsolute(descriptor.storageNamespace) ||
    posix.normalize(descriptor.storageNamespace) !==
      descriptor.storageNamespace ||
    !descriptor.storageNamespace.endsWith(
      `/${scope.organizationId}/${scope.workspaceId}/${scope.ownerId}/${scope.sessionId}/sessions`,
    )
  )
    unavailable();
  const original =
    employee.native_root_origin == null
      ? null
      : NativeRootOriginSchema.parse(employee.native_root_origin);
  if (
    original &&
    (original.contextKind !== 'chat' ||
      original.contextId !== scope.sessionId ||
      original.rootSeed !== scope.sessionId ||
      original.profileId !== 'restricted')
  )
    unavailable();

  if (employee.native_execution_binding == null) {
    if (
      original?.schemaVersion === 2 ||
      (original
        ? binding.binding_basis !== 'business_root_origin' ||
          binding.root_origin_digest !== nativeRootDigest(original) ||
          descriptor.distributionGeneration !==
            original.distributionGeneration ||
          (!descriptor.originReaderApprovalDigest &&
            descriptor.artifactId !== original.artifactId)
        : binding.binding_basis !== 'approved_compatibility_reader' ||
          binding.root_origin_digest != null ||
          descriptor.originReaderApprovalDigest !== undefined ||
          descriptor.distributionGeneration === newNativeGeneration)
    )
      unavailable();
    // A first pin created under U1/U2 belongs to a frozen transition Run. It
    // cannot retroactively prove an earlier unbound Run, even for the same ID.
    const [first] = await db<{ native_execution_binding: unknown }[]>`
      select native_execution_binding from allrice_employee_runs
      where run_id=${binding.first_run_id as string} and session_id=${scope.sessionId}
        and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${scope.ownerId}`;
    if (!first || first.native_execution_binding != null) unavailable();
    return descriptor;
  }

  const frozen = EmployeeRunExecutionBindingSchema.parse(
    employee.native_execution_binding,
  );
  let origin = original;
  let transition: ExecutorTransitionRef | undefined;
  if (frozen.schemaVersion === 2) {
    const receipt = await readChatExecutorTransition(
      db,
      scope,
      original,
      frozen.transition,
    );
    if (!receipt) unavailable();
    transition = executorTransitionRef(receipt);
    // This lookup is permitted only after this Run's exact committed ref has
    // been proven. Pre-adoption Runs never enter this branch.
    if (origin == null) {
      const effective = await readEffectiveChatExecutorOrigin(db, scope, null);
      if (
        !effective ||
        effective.contextKind !== 'chat' ||
        effective.contextId !== scope.sessionId ||
        effective.rootSeed !== scope.sessionId ||
        effective.profileId !== 'restricted'
      )
        unavailable();
      origin = effective;
    }
    await assertChatTransitionPin(db, transition, binding);
  }
  if (!employee.version_id || !employee.config_checksum) unavailable();
  const checked = assertEmployeeRunExecutionBinding(frozen, {
    origin,
    ...(transition ? { transition } : {}),
    scope,
    source: {
      employeeVersionId: employee.version_id,
      configChecksum: employee.config_checksum,
      manifest: employee.manifest,
    },
    executionSnapshot: employee.execution_snapshot,
  });
  if (
    !transition &&
    (binding.binding_basis !== 'business_root_origin' ||
      binding.root_origin_digest !== checked.originDigest ||
      descriptor.artifactId !== checked.execution.artifactId ||
      descriptor.distributionGeneration !== checked.execution.generation ||
      descriptor.profileId !== checked.execution.profileId ||
      descriptor.originReaderApprovalDigest !== undefined)
  )
    unavailable();
  const actual = NativeSessionDescriptorSchema.parse({
    nativeSessionId: descriptor.nativeSessionId,
    artifactId: checked.execution.artifactId,
    artifactManifestDigest: checked.execution.artifactId,
    distributionGeneration: descriptor.distributionGeneration,
    profileId: descriptor.profileId,
    storageContextKey: descriptor.storageContextKey,
    storageNamespace: descriptor.storageNamespace,
    ...(transition ? { executorTransitionDigest: transition.digest } : {}),
  });
  if (transition) assertTransitionDescriptor(transition, actual);
  return actual;
}

/** Same ordinary Run authorization as RunEvents, plus exact owner access to
 * the native diagnostic. SQL alone chooses reader, namespace and source cuts. */
export async function getRunNativeDiagnosticTarget(
  context: RequestContext,
  workspaceId: string,
  runId: string,
): Promise<NativeDiagnosticTarget> {
  const run = await getRun(context, workspaceId, runId);
  if (context.actor.type !== 'user' || context.actor.id !== run.ownerId)
    throw new QueueError('not_found');
  const db = getDatabase();
  const [employee] = await db<NativeDiagnosticEmployeeRun[]>`
    select e.session_id,e.native_execution_binding,e.execution_snapshot,c.native_root_origin,
      v.id as version_id,v.manifest,v.config_checksum
    from allrice_employee_runs e
    join allrice_chat_sessions c on c.id=e.session_id and c.organization_id=e.organization_id
      and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
    left join allrice_employee_versions v on v.id=e.employee_version_id
      and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    where e.run_id=${run.id} and e.organization_id=${run.organizationId}
      and e.workspace_id=${run.workspaceId} and e.owner_id=${run.ownerId}`;
  const result: NativeDiagnosticTarget = {
    runId: run.id,
    running: !['succeeded', 'failed', 'canceled'].includes(run.status),
    reasons: [],
    slices: [],
  };
  if (!employee) return { ...result, reasons: ['source_receipts_missing'] };
  const rows = await db<NativeDiagnosticReceiptRow[]>`
    select e.event_type,
      jsonb_build_object('source',e.payload->'source','threadId',e.payload->'threadId',
        'turnId',e.payload->'turnId','generation',e.payload->'generation',
        'attempt',e.payload->'attempt','sourceEventId',e.payload->'sourceEventId',
        'sourceEventType',e.payload->'sourceEventType',
        'nativePayload',jsonb_build_object('turn',e.payload->'nativePayload'->'turn')) as payload,
      case when e.event_type='turn.started' then exists(
        select 1 from allrice_run_events other where other.run_id<>e.run_id
          and other.organization_id=e.organization_id and other.workspace_id=e.workspace_id
          and other.event_type='turn.started' and other.payload->>'source'='dsh'
          and other.payload->>'threadId'=e.payload->>'threadId'
          and other.payload->>'turnId'=e.payload->>'turnId'
      ) else false end as conflicting_turn
    from allrice_run_events e
    where e.run_id=${run.id} and e.organization_id=${run.organizationId} and e.workspace_id=${run.workspaceId}
      and e.payload->>'source'='dsh'
      and (e.event_type='turn.started' or e.payload->>'sourceEventId' ~ '^dsh:[0-9]+$')
    order by e.sequence desc limit 2049`;
  if (rows.length > 2048) result.reasons.push('source_receipts_truncated');
  const slices = nativeDiagnosticReceiptSlices(rows.slice(0, 2048).reverse());
  if (slices.length > 16) result.reasons.push('source_receipts_truncated');
  result.slices = slices.slice(0, 16);
  if (!result.slices.length) result.reasons.push('source_receipts_missing');
  for (const slice of result.slices) {
    const [binding] = await db`
      select * from allrice_native_session_bindings
      where native_session_id=${slice.nativeSessionId}
        and organization_id=${run.organizationId} and workspace_id=${run.workspaceId}
        and owner_id=${run.ownerId} and context_kind='chat' and context_id=${employee.session_id}`;
    if (!binding) {
      slice.reasons.push('binding_unavailable');
      continue;
    }
    const descriptor = NativeSessionDescriptorSchema.safeParse({
      nativeSessionId: binding.native_session_id,
      artifactId: binding.artifact_id,
      artifactManifestDigest: binding.artifact_manifest_digest,
      distributionGeneration: binding.distribution_generation,
      profileId: binding.profile_id,
      storageContextKey: binding.storage_context_key,
      storageNamespace: binding.storage_namespace,
      ...(binding.origin_reader_approval_digest
        ? { originReaderApprovalDigest: binding.origin_reader_approval_digest }
        : {}),
    });
    if (
      !descriptor.success ||
      binding.artifact_id !== binding.artifact_manifest_digest
    ) {
      slice.reasons.push('binding_unavailable');
      continue;
    }
    slice.binding = {
      ...descriptor.data,
      organizationId: run.organizationId,
      workspaceId: run.workspaceId,
      ownerId: run.ownerId,
      contextKind: 'chat',
      contextId: employee.session_id,
      firstRunId: binding.first_run_id,
      firstJobId: binding.first_job_id,
      firstAttempt: binding.first_attempt,
      boundAt: new Date(binding.bound_at).toISOString(),
      bindingBasis: binding.binding_basis,
      rootOriginDigest: binding.root_origin_digest,
    };
    try {
      slice.execution = await readNativeDiagnosticExecution(
        db,
        {
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          ownerId: run.ownerId,
          sessionId: employee.session_id,
          runId: run.id,
        },
        employee,
        binding,
        descriptor.data,
      );
    } catch {
      slice.reasons.push('binding_unavailable');
    }
  }
  return result;
}
