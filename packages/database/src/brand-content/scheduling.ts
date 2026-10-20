import { randomUUID } from 'node:crypto';
import {
  BrandContentWorkflowPinSchema,
  ChatMessageContentSchema,
  RegisterBrandContentReminderSchema,
  brandContentTemplateKeys,
  type BrandContentWorkflowPin,
  type Membership,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { ArtifactReviewError } from '../artifact-review.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';
import { EmployeeInstanceError } from '../employees/employee-instances.ts';
import {
  assertWorkflowPackageExecution,
  WorkflowPackageError,
} from '../capabilities/workflow-packages.ts';
import { readWorkAutomation } from '../work-automation.ts';
import { requireBrandContentScope } from './authority.ts';
import { assertBrandBundle, readBrand, scopedRow } from './queries.ts';
import {
  mutateBrandContentInTransaction,
  type BrandContentMutationOptions,
} from './service.ts';
import {
  assertBrandContentApprovedBundle,
  assertBrandRevision,
  brandContentDigest,
  brandContentFail as fail,
  BrandContentError,
} from './rules.ts';
import type {
  ArticleRow,
  BundleRow,
  PlanRow,
  ReviewRow,
  Scope,
  Tx,
  BrandContentIdentity,
} from './types.ts';

export type ReminderRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  instance_id: string;
  assignment_id: string;
  brand_id: string;
  plan_id: string;
  plan_revision: number;
  article_id: string;
  bundle_id: string;
  review_id: string;
  bundle_digest: string;
  session_id: string;
  workflow_revision_id: string;
  package_digest: string;
  automation_id: string;
  scheduled_for: Date;
  request_digest: string;
  reserved_occurrence_id: string;
  reserved_message_id: string;
  state: 'registered' | 'reminded' | 'blocked' | 'superseded';
  automation_run_id: string | null;
  delivery_message_id: string | null;
};
export type BrandContentReminderOptions = Pick<
  BrandContentMutationOptions,
  'db' | 'beforeCommit'
