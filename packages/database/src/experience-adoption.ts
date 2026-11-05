import { createHash } from 'node:crypto';
import { z } from 'zod';
import type postgres from 'postgres';
import {
  ExperienceAdoptionProofSchema,
  ExperienceReadPinsSchema,
  ExperienceAdoptionViewSchema,
  supportedExperienceRule,
  REPORT_STYLE_RECOGNIZER_VERSION,
  type ExperienceReadPin,
  UuidSchema,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { type ContentIdentity } from './content-maintenance.ts';
import { readExperienceValidationSource } from './experience-consolidation.ts';
import { readPassedExperienceProof } from './experience-validation.ts';
import { ExperienceError, experienceReviewEnabled } from './experience.ts';
import { DataAccessError } from './data.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';
import { PersonalSkillError } from './employees/personal-skills.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

import { assertExperienceSkillsCurrent } from './experience-skill-dependencies.ts';

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
/** Historical receipts and plans are read-only; no automatic adoption. */
export async function syncExperienceAdoptions() {}

/** The targeted old recognizer continuation is closed too. */
export async function reassessReportStyleAdoption(
  who: ContentIdentity,
  input: z.input<typeof ReportStyleReassessmentInputSchema>,
): Promise<z.infer<typeof ReportStyleReassessmentResultSchema>> {
  void who;
  void input;
  throw new ExperienceError('disabled');
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
