import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type postgres from 'postgres';
import {
  ExperienceAdoptionProofSchema,
  ExperienceReadPinsSchema,
  ExperienceAdoptionViewSchema,
  supportedExperienceRule,
  REPORT_STYLE_RECOGNIZER_VERSION,
  supportsDirectReportPreference,
  type ExperienceAdoptionProof,
  type ExperienceReadPin,
  UuidSchema,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  readContentPrincipal,
  type ContentIdentity,
} from './content-maintenance.ts';
import {
  readExperiencePolicy,
  readExperienceValidationSource,
} from './experience-consolidation.ts';
import { readPassedExperienceProof } from './experience-validation.ts';
import { ExperienceError, experienceReviewEnabled } from './experience.ts';
import { DataAccessError } from './data.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';
import { PersonalSkillError } from './employees/personal-skills.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { embedWorkspaceText } from './workspace/memory-recall.ts';
import { classifyExperienceFeedback } from './experience-feedback.ts';
import { assertExperienceSkillsCurrent } from './experience-skill-dependencies.ts';
import { buildExperienceProjection } from './experience-projection.ts';

type Tx = postgres.TransactionSql;
type Sql = Tx | ReturnType<typeof getDatabase>;
const hash = (s: string) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;
export const experienceUnavailable = (e: unknown) =>
  e instanceof ExperienceError ||
  e instanceof DataAccessError ||
  e instanceof EmployeeInstanceError ||
  e instanceof PersonalSkillError;
const deny = (): never => {
  throw new ExperienceError('source_changed');
};

const contentFor = (d: { rule: string; applicability: string }) =>
  `${d.rule}\n适用范围：${d.applicability}`;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ReportStyleReassessmentInputSchema = z
  .object({
    occurrenceId: UuidSchema,
    draftIndex: z.number().int().min(0).max(7),
    expectedOutputDigest: digestSchema,
    expectedPlanDigest: digestSchema,
  })
  .strict();
const ReportStyleReassessmentResultSchema = z.object({
  auditId: UuidSchema,
  occurrenceId: UuidSchema,
  draftIndex: z.number().int().min(0).max(7),
  recognizerVersion: z.literal(REPORT_STYLE_RECOGNIZER_VERSION),
  decision: z.enum(['adopted', 'not_adopted']),
  memoryId: UuidSchema.nullable(),
  reason: z.string().nullable(),
});
type Reassessment = {
  who: ContentIdentity;
  input: z.infer<typeof ReportStyleReassessmentInputSchema>;
};

/** Bounded deterministic consumer on the existing tick. No model or new queue. */
export async function syncExperienceAdoptions() {
  await consumeExperienceAdoptions();
}

/** Internal, explicitly targeted continuation after a recognizer correction.
 * Reuses the same consumer, preserves the prior decision in an append-only audit,
 * and never reopens other completed batches or invokes a model/test. */
export async function reassessReportStyleAdoption(
  who: ContentIdentity,
  input: z.input<typeof ReportStyleReassessmentInputSchema>,
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  if (who.actor.type !== 'user' || !who.workspaceId) return deny();
  UuidSchema.parse(who.actor.id);
  UuidSchema.parse(who.organizationId);
  UuidSchema.parse(who.workspaceId);
  const result = await consumeExperienceAdoptions({
    who,
    input: ReportStyleReassessmentInputSchema.parse(input),
  });
  if (!result) throw new ExperienceError('conflict');
  return result;
}

