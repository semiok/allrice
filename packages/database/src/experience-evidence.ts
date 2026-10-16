import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import {
  EmployeeInstanceSnapshotSchema,
  ExperienceCollectionPolicySchema,
  ExperienceEvidenceSchema,
  PersonalSkillPinSchema,
  runtimeFeatureEnabled,
  type ExperienceEvidence,
} from '@allrice/contracts';
import type { ContentIdentity } from './content-maintenance.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  EmployeeInstanceError,
  resolveEmployeeSessionInstance,
} from './employees/employee-instances.ts';
import { classifyExperienceFeedback } from './experience-feedback.ts';

const hash = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
type Tx = TransactionSql;
type Source = {
  run_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  session_id: string;
  employee_assignment_id: string;
  employee_version_id: string;
  user_message_id: string;
  execution_snapshot: unknown;
  completed_at: Date;
};
function contextFor(s: Source): ContentIdentity & { requestId: string } {
  return {
    requestId: randomUUID(),
    // This is a background policy action, not an authenticated browser request.
    // A conversation ID must never be passed as an authentication Session ID.
    actor: { type: 'user', id: s.owner_id },
    organizationId: s.organization_id,
    workspaceId: s.workspace_id,
  };
}

/** Only successful actual Skill loads matched against that Run's immutable pin
 * count as dependencies. Mere registration, model prose and tool text do not. */
export function loadedExperienceSkillEvidence(
  run: { run_id: string; execution_snapshot: unknown },
  events: { id: string; event_type: string; payload: unknown }[],
): ExperienceEvidence['skills'] {
  const snapshot = record(run.execution_snapshot);
  const skills = record(snapshot.personalSkills).skills;
  const pins = Array.isArray(skills)
    ? skills.flatMap((item) => {
        const pin = PersonalSkillPinSchema.safeParse(item);
        return pin.success ? [pin.data] : [];
      })
    : [];
  const found = new Set<string>();
  return events.flatMap((event) => {
    const payload = record(event.payload),
      native = record(payload.nativePayload);
    if (
      event.event_type !== 'tool.completed' ||
      payload.name !== 'skill' ||
      native.skillStatus !== 'loaded'
    )
      return [];
    const parsed = PersonalSkillPinSchema.safeParse(native.personalSkill);
    if (!parsed.success) return [];
    const p = parsed.data;
    const pin = pins.find(
      (v) =>
        Object.keys(v).every(
          (key) => v[key as keyof typeof v] === p[key as keyof typeof p],
        ) && Object.keys(p).length === Object.keys(v).length,
    );
    if (!pin || found.has(pin.bindingId)) return [];
    found.add(pin.bindingId);
    return [{ runId: run.run_id, eventId: event.id, pin }];
  });
}

