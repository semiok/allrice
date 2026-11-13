import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { ZodError } from 'zod';
import {
  EmployeeInstanceSnapshotSchema,
  MemorySourceEvidenceSchema,
  type MemorySourceEvidence,
} from '@allrice/contracts';
import type { ContentIdentity } from './content-maintenance.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  EmployeeInstanceError,
  resolveEmployeeSessionInstance,
} from './employees/employee-instances.ts';
import { loadedMemorySourceSkillEvidence } from './memory-source-skills.ts';
import { readMemorySourceCollectionPolicy } from './memory-source-policy.ts';
import {
  memorySourceProducer,
  memorySourceCaptureEnabled,
} from './memory-source-capture.ts';
import { readEmployeeRunSourceKind } from './employees/employee-chat-authority.ts';
import { recordTransactionRetry } from './core/transaction-retries.ts';
import { EmployeeContentError } from './employees/employee-content-model.ts';
import {
  assertMemorySourceScenesAvailable,
  readMemorySourceScenes,
  type MemorySourceSceneRun,
} from './memory-source-scenes.ts';

const hash = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
type Tx = TransactionSql;
type Source = MemorySourceSceneRun & {
  capture_run_id: string;
  run_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  session_id: string;
  employee_assignment_id: string;
  employee_version_id: string;
  user_message_id: string;
  execution_user_message_id: string;
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

async function evidenceFor(
  tx: Tx,
  s: Source,
  kind: MemorySourceEvidence['kind'],
  policy: { revision: number; collectionStartedAt: string },
  inputs: { message_id: string; object_id: string; checksum: string }[],
  instanceId: string,
) {
  // Only the actual execution supplies resource identities. Previous assistant
  // answers, old summaries and MEMORY bodies are not new human sources.
  const runs = [s],
    ids = [s.run_id];
  const events = await tx<
    { id: string; run_id: string; event_type: string; payload: unknown }[]
  >`
    select id,run_id,event_type,payload from allrice_run_events
    where organization_id=${s.organization_id} and workspace_id=${s.workspace_id}
      and run_id in ${tx(ids)} and event_type='tool.completed'
      and payload->>'name'='skill' and payload->'nativePayload'->>'skillStatus'='loaded'
    order by sequence limit 65`;
  const skills = runs.flatMap((r) =>
    loadedMemorySourceSkillEvidence(
      r,
      events.filter((e) => e.run_id === r.run_id),
    ),
  );
  const { scenes, truncated: scenesTruncated } = await readMemorySourceScenes(
    tx,
    s,
    instanceId,
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
    order by a.created_at,a.version_id limit 33`;
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
  return MemorySourceEvidenceSchema.parse({
    schemaVersion: 2,
    captureRunId: s.capture_run_id,
    policyRevision: policy.revision,
    collectionStartedAt: policy.collectionStartedAt,
    capturedAt: new Date().toISOString(),
    kind,
    messageId: s.user_message_id,
    runId: s.run_id,
    relatedRunId: null,
    skills: skills.slice(0, 16),
    scenes,
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
      scenesTruncated ||
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
    select pg_try_advisory_xact_lock(hashtextextended(${s.capture_run_id},183)) locked`;
  if (!claim?.locked) return 'busy' as const;
  const finish = async (state: 'captured' | 'ignored', reason: string) => {
    await tx`update allrice_employee_runs set memory_source_capture_state=${state},
      memory_source_capture_reason=${reason},memory_source_captured_at=clock_timestamp()
      where run_id=${s.capture_run_id} and memory_source_capture_state='pending'
        and memory_source_capture_reason=${memorySourceProducer}`;
    return state;
  };
  const policy = await readMemorySourceCollectionPolicy(tx, s.organization_id);
  if (!policy) return finish('ignored', 'policy_disabled');
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
      false,
    );
  } catch (error) {
    if (
      error instanceof DataAccessError ||
      error instanceof EmployeeInstanceError
    )
      return finish('ignored', 'authority_unavailable');
    throw error;
  }
  const readOrigin = (reader: Tx) => reader<
    { text: string; created_at: Date; employee_id: string }[]
  >`
    select m.content->>'text' text,m.created_at,a.employee_id from allrice_employee_runs er
    join allrice_employee_runs actual on actual.run_id=coalesce(er.memory_source_execution_run_id,er.run_id)
      and actual.organization_id=er.organization_id and actual.workspace_id=er.workspace_id
      and actual.owner_id=er.owner_id and actual.session_id=er.session_id
      and actual.employee_assignment_id=er.employee_assignment_id
    join allrice_chat_sessions cs on cs.id=actual.session_id and cs.organization_id=actual.organization_id and cs.workspace_id=actual.workspace_id
    join allrice_employee_assignments a on a.id=actual.employee_assignment_id and a.organization_id=actual.organization_id and a.workspace_id=actual.workspace_id
    join allrice_messages m on m.id=er.user_message_id and m.session_id=er.session_id and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id
    where er.run_id=${s.capture_run_id} and actual.run_id=${s.run_id}
      and er.memory_source_capture_state='pending' and er.memory_source_capture_reason=${memorySourceProducer}
      and not er.method_authoring and not actual.method_authoring
      and not exists(select 1 from allrice_runtime_run_links l where l.run_id in (er.run_id,actual.run_id) and l.root_run_id<>l.run_id)
      and er.status in ('succeeded','failed','canceled') and er.completed_at is not null
      and actual.status in ('succeeded','failed','canceled') and actual.completed_at is not null
      and (er.memory_source_execution_run_id is null or exists(
        select 1 from allrice_conversation_commands c where c.followup_run_id=er.run_id
          and c.organization_id=er.organization_id and c.workspace_id=er.workspace_id and c.session_id=er.session_id
          and c.owner_id=er.owner_id and c.client_user_message_id=m.client_message_id
          and c.state='consumed' and c.input_kind='steer_current'
          and c.native_proof->>'status'='adopted' and c.native_proof->>'inputId'=c.client_user_message_id::text
          and ((c.native_proof->>'runId' is not null and c.native_proof->>'runId'=actual.run_id::text)
            or (c.native_proof->>'runId' is null and c.native_proof->>'turnId'=c.expected_turn_id))))
      and cs.archived_at is null and cs.owner_id=${s.owner_id} and m.owner_id=${s.owner_id}
      and coalesce(cs.employee_instance_id,cs.employee_assignment_id)=${snapshot.data.id}
      and er.execution_snapshot->'instance'->>'id'=${snapshot.data.id}
      and m.role='user' and m.status='completed' and m.created_at>=${policy.collectionStartedAt}::timestamptz
    `;
  const [origin] = await readOrigin(tx);
  if (!origin) return finish('ignored', 'source_ineligible');
  for (const [runId, userMessageId] of [
    [s.capture_run_id, s.user_message_id],
    [s.run_id, s.execution_user_message_id],
  ]) {
    if (
      (await readEmployeeRunSourceKind(
        {
          runId: runId!,
          userMessageId: userMessageId!,
          organizationId: s.organization_id,
          workspaceId: s.workspace_id,
          ownerId: s.owner_id,
        },
        tx,
      )) !== 'human'
    )
      return finish('ignored', 'source_unproven');
  }
  // The bounded source limit is structural; semantic selection belongs to the
  // later model pass. Do not crop a long message into a different instruction.
  if (!origin.text?.trim() || origin.text.length > 4000)
    return finish('ignored', 'source_size');
  const kind =
    s.capture_run_id === s.run_id ? 'human_message' : 'adopted_steering';
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
  const [existing] = await tx`select id from allrice_memory_sources
    where organization_id=${s.organization_id} and workspace_id=${s.workspace_id} and owner_id=${s.owner_id}
      and instance_id=${snapshot.data.id} and source_key=${sourceKey}`;
  if (existing) return finish('captured', 'source_already_recorded');
  // Optimistic reads never hold interactive attachment/identity rows. Recheck
  // the complete set after staging the ledger, preserving revoked dependencies.
  const readInputs = (reader: Tx) => reader<
    {
      message_id: string;
      object_id: string;
      checksum: string;
      owner_id: string;
      attached_by: string;
      state: string;
      deleted_at: Date | null;
      retention_until: Date | null;
    }[]
  >`select a.message_id,o.id object_id,o.checksum,o.owner_id,a.attached_by,o.state,o.deleted_at,o.retention_until
    from allrice_message_attachments a
    join allrice_storage_objects o on o.id=a.object_id and o.organization_id=a.organization_id and o.workspace_id=a.workspace_id
    where a.message_id in ${reader([...new Set([s.user_message_id, s.execution_user_message_id])])}
      and a.organization_id=${s.organization_id} and a.workspace_id=${s.workspace_id}
    order by a.message_id,a.object_id`;
  const inputs = await readInputs(tx);
  const inputsAvailable = async (reader: Tx, files: typeof inputs) => {
    const [clock] = await reader<
      { checked_at: Date }[]
    >`select clock_timestamp() checked_at`;
    return files.every(
      (file) =>
        file.attached_by === s.owner_id &&
        file.owner_id === s.owner_id &&
        file.state === 'ready' &&
        file.deleted_at === null &&
        (file.retention_until === null ||
          file.retention_until > clock!.checked_at),
    );
  };
  if (!(await inputsAvailable(tx, inputs)))
    return finish('ignored', 'dependency_unavailable');
  let evidence: MemorySourceEvidence;
  try {
    evidence = await evidenceFor(tx, s, kind, policy, inputs, snapshot.data.id);
    await assertMemorySourceScenesAvailable(
      tx,
      context,
      snapshot.data.id,
      evidence.scenes ?? [],
    );
  } catch (error) {
    if (
      error instanceof DataAccessError ||
      error instanceof EmployeeContentError ||
      error instanceof EmployeeInstanceError ||
      error instanceof ZodError
    )
      return finish('ignored', 'dependency_unavailable');
    throw error;
  }
  // A recorded historical version is useful evidence; a revoked installation or
  // binding is not a current authority to collect its reusable method. Unloaded
  // Skills are absent here, so their removal cannot discard independent facts.
  const assertSkills = async (reader: Tx) => {
    for (const { pin } of evidence.skills) {
      if (
        pin.organizationId !== s.organization_id ||
        pin.ownerId !== s.owner_id ||
        pin.instanceId !== snapshot.data.id
      )
        throw new DataAccessError('authorization_denied');
      const [allowed] =
        await reader`select v.id from allrice_personal_skill_bindings b
      join allrice_personal_skill_installations i on i.id=b.installation_id and i.organization_id=b.organization_id and i.owner_id=b.owner_id
      join allrice_personal_skill_versions v on v.installation_id=i.id and v.organization_id=i.organization_id and v.owner_id=i.owner_id
      where b.id=${pin.bindingId} and b.instance_id=${pin.instanceId} and b.organization_id=${s.organization_id}
        and b.owner_id=${s.owner_id} and b.enabled and b.epoch=${pin.bindingEpoch}
        and i.id=${pin.installationId} and i.state='installed'
        and v.id=${pin.versionId} and v.definition_checksum=${pin.definitionChecksum}
        and v.package_checksum is not distinct from ${pin.packageChecksum ?? null}
      `;
      if (!allowed) throw new DataAccessError('authorization_denied');
    }
  };
  const id = randomUUID();
  try {
    await tx.savepoint(async (writeTx) => {
      await assertSkills(writeTx);
      await writeTx`insert into allrice_memory_sources(id,organization_id,workspace_id,owner_id,employee_id,instance_id,
        capture_run_id,run_id,session_id,message_id,source_key,source_excerpt,source_digest,evidence)
      values(${id},${s.organization_id},${s.workspace_id},${s.owner_id},${origin.employee_id},${snapshot.data.id},
        ${s.capture_run_id},${s.run_id},${s.session_id},${s.user_message_id},${sourceKey},${origin.text},${hash(origin.text)},
        ${writeTx.json(evidence as unknown as postgres.JSONValue)})`;
      await writeTx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values(${s.organization_id},${s.workspace_id},${s.owner_id},'memory.source.capture','memory_source',${id},'allowed','structured_human_source',${context.requestId})`;
      // Optimistic commit check: a revocation can proceed during collection.
      // Roll back every ledger write if its exact source is no longer readable.
      await assertMemorySourceScenesAvailable(
        writeTx,
        context,
        snapshot.data.id,
        evidence.scenes ?? [],
      );
      await resolveEmployeeSessionInstance(
        context,
        s.employee_assignment_id,
        snapshot.data.id,
        writeTx,
        false,
      );
      const [currentOrigin] = await readOrigin(writeTx);
      const currentInputs = await readInputs(writeTx);
      if (
        !currentOrigin ||
        currentOrigin.text !== origin.text ||
        currentOrigin.employee_id !== origin.employee_id ||
        JSON.stringify(currentInputs) !== JSON.stringify(inputs) ||
        !(await inputsAvailable(writeTx, currentInputs))
      )
        throw new DataAccessError('authorization_denied');
      await assertSkills(writeTx);
      for (const artifact of evidence.artifacts) {
        const [current] = await writeTx`select v.id
          from allrice_workbench_artifacts a
          join allrice_deliverable_versions v on v.id=a.version_id
            and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
          join allrice_storage_objects o on o.id=v.object_id
            and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id
          where a.run_id=${artifact.runId} and a.version_id=${artifact.versionId}
            and a.organization_id=${s.organization_id} and a.workspace_id=${s.workspace_id}
            and a.owner_id=${s.owner_id} and v.owner_id=${s.owner_id} and o.owner_id=${s.owner_id}
            and o.id=${artifact.objectId} and o.checksum=${artifact.checksum}
            and o.state='ready' and o.deleted_at is null`;
        if (!current) throw new DataAccessError('authorization_denied');
      }
      const currentPolicy = await readMemorySourceCollectionPolicy(
        writeTx,
        s.organization_id,
      );
      if (
        !currentPolicy ||
        JSON.stringify(currentPolicy) !== JSON.stringify(policy)
      )
        throw new DataAccessError('authorization_denied');
    });
  } catch (error) {
    if (
      error instanceof DataAccessError ||
      error instanceof EmployeeContentError ||
      error instanceof EmployeeInstanceError ||
      error instanceof ZodError
    )
      return finish('ignored', 'dependency_unavailable');
    throw error;
  }
  return finish('captured', 'structured_human_source');
}

/** Durable markers are set by the normal terminal transaction. This bounded,
 * deterministic consumer runs after foreground claims, with no model calls,
 * separate scheduler or scan of historical conversations. */
export async function collectPendingMemorySources(
  options: {
    database?: ReturnType<typeof getDatabase>;
    limit?: number;
  } = {},
) {
  const counts = { captured: 0, ignored: 0, busy: 0 };
  if (!memorySourceCaptureEnabled()) return counts;
  const sql = options.database ?? getDatabase();
  const pending = await sql<
    Source[]
  >`select source.run_id capture_run_id,actual.run_id,actual.organization_id,actual.workspace_id,
    actual.owner_id,actual.session_id,actual.employee_assignment_id,actual.employee_version_id,
    source.user_message_id,actual.user_message_id execution_user_message_id,actual.execution_snapshot,actual.completed_at,
    actual.assistant_message_id,actual.content_generation_id,actual.content_scene_state
    from allrice_employee_runs source
    join allrice_employee_runs actual on actual.run_id=coalesce(source.memory_source_execution_run_id,source.run_id)
    where source.memory_source_capture_state='pending' and source.memory_source_capture_reason=${memorySourceProducer}
      and actual.status in ('succeeded','failed','canceled') and actual.completed_at is not null
    order by actual.completed_at,source.run_id limit ${Math.max(1, Math.min(options.limit ?? 4, 16))}`;
  for (const row of pending) {
    try {
      const result = await sql.begin((tx) => capture(tx, row));
      counts[result]++;
    } catch (error) {
      // Locks/timeout are a retryable scheduling outcome, not an ignored source.
      const code = record(error).code;
      if (['55P03', '57014', '40P01'].includes(String(code))) counts.busy++;
      else throw error;
      if (code === '40P01')
        recordTransactionRetry({
          site: 'memory_source_capture',
          sqlState: '40P01',
          attempt: 1,
          outcome: 'retrying',
        });
    }
  }
  return counts;
}