async function consumeExperienceAdoptions(reassessment?: Reassessment) {
  if (!experienceReviewEnabled()) return;
  const db = getDatabase();
  let result: z.infer<typeof ReportStyleReassessmentResultSchema> | undefined;
  const rows = reassessment
    ? [{ id: reassessment.input.occurrenceId }]
    : await db`select a.id from allrice_automation_runs a
    left join allrice_settings org on org.scope_type='organization' and org.scope_id=a.organization_id and org.key='employee_experience_policy'
    left join allrice_settings sys on sys.scope_type='system' and sys.scope_id is null and sys.key='employee_experience_policy'
    where a.status='succeeded' and not exists(select 1 from allrice_native_context_retirements retired where retired.context_kind='experience_consolidation' and retired.context_id=a.id) and a.experience_receipt is not null and (a.experience_adoption_plan is null or (a.experience_adoption_plan->>'status'='awaiting_validation' and exists(
        select 1 from allrice_platform_employee_test_runs ready
        join jsonb_array_elements(coalesce(a.experience_adoption_plan->'pendingDrafts','[]'::jsonb)) pending(value)
          on ready.experience_binding->'draftIndex'=pending.value where ready.purpose='experience_validation'
          and ready.experience_binding->>'occurrenceId'=a.id::text and ready.status not in ('queued','running'))))
      and coalesce(org.value,sys.value)->>'adoptionMode'='supported_private'
      and coalesce(org.value,sys.value)->>'frequency'<>'off'
      and not exists(select 1 from allrice_platform_employee_test_runs t where t.purpose='experience_validation'
        and t.experience_binding->>'occurrenceId'=a.id::text and t.status in ('queued','running'))
    order by a.created_at,a.id limit 8`;
  for (const row of rows) {
    try {
      const committedResult = await db.begin(async (tx) => {
        if (reassessment) await tx`set local lock_timeout='3s'`;
        else await tx`set local lock_timeout='100ms'`;
        await tx`set local statement_timeout='3000ms'`;
        const [batch] = reassessment
          ? await tx`select id,organization_id,experience_adoption_plan from allrice_automation_runs where id=${row.id} and status='succeeded' for update`
          : await tx`select id,organization_id,experience_adoption_plan from allrice_automation_runs where id=${row.id} and (experience_adoption_plan is null or experience_adoption_plan->>'status'='awaiting_validation') for update skip locked`;
        if (!batch) return;
        if (
          (
            await tx`select 1 from allrice_native_context_retirements where context_kind='experience_consolidation' and context_id=${row.id}`
          ).length
        ) {
          if (reassessment) return deny();
          return;
        }
        if (
          reassessment &&
          !Array.isArray(batch.experience_adoption_plan?.drafts)
        )
          return deny();
        const policy = await readExperiencePolicy(batch.organization_id, tx);
        if (
          policy.schemaVersion !== 4 ||
          policy.adoptionMode !== 'supported_private' ||
          !policy.adoptionAuthorizedBy ||
          policy.frequency === 'off'
        ) {
          if (reassessment) return deny();
          return;
        }
        const pending = reassessment
          ? new Set<number>([reassessment.input.draftIndex])
          : batch.experience_adoption_plan?.status === 'awaiting_validation'
            ? new Set<number>(batch.experience_adoption_plan.pendingDrafts)
            : null;
        // A newly covered draft does not rewrite completed siblings' records.
        const plan: {
          draftIndex: number;
          memoryId?: string;
          reason?: string;
        }[] = pending
          ? batch.experience_adoption_plan.drafts.filter(
              (d: { draftIndex: number }) => !pending.has(d.draftIndex),
            )
          : [];
        let source;
        try {
          source = await readExperienceValidationSource(tx, row.id);
        } catch (e) {
          if (reassessment) throw e;
          if (!experienceUnavailable(e)) throw e;
          const reason = '来源或有效要求已变化，未采用。';
          await tx`update allrice_automation_runs set experience_adoption_plan=${tx.json(
            pending
              ? {
                  status: 'complete',
                  pendingDrafts: [],
                  drafts: [
                    ...plan,
                    ...[...pending].map((draftIndex) => ({
                      draftIndex,
                      reason,
                    })),
                  ],
                }
              : [{ reason }],
          )} where id=${row.id}`;
          return;
        }
        const { occurrence: o, receipt } = source;
        const requestDigest = reassessment
          ? runtimePolicyDigest({
              ...reassessment.input,
              recognizerVersion: REPORT_STYLE_RECOGNIZER_VERSION,
            })
          : null;
        if (reassessment) {
          const { who, input } = reassessment;
          const principal = await readContentPrincipal(who, tx, true);
          if (
            !principal?.writable ||
            who.actor.id !== o.ownerId ||
            who.organizationId !== o.organizationId ||
            who.workspaceId !== o.workspaceId ||
            receipt.outputDigest !== input.expectedOutputDigest
          )
            return deny();
          // The same row lock serializes concurrent and uncertain retries. A
          // saved result is historical; runtime reads still reauthorize it.
          const [previous] = await tx`select metadata from allrice_audit_events
            where action='experience.adoption.reassess' and resource_id=${o.id}
              and organization_id=${o.organizationId} and actor_id=${who.actor.id}
              and metadata->>'requestDigest'=${requestDigest}`;
          if (previous) {
            return ReportStyleReassessmentResultSchema.parse(
              previous.metadata.result,
            );
          }
          const oldPlan = batch.experience_adoption_plan;
          const entries = Array.isArray(oldPlan?.drafts)
            ? oldPlan.drafts.filter(
                (d: { draftIndex: number }) =>
                  d.draftIndex === input.draftIndex,
              )
            : [];
          const draft = receipt.output.drafts[input.draftIndex];
          if (
            !draft ||
            oldPlan?.status !== 'complete' ||
            runtimePolicyDigest(oldPlan) !== input.expectedPlanDigest ||
            entries.length !== 1 ||
            entries[0].memoryId ||
            entries[0].reason !== '尚无覆盖完整规则及依赖的验证，未采用。' ||
            supportedExperienceRule(draft)?.kind !== 'report_style'
          )
            return deny();
        }
        const pendingDrafts: number[] = [];
        for (const [draftIndex, draft] of receipt.output.drafts.entries()) {
          if (pending && !pending.has(draftIndex)) continue;
          const sources = o.sources.filter((s) =>
            draft.sourceIds.includes(s.id),
          );
          const rule = supportedExperienceRule(draft);
          if (
            !rule ||
            sources.some((s) => s.evidence.truncated) ||
            sources.length !== draft.sourceIds.length
          ) {
            plan.push({
              draftIndex,
              reason: '尚无覆盖完整规则及依赖的验证，未采用。',
            });
            continue;
          }
          const sourceKey = runtimePolicyDigest(rule);
          const [known] =
            await tx`select memory_id from allrice_experience_reviews where organization_id=${o.organizationId}
            and workspace_id=${o.workspaceId} and owner_id=${o.ownerId} and instance_id=${o.instanceId}
            and origin_kind='derived' and source_key=${sourceKey}`;
          if (known) {
            plan.push({
              draftIndex,
              reason: '同类经验已有记录或已撤回，不重复采用。',
            });
            continue;
          }
          let validation: ExperienceAdoptionProof['validation'] | null = null;
          try {
            await readExperienceValidationSource(tx, row.id, draftIndex);
            if (rule.kind === 'attendance_groups')
              validation = await readPassedExperienceProof(
                tx,
                source,
                draftIndex,
              );
            else if (
              sources.every((s) => s.evidence.skills.length === 0) &&
              !o.currentRules.profile.expressionStyle &&
              !o.currentRules.profile.workStyle &&
              !o.currentRules.sources.some((s) => s.body) &&
              sources.every(
                (s) =>
                  classifyExperienceFeedback(s.excerpt) === 'explicit_feedback',
              ) &&
              supportsDirectReportPreference(
                rule.style,
                sources.map((s) => s.excerpt),
              )
            ) {
              validation = {
                kind: 'direct_preference',
                evaluator: 'report-style-v1',
                evidenceDigest: runtimePolicyDigest(sources),
              };
            }
          } catch (e) {
            if (!experienceUnavailable(e)) throw e;
            plan.push({
              draftIndex,
              reason: '此草稿的来源或技能依赖已失效，未采用。',
            });
            continue;
          }
          if (!validation) {
            if (rule.kind === 'attendance_groups') {
              const [test] =
                await tx`select status from allrice_platform_employee_test_runs where purpose='experience_validation'
                and experience_binding->>'occurrenceId'=${o.id} and experience_binding->>'draftIndex'=${String(draftIndex)}`;
              if (!test || ['queued', 'running'].includes(test.status))
                pendingDrafts.push(draftIndex);
            }
            plan.push({
              draftIndex,
              reason: '未取得当前有效的独立验证或明确表达反馈，未采用。',
            });
            continue;
          }
          // Serializes batches for the same private instance, including tombstones.
          await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-adoption:${o.instanceId}`},183))`;
          const [existing] =
            await tx`select memory_id from allrice_experience_reviews where organization_id=${o.organizationId}
            and workspace_id=${o.workspaceId} and owner_id=${o.ownerId} and instance_id=${o.instanceId}
            and origin_kind='derived' and source_key=${sourceKey}`;
          if (existing) {
            plan.push({
              draftIndex,
              reason: '同类经验已有记录或已撤回，不重复采用。',
            });
            continue;
          }
          const id = randomUUID(),
            content = contentFor(draft),
            now = new Date().toISOString();
          const proof = ExperienceAdoptionProofSchema.parse({
            schemaVersion: 1,
            occurrenceId: o.id,
            draftIndex,
            instanceId: o.instanceId,
            sourceIds: draft.sourceIds,
            outputDigest: receipt.outputDigest,
            draftDigest: runtimePolicyDigest(draft),
            sourceDigest: runtimePolicyDigest(o.sources),
            rule,
            ...(rule.kind === 'report_style'
              ? { recognizerVersion: REPORT_STYLE_RECOGNIZER_VERSION }
              : {}),
            validation,
            authority: {
              kind: 'platform_automatic_experience_policy',
              revision: policy.revision,
              digest: runtimePolicyDigest(policy),
              authorizedBy: policy.adoptionAuthorizedBy,
            },
            contentDigest: hash(content),
            adoptedAt: now,
          });
          const memoryClass =
            rule.kind === 'report_style' ? 'user_preference' : 'work_note';
          const source0 = sources[0]!;
          await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,instance_id,content,
            visibility,source_type,source_id,lifecycle_state,memory_class,revision,trust_level,confidence,source_label)
            values(${id},${o.organizationId},${o.workspaceId},${o.ownerId},${o.employeeId},${o.instanceId},${content},
              'private','message',${source0.messageId},'durable',${memoryClass},1,'derived',0.7,'私人经验 · 自动验证后采用')`;
          await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
            values(${o.organizationId},${o.workspaceId},${id},1,${content},'derived','durable',${memoryClass},0.7,'平台策略自动采用；非人工审核',${policy.adoptionAuthorizedBy})`;
          await tx`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,
            run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged,status,
            reviewed_at,review_reason,origin_kind,instance_id,source_key,adoption_proof)
            values(${id},${o.organizationId},${o.workspaceId},${o.ownerId},${randomUUID()},${runtimePolicyDigest(proof)},
              ${source0.runId},${source0.sessionId},${source0.messageId},${source0.excerpt},${source0.sourceDigest},${proof.contentDigest},'private',false,'approved',
              ${now},'平台策略自动采用；非人工审核','derived',${o.instanceId},${sourceKey},${tx.json(proof)})`;
          const projection = buildExperienceProjection(
            {
              id,
              revision: 1,
              instanceId: o.instanceId,
              contentDigest: proof.contentDigest,
              adoptionDigest: runtimePolicyDigest(proof),
            },
            proof,
            draft,
          );
          await tx`insert into allrice_rag_chunks(organization_id,workspace_id,memory_id,owner_id,content,embedding,visibility,experience_projection)
            values(${o.organizationId},${o.workspaceId},${id},${o.ownerId},${content},${`[${embedWorkspaceText(content).join(',')}]`}::vector,'private',${tx.json(projection)})`;
          await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
            values(${o.organizationId},${o.workspaceId},${policy.adoptionAuthorizedBy},'experience.auto_adopt','memory',${id},'allowed','platform_automatic_experience_policy',${o.id})`;
          plan.push({ draftIndex, memoryId: id });
        }
        const nextPlan = {
          status: pendingDrafts.length ? 'awaiting_validation' : 'complete',
          pendingDrafts,
          drafts: plan,
        };
        let decisionResult:
          z.infer<typeof ReportStyleReassessmentResultSchema> | undefined;
        if (reassessment) {
          const decision = plan.find(
            (d) => d.draftIndex === reassessment.input.draftIndex,
          )!;
          decisionResult = ReportStyleReassessmentResultSchema.parse({
            auditId: randomUUID(),
            occurrenceId: o.id,
            draftIndex: reassessment.input.draftIndex,
            recognizerVersion: REPORT_STYLE_RECOGNIZER_VERSION,
            decision: decision.memoryId ? 'adopted' : 'not_adopted',
            memoryId: decision.memoryId ?? null,
            reason: decision.reason ?? null,
          });
          await tx`insert into allrice_audit_events(id,organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
            values(${decisionResult.auditId},${o.organizationId},${o.workspaceId},${reassessment.who.actor.id},'experience.adoption.reassess','experience_occurrence',${o.id},'recorded','explicit_report_grammar_continuation',${o.id},${tx.json(
              {
                requestDigest,
                input: reassessment.input,
                recognizerVersion: REPORT_STYLE_RECOGNIZER_VERSION,
                previousDecision: batch.experience_adoption_plan,
                nextDecision: nextPlan,
                sourceDigest: runtimePolicyDigest(o.sources),
                outputDigest: receipt.outputDigest,
                draftDigest: runtimePolicyDigest(
                  receipt.output.drafts[reassessment.input.draftIndex],
                ),
                result: decisionResult,
              },
            )})`;
        }
        await tx`update allrice_automation_runs set experience_adoption_plan=${tx.json(nextPlan)} where id=${row.id}`;
        return decisionResult;
      });
      if (committedResult) result = committedResult;
    } catch (e) {
      // A targeted request must report a rolled-back transaction as failure.
      // Only the background tick may skip a contended batch until its next tick.
      if (reassessment) throw e;
      if (
        e instanceof Error &&
        'code' in e &&
        ['55P03', '57014'].includes(String(e.code))
      )
        continue;
      throw e;
    }
  }
  return result;
}

/** Common authorization for dispatch, native history, explicit tool reads and
 * queued snapshots. A passed model answer alone never grants access. */
export async function readPrivateExperience(
  sql: Sql,
  who: ContentIdentity,
  id: string,
  lock = true,
) {
  if (
    !experienceReviewEnabled() ||
    who.actor.type !== 'user' ||
    !who.workspaceId
  )
    return deny();
  const [row] =
    await sql`select m.*,e.adoption_proof from allrice_memories m join allrice_experience_reviews e on e.memory_id=m.id
    where m.id=${id} and m.organization_id=${who.organizationId} and m.workspace_id=${who.workspaceId} and m.owner_id=${who.actor.id}
      and m.archived_at is null and m.visibility='private' and m.lifecycle_state='durable' and m.trust_level='derived'
      and e.organization_id=m.organization_id and e.workspace_id=m.workspace_id and e.owner_id=m.owner_id
      and e.instance_id=m.instance_id and e.origin_kind='derived' and e.status='approved'`;
  if (!row) return deny();
  const proof = ExperienceAdoptionProofSchema.parse(row.adoption_proof);
  if (
    proof.instanceId !== row.instance_id ||
    proof.contentDigest !== hash(row.content)
  )
    return deny();
  const source = await readExperienceValidationSource(
    sql as Tx,
    proof.occurrenceId,
    proof.draftIndex,
    lock,
  );
  const { occurrence: o, receipt } = source,
    draft = receipt.output.drafts[proof.draftIndex];
  if (
    !draft ||
    o.ownerId !== who.actor.id ||
    o.organizationId !== who.organizationId ||
    o.workspaceId !== who.workspaceId ||
    o.instanceId !== proof.instanceId ||
    receipt.outputDigest !== proof.outputDigest ||
    runtimePolicyDigest(draft) !== proof.draftDigest ||
    runtimePolicyDigest(o.sources) !== proof.sourceDigest ||
    runtimePolicyDigest(draft.sourceIds) !==
      runtimePolicyDigest(proof.sourceIds) ||
    runtimePolicyDigest(supportedExperienceRule(draft)) !==
      runtimePolicyDigest(proof.rule) ||
    contentFor(draft) !== row.content
  )
    return deny();
  if (proof.validation.kind === 'independent_skill_case') {
    await assertExperienceSkillsCurrent(
      sql,
      who,
      proof.validation.dependencies,
    );
    const checked = await readPassedExperienceProof(
      sql as Tx,
      source,
      proof.draftIndex,
    );
    if (
      !checked ||
      runtimePolicyDigest(checked) !== runtimePolicyDigest(proof.validation)
    )
      return deny();
  }
  const pin: ExperienceReadPin = {
    id,
    revision: row.revision,
    instanceId: proof.instanceId,
    contentDigest: proof.contentDigest,
    adoptionDigest: runtimePolicyDigest(proof),
  };
  return { row, proof, source, pin };
}

export async function assertExperienceReadPins(
  who: ContentIdentity,
  raw: unknown,
  sql: Sql,
) {
  for (const pin of ExperienceReadPinsSchema.parse(raw ?? [])) {
    const current = await readPrivateExperience(sql, who, pin.id);
    if (runtimePolicyDigest(current.pin) !== runtimePolicyDigest(pin))
      return deny();
  }
}

export async function listExperienceAdoptionViews(
  tx: Tx,
  who: ContentIdentity,
  occurrenceId: string,
) {
  const rows =
    await tx`select m.id,m.revision,m.archived_at,m.recall_count,e.adoption_proof from allrice_memories m
    join allrice_experience_reviews e on e.memory_id=m.id where e.origin_kind='derived'
      and e.organization_id=${who.organizationId} and e.workspace_id=${who.workspaceId!} and e.owner_id=${who.actor.id}
      and e.adoption_proof->>'occurrenceId'=${occurrenceId} order by e.created_at,m.id limit 8`;
  const result = [];
  for (const row of rows) {
    const p = ExperienceAdoptionProofSchema.parse(row.adoption_proof);
    let state: 'forgotten' | 'active' | 'unavailable' = row.archived_at
      ? 'forgotten'
      : 'active';
    if (state === 'active') {
      try {
        await readPrivateExperience(tx, who, row.id, false);
      } catch (e) {
        if (!experienceUnavailable(e)) throw e;
        state = 'unavailable';
      }
    }
    result.push(
      ExperienceAdoptionViewSchema.parse({
        memoryId: row.id,
        draftIndex: p.draftIndex,
        revision: row.revision,
        state,
        reason:
          state === 'unavailable' ? '来源或有效要求已变化，暂不采用。' : null,
        adoptedAt: p.adoptedAt,
        recallCount: row.recall_count,
      }),
    );
  }
  return result;
}