async function evidenceFor(
  tx: Tx,
  s: Source,
  kind: ExperienceEvidence['kind'],
  messageCreatedAt: Date,
  policy: { revision: number; collectionStartedAt: string },
) {
  // The preceding delivered/failed task is contextual evidence, not proof that
  // its model answer or every output is correct. Never search another Session.
  const previous = await tx<
    Pick<Source, 'run_id' | 'execution_snapshot' | 'user_message_id'>[]
  >`
    select run_id,execution_snapshot,user_message_id from allrice_employee_runs
    where organization_id=${s.organization_id} and workspace_id=${s.workspace_id}
      and owner_id=${s.owner_id} and session_id=${s.session_id} and run_id<>${s.run_id}
      and completed_at<=${messageCreatedAt} and status in ('succeeded','failed','canceled')
      and not method_authoring order by completed_at desc,run_id desc limit 1`;
  const runs = [s, ...previous],
    ids = runs.map((r) => r.run_id);
  const events = await tx<
    { id: string; run_id: string; event_type: string; payload: unknown }[]
  >`
    select id,run_id,event_type,payload from allrice_run_events
    where organization_id=${s.organization_id} and workspace_id=${s.workspace_id}
      and run_id in ${tx(ids)} and event_type='tool.completed'
      and payload->>'name'='skill' and payload->'nativePayload'->>'skillStatus'='loaded'
    order by sequence limit 65`;
  const skills = runs.flatMap((r) =>
    loadedExperienceSkillEvidence(
      r,
      events.filter((e) => e.run_id === r.run_id),
    ),
  );
  const artifacts = await tx<
    {
      run_id: string;
      version_id: string;
      object_id: string;
      checksum: string;
    }[]
  >`
    select a.run_id,v.id version_id,o.id object_id,o.checksum
    from allrice_workbench_artifacts a
    join allrice_deliverable_versions v on v.id=a.version_id and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
    join allrice_storage_objects o on o.id=v.object_id and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id
    where a.run_id in ${tx(ids)} and a.organization_id=${s.organization_id} and a.workspace_id=${s.workspace_id}
      and a.owner_id=${s.owner_id} and v.owner_id=${s.owner_id} and o.owner_id=${s.owner_id}
      and o.state='ready' and o.deleted_at is null
    order by a.created_at,a.version_id limit 33 for share of o`;
  const inputs = await tx<
    { message_id: string; object_id: string; checksum: string }[]
  >`
    select a.message_id,o.id object_id,o.checksum from allrice_message_attachments a
    join allrice_storage_objects o on o.id=a.object_id and o.organization_id=a.organization_id and o.workspace_id=a.workspace_id
    where a.message_id in ${tx(runs.map((r) => r.user_message_id))}
      and a.organization_id=${s.organization_id} and a.workspace_id=${s.workspace_id}
      and a.attached_by=${s.owner_id} and o.owner_id=${s.owner_id} and o.state='ready' and o.deleted_at is null
    order by a.created_at,a.object_id limit 33 for share of o`;
  const knowledge = runs.flatMap((r) => {
    const bindings = record(
      record(r.execution_snapshot).capabilitySnapshot,
    ).knowledge;
    return Array.isArray(bindings)
      ? bindings.flatMap((value) => {
          const b = record(value),
            rev = record(b.revision);
          return b.effective === true &&
            typeof rev.id === 'string' &&
            typeof rev.checksum === 'string'
            ? [{ runId: r.run_id, revisionId: rev.id, checksum: rev.checksum }]
            : [];
        })
      : [];
  });
  return ExperienceEvidenceSchema.parse({
    schemaVersion: 1,
    policyRevision: policy.revision,
    collectionStartedAt: policy.collectionStartedAt,
    capturedAt: new Date().toISOString(),
    kind,
    messageId: s.user_message_id,
    runId: s.run_id,
    relatedRunId: previous[0]?.run_id ?? null,
    skills: skills.slice(0, 16),
    artifacts: artifacts.slice(0, 32).map((r) => ({
      runId: r.run_id,
      versionId: r.version_id,
      objectId: r.object_id,
      checksum: r.checksum,
    })),
    inputs: inputs.slice(0, 32).map((r) => ({
      messageId: r.message_id,
      objectId: r.object_id,
      checksum: r.checksum,
    })),
    availableKnowledge: knowledge.slice(0, 64),
    truncated:
      events.length > 64 ||
      skills.length > 16 ||
      artifacts.length > 32 ||
      inputs.length > 32 ||
      knowledge.length > 64,
  });
}

