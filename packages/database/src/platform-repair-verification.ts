import {
  CloudCommandSchema,
  cloudBackendV1,
  cloudToolchainImageV1,
  type CloudCommand,
  type ExecutionContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  hasRepairMarker,
  repairSchemaAvailable,
  assertPlatformRepairLease,
  type RepairLease,
} from './platform-repair-authority.ts';
import {
  RepositoryExecutionProofSchema,
  RepairVerificationObservationSchema,
  RepositoryCandidateSchema,
  repositorySourceLimits,
} from './platform-repair-contracts.ts';
import { repairProfileId } from './platform-repair-contracts.ts';
import { readPlatformRepairSource } from './platform-repair.ts';
import {
  repositoryDigest,
  repositoryMaterialDigest,
  applyRepositoryCandidate,
} from './platform-repository-source.ts';
import {
  repositoryVerificationCommand,
  readRepositoryVerification,
} from './platform-repair-profile.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import type { JobRow } from './queue/row-mappers.ts';
import type postgres from 'postgres';
type Db = ReturnType<typeof getDatabase>;

export async function preparePlatformRepairVerification(
  lease: RepairLease,
  context: ExecutionContext,
  candidateChecksum: string,
) {
  const source = await readPlatformRepairSource(lease);
  if (
    source.task.run_id !== context.runId ||
    source.task.job_id !== context.jobId ||
    source.candidate.checksum !== candidateChecksum ||
    !source.task.input_object_id
  )
    throw new QueueError('conflict');
  const args = repositoryVerificationCommand({
    baseline: source.source.baseline,
    candidate: source.candidate,
    object: {
      id: source.task.input_object_id,
      checksum: source.source.baseline.archiveChecksum,
    },
  });
  const command = CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    arguments: args,
    backend: cloudBackendV1,
    imageDigest: cloudToolchainImageV1,
    runtime: 'runsc',
    network: 'none',
  });
  const callId = 'repair-verify:' + source.candidate.revision,
    operationId = cloudStableId(
      'cloud-command:' + context.runId + ':' + callId,
    );
  const proof = RepositoryExecutionProofSchema.parse({
    version: 1,
    profileId: repairProfileId,
    commandDigest: repositoryDigest(JSON.stringify(command)),
    baselineId: source.source.baseline.id,
    candidateChecksum,
    inputLimit: repositorySourceLimits.archiveBytes,
    tmpfsMiB: 64,
  });
  return getDatabase().begin(async (tx) => {
    await assertPlatformRepairLease(tx, lease);
    const [q] =
      await tx`select candidate from allrice_platform_repair_tasks where id=${source.task.id} for update`;
    if (q?.candidate?.checksum !== candidateChecksum)
      throw new QueueError('conflict');
    if (source.candidate.revision > 0) {
      const [before] =
        await tx`select observation from allrice_platform_repair_verifications where task_id=${source.task.id} and revision=0`;
      if (
        before?.observation?.report?.exitCode !== 1 ||
        before.observation.report.failureKind !== 'assertion_failed'
      )
        throw new DataAccessError('grant_invalid');
    }
    await tx`insert into allrice_platform_repair_verifications(task_id,revision,operation_id,command,command_digest,proof)
      values(${source.task.id},${source.candidate.revision},${operationId},${tx.json(command)},${proof.commandDigest},${tx.json(proof)}) on conflict(task_id,revision) do nothing`;
    const [v] =
      await tx`select * from allrice_platform_repair_verifications where task_id=${source.task.id} and revision=${source.candidate.revision}`;
    if (
      !v ||
      v.operation_id !== operationId ||
      v.command_digest !== proof.commandDigest ||
      technicalDigest(v.command) !== technicalDigest(command) ||
      technicalDigest(v.proof) !== technicalDigest(proof)
    )
      throw new QueueError('conflict');
    return {
      arguments: args,
      command,
      callId,
      operationId,
      observation: v.observation
        ? RepairVerificationObservationSchema.parse(v.observation)
        : null,
    };
  });
}
/** The same private predicate runs inside the caller's existing admission,
 * heartbeat or publication transaction. It never opens a nested transaction. */