> & {
  authority?: 'user' | 'workflow';
  /** Selected and validated by a server route/broker, never browser/model raw. */
  workflow: BrandContentWorkflowPin;
};
export type BrandContentReminderRegistration = {
  automationId: string;
  planId: string;
  revision: number;
  replayed: boolean;
  status: ReminderRow['state'];
  messageId: string | null;
};
function registration(
  row: ReminderRow,
  replayed: boolean,
): BrandContentReminderRegistration {
  return {
    automationId: row.automation_id,
    planId: row.plan_id,
    revision: row.plan_revision,
    replayed,
    status: row.state,
    messageId: row.delivery_message_id,
  };
}
function scopeOf(row: ReminderRow): Scope {
  return {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    instanceId: row.instance_id,
  };
}
function internalContext(row: ReminderRow): BrandContentIdentity {
  // Resource authority is reconstructed from persisted owner scope below.
  // There is deliberately no browser session token or fabricated login ID.
  return {
    actor: { type: 'user', id: row.owner_id },
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    requestId: row.reserved_occurrence_id,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
}
async function packageFence(
  tx: Tx,
  context: BrandContentIdentity,
  instanceId: string,
  workflow: BrandContentWorkflowPin,
  allowHistoricalPin = true,
) {
  const selected = await assertWorkflowPackageExecution(
    context,
    {
      workspaceId: context.workspaceId,
      instanceId,
      sceneId: null,
      workflowRevisionId: workflow.workflowRevisionId,
      ...(allowHistoricalPin
        ? { frozenPackageDigest: workflow.packageDigest }
        : {}),
    },
    tx,
    true,
  );
  if (
    selected.package.checksum !== workflow.packageDigest ||
    selected.package.manifest.templateKey !== brandContentTemplateKeys.handoff
  )
    fail('source_reference_invalid');
  return selected.package.assignmentId;
}
async function privateSession(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  sessionId: string,
  assignmentId: string,
) {
  const [session] = await tx`select id from allrice_chat_sessions
    where id=${sessionId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and employee_assignment_id=${assignmentId}
      and employee_instance_id=${scope.instanceId} and visibility='private' and archived_at is null for update`;
  if (!session) fail('source_unavailable');
  if (context.actor.id !== scope.ownerId) fail('authority_denied');
}
async function approvedPlan(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  brandId: string,
  planId: string,
  assignmentId: string,
) {
  await readBrand(tx, scope, brandId, true);
  const [plan] = await tx<PlanRow[]>`select * from allrice_brand_content_plans
    where id=${planId} and brand_id=${brandId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and instance_id=${scope.instanceId} for update`;
  if (!plan) fail('not_found');
  if (plan.state !== 'planned') fail('invalid_state');
  const article = await scopedRow<ArticleRow>(
    tx,
    scope,
    'articles',
    brandId,
    plan.article_id,
  );
  const bundle = await scopedRow<BundleRow>(
    tx,
    scope,
    'bundles',
    brandId,
    plan.bundle_id,
  );
  const review = await scopedRow<ReviewRow>(
    tx,
    scope,
    'reviews',
    brandId,
    plan.review_id,
  );
  assertBrandContentApprovedBundle(article, bundle, review, {
    bundleDigest: plan.bundle_digest,
    platform: plan.platform,
  });
  if (article.current_bundle_id !== bundle.id) fail('invalid_state');
  const [published] =
    await tx`select id from allrice_brand_content_receipts where plan_id=${plan.id}`;
  if (published) fail('invalid_state');
  await privateSession(tx, context, scope, article.session_id, assignmentId);
  await assertBrandBundle(tx, context, scope, brandId, article, bundle);
  const [frozen] = await tx<
    { brand_name: string }[]
  >`select brand_name from allrice_brand_content_contexts where id=${article.context_id}`;
  if (!frozen) fail('source_unavailable');
  return { plan, article, bundle, brandName: frozen.brand_name };
}

/** Register only an already reviewed plan. All work is SQL; a 55P03 retry
 * cannot repeat storage, provider, message-send or other external side effects. */
export async function registerBrandContentReminder(
  context: BrandContentIdentity,
  raw: unknown,
  options: BrandContentReminderOptions,
): Promise<BrandContentReminderRegistration> {
  const input = RegisterBrandContentReminderSchema.parse(raw);
  const workflow = BrandContentWorkflowPinSchema.parse(options.workflow);
  const authority = options.authority ?? 'user';
  if (
    !['user', 'workflow'].includes(authority) ||
    (authority === 'workflow' && !options.beforeCommit)
  )
    fail('authority_denied');
  const identity: BrandContentIdentity =
    authority === 'user' ? context : { ...context, sessionId: undefined };
  return employeeAccessTransaction(options.db ?? getDatabase(), async (tx) => {
    const principal = await readContentPrincipal(
      { ...identity, workspaceId: input.workspaceId },
      tx,
      true,
    );
    if (!principal?.writable) fail('authority_denied');
    const work = await readWorkAutomation(tx, {
      organizationId: context.organizationId,
      workspaceId: input.workspaceId,
      userId: context.actor.id,
    });
    if (!work.available || !work.settings.cloud) fail('authority_denied');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`brand-content-reminder:${context.organizationId}:${context.actor.id}:${input.instanceId}:${input.requestId}`},0))`;
    const [prior] = await tx<
      ReminderRow[]
    >`select * from allrice_brand_content_reminders
      where organization_id=${context.organizationId} and workspace_id=${input.workspaceId}
        and owner_id=${context.actor.id} and instance_id=${input.instanceId} and request_id=${input.requestId}`;
    // A lost HTTP ACK is retried with whatever package the server selects now.
    // Preserve the original immutable pin while still checking current access.
    const selectedWorkflow = prior
      ? {
          workflowRevisionId: prior.workflow_revision_id,
          packageDigest: prior.package_digest,
        }
      : workflow;
    const requestDigest = brandContentDigest({
      input,
      workflow: selectedWorkflow,
      authority,
    });
    if (prior && prior.request_digest !== requestDigest)
      fail('request_conflict');
    const assignmentId = await packageFence(
      tx,
      { ...identity, workspaceId: input.workspaceId },
      input.instanceId,
      selectedWorkflow,
      Boolean(prior),
    );
    const scope = await requireBrandContentScope(
      tx,
      context,
      input,
      true,
      authority,
    );
    if (prior) {
      const article = await scopedRow<ArticleRow>(
        tx,
        scope,
        'articles',
        prior.brand_id,
        prior.article_id,
      );
      const bundle = await scopedRow<BundleRow>(
        tx,
        scope,
        'bundles',
        prior.brand_id,
        prior.bundle_id,
      );
      await privateSession(
        tx,
        context,
        scope,
        prior.session_id,
        prior.assignment_id,
      );
      await assertBrandBundle(
        tx,
        identity,
        scope,
        prior.brand_id,
        article,
        bundle,
      );
      await options.beforeCommit?.(tx);
      return registration(prior, true);
    }
    const { plan, article, bundle, brandName } = await approvedPlan(
      tx,
      identity,
      scope,
      input.brandId,
      input.planId,
      assignmentId,
    );
    assertBrandRevision(plan.revision, input.expectedRevision);
    if (plan.reminder_status !== 'not_registered') fail('invalid_state');
    const [future] = await tx<
      { valid: boolean }[]
    >`select ${plan.planned_at}::timestamptz>clock_timestamp() as valid`;
    if (!future?.valid) fail('invalid_state');
    const id = randomUUID(),
      automationId = randomUUID(),
      occurrenceId = randomUUID(),
      messageId = randomUUID();
    const schedule = {
      frequency: 'once',
      runAt: plan.planned_at.toISOString(),
      timezone: plan.timezone,
    };
    await tx`insert into allrice_automations
      (id,organization_id,workspace_id,owner_id,name,description,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,next_run_at,brand_content_binding)
      values(${automationId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${`发布提醒 · ${brandName}`.slice(0, 160)},
        '已审核图文的站内发布提醒；仍由本人实际发布。','系统确定性发布提醒；不调用模型，不自动发帖。',
        'schedule',${tx.json(schedule)},'enabled','reuse',${assignmentId},${article.session_id},${plan.planned_at},${id})`;
    const [saved] = await tx<
      ReminderRow[]
    >`insert into allrice_brand_content_reminders
      (id,organization_id,workspace_id,owner_id,instance_id,assignment_id,brand_id,plan_id,plan_revision,article_id,bundle_id,review_id,bundle_digest,
        session_id,workflow_revision_id,package_digest,automation_id,scheduled_for,request_id,request_digest,authority,reserved_occurrence_id,reserved_message_id)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${assignmentId},${input.brandId},${plan.id},${plan.revision + 1},
        ${article.id},${bundle.id},${plan.review_id},${bundle.digest},${article.session_id},${workflow.workflowRevisionId},${workflow.packageDigest},${automationId},
        ${plan.planned_at},${input.requestId},${requestDigest},${authority},${occurrenceId},${messageId}) returning *`;
    if (!saved) fail('invalid_state');
    await mutateBrandContentInTransaction(
      identity,
      {
        ...input,
        operation: 'plan.reminder',
        requestId: `brand-reminder-register:${id}`,
        status: 'registered',
        automationId,
      },
      tx,
      { authority: 'scheduler', beforeCommit: options.beforeCommit },
    );
    if (process.env.ALLRICE_NATIVE_ONCE_ENABLED === '1') {
      const { enrollBrandReminderNative } =
        await import('./native-reminder.ts');
      await enrollBrandReminderNative(tx, saved);
    }
    return registration(saved, false);
  });
}

const escapeMarkdown = (text: string) =>
  text.replace(/[\\`*_{}[\]()#+.!<>|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function brandContentReminderMessage(input: {
  brandName: string;
  platform: string;
  publisher: string;
  bundle: Pick<BundleRow, 'content' | 'images'>;
}) {
  return ChatMessageContentSchema.parse({
    text: [
      '**发布提醒**',
      `${escapeMarkdown(input.brandName)} 的 ${escapeMarkdown(input.platform)} 内容已到计划时间，请 ${escapeMarkdown(input.publisher)} 按已审核版本人工发布。`,
      `[下载已审核正文](/api/v1/files/${input.bundle.content.objectId}/download)`,
      ...input.bundle.images.map(
        (image, index) =>
          `[下载配图 ${index + 1}${image.caption ? `：${escapeMarkdown(image.caption)}` : ''}](/api/v1/files/${image.file.objectId}/download)`,
      ),
      '这是一条站内到点提醒，不表示已对外发布。发布完成后，请在品牌内容工作台填写真实链接与时间。',
    ].join('\n\n'),
    citations: [],
  });
}
function expectedAdmissionFailure(error: unknown): string | null {
  if (
    error instanceof BrandContentError ||
    error instanceof DataAccessError ||
    error instanceof ArtifactReviewError ||
    error instanceof EmployeeInstanceError ||
    error instanceof WorkflowPackageError
  )
    return 'code' in error ? String(error.code) : 'SOURCE_UNAVAILABLE';
  return null;
}

