import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { isPlatformAdmin } from './platform-authority.ts';
import {
  currentMaintenanceAdmin,
  MaintenanceConflict,
} from './platform-maintenance.ts';
import { MaintenancePolicySchema } from './platform-maintenance-contracts.ts';
import { MaintenanceReportPayloadSchema } from './platform-maintenance-report-contracts.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { cloudStableId } from './cloud-execution.ts';
import { loadRepositoryBaseline } from './platform-repository-source.ts';
import {
  maintenanceRepairPlan,
  maintenanceFixtureDigest,
  maintenanceOracleChecksum,
} from './platform-maintenance-profile.ts';
import {
  CreateMaintenanceGrantSchema,
  MaintenanceDiagnosisProofSchema,
  MaintenanceDiagnosisSchema,
  MaintenanceGrantFrozenSchema,
  MaintenanceGrantSchema,
  type MaintenanceDiagnosisProof,
} from './platform-maintenance-authority-contracts.ts';
import {
  maintenanceGithubIdentity,
  readMaintenanceGithubBot,
} from './platform-maintenance-github.ts';
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const denied = () => {
  throw new DataAccessError('authorization_denied');
};
async function currentIssuer(tx: Tx, owner: string) {
  if (
    !(await isPlatformAdmin({ actor: { type: 'user', id: owner } }, tx)) ||
    !(
      await tx`select id from allrice_users where id=${owner} and status='active' for share`
    ).length
  )
    denied();
}
function diagnosis(row: Row) {
  return MaintenanceDiagnosisSchema.parse({
    id: row.id,
    reportId: row.report_id,
    targetSha: row.target_sha,
    defectId: row.defect_id,
    proof: row.proof,
    proofDigest: row.proof_digest,
    createdAt: iso(row.created_at),
  });
}
function grant(row: Row) {
  return MaintenanceGrantSchema.parse({
    id: row.id,
    requestId: row.request_id,
    ...(row.can_control !== undefined
      ? {
          canControl: row.can_control,
          repairStatus: row.repair_status ?? null,
          publication: row.publication ?? null,
        }
      : {}),
    reportId: row.report_id,
    deploymentId: row.deployment_id,
    defectId: row.defect_id,
    origin: row.origin,
    frozenDigest: row.frozen_digest,
    attemptId: row.attempt_id,
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    repairTaskId: row.repair_task_id,
    publicationId: row.publication_id,
    createdAt: iso(row.created_at),
  });
}
/** Called only by the trusted central Worker; installation HTTP never accepts a
 * diagnosis, proof, candidate path, fingerprint or caller-selected repository. */