export async function resolvePlatformRepositoryExecutionProofTx(
  tx: postgres.TransactionSql,
  scope: {
    organizationId: string;
    workspaceId: string | null;
    ownerId: string;
    runId: string;
    jobId: string;
    workerId: string;
    leaseToken: string;
    operationId: string;
  },
  payload: CloudCommand,
) {
  const [job] = await tx<
    JobRow[]
  >`select * from allrice_jobs where id=${scope.jobId} and run_id=${scope.runId} for share`;
  if (!job || !hasRepairMarker(job)) return undefined;
  if (
    job.organization_id !== scope.organizationId ||
    job.workspace_id !== scope.workspaceId ||
    job.owner_id !== scope.ownerId ||
    !(await repairSchemaAvailable(tx))
  )
    throw new DataAccessError('authorization_denied');
  await assertPlatformRepairLease(tx, {
    workerId: scope.workerId,
    jobId: scope.jobId,
    leaseToken: scope.leaseToken,
    attempt: job.attempt,
  });
  const [v] =
    await tx`select v.*,q.frozen,c.candidate,q.candidate head_candidate,q.input_object_id
    from allrice_platform_repair_tasks q join allrice_platform_repair_verifications v on v.task_id=q.id
    join allrice_platform_repair_candidates c on c.task_id=q.id and c.revision=v.revision
    where q.run_id=${scope.runId} and q.job_id=${scope.jobId} and q.organization_id=${scope.organizationId}
    and q.workspace_id=${scope.workspaceId!} and q.owner_id=${scope.ownerId}
    and v.operation_id=${scope.operationId} and v.command_digest=${repositoryDigest(JSON.stringify(payload))}
    for share of q,v,c`;
  if (!v || !v.input_object_id)
    throw new DataAccessError('authorization_denied');
  const candidate = RepositoryCandidateSchema.parse(v.candidate);
  const expected = CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    arguments: repositoryVerificationCommand({
      baseline: v.frozen.baseline,
      candidate,
      object: {
        id: v.input_object_id,
        checksum: v.frozen.baseline.archiveChecksum,
      },
    }),
    backend: cloudBackendV1,
    imageDigest: cloudToolchainImageV1,
    runtime: 'runsc',
    network: 'none',
  });
  const proof = RepositoryExecutionProofSchema.parse(v.proof);
  if (
    v.head_candidate?.checksum !== candidate.checksum ||
    technicalDigest(payload) !== technicalDigest(expected) ||
    technicalDigest(v.command) !== technicalDigest(expected) ||
    proof.commandDigest !== repositoryDigest(JSON.stringify(payload)) ||
    proof.baselineId !== v.frozen.baselineId ||
    proof.candidateChecksum !== candidate.checksum ||
    scope.operationId !==
      cloudStableId(
        'cloud-command:' + scope.runId + ':repair-verify:' + candidate.revision,
      )
  )
    throw new DataAccessError('authorization_denied');
  return proof;
}
/** Worker ingress additionally binds the durable input to the original lease.
 * Model flags cannot select a larger input budget or a privileged supervisor. */
export async function resolvePlatformRepositoryExecutionProof(
  context: ExecutionContext,
  payload: CloudCommand,
  db: Db = getDatabase(),
) {
  return db.begin(async (tx) => {
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${context.jobId} and run_id=${context.runId} for share`;
    if (!job || !hasRepairMarker(job)) return undefined;
    const [i] =
      await tx`select operation_id,job_lease_token::text lease_token from allrice_cloud_execution_inputs
      where job_id=${context.jobId} and run_id=${context.runId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId!} and owner_id=${context.policySnapshot.subjectId}
      and worker_id=${context.worker.id} and payload=${tx.json(payload)}`;
    if (!i) throw new DataAccessError('authorization_denied');
    return resolvePlatformRepositoryExecutionProofTx(
      tx,
      {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        ownerId: context.policySnapshot.subjectId,
        runId: context.runId,
        jobId: context.jobId,
        workerId: context.worker.id,
        leaseToken: i.lease_token,
        operationId: i.operation_id,
      },
      payload,
    );
  });
}
export async function recordPlatformRepairVerification(
  lease: RepairLease,
  operationId: string,
) {
  const source = await readPlatformRepairSource(lease);
  return getDatabase().begin(async (tx) => {
    await assertPlatformRepairLease(tx, lease);
    const [v] =
      await tx`select v.*,c.candidate,a.outcome,a.cleanup_confirmed_at,r.snapshot->>'status' runtime_status,r.run_id runtime_run
      from allrice_platform_repair_verifications v join allrice_platform_repair_candidates c on c.task_id=v.task_id and c.revision=v.revision
      join allrice_cloud_execution_attempts a on a.operation_id=v.operation_id
      join allrice_runtime_operations r on r.id=v.operation_id where v.task_id=${source.task.id} and v.operation_id=${operationId}`;
    if (
      !v ||
      !v.cleanup_confirmed_at ||
      v.runtime_run !== source.task.run_id ||
      !v.outcome?.stopped ||
      !['completed', 'failed'].includes(v.outcome.reason) ||
      v.outcome.imageDigest !== cloudToolchainImageV1 ||
      v.outcome.repositoryIsolation?.parentUid !== 0 ||
      v.outcome.repositoryIsolation?.candidateUid !== 1001 ||
      v.outcome.repositoryIsolation?.commandDigest !== v.command_digest ||
      technicalDigest(v.outcome.repositoryIsolation?.capabilities) !==
        technicalDigest(['KILL', 'SETGID', 'SETUID']) ||
      v.outcome.repositoryIsolation?.readOnlyRoot !== true ||
      v.outcome.repositoryIsolation?.network !== 'none'
    )
      throw new DataAccessError('grant_invalid');
    const candidate = RepositoryCandidateSchema.parse(v.candidate),
      files = applyRepositoryCandidate(source.source.archive, candidate).archive
        .files;
    const report = readRepositoryVerification(
      v.outcome.output,
      source.source.baseline,
      candidate,
      {
        digest: repositoryMaterialDigest(files),
        sourceBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
      },
    );
    if (
      report.exitCode !== v.outcome.exitCode ||
      !['failed', 'succeeded'].includes(v.runtime_status) ||
      (report.exitCode === 0) !== (v.runtime_status === 'succeeded') ||
      report.failureKind === 'harness_error'
    )
      throw new DataAccessError('grant_invalid');
    const observation = RepairVerificationObservationSchema.parse({
      completedAt: new Date(v.cleanup_confirmed_at).toISOString(),
      revision: candidate.revision,
      operationId,
      report,
      stopped: true,
      cleanup: 'confirmed',
    });
    if (
      v.observation &&
      technicalDigest(v.observation) !== technicalDigest(observation)
    )
      throw new QueueError('conflict');
    await tx`update allrice_platform_repair_verifications set observation=${tx.json(observation)} where task_id=${source.task.id} and revision=${candidate.revision}`;
    return observation;
  });
}
