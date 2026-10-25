import { isPlatformAdmin } from './platform-authority.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  runtimeFeatureEnabled,
  CreateExperienceInputSchema,
  ExperienceCandidateSchema,
  ExperienceEvidenceSchema,
  ReviewExperienceInputSchema,
  BrandContentWorkflowInvocationSchema,
  UuidSchema,
  type CreateExperienceInput,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { embedWorkspaceText } from './workspace/memory-recall.ts';

export const experienceReviewEnabled = () =>
  runtimeFeatureEnabled('ALLRICE_EXPERIENCE_REVIEW_ENABLED');
export class ExperienceError extends Error {
  constructor(
    readonly code:
      | 'disabled'
      | 'identity_denied'
      | 'not_found'
      | 'source_changed'
      | 'conflict'
      | 'invalid_source'
      | 'validation_required'
      | 'platform_publication_required',
  ) {
    super(code);
  }
}
const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
type Db = ReturnType<typeof getDatabase>;
type Tx = TransactionSql;
interface ReviewRow {
  memory_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  session_id: string;
  message_id: string;
  source_excerpt: string;
  source_digest: string;
  proposed_digest: string;
  requested_scope: 'private' | 'workspace' | 'platform';
  status: 'pending' | 'approved' | 'rejected';
  request_digest: string;
  content: string;
  memory_class: 'user_preference' | 'project_fact' | 'decision' | 'work_note';
  revision: number;
  archived_at: Date | null;
  created_at: Date;
  reviewed_at: Date | null;
  review_reason: string | null;
  origin_kind: 'manual' | 'incremental' | 'derived';
  instance_id: string | null;
  evidence: unknown;
  consolidated_at: Date | null;
}
function principal(context: RequestContext) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  if (context.actor.type !== 'user' || !context.workspaceId)
    throw new ExperienceError('identity_denied');
  return {
    user: UuidSchema.parse(context.actor.id),
    workspace: UuidSchema.parse(context.workspaceId),
    organization: UuidSchema.parse(context.organizationId),
  };
}
/** Current persisted membership wins over a stale browser/session role. */
async function identity(tx: Tx, context: RequestContext, write: boolean) {
  const p = principal(context);
  const users =
    await tx`select id from allrice_users where id=${p.user} and status='active' ${write ? tx`for share` : tx``}`;
  const orgs =
    await tx`select id from allrice_organizations where id=${p.organization} and archived_at is null ${write ? tx`for share` : tx``}`;
  const workspaces =
    await tx`select id from allrice_workspaces where id=${p.workspace} and organization_id=${p.organization} and archived_at is null ${write ? tx`for share` : tx``}`;
  const memberships = await tx<
    { role: string }[]
  >`select role from allrice_memberships where organization_id=${p.organization}
    and user_id=${p.user} and active and (workspace_id is null or workspace_id=${p.workspace}) ${write ? tx`for share` : tx``}`;
  if (
    !users.length ||
    !orgs.length ||
    !workspaces.length ||
    !memberships.some((m) => !write || ['admin', 'member'].includes(m.role))
  )
    throw new ExperienceError('identity_denied');
  return { ...p, admin: await isPlatformAdmin(context, tx) };
}
async function source(
  tx: Tx,
  context: RequestContext,
  runId: string,
  messageId: string,
  owner: string,
) {
  const owners =
    await tx`select id from allrice_users where id=${owner} and status='active' for share`;
  const memberships =
    await tx`select id from allrice_memberships where organization_id=${context.organizationId}
    and user_id=${owner} and active and role in ('admin','member') and (workspace_id is null or workspace_id=${context.workspaceId!}) for share`;
  if (!owners.length || !memberships.length)
    throw new ExperienceError('invalid_source');
  const [row] = await tx<
    {
      session_id: string;
      text: string;
      employee_id: string;
      assignment_id: string;
      instance_id: string | null;
      frozen_instance_id: string | null;
      invocation: unknown;
      message_role: string;
    }[]
  >`
    select er.session_id, m.content->>'text' as text, a.employee_id,
      a.id assignment_id,s.employee_instance_id instance_id,m.role message_role,
      er.execution_snapshot->'instance'->>'id' frozen_instance_id,
      er.execution_snapshot->'workflowInvocation' invocation
    from allrice_employee_runs er
    join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=er.organization_id and s.workspace_id=er.workspace_id
    join allrice_employee_assignments a on a.id=er.employee_assignment_id and a.organization_id=er.organization_id and a.workspace_id=er.workspace_id
    join allrice_messages m on m.id=${messageId} and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id and m.session_id=er.session_id
    where er.run_id=${runId} and er.organization_id=${context.organizationId} and er.workspace_id=${context.workspaceId!}
      and er.owner_id=${owner} and s.owner_id=${owner} and m.owner_id=${owner} and s.archived_at is null
      and er.status in ('succeeded','failed','canceled') and er.completed_at is not null
      and not er.method_authoring
      and m.id in (er.user_message_id,er.assistant_message_id) and m.role in ('user','assistant')
      and m.content->>'text' is not null and m.status='completed'
    for share of er,s,m,a`;
  if (!row) throw new ExperienceError('invalid_source');
  return row;
}