export async function recordMaintenanceDiagnosis(
  reportId: string,
  raw: MaintenanceDiagnosisProof,
) {
  const proof = MaintenanceDiagnosisProofSchema.parse(raw);
  const registered = loadRepositoryBaseline(
    process.env.ALLRICE_REPOSITORY_BASELINE_DIR,
    proof.baseline.id,
  );
  const plan = maintenanceRepairPlan(registered.baseline, registered.archive);
  const mapping = proof.sourceMapping;
  const sourceFile = registered.archive.files.find(
    (f) => f.path === mapping.sourcePath,
  );
  if (
    proof.producerSourceTree !== proof.baseline.gitTree ||
    mapping.sourceTree !== proof.baseline.gitTree ||
    mapping.sourceChecksum !== sourceFile?.checksum ||
    mapping.outputChecksum !== proof.moduleArtifactDigest ||
    mapping.exportEntryChecksum !== proof.exportEntryArtifactDigest ||
    technicalDigest(mapping) !== proof.sourceMappingDigest ||
    proof.oracleChecksum !== maintenanceOracleChecksum ||
    new Set(mapping.configuration.map((x) => x.path)).size !== 4 ||
    mapping.configuration.some(
      (x) =>
        registered.archive.files.find((f) => f.path === x.path)?.checksum !==
        x.checksum,
    ) ||
    proof.probeResults.some(
      (r, i) =>
        r.id !== ['quoted_spaces', 'quoted_escapes', 'streamed_secret'][i] ||
        r.passed !== (r.redactionMarkerPresent && r.secretAbsent),
    ) ||
    technicalDigest(
      proof.probeResults.filter((r) => !r.passed).map((r) => r.id),
    ) !== technicalDigest(proof.failedAssertions)
  )
    denied();
  if (
    proof.producerSourceSha !== process.env.ALLRICE_RELEASE_SHA ||
    proof.baseline.sourceSha !== proof.producerSourceSha ||
    technicalDigest(proof.baseline) !== technicalDigest(registered.baseline) ||
    proof.verificationPlanDigest !== technicalDigest(plan) ||
    technicalDigest(proof.verificationPlan) !== technicalDigest(plan) ||
    new Set(proof.failedAssertions).size !== proof.failedAssertions.length ||
    proof.failedAssertions.length > 0 !== (proof.verdict === 'confirmed_code')
  )
    denied();
  return getDatabase().begin(async (tx) => {
    const [lookup] =
      await tx`select owner_id from allrice_platform_maintenance_reports where id=${UuidSchema.parse(reportId)}`;
    if (!lookup) denied();
    await currentIssuer(tx, lookup!.owner_id);
    const [r] =
      await tx`select r.*,d.policy,d.revoked_at from allrice_platform_maintenance_reports r join allrice_platform_maintenance_deployments d on d.id=r.deployment_id where r.id=${reportId} for share of r,d`;
    if (!r || r.revoked_at || MaintenancePolicySchema.parse(r.policy).paused)
      denied();
    const payload = MaintenanceReportPayloadSchema.parse(r!.payload),
      probe = payload.facts.probe;
    if (
      payload.sourceKind !== 'deployment_health' ||
      !probe ||
      probe.specId !== proof.specId ||
      probe.fixtureDigest !== maintenanceFixtureDigest ||
      !probe.failedAssertions.length ||
      payload.facts.quality
    )
      denied();
    const [old] =
      await tx`select * from allrice_platform_maintenance_diagnoses where report_id=${reportId} and target_sha=${proof.baseline.sourceSha}`;
    if (old) return diagnosis(old);
    let defectId: string | null = null;
    if (proof.verdict === 'confirmed_code') {
      const before = plan.approvedFiles[0]!.beforeChecksum;
      const failureSignature = technicalDigest({
        specId: proof.specId,
        oracleChecksum: maintenanceOracleChecksum,
        assertions: [...proof.failedAssertions].sort(),
      });
      const key = technicalDigest({
        repositoryId: 1323769790,
        family: 'command-output.credentials.v2',
        beforeChecksum: before,
        failureSignature,
      });
      await tx`insert into allrice_platform_maintenance_defects(id,repository_id,defect_key,spec_id,before_checksum,failure_signature) values(${randomUUID()},1323769790,${key},${proof.specId},${before},${failureSignature}) on conflict(defect_key) do nothing`;
      const [d] =
        await tx`select id from allrice_platform_maintenance_defects where defect_key=${key}`;
      defectId = d!.id;
    }
    const [row] =
      await tx`insert into allrice_platform_maintenance_diagnoses(id,report_id,report_digest,target_sha,proof,proof_digest,defect_id) values(${randomUUID()},${reportId},${r!.payload_digest},${proof.baseline.sourceSha},${tx.json(proof)},${technicalDigest(proof)},${defectId}) on conflict(report_id,target_sha) do nothing returning *`;
    if (row) return diagnosis(row);
    return diagnosis(
      (
        await tx`select * from allrice_platform_maintenance_diagnoses where report_id=${reportId} and target_sha=${proof.baseline.sourceSha}`
      )[0]!,
    );
  });
}
export async function maintenanceDiagnosisCandidates(targetSha: string) {
  if (!/^[a-f0-9]{40}$/.test(targetSha)) return [];
  const emails = (
    process.env.ALLRICE_PLATFORM_ADMIN_EMAILS ?? 'semiokshen@gmail.com'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) return [];
  const sql = getDatabase();
  return sql`select r.id from allrice_platform_maintenance_reports r join allrice_platform_maintenance_deployments d on d.id=r.deployment_id join allrice_users u on u.id=r.owner_id
 where u.status='active' and lower(u.email) in ${sql(emails)} and d.revoked_at is null and coalesce((d.policy->>'paused')::boolean,true)=false
 and r.payload->>'sourceKind'='deployment_health' and r.payload->'facts'->'quality'='null'::jsonb
 and r.payload->'facts'->'probe'->>'specId'='command-output.credentials.v2'
 and r.payload->'facts'->'probe'->>'fixtureDigest'=${maintenanceFixtureDigest}
 and jsonb_array_length(r.payload->'facts'->'probe'->'failedAssertions')>0
 and not exists(select 1 from allrice_platform_maintenance_diagnoses a where a.report_id=r.id and a.target_sha=${targetSha})
 order by r.received_at,r.id limit 10`;
}
export async function getMaintenanceReportAuthority(
  context: RequestContext,
  reportId: string,
) {
  return getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    const [r] =
      await tx`select id from allrice_platform_maintenance_reports where id=${UuidSchema.parse(reportId)} and owner_id=${owner}`;
    if (!r) throw new DataAccessError('not_found');
    const diagnoses =
      await tx`select * from allrice_platform_maintenance_diagnoses where report_id=${reportId} order by created_at desc,id desc limit 10`;
    const grants =
      await tx`select g.*,l.attempt_id,a.repair_task_id shared_repair_task_id,a.publication_id shared_publication_id,(a.primary_grant_id=g.id) can_control,j.status repair_status,
      case when p.id is null then null else jsonb_build_object('id',p.id,'url',p.remote->>'url','number',(p.remote->>'number')::int,'ci',coalesce(p.ci,'{"state":"not_observed","observedAt":null,"workflowRunId":null,"runAttempt":null,"headSha":null,"checkoutSha":null,"checkoutTree":null,"materialDigest":null,"checks":[]}'::jsonb),'sourceCompanySlug',p.provenance->>'companySlug') end publication
      from allrice_platform_maintenance_grants g join allrice_platform_maintenance_grant_attempts l on l.grant_id=g.id join allrice_platform_maintenance_attempts a on a.id=l.attempt_id
      left join allrice_platform_repair_tasks q on q.id=a.repair_task_id left join allrice_jobs j on j.id=q.job_id left join allrice_platform_repository_publications p on p.id=a.publication_id
      where g.report_id=${reportId} and g.issuer_id=${owner} order by g.created_at desc,g.id desc limit 10`;
    return {
      diagnoses: diagnoses.map(diagnosis),
      grants: grants.map((r) =>
        grant({
          ...r,
          repair_task_id: r.shared_repair_task_id,
          publication_id: r.shared_publication_id,
        }),
      ),
    };
  });
}
async function issue(
  tx: Tx,
  request: ReturnType<typeof CreateMaintenanceGrantSchema.parse>,
  origin: 'manual' | 'automatic',
  context?: RequestContext,
) {
  const [lookup] =
    await tx`select deployment_id,owner_id from allrice_platform_maintenance_reports where id=${request.reportId}`;
  if (!lookup || (context && lookup.owner_id !== context.actor.id))
    throw new DataAccessError('not_found');
  const owner = lookup.owner_id as string;
  await currentIssuer(tx, owner);
  if (context) await currentMaintenanceAdmin(context, tx);
  const [d] =
    await tx`select * from allrice_platform_maintenance_deployments where id=${lookup.deployment_id} and owner_id=${owner} for update`;
  const [r] =
    await tx`select * from allrice_platform_maintenance_reports where id=${request.reportId} and deployment_id=${d!.id} for share`;
  const [a] =
    await tx`select * from allrice_platform_maintenance_diagnoses where report_id=${r!.id} and target_sha=${process.env.ALLRICE_RELEASE_SHA ?? ''} order by created_at desc limit 1 for share`;
  const p = MaintenancePolicySchema.parse(d!.policy);
  if (
    !a?.defect_id ||
    d!.revoked_at ||
    p.paused ||
    !p.allowedModules.includes('project-runtime') ||
    d!.revision !== request.expectedDeploymentRevision ||
    r!.payload_digest !== request.expectedReportDigest ||
    a.proof_digest !== request.expectedDiagnosisDigest
  )
    throw new DataAccessError('grant_invalid');
  const proof = MaintenanceDiagnosisProofSchema.parse(a.proof);
  if (
    proof.verdict !== 'confirmed_code' ||
    a.report_digest !== r!.payload_digest
  )
    denied();
  const registered = loadRepositoryBaseline(
      process.env.ALLRICE_REPOSITORY_BASELINE_DIR,
      proof.baseline.id,
    ),
    plan = maintenanceRepairPlan(registered.baseline, registered.archive);
  if (
    technicalDigest(plan) !== proof.verificationPlanDigest ||
    technicalDigest(proof.baseline) !== technicalDigest(registered.baseline)
  )
    denied();
  // Cross-company key, not request UUID or error text. Serialize one defect.
  await tx`select id from allrice_platform_maintenance_defects where id=${a.defect_id} for update`;
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const now = clock!.now;
  if (
    origin === 'automatic' &&
    (p.mode !== 'repair_and_pr' ||
      !d!.enabled_at ||
      !p.automaticAuthorizationUntil ||
      Date.parse(p.automaticAuthorizationUntil) <= now.getTime() ||
      r!.received_at < d!.enabled_at ||
      Date.parse(r!.payload.sampledAt) < d!.enabled_at.getTime())
  )
    throw new DataAccessError('grant_invalid');
  const requestDigest = technicalDigest({ request, origin });
  const [prior] =
    await tx`select g.*,l.attempt_id from allrice_platform_maintenance_grants g join allrice_platform_maintenance_grant_attempts l on l.grant_id=g.id where g.issuer_id=${owner} and g.request_id=${request.requestId}`;
  if (prior) {
    if (prior.request_digest !== requestDigest) throw new MaintenanceConflict();
    return grant(prior);
  }
  const [count] =
    await tx`select count(*)::int n from allrice_platform_maintenance_grants where deployment_id=${d!.id} and created_at>=date_trunc('day',clock_timestamp())`;
  if (Number(count!.n) >= p.dailyRepairLimit)
    throw new DataAccessError('grant_invalid');
  const expiresAt = new Date(
    Math.min(
      now.getTime() + p.repairTimeoutMinutes * 60000,
      origin === 'automatic'
        ? Date.parse(p.automaticAuthorizationUntil!)
        : Infinity,
    ),
  ).toISOString();
  const f = MaintenanceGrantFrozenSchema.parse({
    version: 1,
    reportId: r!.id,
    reportDigest: r!.payload_digest,
    deploymentId: d!.id,
    companySlug: d!.company_slug,
    companyName: d!.company_name,
    deploymentName: d!.deployment_name,
    installedReleaseSha: r!.payload.observedReleaseSha,
    diagnosisId: a.id,
    diagnosisDigest: a.proof_digest,
    defectId: a.defect_id,
    baseline: proof.baseline,
    verificationPlan: plan,
    verificationPlanDigest: proof.verificationPlanDigest,
    policyRevision: d!.revision,
    credentialRevision: d!.credential_revision,
    origin,
    repairTimeoutMs: p.repairTimeoutMinutes * 60000,
    maxCandidateRevisions: p.maxCandidateRevisions,
    maxOutputTokens: p.maxOutputTokens,
    githubBot: await maintenanceGithubIdentity(tx),
    outputBudgetMode: 'observed_threshold',
    maxModelCalls: 16,
    expiresAt,
  });
  if (context) await currentMaintenanceAdmin(context, tx);
  const [row] =
    await tx`insert into allrice_platform_maintenance_grants(id,issuer_id,request_id,request_digest,report_id,deployment_id,diagnosis_id,defect_id,policy_revision,credential_revision,origin,frozen,frozen_digest,expires_at) values(${randomUUID()},${owner},${request.requestId},${requestDigest},${r!.id},${d!.id},${a.id},${a.defect_id},${d!.revision},${d!.credential_revision},${origin},${tx.json(f)},${technicalDigest(f)},${expiresAt}) returning *`;
  const [existingAttempt] =
    await tx`select id from allrice_platform_maintenance_attempts where defect_id=${a.defect_id}`;
  const attemptId = existingAttempt?.id ?? randomUUID();
  if (!existingAttempt)
    await tx`insert into allrice_platform_maintenance_attempts(id,defect_id,primary_grant_id) values(${attemptId},${a.defect_id},${row!.id})`;
  await tx`insert into allrice_platform_maintenance_grant_attempts(grant_id,attempt_id) values(${row!.id},${attemptId})`;
  return grant({ ...row!, attempt_id: attemptId });
}
export async function createMaintenanceGrant(
  context: RequestContext,
  raw: unknown,
) {
  const request = CreateMaintenanceGrantSchema.parse(raw);
  return getDatabase().begin(async (tx) => {
    await currentMaintenanceAdmin(context, tx);
    return issue(tx, request, 'manual', context);
  });
}
export async function createAutomaticMaintenanceGrant(reportId: string) {
  return getDatabase().begin(async (tx) => {
    const [r] =
      await tx`select r.payload_digest,d.revision,a.proof_digest from allrice_platform_maintenance_reports r join allrice_platform_maintenance_deployments d on d.id=r.deployment_id join allrice_platform_maintenance_diagnoses a on a.report_id=r.id and a.target_sha=${process.env.ALLRICE_RELEASE_SHA ?? ''} where r.id=${reportId}`;
    if (!r) throw new DataAccessError('not_found');
    return issue(
      tx,
      {
        requestId: cloudStableId(
          'maintenance-auto:' + reportId + ':' + r.revision,
        ),
        reportId,
        expectedReportDigest: r.payload_digest,
        expectedDiagnosisDigest: r.proof_digest,
        expectedDeploymentRevision: r.revision,
      },
      'automatic',
    );
  });
}
/** Background authority is explicit and expires. It never invents or extends a
 * browser login. Call inside the existing admission/lease/write transaction. */