async function capture(tx: Tx, s: Source) {
  // Short background transactions never wait behind interactive publication or
  // revocation. A collision remains pending and is retried by the existing tick.
  await tx`set local lock_timeout='100ms'`;
  await tx`set local statement_timeout='2000ms'`;
  const [claim] = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtextextended(${s.run_id},183)) locked`;
  if (!claim?.locked) return 'busy' as const;
  const finish = async (state: 'captured' | 'ignored', reason: string) => {
    await tx`update allrice_employee_runs set experience_capture_state=${state},
      experience_capture_reason=${reason},experience_captured_at=clock_timestamp()
      where run_id=${s.run_id} and experience_capture_state='pending'`;
    return state;
  };
  const policies = await tx<{ scope_type: string; value: unknown }[]>`
    select scope_type,value from allrice_settings where key='employee_experience_policy'
      and ((scope_type='system' and scope_id is null) or (scope_type='organization' and scope_id=${s.organization_id}))
    order by scope_type for share`;
  const policy = ExperienceCollectionPolicySchema.safeParse(
    policies.find((p) => p.scope_type === 'organization')?.value ??
      policies.find((p) => p.scope_type === 'system')?.value,
  );
  if (!policy.success || policy.data.frequency === 'off')
    return finish('ignored', 'policy_disabled');
  const snapshot = EmployeeInstanceSnapshotSchema.safeParse(
    record(s.execution_snapshot).instance,
  );
  if (
    !snapshot.success ||
    snapshot.data.organizationId !== s.organization_id ||
    snapshot.data.workspaceId !== s.workspace_id ||
    snapshot.data.ownerId !== s.owner_id ||
    snapshot.data.assignmentId !== s.employee_assignment_id
  )
    return finish('ignored', 'unproven_instance');
  const context = contextFor(s);
  try {
    await resolveEmployeeSessionInstance(
      context,
      s.employee_assignment_id,
      snapshot.data.id,
      tx,
    );
  } catch (error) {
    if (
      error instanceof DataAccessError ||
      error instanceof EmployeeInstanceError
    )
      return finish('ignored', 'authority_unavailable');
    throw error;
  }
  const [origin] = await tx<
    { text: string; created_at: Date; employee_id: string }[]
  >`
    select m.content->>'text' text,m.created_at,a.employee_id from allrice_employee_runs er
    join allrice_chat_sessions cs on cs.id=er.session_id and cs.organization_id=er.organization_id and cs.workspace_id=er.workspace_id
    join allrice_employee_assignments a on a.id=er.employee_assignment_id and a.organization_id=er.organization_id and a.workspace_id=er.workspace_id
    join allrice_messages m on m.id=er.user_message_id and m.session_id=er.session_id and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id
    where er.run_id=${s.run_id} and er.experience_capture_state='pending' and not er.method_authoring
      and er.status in ('succeeded','failed','canceled') and er.completed_at is not null
      and cs.archived_at is null and cs.owner_id=${s.owner_id} and m.owner_id=${s.owner_id}
      and coalesce(cs.employee_instance_id,cs.employee_assignment_id)=${snapshot.data.id}
      and m.role='user' and m.status='completed' and m.created_at>=${policy.data.collectionStartedAt}::timestamptz
    for update of er for share of cs,m`;
  if (!origin) return finish('ignored', 'source_ineligible');
  const kind = classifyExperienceFeedback(origin.text ?? '');
  if (!kind) return finish('ignored', 'not_direct_feedback');
  const sourceKey = hash(
    [
      s.organization_id,
      s.workspace_id,
      s.owner_id,
      snapshot.data.id,
      s.user_message_id,
    ].join(':'),
  );
  const [sourceClaim] = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtextextended(${sourceKey},184)) locked`;
  if (!sourceClaim?.locked) return 'busy' as const;
  const [existing] = await tx`select memory_id from allrice_experience_reviews
    where organization_id=${s.organization_id} and workspace_id=${s.workspace_id} and owner_id=${s.owner_id}
      and instance_id=${snapshot.data.id} and source_key=${sourceKey}`;
  if (existing) return finish('captured', 'source_already_recorded');
  const evidence = await evidenceFor(
    tx,
    s,
    kind,
    origin.created_at,
    policy.data,
  );
  // A recorded historical version is useful evidence; a revoked installation or
  // binding is not a current authority to collect its reusable method. Unloaded
  // Skills are absent here, so their removal cannot discard independent facts.
  for (const { pin } of evidence.skills) {
    if (
      pin.organizationId !== s.organization_id ||
      pin.ownerId !== s.owner_id ||
      pin.instanceId !== snapshot.data.id
    )
      return finish('ignored', 'dependency_unavailable');
    const [allowed] =
      await tx`select v.id from allrice_personal_skill_bindings b
      join allrice_personal_skill_installations i on i.id=b.installation_id and i.organization_id=b.organization_id and i.owner_id=b.owner_id
      join allrice_personal_skill_versions v on v.installation_id=i.id and v.organization_id=i.organization_id and v.owner_id=i.owner_id
      where b.id=${pin.bindingId} and b.instance_id=${pin.instanceId} and b.organization_id=${s.organization_id}
        and b.owner_id=${s.owner_id} and b.enabled and b.epoch=${pin.bindingEpoch}
        and i.id=${pin.installationId} and i.state='installed'
        and v.id=${pin.versionId} and v.definition_checksum=${pin.definitionChecksum}
        and v.package_checksum is not distinct from ${pin.packageChecksum ?? null}
      for share of b,i,v`;
    if (!allowed) return finish('ignored', 'dependency_unavailable');
  }
  const id = randomUUID(),
    content = origin.text.trim(),
    contentDigest = hash(content);
  await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,instance_id,
    content,visibility,source_type,source_id,lifecycle_state,memory_class,revision,trust_level,confidence,source_label)
    values(${id},${s.organization_id},${s.workspace_id},${s.owner_id},${origin.employee_id},${snapshot.data.id},
      ${content},'private','message',${s.user_message_id},'candidate','work_note',1,'derived',0.5,'工作反馈 · 待自动整理')`;
  await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
    values(${s.organization_id},${s.workspace_id},${id},1,${content},'derived','candidate','work_note',0.5,'自动留存直接反馈，尚未整理或采用',${s.owner_id})`;
  await tx`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,
    run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged,
    origin_kind,instance_id,source_key,evidence)
    values(${id},${s.organization_id},${s.workspace_id},${s.owner_id},${randomUUID()},${sourceKey},
      ${s.run_id},${s.session_id},${s.user_message_id},${origin.text},${hash(origin.text)},${contentDigest},'private',false,
      'incremental',${snapshot.data.id},${sourceKey},${tx.json(evidence as unknown as postgres.JSONValue)})`;
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${s.organization_id},${s.workspace_id},${s.owner_id},'experience.capture','memory',${id},'allowed','platform_automatic_experience_policy',${context.requestId})`;
  return finish('captured', 'direct_feedback');
}

/** Durable markers are set by the normal terminal transaction. This bounded,
 * deterministic consumer runs after foreground claims, with no model calls,
 * separate scheduler or scan of historical conversations. */
export async function collectPendingExperienceEvidence(
  options: {
    database?: ReturnType<typeof getDatabase>;
    limit?: number;
  } = {},
) {
  const counts = { captured: 0, ignored: 0, busy: 0 };
  if (!runtimeFeatureEnabled('ALLRICE_EXPERIENCE_REVIEW_ENABLED'))
    return counts;
  const sql = options.database ?? getDatabase();
  const pending = await sql<
    Source[]
  >`select run_id,organization_id,workspace_id,owner_id,session_id,
    employee_assignment_id,employee_version_id,user_message_id,execution_snapshot,completed_at
    from allrice_employee_runs where experience_capture_state='pending'
    order by completed_at,run_id limit ${Math.max(1, Math.min(options.limit ?? 4, 16))}`;
  for (const row of pending) {
    try {
      const result = await sql.begin((tx) => capture(tx, row));
      counts[result]++;
    } catch (error) {
      // Locks/timeout are a retryable scheduling outcome, not an ignored source.
      const code = record(error).code;
      if (['55P03', '57014', '40P01'].includes(String(code))) counts.busy++;
      else throw error;
    }
  }
  return counts;
}
