/** Synthetic pre-retirement records for reader/retirement regressions only.
 * Never calls a retired producer or enables one behind a test switch. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  EmployeeInstanceSnapshotSchema,
  ExperienceEvidenceSchema,
  ExperienceAdoptionProofSchema,
  PlatformEmployeeDefinitionSchema,
  experiencePolicySchedule,
  experienceRosterCase,
  evaluateExperienceRoster,
  type ExperienceDraftOutput,
} from '@allrice/contracts';
import { loadedExperienceSkillEvidence } from './experience-evidence.ts';
import { readExperiencePolicy } from './experience-consolidation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  resolveEmployeeSessionInstance,
  readEmployeeVersionPublication,
} from './employees/employee-instances.ts';
import { freezeEmployeeRuntimeContent } from './employees/employee-content.ts';
import { freezeEmployeeBaseSkills } from './employees/employee-base-skills.ts';
import { freezeExperienceModelSnapshot } from './providers/model-pool.ts';
import { freezeExperienceSkills } from './experience-skill-dependencies.ts';
import {
  ExperienceOccurrenceSchema,
  ExperienceExecutionSchema,
  ExperienceReceiptSchema,
} from './experience-consolidation-contracts.ts';
import { buildExperienceProjection } from './experience-projection.ts';
import { embedWorkspaceText } from './workspace/memory-recall.ts';
import { attendanceAnswer } from './experience-validation.fixture.ts';

type Sql = ReturnType<typeof postgres>;
const hash = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const checked = new WeakSet<Sql>();
async function isolated(db: Sql) {
  if (checked.has(db)) return;
  const [row] =
    await db`select current_database() name,current_schema() schema`;
  assert.notEqual(row!.name, 'allrice_dev');
  assert.match(row!.schema, /^(experience_|p20_experience_|p25_)/);
  checked.add(db);
}

/** The caller explicitly supplies a synthetic completed Run, not a scan. */
export async function seedHistoricalExperienceSource(db: Sql, runId: string) {
  await isolated(db);
  const [r] = await db`select er.*,m.content->>'text' text,a.employee_id
    from allrice_employee_runs er join allrice_messages m on m.id=er.user_message_id
    join allrice_employee_assignments a on a.id=er.employee_assignment_id where er.run_id=${runId}`;
  assert.ok(r);
  const instance = EmployeeInstanceSnapshotSchema.parse(
    r.execution_snapshot.instance,
  );
  const policy = await readExperiencePolicy(r.organization_id, db, false);
  const events = await db<
    { id: string; event_type: string; payload: unknown }[]
  >`select id,event_type,payload from allrice_run_events where run_id=${runId} order by sequence`;
  const evidence = ExperienceEvidenceSchema.parse({
    schemaVersion: 1,
    policyRevision: policy.revision,
    collectionStartedAt: policy.collectionStartedAt,
    capturedAt: new Date().toISOString(),
    kind: 'explicit_feedback',
    messageId: r.user_message_id,
    runId,
    relatedRunId: null,
    skills: loadedExperienceSkillEvidence(
      { run_id: runId, execution_snapshot: r.execution_snapshot },
      events,
    ),
    artifacts: [],
    inputs: [],
    availableKnowledge: [],
    truncated: false,
  });
  const id = randomUUID(),
    content = r.text.trim(),
    sourceKey = hash(
      [
        r.organization_id,
        r.workspace_id,
        r.owner_id,
        instance.id,
        r.user_message_id,
      ].join(':'),
    );
  await db`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,instance_id,content,
    visibility,source_type,source_id,lifecycle_state,memory_class,revision,trust_level,confidence,source_label)
    values(${id},${r.organization_id},${r.workspace_id},${r.owner_id},${r.employee_id},${instance.id},${content},
      'private','message',${r.user_message_id},'candidate','work_note',1,'derived',0.5,'Synthetic historical feedback')`;
  await db`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
    values(${r.organization_id},${r.workspace_id},${id},1,${content},'derived','candidate','work_note',0.5,'Synthetic historical fixture',${r.owner_id})`;
  await db`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,
    run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged,origin_kind,instance_id,source_key,evidence)
    values(${id},${r.organization_id},${r.workspace_id},${r.owner_id},${randomUUID()},${sourceKey},${runId},${r.session_id},${r.user_message_id},
      ${r.text},${hash(r.text)},${hash(content)},'private',false,'incremental',${instance.id},${sourceKey},${db.json(evidence)})`;
  await db`update allrice_employee_runs set experience_capture_state='captured',experience_capture_reason='direct_feedback',experience_captured_at=clock_timestamp() where run_id=${runId}`;
  return id;
}

