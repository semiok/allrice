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
} from './native-root-origin.ts';
import type { JobRow } from '../queue/row-mappers.ts';
import {
  isPlatformTechnicalJobAuthorized,
  platformTechnicalJobType,
} from '../platform-technical-tasks.ts';
import { getExperienceExecutionInTransaction } from '../experience-consolidation.ts';
import { experienceConsolidationJobType } from '../experience-consolidation-contracts.ts';
import { bindConversationThreadInTransaction } from './conversation-runtime.ts';

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

/** Read only the leased subject's immutable business birth fact. This is
 * selection evidence, never prompt permission; the normal binder still checks
 * every live Run/Job/subject/owner/cancellation and deadline below. */
async function readNativeRootOrigin(
  tx: Tx,
  job: JobRow,
  s: NativeSessionLeaseInput['subject'],
): Promise<NativeRootOrigin | null> {
  let row, identity: NativeRootOrigin['frozenIdentity'];
  if (s.kind === 'chat') {
    [row] =
      await tx`select c.native_root_origin,v.manifest,v.id source_id from allrice_employee_runs e
      join allrice_chat_sessions c on c.id=e.session_id and c.archived_at is null
      left join allrice_employee_versions v on v.id::text=c.native_root_origin#>>'{frozenIdentity,sourceId}'
        and v.organization_id=c.organization_id and v.workspace_id=c.workspace_id
        and v.employee_id=(select employee_id from allrice_employee_assignments where id=c.employee_assignment_id)
      where e.run_id=${job.run_id} and c.id=${s.id} and c.organization_id=${job.organization_id}
        and c.workspace_id=${job.workspace_id} and c.owner_id=${job.owner_id}`;
    if (!row) return deny();
    if (row.native_root_origin == null) return null;
    const manifest = EmployeeManifestSchema.parse(row.manifest);
    if (
      manifest.schemaVersion !== 2 ||
      !manifest.runtimePackage ||
      manifest.runtimePackage.runtimeManifest.distributionGeneration !==
        newNativeGeneration
    )
      return deny();
    identity = {
      kind: 'employee_package',
      checksum: manifest.runtimePackage.checksum,
      sourceId: row.source_id,
    };
  } else if (s.kind === 'platform_technical') {
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
    [row] =
      await tx`select t.native_root_origin,t.frozen_runtime_profile from allrice_platform_employee_test_runs t
      join allrice_runs r on r.id=${job.run_id} and r.execution_spec->>'platformEmployeeTestRunId'=t.id::text
      where t.id=${s.id} and r.organization_id=${job.organization_id} and r.workspace_id=${job.workspace_id} and r.owner_id=${job.owner_id}`;
    if (!row) return deny();
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
    artifactId: pin.artifact_id,
    artifactManifestDigest: pin.artifact_manifest_digest,
    distributionGeneration: pin.distribution_generation,
    profileId: pin.profile_id,
    storageContextKey: pin.storage_context_key,
    storageNamespace: pin.storage_namespace,
  });
  const admitted = await bindLeasedNativeSession(tx, job, {
    workerId: input.workerId,
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    attempt: input.attempt,
    subject: input.subject,
    descriptor,
  });
  return { ...admitted, origin, requiresRecovery: true };
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
  if (
    origin
      ? d.artifactId !== origin.artifactId ||
        d.distributionGeneration !== origin.distributionGeneration ||
        d.profileId !== origin.profileId ||
        key !== origin.rootSeed
      : d.distributionGeneration === newNativeGeneration
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
      first_run_id,first_job_id,first_attempt,binding_basis,root_origin_digest)
    values(${d.nativeSessionId},${job.organization_id},${job.workspace_id},${job.owner_id},${s.kind},${s.id},
      ${key},${d.storageNamespace},${d.artifactId},${d.artifactManifestDigest},${d.distributionGeneration},${d.profileId},
      ${job.run_id},${job.id},${job.attempt},${bindingBasis},${rootOriginDigest}) on conflict(native_session_id) do nothing`;
  const [pin] =
    await tx`select * from allrice_native_session_bindings where native_session_id=${d.nativeSessionId}`;
  const equal =
    pin &&
    pin.organization_id === job.organization_id &&
    pin.workspace_id === job.workspace_id &&
    pin.owner_id === job.owner_id &&
    pin.context_kind === s.kind &&
    pin.context_id === s.id &&
    pin.storage_context_key === key &&
    pin.storage_namespace === d.storageNamespace &&
    pin.artifact_id === d.artifactId &&
    pin.artifact_manifest_digest === d.artifactManifestDigest &&
    pin.distribution_generation === d.distributionGeneration &&
    pin.profile_id === d.profileId &&
    pin.binding_basis === bindingBasis &&
    pin.root_origin_digest === rootOriginDigest;
  if (!equal)
    throw new NativeSessionBindingError('NATIVE_SESSION_BINDING_CONFLICT');
  await checkDeadline();
  const binding: NativeSessionPin = {
    ...d,
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
  return { binding, conversation };
}
