import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  EmployeeMethodTestStartSchema,
  EmployeeMethodTestInspectSchema,
  EmployeeMethodTestSchema,
  EmployeeMethodTestAssertionSchema,
  SessionModelSnapshotSchema,
  EmployeeInstanceSchema,
  PlatformEmployeeRuntimeProfileSchema,
  RouteDecisionSchema,
  UuidSchema,
  employeeMethodAmountCase,
  employeeMethodFileCase,
  EmployeeMethodFileAssertionSchema,
  runtimeContractEqual,
  type ExecutionContext,
  employeeMethodTestEnvironment,
  type RequestContext,
  type PlatformEmployeeTestRunOutput,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { acquireDevAdmission } from '../dev-maintenance.ts';
import { employeeAccessTransaction } from './employee-access-cancellation.ts';
import {
  getEmployeeInstance,
  EmployeeInstanceError,
} from './employee-instances.ts';
import { freezeEmployeeMethodCandidate } from './employee-content.ts';
import { EmployeeContentError } from './employee-content-model.ts';
import {
  enterMethodChat,
  EmployeeMethodChatError,
  explicitEmployeeMethodTestIntent,
  explicitEmployeeMethodTestRetryIntent,
} from './employee-method-chat.ts';
import {
  assertEmployeeChatExecution,
  employeeChatIdentity,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';
import { validatePlatformEmployeeTestExecutionSnapshot } from '../platform-employees/runtime-package.ts';
import {
  admitModelExecutionInTransaction,
  assertProviderAvailable,
  getProviderGovernance,
  ModelGovernanceError,
} from '../providers/model-governance.ts';
import {
  recordRouteDecisionInTransaction,
  completeRouteDecisionInTransaction,
} from '../execution/route-decision.ts';

import {
  freezeMethodFileEnvironment,
  currentMethodFileGrant,
} from './employee-method-file-runtime.ts';

type Tx = postgres.TransactionSql;
type Identity = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId' | 'requestId'
>;
type Candidate = Awaited<ReturnType<typeof freezeEmployeeMethodCandidate>>;
export type EmployeeMethodTestBinding = {
  case_id: string;
  environment: string;
  test_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_id: string;
  instance_id: string;
  set_id: string;
  candidate_revision_id: string;
  candidate_digest: string;
  dependency_digest: string;
  scene_id: string;
  request_digest: string;
  binding_digest: string;
  retry_of_test_id: string | null;
  source_run_id: string;
  source_session_id: string;
  employee_version_id: string;
  model_snapshot: unknown;
  candidate_snapshot: {
    content: Candidate;
    instance: ReturnType<typeof EmployeeInstanceSchema.parse>;
    timeoutMs: number;
    fileEnvironment?: Awaited<ReturnType<typeof freezeMethodFileEnvironment>>;
  };
  snapshot_digest: string;
  run_id: string | null;
  route_decision_id: string | null;
  assertion: unknown | null;
  created_at: Date;
};
type Binding = EmployeeMethodTestBinding;
const contextFor = (b: Binding): Identity => ({
  actor: { type: 'user', id: b.owner_id },
  organizationId: b.organization_id,
  workspaceId: b.workspace_id,
  requestId: b.test_id,
});
const inputFor = (b: Binding) => ({
  instanceId: b.instance_id,
  expectedRevision: b.candidate_snapshot.content.setRevision,
  candidateRevisionId: b.candidate_revision_id,
  candidateDigest: b.candidate_digest,
  sceneId: b.scene_id,
});

async function readBinding(tx: Tx, testId: string) {
  const [b] = await tx<
    Binding[]
  >`select * from allrice_employee_method_tests where test_id=${testId}`;
  if (!b) throw new DataAccessError('not_found');
  if (
    runtimePolicyDigest({
      candidate: b.candidate_snapshot,
      model: b.model_snapshot,
    }) !== b.snapshot_digest
  )
    throw new EmployeeContentError('source_changed');
  return b;
}

async function currentBinding(tx: Tx, b: Binding, admission = false) {
  const context = contextFor(b);
  if (b.case_id === employeeMethodFileCase.id) {
    try {
      if (
        !runtimeContractEqual(
          b.candidate_snapshot.fileEnvironment?.manifest,
          employeeMethodFileCase,
        )
      )
        throw new Error('case_changed');
      await currentMethodFileGrant(tx, b, false);
    } catch {
      throw new EmployeeContentError('source_changed');
    }
  }
  // Chat callers already hold SHARE before the content lock. A DTO must not
  // upgrade that lock while another chat waits for the same content lock.
  // The scheduler alone reserves policy allocation before taking content.
  const principal = await readContentPrincipal(
    context,
    tx,
    admission ? 'update_user' : true,
  );
  if (!principal?.writable) throw new DataAccessError('authorization_denied');
  await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${b.organization_id}`},0))`;
  const instance = await getEmployeeInstance(context, b.instance_id, tx);
  const old = EmployeeInstanceSchema.parse(b.candidate_snapshot.instance);
  if (
    instance.revision !== old.revision ||
    instance.source.employeeVersionId !== b.employee_version_id
  )
    throw new EmployeeContentError('source_changed');
  const current = await freezeEmployeeMethodCandidate(context, inputFor(b), tx);
  if (current.dependencyDigest !== b.dependency_digest)
    throw new EmployeeContentError('source_changed');
  return { instance, current };
}

async function dto(tx: Tx, context: Identity, testId: string) {
  const b = await readBinding(tx, testId);
  if (
    context.actor.type !== 'user' ||
    b.organization_id !== context.organizationId ||
    b.workspace_id !== context.workspaceId ||
    b.owner_id !== context.actor.id
  )
    throw new DataAccessError('not_found');
  await getEmployeeInstance(context, b.instance_id, tx);
  let applicable = true;
  try {
    await currentBinding(tx, b);
  } catch (error) {
    if (error instanceof EmployeeContentError) applicable = false;
    else throw error;
  }
  const [test] =
    await tx`select status,output,completed_at from allrice_platform_employee_test_runs where id=${b.test_id} and purpose='method_candidate'`;
  if (!test) throw new DataAccessError('not_found');
  const assertion = b.assertion
    ? EmployeeMethodTestAssertionSchema.parse(b.assertion)
    : null;
  const [retry] = await tx<{ test_id: string }[]>`
    select test_id from allrice_employee_method_tests
    where retry_of_test_id=${b.test_id} and organization_id=${b.organization_id}
      and workspace_id=${b.workspace_id} and owner_id=${b.owner_id}`;
  return EmployeeMethodTestSchema.parse({
    id: b.test_id,
    instanceId: b.instance_id,
    setId: b.set_id,
    candidateRevisionId: b.candidate_revision_id,
    candidateDigest: b.candidate_digest,
    dependencyDigest: b.dependency_digest,
    sceneId: b.scene_id,
    caseId: b.case_id,
    environment: b.environment,
    status: test.status,
    applicable,
    assertion,
    validationStatus: ['queued', 'running'].includes(test.status)
      ? 'pending'
      : assertion &&
          !assertion.passed &&
          assertion.reason !== 'execution_failed'
        ? 'failed'
        : test.status === 'failed'
          ? 'not_verified'
          : assertion?.passed
            ? 'passed'
            : 'failed',
    runId: b.run_id,
    createdAt: b.created_at.toISOString(),
    completedAt: test.completed_at?.toISOString() ?? null,
    errorCode: test.output?.error?.code ?? null,
    retryOfTestId: b.retry_of_test_id,
    retryTestId: retry?.test_id ?? null,
    files: await methodTestFiles(tx, b),
    currency: 'CNY',
    amountUnit: 'cent',
    coverage:
      b.case_id === employeeMethodFileCase.id
        ? employeeMethodFileCase.coverage
        : '仅验证所选场景在固定合成金额样例中的结果，不代表所有业务场景已验证。',
  });
}

export async function startEmployeeMethodTestFromChat(input: EmployeeChatCall) {
  const args = EmployeeMethodTestStartSchema.parse(input.arguments),
    { scope, requestId } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.employee.method.test',
    true,
    async (tx, instance, text) => {
      if (args.retryOfTestId) {
        if (!explicitEmployeeMethodTestRetryIntent(text, args.retryOfTestId))
          throw new EmployeeMethodChatError('explicit_test_retry_required');
      } else if (!explicitEmployeeMethodTestIntent(text))
        throw new EmployeeMethodChatError('explicit_method_request_required');
      await acquireDevAdmission(tx);
      const requestDigest = runtimePolicyDigest(args);
      const [replay] = await tx<
        Binding[]
      >`select * from allrice_employee_method_tests
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.actor.id} and request_id=${requestId}`;
      if (replay) {
        if (
          replay.request_digest !== requestDigest ||
          replay.instance_id !== instance.id
        )
          throw new EmployeeContentError('request_conflict');
        return dto(tx, scope, replay.test_id);
      }
      const { snapshot } = await assertEmployeeChatExecution(
        tx,
        input,
        instance,
        'workspace.employee.method.test',
      );
      if (snapshot.schemaVersion !== 2 || !snapshot.modelSnapshot)
        throw new DataAccessError('authorization_denied');
      let model = SessionModelSnapshotSchema.parse(snapshot.modelSnapshot);
      if (
        model.sessionId !== input.sessionId ||
        model.employeeId !== snapshot.employee.id ||
        model.harness !== 'dsh'
      )
        throw new DataAccessError('authorization_denied');
      let retry: Binding | null = null;
      if (args.retryOfTestId) {
        const parent = await dto(tx, scope, args.retryOfTestId);
        if (parent.instanceId !== instance.id)
          throw new DataAccessError('not_found');
        retry = await readBinding(tx, parent.id);
        if (
          args.expectedRevision !==
            retry.candidate_snapshot.content.setRevision ||
          args.candidateRevisionId !== retry.candidate_revision_id ||
          args.candidateDigest !== retry.candidate_digest ||
          args.sceneId !== retry.scene_id ||
          args.caseId !== retry.case_id
        )
          throw new EmployeeContentError('source_changed');
        if (
          parent.status !== 'failed' ||
          parent.validationStatus !== 'not_verified'
        )
          throw new EmployeeMethodChatError('test_retry_not_allowed');
        // Reconcile an uncertain or concurrent write before considering any
        // new paid execution. A later retry must name that child explicitly.
        if (parent.retryTestId) return dto(tx, scope, parent.retryTestId);
        await currentBinding(tx, retry);
        const originalModel = SessionModelSnapshotSchema.parse(
          retry.model_snapshot,
        );
        const comparableModel = (m: typeof model) =>
          runtimePolicyDigest({ ...m, sessionId: null, frozenAt: null });
        if (comparableModel(model) !== comparableModel(originalModel))
          throw new EmployeeMethodChatError('test_retry_model_changed');
        await assertEmployeeMethodModelCurrent(tx, retry, originalModel);
        model = originalModel;
      }
      const content =
        retry?.candidate_snapshot.content ??
        (await freezeEmployeeMethodCandidate(
          scope,
          { ...args, instanceId: instance.id },
          tx,
        ));
      if (
        content.employeeVersionId !==
        snapshot.instance!.source.employeeVersionId
      )
        throw new EmployeeContentError('source_changed');
      const [base] = retry
        ? await tx`select employee_id,revision_id id,frozen_runtime_profile runtime_profile,frozen_definition definition
          from allrice_platform_employee_test_runs where id=${retry.test_id} and purpose='method_candidate'`
        : await tx`select r.employee_id,r.id,r.runtime_profile,r.definition
      from allrice_employee_version_sources s join allrice_platform_employee_revisions r
        on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
      where s.employee_version_id=${content.employeeVersionId} and s.employee_id=${content.employeeId}
        and s.organization_id=${scope.organizationId} and s.workspace_id=${scope.workspaceId} and r.status='published' for share of r`;
      if (!base) throw new EmployeeContentError('source_changed');
      const profile = PlatformEmployeeRuntimeProfileSchema.parse(
        base.runtime_profile,
      );
      const frozen = validatePlatformEmployeeTestExecutionSnapshot({
        runtimeProfile: profile,
        definition: base.definition,
        nativeSkills: profile.runtimePackage?.skills,
        packageChecksum: profile.runtimePackage?.checksum ?? null,
      });
      const timeoutMs =
        retry?.candidate_snapshot.timeoutMs ??
        Math.min(model.runLimits.timeoutMs, 300_000);
      const candidate = retry?.candidate_snapshot ?? {
        content,
        instance,
        timeoutMs,
        ...(args.caseId === employeeMethodFileCase.id
          ? { fileEnvironment: await freezeMethodFileEnvironment(tx, scope) }
          : {}),
      };
      const bindingDigest =
        retry?.binding_digest ??
        runtimePolicyDigest({
          content,
          profileRevision: instance.revision,
          packageChecksum: profile.runtimePackage!.checksum,
          model: { ...model, sessionId: null, frozenAt: null },
          case: args.caseId,
          environment:
            candidate.fileEnvironment ?? employeeMethodTestEnvironment,
          timeoutMs,
        });
      // The existing content lock serializes starts. Read-only reuse never waits
      // on a scheduler's test row while holding principal/content locks.
      if (!retry) {
        const [same] = await tx<
          { test_id: string }[]
        >`select test_id from allrice_employee_method_tests
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.actor.id}
        and instance_id=${instance.id} and binding_digest=${bindingDigest} and retry_of_test_id is null`;
        if (same) return dto(tx, scope, same.test_id);
      }
      const id = randomUUID();
      await tx`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,
      frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,purpose)
      values(${id},${base.employee_id},${base.id},${scope.actor.id},'queued',${tx.json({ prompt: args.caseId === employeeMethodFileCase.id ? employeeMethodFileCase.prompt : employeeMethodAmountCase.prompt, environment: 'platform', workspaceId: scope.workspaceId, ownerId: scope.actor.id })},
        ${tx.json(frozen.runtimeProfile)},${tx.json(frozen.definition)},${tx.json(frozen.nativeSkills)},${profile.runtimePackage!.checksum},'method_candidate')`;
      await tx`insert into allrice_employee_method_tests(test_id,organization_id,workspace_id,owner_id,employee_id,instance_id,set_id,
      candidate_revision_id,candidate_digest,dependency_digest,scene_id,case_id,environment,request_id,request_digest,binding_digest,
      source_run_id,source_session_id,employee_version_id,model_snapshot,candidate_snapshot,snapshot_digest,retry_of_test_id)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.actor.id},${content.employeeId},${instance.id},${content.setId},
        ${content.candidateRevisionId},${content.candidateDigest},${content.dependencyDigest},${args.sceneId},${args.caseId},${args.caseId === employeeMethodFileCase.id ? employeeMethodFileCase.environment : employeeMethodTestEnvironment},${requestId},${requestDigest},${bindingDigest},
        ${input.context.runId},${input.sessionId},${content.employeeVersionId},${tx.json(model)},${tx.json(candidate)},${runtimePolicyDigest({ candidate, model })},${retry?.test_id ?? null})`;
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values(${scope.organizationId},${scope.workspaceId},${scope.actor.id},${retry ? 'employee.method.test.retried' : 'employee.method.test.queued'},'employee_method_test',${id},'allowed','isolated_fixed_case',${requestId})`;
      return dto(tx, scope, id);
    },
  );
}

export async function inspectEmployeeMethodTestFromChat(
  input: EmployeeChatCall,
) {
  const args = EmployeeMethodTestInspectSchema.parse(input.arguments),
    { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.employee.method.test_status',
    true,
    async (tx, instance) => {
      const result = await dto(tx, scope, args.testId);
      if (result.instanceId !== instance.id)
        throw new DataAccessError('not_found');
      return result;
    },
  );
}

/** Activation uses the original fixed assertion and current frozen authority;
 * a model's description of a successful test is never evidence. */
export async function readEmployeeMethodActivationTest(
  tx: Tx,
  context: Identity,
  instanceId: string,
  testId: string,
  modelInput: unknown,
) {
  const result = await dto(tx, context, testId);
  if (result.instanceId !== instanceId) throw new DataAccessError('not_found');
  if (
    !result.applicable ||
    result.status !== 'succeeded' ||
    result.validationStatus !== 'passed'
  )
    throw new EmployeeContentError('validation_required');
  const b = await readBinding(tx, testId);
  const model = SessionModelSnapshotSchema.parse(modelInput);
  const original = SessionModelSnapshotSchema.parse(b.model_snapshot);
  const comparable = (m: typeof model) =>
    runtimePolicyDigest({ ...m, sessionId: null, frozenAt: null });
  if (comparable(model) !== comparable(original))
    throw new EmployeeContentError('source_changed');
  await assertEmployeeMethodModelCurrent(tx, b, original);
  return {
    testId,
    sceneId: result.sceneId,
    caseId: result.caseId,
    snapshotDigest: b.snapshot_digest,
    candidateRevisionId: result.candidateRevisionId,
    candidateDigest: result.candidateDigest,
    dependencyDigest: result.dependencyDigest,
    assertion: result.assertion,
    coverage: result.coverage,
  };
}

export async function getEmployeeMethodTest(context: Identity, testId: string) {
  return employeeAccessTransaction(getDatabase(), (tx) =>
    dto(tx, context, UuidSchema.parse(testId)),
  );
}

/** Scheduler-only: no chat lease dependency after enqueue. Recheck current
 * ownership, frozen inputs and provider before granting a paid execution. */
export async function prepareEmployeeMethodTestClaim(tx: Tx, testId: string) {
  const b = await readBinding(tx, testId);
  await currentBinding(tx, b, true);
  if (b.case_id === employeeMethodFileCase.id) {
    try {
      await currentMethodFileGrant(tx, b);
      await freezeMethodFileEnvironment(tx, contextFor(b));
    } catch {
      throw new DataAccessError('authorization_denied');
    }
  }
  const model = SessionModelSnapshotSchema.parse(b.model_snapshot);
  await assertEmployeeMethodModelCurrent(tx, b, model);
  try {
    await admitModelExecutionInTransaction(
      {
        organizationId: b.organization_id,
        workspaceId: b.workspace_id,
        userId: b.owner_id,
        employeeId: b.employee_id,
        connectionId: model.connectionId,
        requestedTokens: model.runLimits.maxTotalTokens,
        requestedRuntimeMs: b.candidate_snapshot.timeoutMs,
      },
      tx,
    );
  } catch (error) {
    if (
      !(error instanceof ModelGovernanceError) ||
      error.code !== 'MODEL_RESOURCE_CONCURRENCY_EXCEEDED'
    )
      throw error;
    // No Run, Job, route or dispatch exists yet. Only this scheduler queue is
    // deferred; a running Job is never put back into the ordinary job queue.
    await tx`update allrice_platform_employee_test_runs set available_at=clock_timestamp()+interval '3 seconds' where id=${testId} and status='queued'`;
    return null;
  }
  const [principal] =
    await tx`select m.id membership_id,m.role,w.name workspace_name from allrice_memberships m
    join allrice_workspaces w on w.id=${b.workspace_id} and w.organization_id=m.organization_id and w.archived_at is null
    where m.user_id=${b.owner_id} and m.organization_id=${b.organization_id} and m.active
      and (m.workspace_id is null or m.workspace_id=w.id) order by m.id limit 1`;
  if (!principal) throw new DataAccessError('authorization_denied');
  const content = b.candidate_snapshot.content;
  const methodInstructions = content.sources
    .filter((s) =>
      ['requirement', 'procedure', 'company_rule'].includes(
        s.reference.sourceKind,
      ),
    )
    .map((s) => `${s.title ?? s.reference.sourceKind}\n${s.body ?? ''}`)
    .join('\n\n');
  return {
    binding: b,
    modelSnapshot: model,
    timeoutMs: b.candidate_snapshot.timeoutMs,
    instructions: `隔离的工作方法测试。仅针对所选候选场景应用下面的方法；它尚未启用。${b.case_id === employeeMethodFileCase.id ? '只可使用 platform_employee_method_step 处理平台合成文件。不得读取公司资料。工具仅在隔离云端执行 JavaScript，输入、输出、限额由平台固定。按候选实际顺序执行，不要替候选修正错误。' : '不要调用工具、读取公司文件或修改任何状态。'}\n场景：${content.scene.name}\n${methodInstructions}`,
    previewContext: {
      organization_id: b.organization_id,
      workspace_id: b.workspace_id,
      owner_id: b.owner_id,
      membership_id: principal.membership_id as string,
      role: principal.role as 'member' | 'admin',
      workspace_name: principal.workspace_name as string,
    },
  };
}

export async function assertEmployeeMethodModelCurrent(
  tx: Tx,
  b: Pick<Binding, 'organization_id'>,
  model: ReturnType<typeof SessionModelSnapshotSchema.parse>,
) {
  const [current] =
    await tx`select p.provider_key,p.auth_mode,c.credential_reference,c.base_url from allrice_model_connections c
    join allrice_model_providers p on p.id=c.provider_id
    join allrice_model_catalog_entries m on m.id=${model.modelCatalogEntryId} and m.provider_id=p.id and m.model=${model.model} and m.enabled
    where c.id=${model.connectionId} and c.status='ready' and (c.scope='platform' or c.organization_id=${b.organization_id})`;
  if (
    !current ||
    current.auth_mode !== model.authMode ||
    current.credential_reference !== model.credentialReference ||
    current.base_url !== model.baseUrl ||
    !(
      current.provider_key === model.provider ||
      (current.provider_key === 'codex' && model.provider === 'openai-codex')
    )
  )
    throw new DataAccessError('authorization_denied');
  assertProviderAvailable(await getProviderGovernance(model.connectionId, tx));
}

export async function recordEmployeeMethodTestExecution(
  tx: Tx,
  claim: NonNullable<
    Awaited<ReturnType<typeof prepareEmployeeMethodTestClaim>>
  >,
  runId: string,
) {
  const b = claim.binding,
    m = claim.modelSnapshot;
  const decision = await recordRouteDecisionInTransaction(
    RouteDecisionSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      runId,
      organizationId: b.organization_id,
      workspaceId: b.workspace_id,
      actorId: b.owner_id,
      employeeId: b.employee_id,
      inputChecksum: runtimePolicyDigest({
        candidate: b.snapshot_digest,
        case: b.case_id,
      }),
      candidates: [
        {
          id: b.case_id,
          kind: 'direct',
          name:
            b.case_id === employeeMethodFileCase.id
              ? '隔离文件流程样例'
              : '隔离金额样例',
          bindingId: null,
          requiredCapabilities: ['model:invoke'],
          risk: 'low',
          requiresApproval: false,
          authorized: true,
          exclusionReason: null,
          score: 100,
        },
      ],
      selectedKind: 'direct',
      selectedCandidateId: b.case_id,
      harness: m.harness,
      provider: m.provider,
      model: m.model,
      modelConnectionId: m.connectionId,
      modelCatalogEntryId: m.modelCatalogEntryId,
      modelPolicyRevision: m.policyRevision,
      generation: 0,
      attempt: 1,
      reasonCodes: ['matched_explicit_intent', 'minimum_necessary_capability'],
      createdAt: new Date().toISOString(),
    }),
    tx,
  );
  await tx`update allrice_employee_method_tests set run_id=${runId},route_decision_id=${decision.id} where test_id=${b.test_id} and run_id is null`;
  return {
    caseId: b.case_id,
    modelSnapshot: m,
    // A retry can be requested in a new chat. Subscription execution must use
    // the original frozen model session; the new source session stays in the
    // binding for audit and must not silently rewrite that model snapshot.
    sourceSessionId: m.sessionId,
    instructions: claim.instructions,
    timeoutMs: claim.timeoutMs,
    decision,
  };
}

export async function finishEmployeeMethodTestInTransaction(
  tx: Tx,
  testId: string,
  output: PlatformEmployeeTestRunOutput,
  status: 'succeeded' | 'failed' | 'canceled',
) {
  const [b] = await tx<
    Binding[]
  >`select * from allrice_employee_method_tests where test_id=${testId}`;
  if (!b) return;
  const assertion =
    b.case_id === employeeMethodFileCase.id
      ? EmployeeMethodFileAssertionSchema.parse(
          b.assertion ?? {
            id: 'file-flow-cny-total',
            expected: 30000,
            actual: null,
            passed: false,
            reason:
              status === 'succeeded' ? 'missing_stage' : 'execution_failed',
          },
        )
      : employeeMethodAmountCase.evaluate(
          output.answer,
          status !== 'succeeded',
        );
  await tx`update allrice_employee_method_tests set assertion=${tx.json(assertion)} where test_id=${testId}`;
  if (!b.route_decision_id) return;
  const meter = output.modelExecution;
  await completeRouteDecisionInTransaction(
    {
      organizationId: b.organization_id,
      workspaceId: b.workspace_id,
      ...(meter?.dispatched === false
        ? {
            undispatched: {
              subscriptionSnapshotCreated: meter.subscriptionSnapshotCreated,
            },
          }
        : {}),
      outcome: {
        decisionId: b.route_decision_id,
        status,
        inputTokens: output.usage?.inputTokens ?? 0,
        cachedInputTokens: output.usage?.cachedInputTokens ?? 0,
        outputTokens: output.usage?.outputTokens ?? 0,
        costCents: meter?.costCents ?? null,
        usageComplete: meter?.usageComplete ?? false,
        cacheUsageKnown: meter?.cacheUsageKnown ?? false,
        errorCode: output.error?.code ?? null,
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    },
    tx,
  );
}

export async function employeeMethodTestStillCurrent(testId: string) {
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    const b = await readBinding(tx, testId);
    const [test] =
      await tx`select t.status from allrice_platform_employee_test_runs t
      join allrice_jobs j on j.run_id=${b.run_id} and j.organization_id=${b.organization_id}
        and j.workspace_id=${b.workspace_id} and j.owner_id=${b.owner_id}
        and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp()
      where t.id=${testId}`;
    if (test?.status !== 'running') return false;
    try {
      await currentBinding(tx, b);
      await assertEmployeeMethodModelCurrent(
        tx,
        b,
        SessionModelSnapshotSchema.parse(b.model_snapshot),
      );
      return true;
    } catch (error) {
      if (
        error instanceof DataAccessError ||
        error instanceof EmployeeContentError ||
        error instanceof EmployeeInstanceError ||
        error instanceof ModelGovernanceError
      )
        return false;
      throw error;
    }
  });
}

/** Called inside the runtime admission transaction. Never lock the test row
 * after a Run lock: test finalization takes those locks in the reverse order. */
export async function assertEmployeeMethodFileExecution(
  tx: Tx,
  context: Pick<
    ExecutionContext,
    'organizationId' | 'workspaceId' | 'runId' | 'jobId' | 'worker'
  > & {
    policySnapshot: Pick<
      ExecutionContext['policySnapshot'],
      'id' | 'subjectId'
    >;
  },
) {
  const [row] = await tx<
    { test_id: string }[]
  >`select test_id from allrice_employee_method_tests
    where run_id=${context.runId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId} and owner_id=${context.policySnapshot.subjectId}`;
  if (!row) throw new DataAccessError('authorization_denied');
  const b = await readBinding(tx, row.test_id);
  if (
    b.case_id !== employeeMethodFileCase.id ||
    !b.candidate_snapshot.fileEnvironment ||
    !runtimeContractEqual(
      b.candidate_snapshot.fileEnvironment.manifest,
      employeeMethodFileCase,
    )
  )
    throw new DataAccessError('authorization_denied');
  await currentBinding(tx, b);
  await assertEmployeeMethodModelCurrent(
    tx,
    b,
    SessionModelSnapshotSchema.parse(b.model_snapshot),
  );
  const [run] = await tx<
    {
      execution_spec: Record<string, unknown>;
      policy_snapshot_id: string;
      payload: unknown;
      timeout_at: Date;
      lease_token: string;
      attempt: number;
    }[]
  >`select r.execution_spec,r.policy_snapshot_id,p.payload,j.timeout_at,j.lease_token::text,j.attempt
    from allrice_runs r join allrice_jobs j on j.run_id=r.id and j.id=${context.jobId}
      and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_platform_employee_test_runs t on t.id=${b.test_id} and t.purpose='method_candidate' and t.status='running'
    where r.id=${context.runId} and r.organization_id=${b.organization_id} and r.workspace_id=${b.workspace_id}
      and r.owner_id=${b.owner_id} and r.state='running' and j.status='running'
      and j.worker_id=${context.worker.id} and j.cancel_requested_at is null
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() for share of r,j,p`;
  if (
    !run ||
    run.policy_snapshot_id !== context.policySnapshot.id ||
    run.execution_spec.platformEmployeeTestRunId !== b.test_id ||
    run.execution_spec.employeeMethodSnapshotDigest !== b.snapshot_digest
  )
    throw new DataAccessError('authorization_denied');
  return { b, run };
}

async function methodTestFiles(tx: Tx, b: Binding) {
  if (b.case_id !== employeeMethodFileCase.id) return [];
  const files = await tx<
    {
      stage: string;
      object_id: string;
      version_id: string;
      file_name: string;
      checksum: string;
    }[]
  >`
    select s.stage,o.id object_id,v.id version_id,v.file_name,o.checksum
    from allrice_employee_method_file_steps s join allrice_deliverable_versions v on v.id=s.output_version_id
    join allrice_storage_objects o on o.id=s.output_object_id and o.id=v.object_id
    join allrice_workbench_artifacts a on a.version_id=v.id and a.run_id=${b.run_id}
    where s.test_id=${b.test_id} and v.platform_test_run_id=${b.test_id}
      and o.organization_id=${b.organization_id} and o.workspace_id=${b.workspace_id}
      and o.owner_id=${b.owner_id} and o.visibility='private' and o.immutable and o.state='ready' and o.deleted_at is null
    order by s.created_at,s.stage`;
  return files.map((f) => ({
    stage: f.stage,
    objectId: f.object_id,
    versionId: f.version_id,
    fileName: f.file_name,
    checksum: f.checksum,
    downloadUrl: `/api/v1/files/${f.object_id}/download?workspaceId=${b.workspace_id}`,
    previewUrl: `/api/v1/files/${f.object_id}/preview?workspaceId=${b.workspace_id}&name=${encodeURIComponent(f.file_name)}`,
  }));
}
