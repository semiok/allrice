import {
  FeedbackInboxQuerySchema,
  FeedbackReviewInputSchema,
  MessageFeedbackDeleteSchema,
  MessageFeedbackItemSchema,
  MessageFeedbackPutSchema,
  UuidSchema,
  type MessageFeedbackItem,
  type MessageFeedbackResult,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { assertWorkbenchSession } from './artifact-review.ts';
import { isPlatformAdmin } from './providers/model-pool.ts';
import { DataAccessError } from './data.ts';

interface FeedbackRow {
  id: string;
  run_id: string;
  message_id: string;
  helpful: boolean;
  reason: string | null;
  category: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
}
interface InboxRow extends Omit<FeedbackRow, 'created_at' | 'updated_at'> {
  actor_id: string;
  review_status: 'new' | 'reviewing' | 'resolved';
  review_note: string;
  created_at: Date;
  updated_at: Date;
  reviewed_at: Date | null;
  organization_name: string;
  workspace_name: string;
  actor_name: string;
  employee_name: string;
  employee_version: number;
  session_id: string;
  response_preview: string | null;
}
interface FeedbackDetail extends Omit<
  InboxRow,
  'message_id' | 'actor_id' | 'response_preview' | 'reviewed_at'
> {
  run_status: string;
  error_code: string | null;
  run_created_at: Date;
  completed_at: Date | null;
  model: string;
  provider: string | null;
  question: string | null;
  answer: string | null;
}
function item(row: FeedbackRow): MessageFeedbackItem {
  return MessageFeedbackItemSchema.parse({
    messageId: row.message_id,
    rating: row.helpful ? 'positive' : 'negative',
    ...(row.reason ? { note: row.reason } : {}),
    ...(row.category ? { category: row.category } : {}),
    version: row.version,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  });
}
const conflict = (row?: FeedbackRow) => ({
  ok: false as const,
  error: { code: 'version-conflict', current: row ? item(row) : null },
});

/** Feedback never sends a chat message or starts an employee run. */
export async function listMessageFeedback(
  context: RequestContext,
  sessionId: string,
) {
  return getDatabase().begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    const rows = await tx<FeedbackRow[]>`select f.* from allrice_run_feedback f
      join allrice_employee_runs er on er.run_id=f.run_id
      where f.organization_id=${context.organizationId} and f.workspace_id=${context.workspaceId!}
      and er.session_id=${sessionId} and f.actor_id=${context.actor.id} order by f.created_at`;
    return { items: rows.map(item) };
  });
}

export async function mutateMessageFeedback(
  context: RequestContext,
  sessionId: string,
  action: 'put' | 'delete',
  raw: unknown,
): Promise<MessageFeedbackResult<MessageFeedbackItem | { absent: true }>> {
  const input =
    action === 'put'
      ? MessageFeedbackPutSchema.parse(raw)
      : MessageFeedbackDeleteSchema.parse(raw);
  return getDatabase().begin(async (tx) => {
    // The session lock also serializes a first insert, for which no row exists yet.
    await assertWorkbenchSession(tx, context, sessionId);
    const [target] = await tx<
      { run_id: string }[]
    >`select er.run_id from allrice_employee_runs er
      join allrice_messages m on m.id=er.assistant_message_id
      where er.organization_id=${context.organizationId} and er.workspace_id=${context.workspaceId!}
      and er.session_id=${sessionId} and er.owner_id=${context.actor.id}
      and er.assistant_message_id=${input.messageId} and m.role='assistant' and m.status in ('completed','failed')`;
    if (!target)
      return {
        ok: false as const,
        error: { code: 'target-not-found', current: null },
      };
    const [current] = await tx<FeedbackRow[]>`select * from allrice_run_feedback
      where run_id=${target.run_id} and actor_id=${context.actor.id} for update`;
    if (action === 'delete' && !current)
      return { ok: true as const, value: { absent: true as const } };
    if ((current?.version ?? null) !== input.ifVersion)
      return conflict(current);
    if (action === 'delete') {
      await tx`delete from allrice_run_feedback where run_id=${target.run_id} and actor_id=${context.actor.id}`;
      return { ok: true as const, value: { absent: true as const } };
    }
    const put = MessageFeedbackPutSchema.parse(input);
    const [saved] = await tx<FeedbackRow[]>`insert into allrice_run_feedback
      (organization_id,workspace_id,run_id,message_id,actor_id,helpful,reason,category)
      values(${context.organizationId},${context.workspaceId!},${target.run_id},${put.messageId},${context.actor.id},
        ${put.rating === 'positive'},${put.note ?? null},${put.category ?? null})
      on conflict(run_id,actor_id) do update set helpful=excluded.helpful,reason=excluded.reason,
        category=excluded.category,version=gen_random_uuid(),updated_at=clock_timestamp(),
        reviewed=false,review_status='new',review_note='',reviewed_by=null,reviewed_at=null returning *`;
    return { ok: true as const, value: item(saved!) };
  });
}