/** Brand rules stay in the existing human review system, but their scope is
 * derived from the saved Run/report, never from a caller's proposed metadata. */
async function brandRetrospectiveSource(
  tx: Tx,
  context: RequestContext,
  request: CreateExperienceInput,
  origin: Awaited<ReturnType<typeof source>>,
) {
  const raw = origin.invocation as { input?: { stage?: unknown } } | null;
  if (raw?.input?.stage !== 'retrospective') return null;
  const parsed = BrandContentWorkflowInvocationSchema.safeParse(raw);
  if (!parsed.success) throw new ExperienceError('invalid_source');
  const invocation = parsed.data;
  if (
    origin.message_role !== 'assistant' ||
    origin.instance_id !== invocation.instanceId ||
    origin.frozen_instance_id !== invocation.instanceId ||
    request.scope !== 'private' ||
    request.memoryClass !== 'work_note' ||
    request.shareAcknowledged
  )
    throw new ExperienceError('invalid_source');
  // Distinct browser requests must not create duplicate candidates or revive a
  // forgotten rule. The immutable scope row remains after Memory withdrawal.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`brand-experience:${context.organizationId}:${request.runId}`},194))`;
  const [report] = await tx<
    {
      id: string;
      instance_id: string;
      brand_id: string;
      context_id: string;
      platform: string;
      campaign_key: string | null;
      source_text: string;
    }[]
  >`select report.id,report.instance_id,report.brand_id,report.context_id,
      report.platform,report.campaign_key,report.source_text
    from allrice_brand_content_retrospectives report
    join allrice_employee_instances i on i.id=report.instance_id
      and i.organization_id=report.organization_id and i.workspace_id=report.workspace_id and i.owner_id=report.owner_id
    join allrice_employee_assignments a on a.id=i.assignment_id
      and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id and a.user_id=i.owner_id
    join allrice_employees employee on employee.id=a.employee_id
      and employee.organization_id=a.organization_id and employee.workspace_id=a.workspace_id
    where report.organization_id=${context.organizationId} and report.workspace_id=${context.workspaceId!}
      and report.owner_id=${context.actor.id} and report.run_id=${request.runId} and report.session_id=${origin.session_id}
      and report.instance_id=${invocation.instanceId} and report.brand_id=${invocation.input.brandId}
      and report.context_id=${invocation.input.contextRevisionId} and report.platform=${invocation.input.platform}
      and report.campaign_key is not distinct from ${invocation.input.context.campaign?.key ?? null}::text
      and report.workflow->>'workflowRevisionId'=${invocation.workflowRevisionId}
      and report.workflow->>'packageDigest'=${invocation.packageDigest}
      and i.assignment_id=${origin.assignment_id} and i.kind='custom' and i.archived_at is null and a.active
      and employee.status='active' for share of report,i,a,employee`;
  if (
    !report ||
    request.sourceExcerpt !== report.source_text ||
    request.content !== report.source_text ||
    !origin.text.includes(report.source_text)
  )
    throw new ExperienceError('invalid_source');
  const [prior] =
    await tx`select memory_id from allrice_brand_content_experiences where retrospective_id=${report.id}`;
  if (prior) throw new ExperienceError('conflict');
  return report;
}
function view(row: ReviewRow, user: string, admin: boolean) {
  return ExperienceCandidateSchema.parse({
    id: row.memory_id,
    content: row.content,
    memoryClass: row.memory_class,
    scope: row.requested_scope,
    status: row.status,
    archived: row.archived_at !== null,
    revision: row.revision,
    digest: row.proposed_digest,
    // Consent shares the rewritten rule, not the private source conversation.
    source:
      row.owner_id === user
        ? {
            runId: row.run_id,
            sessionId: row.session_id,
            messageId: row.message_id,
            excerpt: row.source_excerpt,
            digest: row.source_digest,
          }
        : null,
    ownedByMe: row.owner_id === user,
    canReview:
      row.status === 'pending' &&
      row.origin_kind === 'manual' &&
      row.archived_at === null &&
      row.requested_scope !== 'platform' &&
      (row.requested_scope === 'private' ? row.owner_id === user : admin),
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewReason: row.review_reason,
    originKind: row.origin_kind,
    instanceId: row.instance_id,
    consolidatedAt: row.consolidated_at?.toISOString() ?? null,
    evidence:
      row.origin_kind === 'incremental' && row.owner_id === user
        ? ExperienceEvidenceSchema.parse(row.evidence)
        : null,
  });
}
async function audit(
  tx: Tx,
  context: RequestContext,
  id: string,
  action: string,
  reason: string,
) {
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${context.organizationId},${context.workspaceId!},${context.actor.id},${action},'memory',${id},'allowed',${reason},${context.requestId})`;
}

/** Compose a candidate with its business receipt inside one caller-owned
 * transaction. This retains the same current identity, exact source and review
 * gates as the ordinary Experience API; it never approves the rule. */
export async function createExperienceInTransaction(
  tx: Tx,
  context: RequestContext,
  input: unknown,
) {
  const request = CreateExperienceInputSchema.parse(input);
  const requestDigest = digest(JSON.stringify(request));
  const p = await identity(tx, context, true);
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${p.organization}:${p.workspace}:${p.user}:${request.clientRequestId}`},88))`;
  const [existing] = await tx<
    ReviewRow[]
  >`select e.*,m.content,m.memory_class,m.revision,m.archived_at from allrice_experience_reviews e
    join allrice_memories m on m.id=e.memory_id
    where e.organization_id=${p.organization} and e.workspace_id=${p.workspace} and e.owner_id=${p.user} and e.client_request_id=${request.clientRequestId}`;
  if (existing) {
    if (existing.request_digest !== requestDigest)
      throw new ExperienceError('conflict');
    return view(existing, p.user, p.admin);
  }
  const origin = await source(
    tx,
    context,
    request.runId,
    request.messageId,
    p.user,
  );
  if (!origin.text.includes(request.sourceExcerpt))
    throw new ExperienceError('invalid_source');
  const report = await brandRetrospectiveSource(tx, context, request, origin);
  const id = randomUUID();
  await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,content,visibility,source_type,source_id,
    lifecycle_state,memory_class,revision,trust_level,confidence,source_label,last_verified_at)
    values(${id},${p.organization},${p.workspace},${p.user},${origin.employee_id},${request.content},'private','user',null,
      'candidate',${request.memoryClass},1,'derived',0.7,'人工经验候选',null)`;
  await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
    values(${p.organization},${p.workspace},${id},1,${request.content},'derived','candidate',${request.memoryClass},0.7,'人工选取，尚未审核',${p.user})`;
  await tx`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,
    run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged)
    values(${id},${p.organization},${p.workspace},${p.user},${request.clientRequestId},${requestDigest},${request.runId},${origin.session_id},${request.messageId},
      ${request.sourceExcerpt},${digest(origin.text)},${digest(request.content)},${request.scope},${request.shareAcknowledged})`;
  if (report)
    await tx`insert into allrice_brand_content_experiences
      (memory_id,organization_id,workspace_id,owner_id,instance_id,brand_id,retrospective_id,context_id,platform,campaign_key)
      values(${id},${p.organization},${p.workspace},${p.user},${report.instance_id},${report.brand_id},${report.id},
        ${report.context_id},${report.platform},${report.campaign_key})`;
  await audit(
    tx,
    context,
    id,
    'experience.propose',
    `manual_${request.scope}_candidate`,
  );
  const [created] = await tx<
    ReviewRow[]
  >`select e.*,m.content,m.memory_class,m.revision,m.archived_at from allrice_experience_reviews e join allrice_memories m on m.id=e.memory_id where e.memory_id=${id}`;
  return view(created!, p.user, p.admin);
}

/** Existing human review, composed with a domain's exact scope and request
 * receipt in one transaction. Automatic experience adoption remains separate. */
export async function reviewExperienceInTransaction(
  tx: Tx,
  context: RequestContext,
  id: string,
  input: unknown,
) {
  UuidSchema.parse(id);
  const request = ReviewExperienceInputSchema.parse(input);
  const p = await identity(tx, context, true);
  const [current] = await tx<
    ReviewRow[]
  >`select e.*,m.content,m.memory_class,m.revision,m.archived_at from allrice_experience_reviews e
    join allrice_memories m on m.id=e.memory_id and m.organization_id=e.organization_id and m.workspace_id=e.workspace_id
    where e.memory_id=${id} and e.organization_id=${p.organization} and e.workspace_id=${p.workspace} and m.archived_at is null
      and (e.owner_id=${p.user} or (${p.admin} and e.requested_scope='workspace' and e.share_acknowledged)) for update of e,m`;
  if (!current) throw new ExperienceError('not_found');
  if (current.origin_kind !== 'manual' && request.decision === 'approve')
    throw new ExperienceError('validation_required');
  if (current.requested_scope === 'platform' && request.decision === 'approve')
    throw new ExperienceError('platform_publication_required');
  if (
    current.requested_scope === 'workspace' &&
    !p.admin &&
    request.decision === 'approve'
  )
    throw new ExperienceError('identity_denied');
  if (
    current.status !== 'pending' ||
    current.revision !== request.expectedRevision ||
    current.proposed_digest !== request.expectedDigest ||
    digest(current.content) !== current.proposed_digest
  )
    throw new ExperienceError('conflict');
  const approve = request.decision === 'approve';
  // New trust requires a still-accessible, unchanged origin. Withdrawing
  // trust must remain possible even if the source was edited/archived.
  if (approve) {
    const origin = await source(
      tx,
      context,
      current.run_id,
      current.message_id,
      current.owner_id,
    );
    if (digest(origin.text) !== current.source_digest)
      throw new ExperienceError('source_changed');
  }
  const revision = current.revision + 1;
  await tx`update allrice_memories set lifecycle_state=${approve ? 'durable' : 'candidate'},revision=${revision},
    source_label=${approve ? '人工审核经验' : '已撤回经验候选'},
    trust_level=${approve ? 'user_confirmed' : 'derived'},confidence=${approve ? 1 : 0.7},visibility=${approve ? current.requested_scope : 'private'},
    last_verified_at=${approve ? new Date() : null},archived_at=${approve ? null : new Date()},updated_at=now()
    where id=${id}`;
  await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
    values(${p.organization},${p.workspace},${id},${revision},${current.content},${approve ? 'user_confirmed' : 'derived'},${approve ? 'durable' : 'candidate'},${current.memory_class},${approve ? 1 : 0.7},${request.reason},${p.user})`;
  if (approve)
    await tx`insert into allrice_rag_chunks(organization_id,workspace_id,memory_id,owner_id,content,embedding,visibility)
    values(${p.organization},${p.workspace},${id},${current.owner_id},${current.content},${`[${embedWorkspaceText(current.content).join(',')}]`}::vector,${current.requested_scope})`;
  await tx`update allrice_experience_reviews set status=${approve ? 'approved' : 'rejected'},reviewed_by=${p.user},reviewed_at=now(),review_reason=${request.reason} where memory_id=${id}`;
  await audit(
    tx,
    context,
    id,
    approve ? 'experience.approve' : 'experience.reject',
    `manual_${current.requested_scope}_review`,
  );
  const [updated] = await tx<
    ReviewRow[]
  >`select e.*,m.content,m.memory_class,m.revision,m.archived_at from allrice_experience_reviews e join allrice_memories m on m.id=e.memory_id where e.memory_id=${id}`;
  return view(updated!, p.user, p.admin);
}

