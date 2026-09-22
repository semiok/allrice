import {
  RuntimeOperationSnapshotSchema,
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandResultSchema,
  runtimeContractEqual,
  type TenantDevelopmentInspection,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import type { TenantManagementTarget } from './tenant-management-scope.ts';
import { localCommandCandidateEvidence } from './local-command-candidate.ts';

/** Pure receipt matching. A terminal label or a model's report is not test proof. */
export function inspectDevelopmentTestEvidence(
  snapshot: unknown,
  payload: unknown,
  output: unknown,
  assigned: { testerRunId: string; candidateId: string; digest: string },
) {
  const op = RuntimeOperationSnapshotSchema.safeParse(snapshot);
  const command = RuntimeLocalCommandSchema.safeParse(payload);
  const result = RuntimeLocalCommandResultSchema.safeParse(output);
  const matched =
    op.success &&
    command.success &&
    result.success &&
    op.data.agentInstanceId === assigned.testerRunId &&
    op.data.binding.action === 'local.process.execute' &&
    ['succeeded', 'failed'].includes(op.data.status) &&
    command.data.arguments.candidate?.artifactId === assigned.candidateId &&
    command.data.arguments.candidate.checksum === assigned.digest &&
    result.data.imageDigest === command.data.arguments.imageDigest &&
    runtimeContractEqual(
      result.data.candidate,
      localCommandCandidateEvidence(command.data),
    );
  return {
    evidenceMatched: Boolean(matched),
    exitCode: matched && result.success ? result.data.exitCode : null,
    reason: matched && result.success ? result.data.reason : null,
  };
}

/** Internal: caller must check live admin authority before and after inspection.
 * Recheck root ownership here as well; only project selected bounded fields. */
export async function inspectTenantDevelopment(
  target: TenantManagementTarget,
  runId: string,
  redact: (text: string) => string,
  db = getDatabase(),
): Promise<TenantDevelopmentInspection | null> {
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const [head] = await tx<
      { candidateId: string; digest: string; revision: number }[]
    >`
      select h.head_artifact_id as "candidateId",h.head_digest as digest,h.revision
      from allrice_development_heads h
      join allrice_runs r on r.id=h.root_run_id
      join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id
        and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=r.organization_id
        and s.workspace_id=r.workspace_id and s.owner_id=r.owner_id and s.archived_at is null
      where h.root_run_id=${runId} and r.organization_id=${target.organizationId}
        and r.workspace_id=${target.workspaceId} and r.owner_id=${target.subjectId}`;
    if (!head) return null;
    const proposals = await tx<TenantDevelopmentInspection['proposals']>`
      select p.artifact_id as "artifactId",a.run_id as "authorRunId",p.digest,
        exists(select 1 from allrice_development_merge_sources s join allrice_development_merges m
          on m.request_id=s.request_id where s.artifact_id=p.artifact_id and m.root_run_id=${runId}) as accepted
      from allrice_development_proposals p join allrice_development_assignments a
        on a.id=p.assignment_id and a.root_run_id=p.root_run_id
      where p.root_run_id=${runId} order by p.created_at desc,p.artifact_id limit 65`;
    const reviews = await tx<TenantDevelopmentInspection['reviews']>`
      select id,reviewer_run_id as "reviewerRunId",artifact_id as "candidateId",digest,
        operation_id as "operationId",verdict,left(summary,2000) as summary
      from allrice_development_reviews where root_run_id=${runId} order by created_at desc,id limit 65`;
    const deliveries = await tx<TenantDevelopmentInspection['deliveries']>`
      select artifact_id as "artifactId",candidate_id as "candidateId",digest,review_id as "reviewId"
      from allrice_development_deliveries where root_run_id=${runId} order by created_at desc,artifact_id limit 65`;
    const tests = await tx<
      {
        operationId: string;
        testerRunId: string;
        candidateId: string;
        digest: string;
        status: string;
        snapshot: unknown;
        payload: unknown;
        output: unknown;
      }[]
    >`
      select o.id as "operationId",v.run_id as "testerRunId",v.artifact_id as "candidateId",v.digest,
        left(o.snapshot->>'status',80) as status,o.snapshot,o.bridge_payload as payload,receipt.output
      from allrice_runtime_operations o join allrice_development_verifiers v
        on v.root_run_id=o.root_run_id and v.role='test'
        and v.run_id::text=o.snapshot->>'agentInstanceId'
        and v.artifact_id::text=o.bridge_payload->'arguments'->'candidate'->>'artifactId'
        and v.digest=o.bridge_payload->'arguments'->'candidate'->>'checksum'
      left join lateral(select payload->'evidence'->'output' as output
        from allrice_runtime_operation_receipts where operation_id=o.id and disposition='applied'
          and payload->'signal'->>'type'='operation.outcome'
          and payload->'signal'->'result'->'evidence'->>'id'=o.snapshot->'result'->'evidence'->>'id'
        order by received_at desc limit 1) receipt on true
      where o.root_run_id=${runId} and o.organization_id=${target.organizationId}
        and o.workspace_id=${target.workspaceId} and o.snapshot->'binding'->'requestedBy'->>'id'=${target.subjectId}
        and o.snapshot->'binding'->>'action'='local.process.execute'
      order by o.created_at desc,o.id limit 65`;
    return {
      ...head,
      proposals: proposals.slice(0, 64),
      tests: tests.slice(0, 64).map((t) => ({
        operationId: t.operationId,
        testerRunId: t.testerRunId,
        candidateId: t.candidateId,
        digest: t.digest,
        status: t.status,
        ...inspectDevelopmentTestEvidence(t.snapshot, t.payload, t.output, t),
      })),
      reviews: reviews
        .slice(0, 64)
        .map((r) => ({ ...r, summary: redact(r.summary) })),
      deliveries: deliveries.slice(0, 64),
      truncated: [proposals, tests, reviews, deliveries].some(
        (rows) => rows.length > 64,
      ),
    };
  }) as Promise<TenantDevelopmentInspection | null>;
}