/** Called at the beginning of the existing scanner's transaction, BEFORE it
 * locks the Automation. This owns no timer, network call, LLM, Job or Run. */
export async function lockBrandContentReminder(tx: Tx, automationId: string) {
  const [binding] = await tx<
    ReminderRow[]
  >`select * from allrice_brand_content_reminders where automation_id=${automationId}`;
  if (!binding) return null;
  if (binding.state !== 'registered') return null;
  const context = internalContext(binding),
    scope = scopeOf(binding);
  const principal = await readContentPrincipal(context, tx, true);
  if (principal?.writable) {
    const memberships = await tx<
      {
        id: string;
        user_id: string;
        organization_id: string;
        workspace_id: string | null;
        role: Membership['role'];
        active: boolean;
      }[]
    >`select id,user_id,organization_id,workspace_id,role,active from allrice_memberships
      where organization_id=${scope.organizationId} and user_id=${scope.ownerId} and active
        and (workspace_id is null or workspace_id=${scope.workspaceId}) order by id`;
    context.memberships = memberships.map((row) => ({
      id: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      role: row.role,
      active: row.active,
    }));
  }
  const work = await readWorkAutomation(tx, {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    userId: scope.ownerId,
  });
  let blocked: string | null =
    !principal?.writable || !work.available || !work.settings.cloud
      ? 'AUTHORITY_DENIED'
      : null;
  let approved: Awaited<ReturnType<typeof approvedPlan>> | undefined;
  if (!blocked) {
    try {
      const assignmentId = await packageFence(tx, context, scope.instanceId, {
        workflowRevisionId: binding.workflow_revision_id,
        packageDigest: binding.package_digest,
      });
      if (assignmentId !== binding.assignment_id) fail('authority_denied');
      await requireBrandContentScope(
        tx,
        context,
        { workspaceId: scope.workspaceId, instanceId: scope.instanceId },
        true,
        'scheduler',
      );
    } catch (error) {
      blocked = expectedAdmissionFailure(error);
      if (!blocked) throw error;
    }
  }
  // Even failed admission locks metadata in the same brand→plan→Automation
  // order as reschedule/cancel; no source content is read in this branch.
  await tx`select id from allrice_brand_content_brands where id=${binding.brand_id} for update`;
  const [plan] = await tx<
    { id: string }[]
  >`select id from allrice_brand_content_plans where id=${binding.plan_id} for update`;
  if (!blocked) {
    try {
      approved = await approvedPlan(
        tx,
        context,
        scope,
        binding.brand_id,
        binding.plan_id,
        binding.assignment_id,
      );
      if (
        approved.plan.revision !== binding.plan_revision ||
        approved.plan.automation_id !== automationId ||
        approved.plan.reminder_status !== 'registered' ||
        approved.plan.bundle_id !== binding.bundle_id ||
        approved.plan.review_id !== binding.review_id ||
        approved.plan.bundle_digest !== binding.bundle_digest ||
        approved.article.id !== binding.article_id ||
        approved.article.session_id !== binding.session_id ||
        approved.plan.planned_at.getTime() !== binding.scheduled_for.getTime()
      )
        fail('version_conflict');
    } catch (error) {
      blocked = expectedAdmissionFailure(error);
      if (!blocked) throw error;
    }
  }
  const [automation] = await tx<
    {
      brand_content_binding: string;
      clock_owner: string;
      revision: number;
      status: string;
      deleted_at: Date | null;
      due: boolean;
      next_run_at: Date | null;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      employee_assignment_id: string;
      session_id: string;
    }[]
  >`
    select a.brand_content_binding,a.clock_owner,a.revision,a.status,a.deleted_at,a.organization_id,a.workspace_id,a.owner_id,a.employee_assignment_id,a.session_id,a.next_run_at,
      a.status='enabled' and a.deleted_at is null and a.next_run_at<=clock_timestamp() as due
    from allrice_automations a where a.id=${automationId} for update`;
  const [current] = await tx<
    ReminderRow[]
  >`select * from allrice_brand_content_reminders where id=${binding.id} for update`;
  if (!current || current.state !== 'registered' || !automation) return null;
  if (
    automation.brand_content_binding !== binding.id ||
    automation.organization_id !== scope.organizationId ||
    automation.workspace_id !== scope.workspaceId ||
    automation.owner_id !== scope.ownerId ||
    automation.employee_assignment_id !== binding.assignment_id ||
    automation.session_id !== binding.session_id ||
    automation.next_run_at?.getTime() !== binding.scheduled_for.getTime()
  )
    blocked = 'BINDING_MISMATCH';
  const gate = {
    context,
    scope,
    binding: current,
    approved,
    plan,
    automation,
    blocked,
  };
  reminderGates.set(tx, gate);
  return gate;
}
const reminderGates = new WeakMap<Tx, object>();
export type BrandReminderGate = NonNullable<
  Awaited<ReturnType<typeof lockBrandContentReminder>>