export function createExperienceStore(options: { database?: Db } = {}) {
  const database = () => options.database ?? getDatabase();
  return {
    async sources(context: RequestContext, sessionId: string) {
      UuidSchema.parse(sessionId);
      return database().begin(async (tx) => {
        const p = await identity(tx, context, false);
        const rows = await tx<
          {
            run_id: string;
            message_id: string;
            text: string;
            role: string;
            completed_at: Date;
          }[]
        >`
          select er.run_id,m.id as message_id,m.content->>'text' as text,m.role,er.completed_at
          from allrice_employee_runs er
          join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=er.organization_id and s.workspace_id=er.workspace_id
          join allrice_messages m on m.id in (er.user_message_id,er.assistant_message_id)
            and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id and m.session_id=s.id
          where er.organization_id=${p.organization} and er.workspace_id=${p.workspace} and er.session_id=${sessionId}
            and er.owner_id=${p.user} and s.owner_id=${p.user} and m.owner_id=${p.user} and s.archived_at is null
            and er.status in ('succeeded','failed','canceled') and er.completed_at is not null
            and not er.method_authoring
            and m.role in ('user','assistant') and m.status='completed' and length(m.content->>'text')>0
          order by er.completed_at desc,m.id limit 100`;
        return rows.map((r) => ({
          runId: r.run_id,
          messageId: r.message_id,
          text: r.text,
          role: r.role,
          completedAt: r.completed_at.toISOString(),
        }));
      });
    },
    async list(context: RequestContext, instanceId?: string) {
      if (instanceId) UuidSchema.parse(instanceId);
      return database().begin(async (tx) => {
        const p = await identity(tx, context, false);
        const rows = await tx<
          ReviewRow[]
        >`select e.*,m.content,m.memory_class,m.revision,m.archived_at from allrice_experience_reviews e
          join allrice_memories m on m.id=e.memory_id and m.organization_id=e.organization_id and m.workspace_id=e.workspace_id
          where e.organization_id=${p.organization} and e.workspace_id=${p.workspace}
            and e.origin_kind<>'derived'
            and (e.owner_id=${p.user} or (${p.admin} and e.requested_scope='workspace' and e.share_acknowledged))
            and (${instanceId ?? null}::uuid is null or e.instance_id=${instanceId ?? null}
              or exists(select 1 from allrice_brand_content_experiences brand where brand.memory_id=e.memory_id
                and brand.organization_id=e.organization_id and brand.workspace_id=e.workspace_id
                and brand.owner_id=${p.user} and brand.instance_id=${instanceId ?? null}))
            and (e.origin_kind='manual' or exists(select 1 from allrice_employee_instances i
              where i.id=e.instance_id and i.organization_id=e.organization_id and i.workspace_id=e.workspace_id
                and i.owner_id=${p.user}))
          order by (e.status='pending' and m.archived_at is null and e.consolidation_occurrence_id is null) desc,e.created_at desc,e.memory_id limit 100`;
        return rows.map((r) => view(r, p.user, p.admin));
      });
    },
    async create(context: RequestContext, input: unknown) {
      return database().begin((tx) =>
        createExperienceInTransaction(tx, context, input),
      );
    },
    async review(context: RequestContext, id: string, input: unknown) {
      return database().begin((tx) =>
        reviewExperienceInTransaction(tx, context, id, input),
      );
    },
  };
}
