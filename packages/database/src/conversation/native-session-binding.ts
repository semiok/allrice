import { posix } from 'node:path';
import type postgres from 'postgres';
import { z } from 'zod';
import {
  EmployeeManifestSchema,
  PlatformEmployeeRuntimeProfileSchema,
  UuidSchema,
  DSH_FROZEN_PROFILE_GENERATIONS,
} from '@allrice/contracts';
import {
  assertNativeRootOrigin,
  nativeRootDigest,
  newNativeGeneration,
  type NativeRootOrigin,
  type NativeRootOriginV1,
} from './native-root-origin.ts';
import {
  assertCurrentEmployeeChatOrigin,
  assertEmployeeRunExecutionBinding,
  freezeEmployeeRunExecutionBinding,
  type EmployeeRunExecutionBinding,
} from './current-execution-binding.ts';
import {
  readCurrentPlatformTestExecutionRecord,
  type PlatformTestExecutionRecord,
} from './platform-test-execution-record.ts';
import {
  LeasedPlatformTestExecutionBindingSchema,
  type LeasedPlatformTestExecutionBinding,
} from './native-run-execution-binding.ts';
import type { JobRow } from '../queue/row-mappers.ts';
import {
  isPlatformTechnicalJobAuthorized,
  platformTechnicalJobType,
} from '../platform-technical-tasks.ts';
import { getExperienceExecutionInTransaction } from '../experience-consolidation.ts';
import { experienceConsolidationJobType } from '../experience-consolidation-contracts.ts';
import { bindConversationThreadInTransaction } from './conversation-runtime.ts';
import {
  checkNativeOriginReaderBindings,
  nativeOriginReaderForOrigin,
} from './native-origin-reader.ts';
import { nativeContextExecutionRetired } from './native-context-retirement.ts';

import {
  readChatTransitionRef,
  readEffectiveChatExecutorOrigin,
  assertChatTransitionPin,
} from './native-executor-transition.ts';
import { assertTransitionDescriptor } from './native-executor-transition-contract.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const NativeSessionDescriptorSchema = z
  .object({
    nativeSessionId: z
      .string()
      .min(5)
      .max(255)
      .regex(/^dsh-[a-zA-Z0-9._:-]+$/),
    artifactId: digest,
    artifactManifestDigest: digest,
    distributionGeneration: z.enum(DSH_FROZEN_PROFILE_GENERATIONS),
    profileId: z.enum(['restricted', 'technical']),
    storageContextKey: z.string().min(1).max(100),
    storageNamespace: z.string().min(1).max(4096),
    originReaderApprovalDigest: digest.optional(),
    /** Actual leased execution only; never rewrites the first-writer pin. */
    executorTransitionDigest: digest.optional(),
  })
  .strict();
export type NativeSessionDescriptor = z.infer<
  typeof NativeSessionDescriptorSchema
>;
const subject = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('chat'),
      id: UuidSchema,
      configChecksum: digest,
      generation: z.number().int().nonnegative(),
      expectedThreadId: z.string().max(255).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.enum([
        'platform_technical',
        'experience_consolidation',
        'platform_employee_test',
      ]),
      id: UuidSchema,
    })
    .strict(),
]);
export const NativeSessionLeaseInputSchema = z
  .object({
    workerId: UuidSchema,
    jobId: UuidSchema,
    leaseToken: UuidSchema,
    attempt: z.number().int().positive(),
    subject,
    descriptor: NativeSessionDescriptorSchema,
  })
  .strict();
export type NativeSessionLeaseInput = z.infer<
  typeof NativeSessionLeaseInputSchema
>;
export const NativeSessionPreparationInputSchema =
  NativeSessionLeaseInputSchema.omit({ descriptor: true })
    .extend({
      nativeSessionId: NativeSessionDescriptorSchema.shape.nativeSessionId,
      storageContextKey: NativeSessionDescriptorSchema.shape.storageContextKey,
    })
    .strict();
export type NativeSessionPreparationInput = z.infer<
  typeof NativeSessionPreparationInputSchema
