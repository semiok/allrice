import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { runtimeContractEqual } from '@allrice/contracts';
import type { JobRow } from './queue/row-mappers.ts';
import { DataAccessError } from './data.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { assertRepositoryCredentialAuthority } from './platform-repository-publication-authority.ts';
import { RepairFrozenSchema } from './platform-repair-authority.ts';
import { freezeRepositoryReviewMaterial } from './platform-repository-review-material.ts';
import {
  RepositoryReviewBindingSchema,
  RepositoryReviewFrozenSchema,
  RepositoryReviewRequestSchema,
  repositoryReviewConfiguration,
  repositoryReviewTools,
  type RepositoryReviewBinding,
} from './platform-repository-review-contracts.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { QueueError } from './execution/queue.ts';

type Tx = postgres.TransactionSql;
function deny(): never {
  throw new DataAccessError('authorization_denied');
}
export async function repositoryReviewSchemaAvailable(tx: Tx) {
  const [r] =
    await tx`select to_regclass(format('%I.allrice_platform_repository_review_subjects',current_schema())) is not null as available`;
  return r?.available === true;
}
/** Re-read the canonical lease with the database clock after all potentially
 * blocking authority locks. A lease observed before waiting is not authority. */
export async function assertRepositoryReviewLease(tx: Tx, job: JobRow) {
  const [live] = await tx<
    { lease_expires_at: Date; timeout_at: Date; now: Date }[]
  >`select lease_expires_at,timeout_at,clock_timestamp() as now from allrice_jobs
    where id=${job.id} and run_id=${job.run_id} and owner_id=${job.owner_id} and organization_id=${job.organization_id} and workspace_id=${job.workspace_id}
      and worker_id=${job.worker_id} and lease_token=${job.lease_token} and attempt=${job.attempt} and status='running' and cancel_requested_at is null
      and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() for share`;
  if (!live) deny();
  return live;
}
export function hasRepositoryReviewMarker(job: Pick<JobRow, 'payload'>) {
  const input = ((job.payload as { input?: unknown })?.input ?? {}) as Record<
    string,
    unknown
  >;
  return (
    Object.hasOwn(input, 'repositoryReviewRequestId') ||
    Object.hasOwn(input, 'repositoryReviewInputDigest')
  );
}
export async function readRepositoryReviewMaterial(
  tx: Tx,
  context: RequestContext,
  publicationId: string,
) {
  const [p] =
    await tx`select * from allrice_platform_repository_publications where id=${publicationId} and owner_id=${context.actor.id}
    and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} for share`;
  if (!p) throw new DataAccessError('not_found');
  const rows = await readRepositoryReviewRepairs(tx, context, p.source_task_id);
  const [inspection] =
    await tx`select a.mode,a.receipt,j.status from allrice_platform_repository_actions a join allrice_jobs j on j.id=a.job_id and j.run_id=a.run_id and j.owner_id=a.owner_id
    where a.publication_id=${p.id} and a.owner_id=${context.actor.id} and a.mode='inspect' order by a.created_at desc,a.id desc limit 1`;
  if (!inspection) throw Error('repository_review_current_ci_required');
  return freezeRepositoryReviewMaterial(
    p as Parameters<typeof freezeRepositoryReviewMaterial>[0],
    rows,
    inspection as Parameters<typeof freezeRepositoryReviewMaterial>[2],
  );
}
export function repositoryReviewFrozenValid(raw: unknown) {
  const p = RepositoryReviewFrozenSchema.safeParse(raw);
  if (!p.success) return false;
  const { fingerprint, ...fields } = p.data;
  return (
    fingerprint === technicalDigest(fields) &&
    p.data.expectedSubjectDigest === p.data.material.subjectDigest &&
    p.data.publicationId === p.data.material.publicationId
  );
}
export async function admitRepositoryReviewBinding(
  tx: Tx,
  context: RequestContext,
  assignmentId: string,
  raw: RepositoryReviewBinding,
) {
  const b = RepositoryReviewBindingSchema.parse(raw),
    f = b.frozen;
  if (
    !repositoryReviewFrozenValid(f) ||
    b.inputDigest !==
      technicalDigest(
        RepositoryReviewRequestSchema.parse({
          requestId: f.requestId,
          publicationId: f.publicationId,
          expectedSubjectDigest: f.expectedSubjectDigest,
          credentialRevision: f.credentialRevision,
        }),
      ) ||
    context.sessionId !== f.loginSessionId ||
    context.authenticatedAt !== f.loginAuthenticatedAt ||
    f.material.ownerId !== context.actor.id ||
    f.material.organizationId !== context.organizationId ||
    f.material.workspaceId !== context.workspaceId ||
    assignmentId !== f.assignmentId
  )
    deny();
  await assertRepositoryCredentialAuthority(tx, context, f.credentialRevision);
  await resolvePlatformPreviewContext(
    tx,
    {
      environment: 'platform',
      ownerId: context.actor.id,
      workspaceId: context.workspaceId,
    },
    context.actor.id,
  );
  const [d] =
    await tx`select * from allrice_platform_quality_deployments where assignment_id=${assignmentId} for share`;
  if (
    !d ||
    d.owner_id !== context.actor.id ||
    d.organization_id !== context.organizationId ||
    d.workspace_id !== context.workspaceId ||
    d.employee_version_id !== f.employeeVersionId ||
    d.employee_revision_id !== f.employeeRevisionId
  )
    deny();
  const material = await readRepositoryReviewMaterial(
    tx,
    context,
    f.publicationId,
  );
  if (material.subjectDigest !== f.material.subjectDigest) deny();
}
export async function bindRepositoryReview(
  tx: Tx,
  context: RequestContext,
  runId: string,
  jobId: string,
  sessionId: string,
  b: RepositoryReviewBinding,
) {
  await admitRepositoryReviewBinding(tx, context, b.frozen.assignmentId, b);
  await tx`select pg_advisory_xact_lock(hashtextextended(${`platform-repository-review:${context.actor.id}:${b.frozen.publicationId}`},0))`;
  const [blocked] =
    await tx`select s.id from allrice_platform_repository_review_subjects s join allrice_jobs j on j.id=s.job_id
    left join allrice_platform_repository_reviews r on r.subject_id=s.id where s.owner_id=${context.actor.id} and
    ((s.publication_id=${b.frozen.publicationId} and (j.status in ('queued','claimed','running') or (j.status='succeeded' and s.subject_digest=${b.frozen.material.subjectDigest} and r.verdict='accept' and s.delivery_artifact_id is not null)))
      or (s.content_digest=${b.frozen.material.candidateContentDigest} and r.verdict='revise')) limit 1`;
  if (blocked) throw new QueueError('conflict');
  await tx`insert into allrice_platform_repository_review_subjects(id,publication_id,owner_id,organization_id,workspace_id,request_id,input_digest,run_id,job_id,session_id,frozen,subject_digest,content_digest)
    values(${b.id},${b.frozen.publicationId},${context.actor.id},${context.organizationId},${context.workspaceId!},${b.frozen.requestId},${b.inputDigest},${runId},${jobId},${sessionId},${tx.json(b.frozen)},${b.frozen.material.subjectDigest},${b.frozen.material.candidateContentDigest})`;
}
export async function assertExistingRepositoryReviewBinding(
  tx: Tx,
  context: RequestContext,
  runId: string,
  b: RepositoryReviewBinding,
) {
  const [s] =
    await tx`select * from allrice_platform_repository_review_subjects where run_id=${runId} and owner_id=${context.actor.id}`;
  if (
    !s ||
    s.id !== b.id ||
    s.input_digest !== b.inputDigest ||
    !repositoryReviewFrozenValid(s.frozen)
  )
    throw new QueueError('conflict');
}
/** Additional platform restrictions; canonical Employee/assistant admission is
 * still required. Missing markers cannot turn a registered subject into chat. */