async function requireAdmin(context: RequestContext) {
  if (!(await isPlatformAdmin(context)))
    throw new DataAccessError('authorization_denied');
}

export async function listTenantFeedback(
  context: RequestContext,
  raw: unknown,
) {
  await requireAdmin(context);
  const filters = FeedbackInboxQuerySchema.parse(raw),
    db = getDatabase();
  const where = db`(${filters.organizationId ?? null}::uuid is null or f.organization_id=${filters.organizationId ?? null})
    and (${filters.employeeId ?? null}::uuid is null or v.employee_id=${filters.employeeId ?? null})
    and (${filters.category ?? null}::text is null or f.category=${filters.category ?? null})
    and (${filters.status ?? null}::text is null or f.review_status=${filters.status ?? null})
    and (${filters.rating ?? null}::text is null or f.helpful=${filters.rating === 'positive'})`;
  const [rows, counts, organizations, employees] = await Promise.all([
    db<
      InboxRow[]
    >`select f.id,f.run_id,f.message_id,f.actor_id,f.helpful,f.reason,f.category,f.version,
      f.review_status,f.review_note,f.created_at,f.updated_at,f.reviewed_at,
      o.name organization_name,w.name workspace_name,u.display_name actor_name,
      v.name employee_name,v.version employee_version,er.session_id,
      left(m.content->>'text',240) response_preview
      from allrice_run_feedback f join allrice_employee_runs er on er.run_id=f.run_id
      join allrice_employee_versions v on v.id=er.employee_version_id
      join allrice_organizations o on o.id=f.organization_id join allrice_workspaces w on w.id=f.workspace_id
      join allrice_users u on u.id=f.actor_id join allrice_messages m on m.id=f.message_id
      where ${where} order by f.updated_at desc,f.id desc limit 20 offset ${(filters.page - 1) * 20}`,
    db<
      { total: number; pending: number }[]
    >`select count(*)::int total,count(*) filter(where f.review_status='new')::int pending
      from allrice_run_feedback f join allrice_employee_runs er on er.run_id=f.run_id
      join allrice_employee_versions v on v.id=er.employee_version_id where ${where}`,
    db<
      { id: string; name: string }[]
    >`select distinct o.id,o.name from allrice_run_feedback f join allrice_organizations o on o.id=f.organization_id order by o.name`,
    db<
      { id: string; name: string }[]
    >`select distinct e.id,e.name from allrice_run_feedback f
      join allrice_employee_runs er on er.run_id=f.run_id join allrice_employee_versions v on v.id=er.employee_version_id
      join allrice_employees e on e.id=v.employee_id order by e.name`,
  ]);
  return {
    items: rows,
    total: counts[0]!.total,
    pending: counts[0]!.pending,
    page: filters.page,
    organizations,
    employees,
  };
}

export async function getTenantFeedback(context: RequestContext, id: string) {
  await requireAdmin(context);
  UuidSchema.parse(id);
  const [row] = await getDatabase()<
    FeedbackDetail[]
  >`select f.id,f.version,f.review_status,f.review_note,
    er.run_id,er.session_id,er.status run_status,er.error_code,er.created_at run_created_at,er.completed_at,
    v.name employee_name,v.version employee_version,coalesce(er.provider_snapshot->>'model',v.model) model,
    er.provider_snapshot->>'provider' provider,
    um.content->>'text' question,am.content->>'text' answer,
    o.name organization_name,w.name workspace_name,u.display_name actor_name,
    f.helpful,f.reason,f.category,f.created_at,f.updated_at
    from allrice_run_feedback f join allrice_employee_runs er on er.run_id=f.run_id
    join allrice_employee_versions v on v.id=er.employee_version_id
    join allrice_messages um on um.id=er.user_message_id join allrice_messages am on am.id=f.message_id
    join allrice_organizations o on o.id=f.organization_id join allrice_workspaces w on w.id=f.workspace_id
    join allrice_users u on u.id=f.actor_id where f.id=${id}`;
  if (!row) throw new DataAccessError('not_found');
  return row;
}

export async function reviewTenantFeedback(
  context: RequestContext,
  id: string,
  raw: unknown,
) {
  await requireAdmin(context);
  UuidSchema.parse(id);
  const input = FeedbackReviewInputSchema.parse(raw);
  const rows =
    await getDatabase()`update allrice_run_feedback set review_status=${input.status},
    review_note=${input.note},reviewed=${input.status === 'resolved'},reviewed_by=${context.actor.id},reviewed_at=now(),
    version=gen_random_uuid() where id=${id} and version=${input.ifVersion} returning id`;
  if (!rows.length) return { updated: false as const };
  return {
    updated: true as const,
    feedback: await getTenantFeedback(context, id),
  };
}