>;
export interface NativeSessionPin extends NativeSessionDescriptor {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  contextKind: NativeSessionLeaseInput['subject']['kind'];
  contextId: string;
  firstRunId: string;
  firstJobId: string;
  firstAttempt: number;
  boundAt: string;
  bindingBasis: 'approved_compatibility_reader' | 'business_root_origin';
  rootOriginDigest?: string | null;
}
export class NativeSessionBindingError extends Error {
  constructor(
    readonly code:
      'NATIVE_SESSION_ADMISSION_DENIED' | 'NATIVE_SESSION_BINDING_CONFLICT',
  ) {
    super(code);
  }
}
const deny = (): never => {
  throw new NativeSessionBindingError('NATIVE_SESSION_ADMISSION_DENIED');
};
type Tx = postgres.TransactionSql;

/** Same immutable chat birth check for admission and leased native binding.
 * Does not lock a Job or grant execution. Only the binder may start a Session. */
export async function readChatNativeRootOrigin(
  tx: Tx | postgres.Sql,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
    runId?: string;
  },
): Promise<NativeRootOrigin | null> {
  if (await nativeContextExecutionRetired(tx, 'chat', input.sessionId))
    return deny();
  const [row] =
    await tx`select c.native_root_origin,allrice_native_chat_effective_origin(c.id) effective_origin,v.manifest,v.id source_id,v.config_checksum
    from allrice_chat_sessions c
    left join allrice_employee_versions v on v.id::text=case when allrice_native_chat_effective_origin(c.id)->>'schemaVersion'='2'
      then allrice_native_chat_effective_origin(c.id)#>>'{birthSource,employeeVersionId}' else c.native_root_origin#>>'{frozenIdentity,sourceId}' end
      and v.organization_id=c.organization_id and v.workspace_id=c.workspace_id
      and v.employee_id=(select employee_id from allrice_employee_assignments where id=c.employee_assignment_id)
    where c.id=${input.sessionId} and c.organization_id=${input.organizationId}
      and c.workspace_id=${input.workspaceId} and c.owner_id=${input.ownerId} and c.archived_at is null
      and (${input.runId ?? null}::uuid is null or exists(select 1 from allrice_employee_runs e
        where e.run_id=${input.runId ?? null}::uuid and e.session_id=c.id
          and e.organization_id=c.organization_id and e.workspace_id=c.workspace_id and e.owner_id=c.owner_id))`;
  if (!row) return deny();
  const effective = await readEffectiveChatExecutorOrigin(
    tx,
    input,
    row.native_root_origin,
  );
  if (effective == null) return null;
  if (effective.schemaVersion === 2)
    return assertCurrentEmployeeChatOrigin(effective, {
      ...input,
      source: {
        employeeVersionId: row.source_id,
        configChecksum: row.config_checksum,
        manifest: row.manifest,
      },
    });
  const manifest = EmployeeManifestSchema.parse(row.manifest);
  if (
    manifest.schemaVersion !== 2 ||
    !manifest.runtimePackage ||
    manifest.runtimePackage.runtimeManifest.distributionGeneration !==
      newNativeGeneration
  )
    return deny();
  return assertNativeRootOrigin(
    row.native_root_origin,
    'chat',
    input.sessionId,
    {
      kind: 'employee_package',
      checksum: manifest.runtimePackage.checksum,
      sourceId: row.source_id,
    },
  );
}

/** Admission freezes the original published source alongside the Run. The
 * current assignment is intentionally not consulted here. NULL/v1 stays NULL. */
export async function freezeChatRunExecutionBinding(
  tx: Tx,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
    runId: string;
    employeeVersionId: string;
    executionSnapshot: unknown;
  },
): Promise<EmployeeRunExecutionBinding | null> {
  await tx`select id from allrice_chat_sessions where id=${input.sessionId} and organization_id=${input.organizationId} and workspace_id=${input.workspaceId} and owner_id=${input.ownerId} for share`;
  const origin = await readChatNativeRootOrigin(tx, {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    sessionId: input.sessionId,
  });
  const transition = await readChatTransitionRef(tx, input, origin);
  if (origin?.schemaVersion !== 2 && !transition) return null;
  if (origin?.contextKind !== 'chat') return deny();
  const [version] =
    await tx`select v.id,v.manifest,v.config_checksum from allrice_employee_versions v
    join allrice_chat_sessions c on c.id=${input.sessionId} and c.organization_id=v.organization_id and c.workspace_id=v.workspace_id
    join allrice_employee_assignments a on a.id=c.employee_assignment_id and a.employee_id=v.employee_id
    where v.id=${input.employeeVersionId} and v.organization_id=${input.organizationId}
      and v.workspace_id=${input.workspaceId} and c.owner_id=${input.ownerId}`;
  if (!version) return deny();
  return freezeEmployeeRunExecutionBinding({
    origin,
    transition,
    scope: {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      runId: input.runId,
    },
    source: {
      employeeVersionId: version.id,
      configChecksum: version.config_checksum,
      manifest: version.manifest,
    },
    executionSnapshot: input.executionSnapshot,
  });
}