export async function isRepositoryReviewJobAuthorized(tx: Tx, job: JobRow) {
  if (!(await repositoryReviewSchemaAvailable(tx)))
    return !hasRepositoryReviewMarker(job);
  const [s] =
    await tx`select s.*,e.employee_assignment_id,e.employee_version_id,e.session_id employee_session,r.input run_input
    from allrice_platform_repository_review_subjects s join allrice_employee_runs e on e.run_id=s.run_id and e.owner_id=s.owner_id and e.organization_id=s.organization_id and e.workspace_id=s.workspace_id
    join allrice_runs r on r.id=e.run_id where s.run_id=${job.run_id} and s.job_id=${job.id}`;
  if (!s) return !hasRepositoryReviewMarker(job);
  if (!hasRepositoryReviewMarker(job) || !repositoryReviewFrozenValid(s.frozen))
    return false;
  const f = RepositoryReviewFrozenSchema.parse(s.frozen),
    i = (job.payload as { input: Record<string, unknown> }).input;
  if (
    i.repositoryReviewRequestId !== f.requestId ||
    i.repositoryReviewInputDigest !== s.input_digest ||
    !runtimeContractEqual(i, s.run_input) ||
    !runtimeContractEqual(
      i.assistantConfiguration,
      repositoryReviewConfiguration,
    ) ||
    s.employee_assignment_id !== f.assignmentId ||
    s.employee_version_id !== f.employeeVersionId ||
    s.employee_session !== s.session_id ||
    job.owner_id !== s.owner_id ||
    job.organization_id !== s.organization_id ||
    job.workspace_id !== s.workspace_id ||
    job.max_attempts !== 1 ||
    job.cancel_requested_at ||
    job.timeout_at <= new Date()
  )
    return false;
  const context: RequestContext = {
    requestId: f.requestId,
    actor: { type: 'user', id: s.owner_id },
    organizationId: s.organization_id,
    workspaceId: s.workspace_id,
    sessionId: f.loginSessionId,
    authenticatedAt: f.loginAuthenticatedAt,
    memberships: [],
  };
  try {
    await admitRepositoryReviewBinding(tx, context, f.assignmentId, {
      id: s.id,
      inputDigest: s.input_digest,
      frozen: f,
    });
    return true;
  } catch {
    return false;
  }
}
export async function assertRepositoryReviewAssistantAuthority(
  tx: Tx,
  rootRunId: string,
  tools: string[],
) {
  if (!(await repositoryReviewSchemaAvailable(tx))) return false;
  const [s] =
    await tx`select job_id from allrice_platform_repository_review_subjects where run_id=${rootRunId}`;
  if (!s) return false;
  const [job] = await tx<
    JobRow[]
  >`select * from allrice_jobs where id=${s.job_id} for share`;
  if (
    !job ||
    !(await isRepositoryReviewJobAuthorized(tx, job)) ||
    tools.some(
      (t) =>
        !repositoryReviewTools.includes(
          t as (typeof repositoryReviewTools)[number],
        ),
    )
  )
    deny();
  await assertRepositoryReviewLease(tx, job);
  return true;
}
export async function repositoryReviewCompletionAllowed(
  tx: Tx,
  job: JobRow,
  requireRemoteProof = true,
) {
  if (!(await repositoryReviewSchemaAvailable(tx)))
    return !hasRepositoryReviewMarker(job);
  const [registered] =
    await tx`select id from allrice_platform_repository_review_subjects where run_id=${job.run_id} and job_id=${job.id}`;
  if (!registered) return !hasRepositoryReviewMarker(job);
  if (!(await isRepositoryReviewJobAuthorized(tx, job))) return false;
  await assertRepositoryReviewLease(tx, job);
  const [s] =
    await tx`select s.id,s.frozen,s.preflight,s.postflight,s.reviewer_run_id,s.delivery_artifact_id,r.verdict,r.artifact_id,i.status,i.cancel_requested_at,
    (rt.root_run_id is not null and rt.cancel_request_id is null and rt.deadline_at>clock_timestamp() and authority.root_run_id is not null and authority.revoked_at is null and root_instance.run_id is not null and root_instance.cancel_requested_at is null) as root_live,
    ar.delivery_id,ar.parent_adopted_seq,
    exists(select 1 from jsonb_array_elements(ar.payload->'evidence') e where e->>'id'=r.artifact_id::text) as reported_review,
    (select count(*)::int from allrice_deliverable_versions v join allrice_storage_objects o on o.id=v.object_id and o.state='ready' and o.immutable and o.deleted_at is null
      where v.id=any(array[s.seed_artifact_id,r.artifact_id,s.delivery_artifact_id]) and v.owner_id=s.owner_id and v.organization_id=s.organization_id and v.workspace_id=s.workspace_id and v.session_id=s.session_id) as ready_artifacts
    from allrice_platform_repository_review_subjects s left join allrice_platform_repository_reviews r on r.subject_id=s.id
    left join allrice_runtime_roots rt on rt.root_run_id=s.run_id and rt.organization_id=s.organization_id and rt.workspace_id=s.workspace_id
    left join allrice_assistant_roots authority on authority.root_run_id=rt.root_run_id
    left join allrice_assistant_instances root_instance on root_instance.run_id=s.run_id and root_instance.root_run_id=s.run_id
    left join allrice_assistant_instances i on i.run_id=s.reviewer_run_id and i.root_run_id=s.run_id and i.parent_run_id=s.run_id
    left join allrice_assistant_results ar on ar.run_id=i.run_id where s.run_id=${job.run_id} and s.job_id=${job.id}`;
  if (!s) return !hasRepositoryReviewMarker(job);
  if (!s.root_live || s.cancel_requested_at) return false;
  if (
    requireRemoteProof &&
    (!s.preflight ||
      !s.postflight ||
      s.preflight.subjectDigest !== s.frozen.material.subjectDigest ||
      s.postflight.subjectDigest !== s.frozen.material.subjectDigest ||
      s.postflight.evidenceDigest !== s.frozen.material.evidenceDigest ||
      s.postflight.jobAttempt !== job.attempt)
  )
    return false;
  return (
    s.status === 'completed' &&
    !!s.delivery_id &&
    s.parent_adopted_seq !== null &&
    s.reported_review === true &&
    !!s.artifact_id &&
    (s.verdict === 'revise'
      ? s.ready_artifacts === 2
      : s.verdict === 'accept' &&
        !!s.delivery_artifact_id &&
        s.ready_artifacts === 3)
  );
}

export async function readRepositoryReviewRepairs(
  tx: Tx,
  context: RequestContext,
  sourceTaskId: string,
) {
  const rows: Parameters<typeof freezeRepositoryReviewMaterial>[1] = [];
  let taskId: string | null = sourceTaskId;
  const seen = new Set<string>();
  while (taskId) {
    if (seen.has(taskId) || seen.size >= 16) deny();
    seen.add(taskId);
    const [r]: Parameters<typeof freezeRepositoryReviewMaterial>[1] = await tx<
      Parameters<typeof freezeRepositoryReviewMaterial>[1]
    >`select q.*,j.status from allrice_platform_repair_tasks q join allrice_jobs j on j.id=q.job_id and j.run_id=q.run_id and j.owner_id=q.owner_id
      where q.id=${taskId} and q.owner_id=${context.actor.id} and q.organization_id=${context.organizationId} and q.workspace_id=${context.workspaceId!} for share of q,j`;
    if (!r) deny();
    rows.push(
      r as Parameters<typeof freezeRepositoryReviewMaterial>[1][number],
    );
    taskId = RepairFrozenSchema.parse(r.frozen).reuseSeed?.sourceTaskId ?? null;
  }
  return rows;
}