export async function seedHistoricalExperienceRule(
  db: Sql,
  sourceRunId: string,
) {
  await isolated(db);
  const [r] =
    await db`select * from allrice_employee_runs where run_id=${sourceRunId}`;
  const instance = EmployeeInstanceSnapshotSchema.parse(
    r!.execution_snapshot.instance,
  );
  const policy = await readExperiencePolicy(r!.organization_id, db, false);
  const [existing] =
    await db`select * from allrice_automations where owner_id=${r!.owner_id} and experience_binding->>'instanceId'=${instance.id} and deleted_at is null`;
  if (existing) return existing;
  const [rule] =
    await db`insert into allrice_automations(organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,
    conversation_mode,employee_assignment_id,next_run_at,experience_binding)
    values(${r!.organization_id},${r!.workspace_id},${r!.owner_id},'Synthetic historical experience','Historical fixture','schedule',
      ${db.json(experiencePolicySchedule(policy))},'enabled','new_each_run',${instance.assignmentId},clock_timestamp(),
      ${db.json({ schemaVersion: 1, instanceId: instance.id, policyDigest: runtimePolicyDigest(policy) })}) returning *`;
  return rule!;
}

/** A completed occurrence already existed before M5-A. No new execution birth. */
export async function seedHistoricalExperienceOccurrence(
  db: Sql,
  sourceRunId: string,
  automationId: string,
) {
  await isolated(db);
  return db.begin(async (tx) => {
    const [r] = await tx`select er.*,a.employee_id from allrice_employee_runs er
      join allrice_employee_assignments a on a.id=er.employee_assignment_id where er.run_id=${sourceRunId}`;
    const snapshot = EmployeeInstanceSnapshotSchema.parse(
      r!.execution_snapshot.instance,
    );
    const who = {
      organizationId: r!.organization_id as string,
      workspaceId: r!.workspace_id as string,
      actor: { type: 'user' as const, id: r!.owner_id as string },
    };
    const instance = await resolveEmployeeSessionInstance(
      who,
      snapshot.assignmentId,
      snapshot.id,
      tx,
    );
    const stable = { ...instance };
    delete (stable as Partial<typeof stable>).createdAt;
    delete (stable as Partial<typeof stable>).updatedAt;
    delete (stable as Partial<typeof stable>).archivedAt;
    const index = await freezeEmployeeRuntimeContent(
      who,
      {
        instanceId: instance.id,
        employeeId: r!.employee_id,
        employeeVersionId: instance.source.employeeVersionId,
      },
      tx,
    );
    const publication = await readEmployeeVersionPublication(
      {
        ...who,
        employeeId: r!.employee_id,
        versionId: instance.source.employeeVersionId,
      },
      tx,
    );
    const definition = publication
      ? PlatformEmployeeDefinitionSchema.parse(publication.definition)
      : null;
    // These fixtures deliberately have no personal/company rule bodies.
    assert.ok(
      index.layers.every((layer) =>
        [
          ...layer.common,
          ...(layer.scenes ?? []).flatMap((s) => s.references),
        ].every(
          (ref) =>
            !['requirement', 'procedure', 'company_rule'].includes(
              ref.sourceKind,
            ),
        ),
      ),
    );
    const rows =
      await tx`select * from allrice_experience_reviews where run_id=${sourceRunId} and origin_kind='incremental'`;
    const policy = await readExperiencePolicy(who.organizationId, tx, false);
    const occurrence = ExperienceOccurrenceSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      organizationId: who.organizationId,
      workspaceId: who.workspaceId,
      ownerId: who.actor.id,
      assignmentId: instance.assignmentId,
      instanceId: instance.id,
      employeeId: r!.employee_id,
      employeeVersionId: instance.source.employeeVersionId,
      instanceDigest: runtimePolicyDigest(stable),
      currentRules: {
        profile: instance.profile,
        index,
        platformRequirements: definition
          ? [
              ...definition.identity.behaviorRules,
              ...definition.identity.safetyBoundaries,
            ]
          : [],
        sources: [],
      },
      policy,
      policyDigest: runtimePolicyDigest(policy),
      createdAt: new Date().toISOString(),
      sources: rows.map((s) => ({
        id: s.memory_id,
        runId: s.run_id,
        sessionId: s.session_id,
        messageId: s.message_id,
        excerpt: s.source_excerpt,
        sourceDigest: s.source_digest,
        evidence: s.evidence,
      })),
    });
    const base = await freezeEmployeeBaseSkills([]);
    const nativeSkills = base.nativeSkills.filter(
      (s) => s.name === 'experience-consolidation',
    );
    const skills = base.catalog!.skills.filter(
      (s) => s.id === nativeSkills[0]!.id,
    );
    const execution = ExperienceExecutionSchema.parse({
      schemaVersion: 1,
      occurrenceDigest: runtimePolicyDigest(occurrence),
      model: await freezeExperienceModelSnapshot(
        { ...occurrence, occurrenceId: occurrence.id },
        tx,
      ),
      nativeSkills,
      catalog: {
        ...base.catalog,
        skills,
        snapshotChecksum: runtimePolicyDigest({ skills, nativeSkills }),
      },
    });
    const runId = randomUUID();
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${runId},${who.organizationId},${who.workspaceId},${who.actor.id},'succeeded','{}','{}')`;
    const [row] =
      await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,status,
      run_id,experience_occurrence,experience_execution,completed_at)
      values(${occurrence.id},${who.organizationId},${who.workspaceId},${automationId},clock_timestamp(),'succeeded',${runId},
        ${tx.json(occurrence)},${tx.json(execution)},clock_timestamp()) returning *`;
    await tx`update allrice_experience_reviews set consolidation_occurrence_id=${occurrence.id} where memory_id in ${tx(occurrence.sources.map((s) => s.id))}`;
    return { row: row!, frozen: { occurrence, execution } };
  });
}