/** Only called with a leased, authorized chat Job. Rechecks the persisted Run
 * binding and immutable original version; never repairs or creates a binding. */
async function readLeasedChatExecutionBinding(
  tx: Tx,
  job: JobRow,
  origin: NativeRootOrigin | null,
  sessionId: string,
): Promise<EmployeeRunExecutionBinding | null> {
  const [run] =
    await tx`select e.native_execution_binding,e.execution_snapshot,v.id,v.manifest,v.config_checksum
    from allrice_employee_runs e join allrice_employee_versions v on v.id=e.employee_version_id
      and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.employee_id=v.employee_id
    where e.run_id=${job.run_id} and e.session_id=${sessionId} and e.organization_id=${job.organization_id}
      and e.workspace_id=${job.workspace_id} and e.owner_id=${job.owner_id}`;
  if (!run) return deny();
  const transition = await readChatTransitionRef(
    tx,
    {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      ownerId: job.owner_id,
      sessionId,
    },
    origin,
  );
  if (origin?.schemaVersion !== 2 && !transition) {
    if (run.native_execution_binding != null) return deny();
    return null;
  }
  if (origin?.contextKind !== 'chat') return deny();
  return assertEmployeeRunExecutionBinding(run.native_execution_binding, {
    origin,
    transition,
    scope: {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      ownerId: job.owner_id,
      sessionId,
      runId: job.run_id,
    },
    source: {
      employeeVersionId: run.id,
      configChecksum: run.config_checksum,
      manifest: run.manifest,
    },
    executionSnapshot: run.execution_snapshot,
  });
}

/** Only the queue's real leased closure calls this. Plain SELECT preserves
 * the existing Job/root/finalizer lock order. No current deployment rebinding. */
async function readLeasedPlatformTestExecutionBinding(
  tx: Tx,
  job: JobRow,
  origin: NativeRootOrigin | null,
  testId: string,
  workerId: string,
): Promise<LeasedPlatformTestExecutionBinding | null> {
  const [test] = await tx`select t.* from allrice_platform_employee_test_runs t
    join allrice_runs r on r.id=${job.run_id}
      and r.execution_spec->>'platformEmployeeTestRunId'=t.id::text
      and r.execution_spec->>'employeeRevisionId'=t.revision_id::text
      and r.execution_spec->>'handler'='platform_employee_preview'
    join allrice_organizations o on o.id=r.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=r.workspace_id and w.organization_id=o.id and w.archived_at is null
    join allrice_users u on u.id=r.owner_id and u.status='active'
    where t.id=${testId} and t.status='running' and t.worker_id=${workerId}
      and t.timeout_at>clock_timestamp() and r.state='running'
      and r.organization_id=${job.organization_id} and r.workspace_id=${job.workspace_id} and r.owner_id=${job.owner_id}
      and exists(select 1 from allrice_memberships m where m.organization_id=r.organization_id
        and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.user_id=r.owner_id and m.active)`;
  const payload = job.payload as {
    type?: string;
    input?: Record<string, unknown>;
  };
  if (
    !test ||
    payload.type !== 'platform_employee_preview' ||
    payload.input?.testRunId !== testId
  )
    return deny();
  if (origin?.schemaVersion !== 2) {
    if (test.native_execution_binding != null) return deny();
    return null;
  }
  if (origin.contextKind !== 'platform_employee_test') return deny();
  const checked = readCurrentPlatformTestExecutionRecord(
    test as PlatformTestExecutionRecord,
    {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      ownerId: job.owner_id,
    },
  );
  if (nativeRootDigest(checked.origin) !== nativeRootDigest(origin))
    return deny();
  return LeasedPlatformTestExecutionBindingSchema.parse({
    kind: 'current_platform_test_run_execution',
    test: checked.executionBinding,
    runId: job.run_id,
    jobId: job.id,
    attempt: job.attempt,
  });
}

