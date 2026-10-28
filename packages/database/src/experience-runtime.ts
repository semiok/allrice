import { hasMemorySourceTool } from '@allrice/contracts';
import { employeeAccessTransaction } from './employees/employee-access-cancellation.ts';
import { readTaskClock } from './task-clock.ts';
import type postgres from 'postgres';
import { ensureExperienceProjection } from './experience-projection.ts';
import {
  ExperienceAdoptionProofSchema,
  ExperienceActionReceiptSchema,
  ExperienceReadPinsSchema,
  explicitExperienceForgetRequest,
  experienceAppliesToRequest,
  type ExperienceReadPin,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  readContentPrincipal,
  type ContentIdentity,
} from './content-maintenance.ts';
import { resolveEmployeeSessionInstance } from './employees/employee-instances.ts';
import { ExperienceError, experienceReviewEnabled } from './experience.ts';
import {
  readPrivateExperience,
  experienceUnavailable,
  assertExperienceReadPins,
} from './experience-adoption.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { experienceSkillsMatchRun } from './experience-skill-dependencies.ts';

type Tx = postgres.TransactionSql;
export type ExperienceRunScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  runId: string;
};
const identity = (s: ExperienceRunScope): ContentIdentity => ({
  actor: { type: 'user', id: s.ownerId },
  organizationId: s.organizationId,
  workspaceId: s.workspaceId,
});
const deny = (): never => {
  throw new ExperienceError('identity_denied');
};

/** Also used by the existing owner memory-delete API. The review/proof remains
 * immutable; archived memory is the durable tombstone, with a revision/audit. */
export async function archivePrivateExperience(
  tx: Tx,
  who: ContentIdentity,
  id: string,
  requestId: string,
) {
  const [origin] =
    await tx`select memory_id from allrice_experience_reviews where memory_id=${id}
    and organization_id=${who.organizationId} and workspace_id=${who.workspaceId!} and owner_id=${who.actor.id}
    and origin_kind in ('incremental','derived')`;
  if (!origin) return null;
  if (!who.workspaceId || !(await readContentPrincipal(who, tx, true)))
    return deny();
  await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${who.organizationId}`},0))`;
  const [row] =
    await tx`select m.*,e.origin_kind from allrice_memories m join allrice_experience_reviews e on e.memory_id=m.id
    where m.id=${id} and m.organization_id=${who.organizationId} and m.workspace_id=${who.workspaceId}
      and m.owner_id=${who.actor.id} and e.owner_id=m.owner_id and e.origin_kind in ('incremental','derived') for update of m`;
  if (!row) return null;
  if (row.archived_at) return { id, already: true };
  await tx`update allrice_memories set archived_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 where id=${id}`;
  await tx`delete from allrice_rag_chunks where memory_id=${id} and organization_id=${who.organizationId} and workspace_id=${who.workspaceId}`;
  await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
    values(${who.organizationId},${who.workspaceId},${id},${row.revision + 1},${row.content},${row.trust_level},${row.lifecycle_state},${row.memory_class},${row.confidence},'本人撤回私人经验；历史证据保留且不再采用',${who.actor.id})`;
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${who.organizationId},${who.workspaceId},${who.actor.id},'experience.forget','memory',${id},'allowed','explicit_owner_request',${requestId})`;
  // Runtime context guards inspect exact read pins, including imports and native
  // compaction. No destructive rewrite of historical Run/answer evidence.
  return { id, already: false };
}
const normalize = (s: string) => s.replace(/[\s，,。.;；：:]/gu, '');
function targetMatches(target: string, rule: string, kind: string) {
  const t = normalize(target);
  return (
    t === normalize(rule) ||
    (kind === 'attendance_groups' && t === '到场和未到人数分项列出')
  );
}

async function memoriesForPins(
  tx: Tx,
  who: ContentIdentity,
  pins: ExperienceReadPin[],
  runSkills: unknown,
  runId: string,
  snapshot: unknown,
) {
  const memories = [];
  for (const pin of pins) {
    const m = await readPrivateExperience(tx, who, pin.id);
    if (runtimePolicyDigest(pin) !== runtimePolicyDigest(m.pin))
      throw new ExperienceError('source_changed');
    if (
      m.proof.validation.kind === 'independent_skill_case' &&
      !experienceSkillsMatchRun(m.proof.validation.dependencies, runSkills)
    )
      throw new ExperienceError('source_changed');
    memories.push({
      id: pin.id,
      revision: pin.revision,
      content: m.row.content as string,
      trust: 'derived' as const,
      lifecycleState: 'durable' as const,
      memoryClass:
        m.proof.rule.kind === 'report_style'
          ? ('user_preference' as const)
          : ('work_note' as const),
      confidence: Number(m.row.confidence),
      sourceLabel: '私人经验 · 自动验证后采用',
      capturedAt: m.row.captured_at.toISOString(),
      ...(hasMemorySourceTool(snapshot)
        ? { sourceHandle: `experience:${runtimePolicyDigest({ runId, pin })}` }
        : {}),
    });
  }
  return memories;
}