export async function assertMaintenanceGrant(
  tx: Tx,
  id: string,
  owner: string,
) {
  const [lookup] =
    await tx`select deployment_id from allrice_platform_maintenance_grants where id=${UuidSchema.parse(id)} and issuer_id=${owner}`;
  if (!lookup) denied();
  // Match queue admission: issuer -> deployment -> grant -> attempt. A
  // preflight must not hold grant SHARE while waiting for issuer UPDATE.
  await currentIssuer(tx, owner);
  const [d] =
    await tx`select * from allrice_platform_maintenance_deployments where id=${lookup!.deployment_id} and owner_id=${owner} for share`;
  const [g] =
    await tx`select * from allrice_platform_maintenance_grants where id=${id} and issuer_id=${owner} for share`;
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const now = clock!.now;
  if (!d || !g || g.revoked_at || d.revoked_at || g.expires_at <= now) denied();
  const f = MaintenanceGrantFrozenSchema.parse(g!.frozen),
    p = MaintenancePolicySchema.parse(d!.policy);
  if (
    technicalDigest(f) !== g!.frozen_digest ||
    f.reportId !== g!.report_id ||
    f.deploymentId !== d!.id ||
    f.defectId !== g!.defect_id ||
    g!.policy_revision !== d!.revision ||
    g!.credential_revision !== d!.credential_revision ||
    f.policyRevision !== d!.revision ||
    f.credentialRevision !== d!.credential_revision ||
    f.origin !== g!.origin ||
    f.expiresAt !== g!.expires_at.toISOString() ||
    p.paused ||
    !p.allowedModules.includes('project-runtime') ||
    f.baseline.sourceSha !== process.env.ALLRICE_RELEASE_SHA ||
    technicalDigest(f.verificationPlan) !== f.verificationPlanDigest
  )
    denied();
  if (
    f.origin === 'automatic' &&
    (p.mode !== 'repair_and_pr' ||
      !p.automaticAuthorizationUntil ||
      Date.parse(p.automaticAuthorizationUntil) <= now.getTime())
  )
    denied();
  if (!f.githubBot) denied();
  await readMaintenanceGithubBot(tx, f.githubBot!, 'write');
  const [r] =
    await tx`select payload_digest from allrice_platform_maintenance_reports where id=${f.reportId} and deployment_id=${d!.id}`;
  const [a] =
    await tx`select proof_digest from allrice_platform_maintenance_diagnoses where id=${f.diagnosisId} and report_id=${f.reportId} and defect_id=${f.defectId}`;
  if (
    r?.payload_digest !== f.reportDigest ||
    a?.proof_digest !== f.diagnosisDigest
  )
    denied();
  return {
    row: g!,
    frozen: f,
    remainingMs: Math.max(0, g!.expires_at.getTime() - now.getTime()),
  };
}
export async function revokeMaintenanceGrant(
  context: RequestContext,
  id: string,
) {
  return getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    const [g] =
      await tx`update allrice_platform_maintenance_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=${UuidSchema.parse(id)} and issuer_id=${owner} returning *`;
    if (!g) throw new DataAccessError('not_found');
    await currentMaintenanceAdmin(context, tx);
    const [link] =
      await tx`select attempt_id from allrice_platform_maintenance_grant_attempts where grant_id=${g.id}`;
    return grant({ ...g, attempt_id: link!.attempt_id });
  });
}

/** Read-only observation of a previously authorized attempt. Expiry/revocation
 * never grants new writes; rotation is permitted only for the same bot account. */
export async function assertMaintenanceReconciliation(
  tx: Tx,
  id: string,
  owner: string,
) {
  await currentIssuer(tx, owner);
  const [g] =
    await tx`select * from allrice_platform_maintenance_grants where id=${UuidSchema.parse(id)} and issuer_id=${owner} for share`;
  if (!g) denied();
  const frozen = MaintenanceGrantFrozenSchema.parse(g!.frozen);
  if (
    technicalDigest(frozen) !== g!.frozen_digest ||
    frozen.reportId !== g!.report_id ||
    frozen.defectId !== g!.defect_id ||
    !frozen.githubBot
  )
    denied();
  const bot = await readMaintenanceGithubBot(
    tx,
    frozen.githubBot!,
    'reconcile',
  );
  return { row: g!, frozen, bot };
}