/** Read only the leased subject's immutable business birth fact. This is
 * selection evidence, never prompt permission; the normal binder still checks
 * every live Run/Job/subject/owner/cancellation and deadline below. */
async function readNativeRootOrigin(
  tx: Tx,
  job: JobRow,
  s: NativeSessionLeaseInput['subject'],
): Promise<NativeRootOrigin | null> {
  if (await nativeContextExecutionRetired(tx, s.kind, s.id)) return deny();
  let row, identity: NativeRootOriginV1['frozenIdentity'];
  if (s.kind === 'chat')
    return readChatNativeRootOrigin(tx, {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      ownerId: job.owner_id,
      sessionId: s.id,
      runId: job.run_id,
    });
  if (s.kind === 'platform_technical') {
    [row] =
      await tx`select native_root_origin,frozen_configuration from allrice_platform_technical_tasks
      where id=${s.id} and job_id=${job.id} and run_id=${job.run_id} and organization_id=${job.organization_id}
        and workspace_id=${job.workspace_id} and owner_id=${job.owner_id}`;
    if (!row) return deny();
    if (row.native_root_origin == null) return null;
    const recipe = { ...row.frozen_configuration };
    delete recipe.question;
    identity = { kind: 'internal_recipe', checksum: nativeRootDigest(recipe) };
  } else if (s.kind === 'experience_consolidation') {
    [row] =
      await tx`select r.native_root_origin,r.experience_occurrence from allrice_automation_runs r
      join allrice_automations a on a.id=r.automation_id
      where r.id=${s.id} and r.organization_id=${job.organization_id} and r.workspace_id=${job.workspace_id}
        and a.owner_id=${job.owner_id} and r.run_id=${job.run_id}`;
    if (!row) return deny();
    if (row.native_root_origin == null) return null;
    identity = {
      kind: 'internal_recipe',
      checksum: nativeRootDigest({
        recipe: 'allrice-experience-consolidation/v1',
        occurrence: row.experience_occurrence,
      }),
    };
  } else {
    [row] = await tx`select t.* from allrice_platform_employee_test_runs t
      join allrice_runs r on r.id=${job.run_id} and r.execution_spec->>'platformEmployeeTestRunId'=t.id::text
      where t.id=${s.id} and r.organization_id=${job.organization_id} and r.workspace_id=${job.workspace_id} and r.owner_id=${job.owner_id}`;
    if (!row) return deny();
    if (row.native_root_origin?.schemaVersion === 2)
      return readCurrentPlatformTestExecutionRecord(
        row as PlatformTestExecutionRecord,
        {
          organizationId: job.organization_id,
          workspaceId: job.workspace_id,
          ownerId: job.owner_id,
        },
      ).origin;
    if (row.native_execution_binding != null) return deny();
    if (row.native_root_origin == null) return null;
    const profile = PlatformEmployeeRuntimeProfileSchema.parse(
      row.frozen_runtime_profile,
    );
    if (
      !profile.runtimePackage ||
      profile.distributionGeneration !== newNativeGeneration ||
      profile.runtimePackage.runtimeManifest.distributionGeneration !==
        newNativeGeneration
    )
      return deny();
    identity = {
      kind: 'employee_package',
      checksum: profile.runtimePackage.checksum,
    };
  }
  return assertNativeRootOrigin(row.native_root_origin, s.kind, s.id, identity);
}

/** Existing pins are fully re-admitted through the same binder and CAS, not
 * returned by an owner-blind lookup. Absence grants no startup/prompt
 * permission. Durable prior adoption requires storage recovery before bind. */