>;

/** Shared locked business sink. A copied JSON object cannot authorize a write. */
export async function completeBrandContentReminder(
  tx: Tx,
  gate: BrandReminderGate,
  options: {
    clockOwner: 'legacy' | 'native_once';
    blocked?: string;
    nativeOccurrenceId?: string;
  },
): Promise<string | null> {
  if (
    reminderGates.get(tx) !== gate ||
    gate.automation.clock_owner !== options.clockOwner ||
    !gate.automation.due
  )
    fail('invalid_state');
  reminderGates.delete(tx);
  const { context, scope, binding, approved, plan } = gate;
  const automationId = binding.automation_id;
  const blocked = gate.blocked ?? options.blocked ?? null;
  const occurrenceId = binding.reserved_occurrence_id;
  await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,session_id,status,started_at,completed_at,error_code,error_message,native_once_occurrence_id)
    values(${occurrenceId},${scope.organizationId},${scope.workspaceId},${automationId},${binding.scheduled_for},${binding.session_id},${blocked ? 'failed' : 'succeeded'},
      clock_timestamp(),clock_timestamp(),${blocked},${blocked ? '发布提醒未投递；当前权限、来源或计划已变化，请检查后重新确认排期。' : null},${options.nativeOccurrenceId ?? null})`;
  await tx`update allrice_automations set status='paused',next_run_at=null,last_run_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=${automationId}`;
  if (blocked || !approved) {
    await tx`update allrice_brand_content_reminders set state='blocked',automation_run_id=${occurrenceId},error_code=${blocked ?? 'SOURCE_UNAVAILABLE'},completed_at=clock_timestamp() where id=${binding.id}`;
    if (plan)
      await tx`update allrice_brand_content_plans set reminder_status='failed',automation_run_id=${occurrenceId},run_id=null,reminder_message_id=null,revision=revision+1,updated_at=clock_timestamp()
        where id=${plan.id} and automation_id=${automationId} and revision=${binding.plan_revision} and state='planned' and reminder_status='registered'`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},'brand.content.reminder.blocked','brand_content',${binding.plan_id},'denied','current_reminder_authority',${tx.json({ automationId, occurrenceId, errorCode: blocked })})`;
    return null;
  }
  const content = brandContentReminderMessage({
    brandName: approved.brandName,
    platform: approved.plan.platform,
    publisher: approved.plan.publisher,
    bundle: approved.bundle,
  });
  await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,visibility,client_message_id,status,completed_at)
    values(${binding.reserved_message_id},${scope.organizationId},${scope.workspaceId},${binding.session_id},${scope.ownerId},'assistant',${tx.json(content)},'private',${binding.reserved_message_id},'completed',clock_timestamp())`;
  await tx`update allrice_chat_sessions set updated_at=clock_timestamp() where id=${binding.session_id}`;
  await tx`update allrice_brand_content_reminders set state='reminded',automation_run_id=${occurrenceId},delivery_message_id=${binding.reserved_message_id},
    delivery_content_digest=${brandContentDigest(content)},completed_at=clock_timestamp() where id=${binding.id}`;
  await mutateBrandContentInTransaction(
    context,
    {
      workspaceId: scope.workspaceId,
      instanceId: scope.instanceId,
      brandId: binding.brand_id,
      planId: binding.plan_id,
      expectedRevision: binding.plan_revision,
      operation: 'plan.reminder',
      requestId: `brand-reminder-delivery:${binding.id}`,
      status: 'reminded',
      automationId,
      automationRunId: occurrenceId,
      deliveryMessageId: binding.reserved_message_id,
    },
    tx,
    { authority: 'scheduler' },
  );
  return occurrenceId;
}

/** The legacy scanner must recheck clock ownership under the same business
 * locks: its earlier candidate read is not authority after a migration. */
export async function claimBrandContentReminder(
  tx: Tx,
  automationId: string,
  scheduledFor: Date,
): Promise<string | null> {
  const [delivered] = await tx<
    { automation_run_id: string }[]
  >`select r.automation_run_id
    from allrice_brand_content_reminders r join allrice_automations a on a.id=r.automation_id and a.brand_content_binding=r.id
    where a.id=${automationId} and a.clock_owner='legacy' and r.state='reminded'`;
  if (delivered) return delivered.automation_run_id;
  const gate = await lockBrandContentReminder(tx, automationId);
  if (!gate || gate.automation.clock_owner !== 'legacy' || !gate.automation.due)
    return null;
  return completeBrandContentReminder(tx, gate, {
    clockOwner: 'legacy',
    ...(scheduledFor.getTime() !== gate.binding.scheduled_for.getTime()
      ? { blocked: 'BINDING_MISMATCH' }
      : {}),
  });
}