export async function seedHistoricalExperienceReceipt(
  db: Sql,
  occurrenceId: string,
  output: ExperienceDraftOutput,
) {
  await isolated(db);
  const [row] =
    await db`select * from allrice_automation_runs where id=${occurrenceId}`;
  const receipt = ExperienceReceiptSchema.parse({
    schemaVersion: 1,
    state: 'pending_validation',
    occurrenceDigest: runtimePolicyDigest(row!.experience_occurrence),
    executionDigest: runtimePolicyDigest(row!.experience_execution),
    runId: row!.run_id,
    output,
    revision: 1,
    outputDigest: runtimePolicyDigest(output),
    skillLoadEventId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  await db`update allrice_automation_runs set experience_receipt=${db.json(receipt)} where id=${occurrenceId}`;
  return receipt;
}

export async function seedHistoricalExperienceValidation(
  db: Sql,
  occurrenceId: string,
  status: 'queued' | 'running' | 'succeeded' = 'succeeded',
) {
  await isolated(db);
  return db.begin(async (tx) => {
    const [row] =
      await tx`select * from allrice_automation_runs where id=${occurrenceId}`;
    const o = ExperienceOccurrenceSchema.parse(row!.experience_occurrence),
      receipt = ExperienceReceiptSchema.parse(row!.experience_receipt);
    const draft = receipt.output.drafts[0]!,
      testId = randomUUID(),
      validationRun = randomUUID();
    const skills = await freezeExperienceSkills(
      tx,
      {
        organizationId: o.organizationId,
        workspaceId: o.workspaceId,
        actor: { type: 'user', id: o.ownerId },
      },
      o.instanceId,
      o.sources,
    );
    const model = await freezeExperienceModelSnapshot(
      { ...o, occurrenceId: testId },
      tx,
    );
    const binding = {
      schemaVersion: skills ? 2 : 1,
      ...skills,
      id: testId,
      occurrenceId: o.id,
      organizationId: o.organizationId,
      workspaceId: o.workspaceId,
      ownerId: o.ownerId,
      employeeId: o.employeeId,
      assignmentId: o.assignmentId,
      instanceId: o.instanceId,
      employeeVersionId: o.employeeVersionId,
      draftIndex: 0,
      outputDigest: receipt.outputDigest,
      draftDigest: runtimePolicyDigest(draft),
      sourceDigest: runtimePolicyDigest(o.sources),
      policyDigest: o.policyDigest,
      caseId: experienceRosterCase.id,
      caseDigest: runtimePolicyDigest(experienceRosterCase),
      model,
      timeoutMs: model.runLimits.timeoutMs,
    };
    const skillValidation = skills
      ? {
          snapshotChecksum: skills.personalSkills.checksum,
          loadedPinsChecksum: runtimePolicyDigest(skills.personalSkills.skills),
          loadedVersionIds: skills.personalSkills.skills.map(
            (p) => p.versionId,
          ),
        }
      : undefined;
    const assertion = {
      ...evaluateExperienceRoster(JSON.stringify(attendanceAnswer), false),
      ...(skillValidation ? { skillValidation } : {}),
    };
    assert.equal(assertion.passed, true);
    const [base] =
      await tx`select r.* from allrice_employee_version_sources s join allrice_platform_employee_revisions r
      on r.id=s.platform_revision_id where s.employee_version_id=${o.employeeVersionId}`;
    assert.ok(base);
    if (status !== 'queued') {
      await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${validationRun},${o.organizationId},${o.workspaceId},${o.ownerId},${status === 'running' ? 'running' : 'succeeded'},'{}','{}')`;
    }
    await tx`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,
      frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,purpose,experience_binding,experience_assertion,experience_run_id,completed_at)
      values(${testId},${base.employee_id},${base.id},${o.ownerId},${status},${tx.json({ prompt: 'Synthetic historical validation', environment: 'platform', workspaceId: o.workspaceId, ownerId: o.ownerId })},
        ${tx.json(base.runtime_profile)},${tx.json(base.definition)},${tx.json(base.runtime_profile.runtimePackage.skills)},${base.runtime_profile.runtimePackage.checksum},
        'experience_validation',${tx.json(binding)},${status === 'succeeded' ? tx.json(assertion) : null},${status === 'queued' ? null : validationRun},${status === 'succeeded' ? new Date() : null})`;
    if (status === 'running')
      await tx`update allrice_platform_employee_test_runs set started_at=clock_timestamp(),timeout_at=clock_timestamp()+interval '5 minutes',worker_id=${randomUUID()} where id=${testId}`;
    return { testId, validationRun, skills, skillValidation, binding };
  });
}

export async function seedHistoricalExperienceAdoption(
  db: Sql,
  occurrenceId: string,
  authorizedBy: string,
  style?: 'structured' | 'concise',
) {
  await isolated(db);
  const historicalValidation = style
    ? undefined
    : await seedHistoricalExperienceValidation(db, occurrenceId);
  return db.begin(async (tx) => {
    const [row] =
      await tx`select * from allrice_automation_runs where id=${occurrenceId}`;
    const o = ExperienceOccurrenceSchema.parse(row!.experience_occurrence),
      receipt = ExperienceReceiptSchema.parse(row!.experience_receipt);
    const draft = receipt.output.drafts[0]!;
    const { testId, skills, skillValidation } = historicalValidation ?? {
      testId: randomUUID(),
      skills: undefined,
      skillValidation: undefined,
    };
    const content = `${draft.rule}\n适用范围：${draft.applicability}`,
      id = randomUUID(),
      now = new Date().toISOString(),
      rule = style
        ? { kind: 'report_style' as const, version: 1 as const, style }
        : { kind: 'attendance_groups' as const, version: 1 as const };
    const proof = ExperienceAdoptionProofSchema.parse({
      schemaVersion: 1,
      occurrenceId: o.id,
      draftIndex: 0,
      instanceId: o.instanceId,
      sourceIds: draft.sourceIds,
      outputDigest: receipt.outputDigest,
      draftDigest: runtimePolicyDigest(draft),
      sourceDigest: runtimePolicyDigest(o.sources),
      rule,
      ...(style ? { recognizerVersion: 'report-style-clauses-v2' } : {}),
      validation: style
        ? {
            kind: 'direct_preference',
            evaluator: 'report-style-v1',
            evidenceDigest: runtimePolicyDigest(o.sources),
          }
        : {
            kind: skills ? 'independent_skill_case' : 'independent_case',
            testId,
            caseId: experienceRosterCase.id,
            caseDigest: runtimePolicyDigest(experienceRosterCase),
            ...(skills
              ? { dependencies: skills.personalSkills, skillValidation }
              : {}),
          },
      authority: {
        kind: 'platform_automatic_experience_policy',
        revision: o.policy.revision,
        digest: o.policyDigest,
        authorizedBy,
      },
      contentDigest: hash(content),
      adoptedAt: now,
    });
    const source = o.sources[0]!;
    await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,employee_id,instance_id,content,
      visibility,source_type,source_id,lifecycle_state,memory_class,revision,trust_level,confidence,source_label)
      values(${id},${o.organizationId},${o.workspaceId},${o.ownerId},${o.employeeId},${o.instanceId},${content},
        'private','message',${source.messageId},'durable',${style ? 'user_preference' : 'work_note'},1,'derived',0.7,'Synthetic historical adoption')`;
    await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
      values(${o.organizationId},${o.workspaceId},${id},1,${content},'derived','durable',${style ? 'user_preference' : 'work_note'},0.7,'Synthetic historical adoption',${authorizedBy})`;
    await tx`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,
      run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged,status,reviewed_at,review_reason,origin_kind,instance_id,source_key,adoption_proof)
      values(${id},${o.organizationId},${o.workspaceId},${o.ownerId},${randomUUID()},${runtimePolicyDigest(proof)},${source.runId},${source.sessionId},${source.messageId},
        ${source.excerpt},${source.sourceDigest},${proof.contentDigest},'private',false,'approved',${now},'Synthetic historical fixture','derived',${o.instanceId},${runtimePolicyDigest(rule)},${tx.json(proof)})`;
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
    await tx`update allrice_automation_runs set experience_validation_plan=${tx.json(style ? [] : [{ draftIndex: 0, testId }])},
      experience_adoption_plan=${tx.json({ status: 'complete', pendingDrafts: [], drafts: [{ draftIndex: 0, memoryId: id }] })} where id=${o.id}`;
    const [memory] =
      await tx`select m.*,e.adoption_proof,e.reviewed_by from allrice_memories m join allrice_experience_reviews e on e.memory_id=m.id where m.id=${id}`;
    return { memory: memory!, validationId: testId };
  });
}