export async function prepareLeasedNativeSession(
  tx: Tx,
  job: JobRow,
  input: NativeSessionPreparationInput,
) {
  const origin = await readNativeRootOrigin(tx, job, input.subject);
  const executionBinding =
    input.subject.kind === 'chat'
      ? await readLeasedChatExecutionBinding(tx, job, origin, input.subject.id)
      : input.subject.kind === 'platform_employee_test'
        ? await readLeasedPlatformTestExecutionBinding(
            tx,
            job,
            origin,
            input.subject.id,
            input.workerId,
          )
        : null;
  const transition =
    executionBinding?.kind === 'current_employee_execution' &&
    executionBinding.schemaVersion === 2
      ? executionBinding.transition
      : undefined;
  const reader =
    origin && !transition
      ? nativeOriginReaderForOrigin(origin, {
          organizationId: job.organization_id,
          workspaceId: job.workspace_id,
          ownerId: job.owner_id,
        })
      : undefined;
  const originReaderAdopted = reader
    ? await checkNativeOriginReaderBindings(tx, reader)
    : false;
  const [pin] = await tx`select * from allrice_native_session_bindings
    where native_session_id=${input.nativeSessionId}`;
  if (!pin) {
    // This read is a recovery requirement, not first-creation authority. The
    // final descriptor binder still rechecks all subject ACLs and chat CAS.
    const [conversation] =
      input.subject.kind === 'chat'
        ? await tx`select thread_id from allrice_conversation_runtimes
          where session_id=${input.subject.id} and organization_id=${job.organization_id}
            and workspace_id=${job.workspace_id} and owner_id=${job.owner_id}`
        : [];
    return {
      binding: null,
      origin,
      executionBinding,
      ...(reader ? { originReaderAdopted } : {}),
      conversation: undefined,
      requiresRecovery:
        job.attempt > 1 ||
        conversation?.thread_id === input.nativeSessionId ||
        (input.subject.kind === 'chat' &&
          input.subject.expectedThreadId === input.nativeSessionId),
    };
  }
  if (pin.storage_context_key !== input.storageContextKey)
    throw new NativeSessionBindingError('NATIVE_SESSION_BINDING_CONFLICT');
  const descriptor = NativeSessionDescriptorSchema.parse({
    nativeSessionId: pin.native_session_id,
    artifactId: transition?.target.artifactId ?? pin.artifact_id,
    artifactManifestDigest:
      transition?.target.artifactId ?? pin.artifact_manifest_digest,
    ...(transition ? { executorTransitionDigest: transition.digest } : {}),
    distributionGeneration: pin.distribution_generation,
    profileId: pin.profile_id,
    storageContextKey: pin.storage_context_key,
    storageNamespace: pin.storage_namespace,
    ...(!transition && pin.origin_reader_approval_digest
      ? { originReaderApprovalDigest: pin.origin_reader_approval_digest }
      : {}),
  });
  const admitted = await bindLeasedNativeSession(tx, job, {
    workerId: input.workerId,
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    attempt: input.attempt,
    subject: input.subject,
    descriptor,
  });
  return {
    ...admitted,
    origin,
    executionBinding,
    ...(reader ? { originReaderAdopted } : {}),
    requiresRecovery: true,
  };
}

/** The queue already owns 703 -> root/clock -> Job. No Run/test row locks:
 * the preview finalizer owns those rows while waiting for this same Job. */