/** Run-bound preparation before native context selection. Never trust a model's
 * instance/source ID. An explicit forget request is applied before loading old
 * native history, so its confirmation can be delivered in a fresh context. */
export type ExperienceWorker = {
  workerId: string;
  jobId: string;
  leaseToken: string;
  attempt: number;
};
export async function assertExperienceWorker(
  tx: Tx,
  scope: ExperienceRunScope,
  worker: ExperienceWorker,
  exclusiveRun = false,
) {
  const roots =
    await tx`select root_run_id,(cancel_requested_at is null and cancel_request_id is null and deadline_at>clock_timestamp()) live
    from allrice_runtime_roots where root_run_id=${scope.runId} for share nowait`;
  if (roots.some((r) => !r.live)) return deny();
  const [live] =
    await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
    join allrice_employee_runs er on er.run_id=r.id
    where j.id=${worker.jobId} and j.run_id=${scope.runId} and j.organization_id=${scope.organizationId}
      and j.workspace_id=${scope.workspaceId} and j.owner_id=${scope.ownerId}
      and r.organization_id=j.organization_id and r.workspace_id=j.workspace_id and r.owner_id=j.owner_id
      and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id and er.owner_id=r.owner_id and er.session_id=${scope.sessionId}
      and j.status='running' and r.state='running' and er.status='running'
      and j.worker_id=${worker.workerId} and j.attempt=${worker.attempt} and j.lease_token=${worker.leaseToken}
      and j.cancel_requested_at is null and j.timeout_at>clock_timestamp() and j.lease_expires_at>clock_timestamp()
      and not exists(select 1 from allrice_runtime_run_links l where l.run_id=r.id and l.root_run_id<>r.id)
    for share of r,j ${exclusiveRun ? tx`for no key update of er` : tx`for share of er nowait`}`;
  if (!live) return deny();
  const clock = await readTaskClock(tx, scope.runId);
  if (
    clock &&
    (clock.deadlineAt.getTime() <= Date.now() ||
      (clock.remainingMs !== null && clock.remainingMs <= 0))
  )
    return deny();
}
export async function prepareRunExperiences(
  scope: ExperienceRunScope,
  worker: ExperienceWorker,
  nativeReplySourceRunId?: string,
) {
  if (!experienceReviewEnabled()) return { memories: [], receipt: null };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    const who = identity(scope);
    if (!(await readContentPrincipal(who, tx, true))) return deny();
    const [run] =
      await tx`select er.*,m.content->>'text' current_request,s.employee_instance_id
      from allrice_employee_runs er join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=er.organization_id and s.workspace_id=er.workspace_id
      join allrice_messages m on m.id=er.user_message_id and m.session_id=s.id and m.owner_id=er.owner_id and m.role='user'
      join allrice_runs r on r.id=er.run_id
      where er.run_id=${scope.runId} and er.session_id=${scope.sessionId} and er.organization_id=${scope.organizationId}
        and er.workspace_id=${scope.workspaceId} and er.owner_id=${scope.ownerId} and s.owner_id=er.owner_id and s.archived_at is null
        and er.status in ('queued','running') and r.state in ('queued','running')`;
    if (!run) return deny();
    const instanceId = run.execution_snapshot?.instance?.id;
    if (!instanceId || run.method_authoring || !run.execution_snapshot?.content)
      return { memories: [], receipt: null };
    if ((run.employee_instance_id ?? run.employee_assignment_id) !== instanceId)
      return deny();
    const target = nativeReplySourceRunId
      ? null
      : explicitExperienceForgetRequest(run.current_request ?? '');
    await assertExperienceWorker(tx, scope, worker);
    if (target)
      await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
    else
      await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
    await assertExperienceWorker(tx, scope, worker);
    await resolveEmployeeSessionInstance(
      who,
      run.employee_assignment_id,
      instanceId,
      tx,
    );
    await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-run:${scope.runId}`},183))`;
    const [fresh] =
      await tx`select experience_reads,experience_prepared_at,experience_action_receipt
      from allrice_employee_runs where run_id=${nativeReplySourceRunId ?? scope.runId}
        and session_id=${scope.sessionId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
        and execution_snapshot->'instance'->>'id'=${instanceId}`;
    if (!fresh) return deny();
    if (nativeReplySourceRunId || fresh.experience_prepared_at) {
      const pins = ExperienceReadPinsSchema.parse(fresh!.experience_reads);
      const memories = await memoriesForPins(
        tx,
        who,
        pins,
        run.execution_snapshot?.personalSkills,
        scope.runId,
        run.execution_snapshot,
      );
      await assertExperienceWorker(tx, scope, worker);
      // Reuse only existing, re-authorized reads; answer text is never an
      // ordinary memory search/forget request. No recall or action is replayed.
      if (nativeReplySourceRunId)
        await tx`update allrice_employee_runs set experience_reads=${tx.json(pins)},
          experience_prepared_at=clock_timestamp(),experience_action_receipt=${fresh.experience_action_receipt ? tx.json(fresh.experience_action_receipt) : null}
          where run_id=${scope.runId}`;
      return {
        memories,
        receipt: fresh!.experience_action_receipt
          ? ExperienceActionReceiptSchema.parse(
              fresh!.experience_action_receipt,
            )
          : null,
      };
    }
    let receipt: ReturnType<typeof ExperienceActionReceiptSchema.parse> | null =
      null;
    if (target) {
      const candidates =
        await tx`select m.id,m.archived_at,m.content,e.adoption_proof from allrice_memories m join allrice_experience_reviews e on e.memory_id=m.id
        where m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId} and m.owner_id=${scope.ownerId}
          and m.instance_id=${instanceId} and e.origin_kind='derived' order by m.id limit 21`;
      // Never silently disambiguate a truncated list.
      const matches =
        candidates.length > 20
          ? candidates
          : candidates.filter((r) => {
              const proof = ExperienceAdoptionProofSchema.parse(
                r.adoption_proof,
              );
              return targetMatches(
                target,
                r.content.split('\n适用范围：')[0],
                proof.rule.kind,
              );
            });
      const result =
        matches.length === 1
          ? await archivePrivateExperience(tx, who, matches[0]!.id, scope.runId)
          : null;
      receipt = ExperienceActionReceiptSchema.parse({
        action: 'forget',
        target,
        memoryId: result?.id ?? null,
        status:
          matches.length > 1
            ? 'ambiguous'
            : !result
              ? 'not_found'
              : result.already
                ? 'already_forgotten'
                : 'forgotten',
      });
    }
    const rows =
      await tx`select m.id from allrice_memories m join allrice_experience_reviews e on e.memory_id=m.id
      where m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId} and m.owner_id=${scope.ownerId}
        and m.instance_id=${instanceId} and m.archived_at is null and e.origin_kind='derived'
      order by m.updated_at desc,m.id limit 20`;
    const pins: ExperienceReadPin[] = [];
    let remaining = 6000; // whole rules + applicability; never truncate boundaries
    for (const row of rows) {
      if (pins.length >= 3) break;
      try {
        const m = await readPrivateExperience(tx, who, row.id);
        if (
          (m.proof.validation.kind === 'independent_skill_case' &&
            !experienceSkillsMatchRun(
              m.proof.validation.dependencies,
              run.execution_snapshot?.personalSkills,
            )) ||
          !experienceAppliesToRequest(
            m.proof.rule,
            run.current_request ?? '',
          ) ||
          m.row.content.length > remaining ||
          target
        )
          continue;
        remaining -= m.row.content.length;
        await ensureExperienceProjection(tx, m);
        pins.push(m.pin);
      } catch (e) {
        if (!experienceUnavailable(e)) throw e;
      }
    }
    await tx`update allrice_employee_runs set experience_reads=${tx.json(pins)},experience_prepared_at=clock_timestamp(),
      experience_action_receipt=${receipt ? tx.json(receipt) : null} where run_id=${scope.runId}`;
    if (pins.length)
      await tx`update allrice_memories set recall_count=recall_count+1,last_recalled_at=clock_timestamp()
      where id in ${tx(pins.map((p) => p.id))}`;
    const memories = await memoriesForPins(
      tx,
      who,
      pins,
      run.execution_snapshot?.personalSkills,
      scope.runId,
      run.execution_snapshot,
    );
    await assertExperienceWorker(tx, scope, worker);
    return { memories, receipt };
  });
}

/** Explicit search can return only the same eligible, Run-bound rules; generic
 * search cannot bypass instance/applicability or revive a revoked rule. */
export async function searchRunExperiences(
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    runId: string;
  },
  transaction?: Tx,
) {
  const read = async (tx: Tx) => {
    const who: ContentIdentity = {
      actor: { type: 'user', id: input.ownerId },
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
    };
    const [row] =
      await tx`select experience_reads,execution_snapshot from allrice_employee_runs where run_id=${input.runId}
      and organization_id=${input.organizationId} and workspace_id=${input.workspaceId} and owner_id=${input.ownerId}`;
    if (!row) return [];
    const pins = ExperienceReadPinsSchema.parse(row.experience_reads);
    await assertExperienceReadPins(who, pins, tx);
    return memoriesForPins(
      tx,
      who,
      pins,
      row.execution_snapshot?.personalSkills,
      input.runId,
      row.execution_snapshot,
    );
  };
  return transaction ? read(transaction) : getDatabase().begin(read);
}