export async function bindLeasedNativeSession(
  tx: Tx,
  job: JobRow,
  input: NativeSessionLeaseInput,
) {
  const d = input.descriptor,
    s = input.subject;
  if (
    job.attempt !== input.attempt ||
    job.cancel_requested_at ||
    job.drain_reason ||
    job.drain_deadline_at
  )
    deny();
  const [run] = await tx`select r.state,r.execution_spec from allrice_runs r
    join allrice_organizations o on o.id=r.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=r.workspace_id and w.organization_id=r.organization_id and w.archived_at is null
    join allrice_users u on u.id=r.owner_id and u.status='active'
    where r.id=${job.run_id} and r.organization_id=${job.organization_id}
      and r.workspace_id=${job.workspace_id} and r.owner_id=${job.owner_id}
      and (${s.kind === 'platform_technical'} or exists(select 1 from allrice_memberships m where m.organization_id=r.organization_id
        and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.user_id=r.owner_id and m.active))`;
  if (!run || run.state !== 'running') deny();
  const payload = job.payload as {
    type?: string;
    input?: Record<string, unknown>;
  };
  const key = d.storageContextKey;
  if (
    !UuidSchema.safeParse(key.replace(/^experience-/, '')).success ||
    !d.nativeSessionId.startsWith('dsh-' + key) ||
    (d.nativeSessionId !== 'dsh-' + key &&
      !d.nativeSessionId.startsWith('dsh-' + key + '-')) ||
    d.artifactId !== d.artifactManifestDigest ||
    d.storageNamespace.includes('\0') ||
    !posix.isAbsolute(d.storageNamespace) ||
    posix.normalize(d.storageNamespace) !== d.storageNamespace ||
    !d.storageNamespace.endsWith(
      `/${job.organization_id}/${job.workspace_id}/${job.owner_id}/${key}/sessions`,
    )
  )
    deny();
  const origin = await readNativeRootOrigin(tx, job, s);
  const executionBinding =
    s.kind === 'chat'
      ? await readLeasedChatExecutionBinding(tx, job, origin, s.id)
      : null;
  const transition =
    executionBinding?.schemaVersion === 2
      ? executionBinding.transition
      : undefined;
  if (s.kind === 'platform_employee_test')
    await readLeasedPlatformTestExecutionBinding(
      tx,
      job,
      origin,
      s.id,
      input.workerId,
    );
  const reader =
    origin && !transition
      ? nativeOriginReaderForOrigin(origin, {
          organizationId: job.organization_id,
          workspaceId: job.workspace_id,
          ownerId: job.owner_id,
        })
      : undefined;
  if (reader) await checkNativeOriginReaderBindings(tx, reader);
  if (transition) {
    assertTransitionDescriptor(transition, d);
    if (
      d.executorTransitionDigest !== transition.digest ||
      d.originReaderApprovalDigest !== undefined ||
      s.kind !== 'chat'
    )
      deny();
  } else if (
    // MET-221: a context binds to its generation, profile and root seed. The
    // descriptor's artifact is the release primary; the origin's is provenance.
    // A context without a business origin has no executor on this release.
    !origin ||
    reader ||
    d.executorTransitionDigest !== undefined ||
    d.originReaderApprovalDigest !== undefined ||
    d.distributionGeneration !== origin.distributionGeneration ||
    d.profileId !== origin.profileId ||
    key !== origin.rootSeed
  )
    deny();
  const bindingBasis = origin
    ? 'business_root_origin'
    : 'approved_compatibility_reader';
  const rootOriginDigest = origin ? nativeRootDigest(origin) : null;
  let testDeadline: Date | undefined;
  if (s.kind === 'chat') {
    const [chat] = await tx`select e.session_id from allrice_employee_runs e
      join allrice_chat_sessions c on c.id=e.session_id and c.archived_at is null
      where e.run_id=${job.run_id} and e.session_id=${s.id} and c.owner_id=${job.owner_id}
        and c.organization_id=${job.organization_id} and c.workspace_id=${job.workspace_id}`;
    if (!chat || key !== s.id || d.profileId !== 'restricted') deny();
  } else if (s.kind === 'platform_technical') {
    const [task] =
      await tx`select id from allrice_platform_technical_tasks where id=${s.id}
      and job_id=${job.id} and run_id=${job.run_id} and owner_id=${job.owner_id}
      and organization_id=${job.organization_id} and workspace_id=${job.workspace_id}`;
    if (
      payload.type !== platformTechnicalJobType ||
      !task ||
      d.profileId !== 'technical' ||
      !(await isPlatformTechnicalJobAuthorized(tx, job))
    )
      deny();
  } else if (s.kind === 'experience_consolidation') {
    if (
      payload.type !== experienceConsolidationJobType ||
      payload.input?.occurrenceId !== s.id ||
      d.profileId !== 'restricted'
    )
      deny();
    const { occurrence } = await getExperienceExecutionInTransaction(
      tx,
      job.run_id,
    );
    if (
      occurrence.id !== s.id ||
      occurrence.organizationId !== job.organization_id ||
      occurrence.workspaceId !== job.workspace_id ||
      occurrence.ownerId !== job.owner_id ||
      key !== `experience-${s.id}`
    )
      deny();
  } else {
    // Plain SELECT is intentional, including its Run join: neither explicit
    // nor FK-implied Run/test locks may reverse the finalizer's lock order.
    const [test] =
      await tx`select t.status,t.worker_id,t.timeout_at,t.purpose,t.revision_id
      from allrice_platform_employee_test_runs t where t.id=${s.id}`;
    const spec = run!.execution_spec as Record<string, unknown>;
    if (
      payload.type !== 'platform_employee_preview' ||
      payload.input?.testRunId !== s.id ||
      spec.handler !== 'platform_employee_preview' ||
      spec.platformEmployeeTestRunId !== s.id ||
      !test ||
      test.status !== 'running' ||
      test.worker_id !== input.workerId ||
      !test.timeout_at ||
      ![
        'platform_preview',
        'method_candidate',
        'experience_validation',
      ].includes(test.purpose) ||
      test.revision_id !== spec.employeeRevisionId ||
      d.profileId !== 'restricted'
    )
      deny();
    testDeadline = test!.timeout_at as Date;
  }
  const checkDeadline = async () => {
    const [at] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
    const [root] =
      await tx`select cancel_requested_at,deadline_at from allrice_runtime_roots where root_run_id=${job.run_id}`;
    const now = at!.now;
    if (
      !job.lease_expires_at ||
      job.lease_expires_at <= now ||
      job.timeout_at <= now ||
      (testDeadline && testDeadline <= now) ||
      root?.cancel_requested_at ||
      (root && root.deadline_at <= now)
    )
      deny();
  };
  await checkDeadline();
  let conversation;
  if (s.kind === 'chat')
    conversation = await bindConversationThreadInTransaction(tx, {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      ownerId: job.owner_id,
      sessionId: s.id,
      runId: job.run_id,
      workerId: input.workerId,
      threadId: d.nativeSessionId,
      expected: {
        configChecksum: s.configChecksum,
        generation: s.generation,
        threadId: s.expectedThreadId,
      },
    });
  await tx`insert into allrice_native_session_bindings
    (native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
      storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,
      first_run_id,first_job_id,first_attempt,binding_basis,root_origin_digest,origin_reader_approval_digest)
    values(${d.nativeSessionId},${job.organization_id},${job.workspace_id},${job.owner_id},${s.kind},${s.id},
      ${key},${d.storageNamespace},${d.artifactId},${d.artifactManifestDigest},${d.distributionGeneration},${d.profileId},
      ${job.run_id},${job.id},${job.attempt},${bindingBasis},${rootOriginDigest},${d.originReaderApprovalDigest ?? null}) on conflict(native_session_id) do nothing`;
  const [pin] =
    await tx`select * from allrice_native_session_bindings where native_session_id=${d.nativeSessionId}`;
  if (transition && pin) await assertChatTransitionPin(tx, transition, pin);
  const equal =
    pin &&
    pin.organization_id === job.organization_id &&
    pin.workspace_id === job.workspace_id &&
    pin.owner_id === job.owner_id &&
    pin.context_kind === s.kind &&
    pin.context_id === s.id &&
    pin.storage_context_key === key &&
    pin.storage_namespace === d.storageNamespace &&
    // artifact_id stays the first writer (provenance); any later release's
    // primary of the same generation continues the context.
    pin.distribution_generation === d.distributionGeneration &&
    pin.profile_id === d.profileId &&
    pin.binding_basis === bindingBasis &&
    pin.root_origin_digest === rootOriginDigest &&
    (transition ||
      pin.origin_reader_approval_digest ===
        (d.originReaderApprovalDigest ?? null));
  if (!equal)
    throw new NativeSessionBindingError('NATIVE_SESSION_BINDING_CONFLICT');
  await checkDeadline();
  const binding: NativeSessionPin = {
    nativeSessionId: pin!.native_session_id,
    artifactId: pin!.artifact_id,
    artifactManifestDigest: pin!.artifact_manifest_digest,
    distributionGeneration: pin!.distribution_generation,
    profileId: pin!.profile_id,
    storageContextKey: pin!.storage_context_key,
    storageNamespace: pin!.storage_namespace,
    ...(pin!.origin_reader_approval_digest
      ? { originReaderApprovalDigest: pin!.origin_reader_approval_digest }
      : {}),
    organizationId: pin!.organization_id,
    workspaceId: pin!.workspace_id,
    ownerId: pin!.owner_id,
    contextKind: pin!.context_kind,
    contextId: pin!.context_id,
    firstRunId: pin!.first_run_id,
    firstJobId: pin!.first_job_id,
    firstAttempt: pin!.first_attempt,
    boundAt: (pin!.bound_at as Date).toISOString(),
    bindingBasis: pin!.binding_basis,
    rootOriginDigest: pin!.root_origin_digest,
  };
  return {
    binding,
    conversation,
    ...(transition ? { effectiveDescriptor: d } : {}),
  };
}
