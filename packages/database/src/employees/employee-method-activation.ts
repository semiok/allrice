import {
  EmployeeMethodPrepareActivationSchema,
  EmployeeMethodActivateSchema,
  EmployeeContentReceiptSchema,
  PlatformModelSettingsSchema,
  SessionModelSnapshotSchema,
  UserQuestionItemSchema,
  methodActivationQuestionPrefix,
  methodActivationApprove,
  methodActivationDecline,
  type EmployeeContentManifest,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { DataAccessError } from '../data.ts';
import { enterMethodChat } from './employee-method-chat.ts';
import {
  employeeChatIdentity,
  employeeChatUuid,
  assertEmployeeChatExecution,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';
import {
  freezeEmployeeMethodActivationCandidate,
  mutateEmployeeContentInTransaction,
} from './employee-content.ts';
import {
  EmployeeContentError,
  type ContentTx,
} from './employee-content-model.ts';
import { readEmployeeMethodActivationTest } from './employee-method-tests.ts';
import {
  EmployeeMethodActivationError,
  requireEmployeeMethodActivationAnswer,
} from './employee-method-activation-question.ts';

/** Publication replaces the whole manifest. A one-scene test must never
 * accidentally approve edits to other scenes or changed common requirements. */
export function employeeMethodActivationChanges(
  before: EmployeeContentManifest,
  after: EmployeeContentManifest,
) {
  const commonChanged =
    runtimePolicyDigest(before.common) !== runtimePolicyDigest(after.common);
  const changedScenes = after.scenes.filter(
    (scene) =>
      commonChanged ||
      runtimePolicyDigest(
        before.scenes.find((s) => s.id === scene.id) ?? null,
      ) !== runtimePolicyDigest(scene),
  );
  const removedScenes = before.scenes.filter(
    (s) => !after.scenes.some((n) => n.id === s.id),
  );
  return { commonChanged, changedScenes, removedScenes };
}

type CandidateInput = ReturnType<
  typeof EmployeeMethodPrepareActivationSchema.parse
>;
async function snapshot(
  tx: ContentTx,
  input: EmployeeChatCall,
  instanceId: string,
  args: CandidateInput,
  model: unknown,
) {
  const { scope } = employeeChatIdentity(input);
  const frozenModel = SessionModelSnapshotSchema.parse(model);
  // Keep model selection stable through the activation commit. A live old Run
  // alone does not prove the model used by the next independent task.
  const [settings] =
    await tx`select revision,configuration,updated_at from allrice_platform_model_settings where singleton for share nowait`;
  if (!settings) throw new DataAccessError('not_found');
  const currentModelSettings = PlatformModelSettingsSchema.parse({
    revision: settings.revision,
    configuration: settings.configuration,
    updatedAt: settings.updated_at.toISOString(),
  });
  if (
    !frozenModel.platformSettings ||
    frozenModel.platformSettings.revision !== currentModelSettings.revision ||
    runtimePolicyDigest(frozenModel.platformSettings.configuration) !==
      runtimePolicyDigest(currentModelSettings.configuration)
  )
    throw new EmployeeContentError('source_changed');
  const content = await freezeEmployeeMethodActivationCandidate(
    scope,
    { ...args, instanceId },
    tx,
  );
  if (content.activeRevisionId === content.candidateRevisionId)
    throw new EmployeeContentError('version_conflict');
  const changes = employeeMethodActivationChanges(
    content.activeManifest,
    content.manifest,
  );
  const tests: Awaited<ReturnType<typeof readEmployeeMethodActivationTest>>[] =
    [];
  for (const id of [...args.testIds].sort()) {
    const proof = await readEmployeeMethodActivationTest(
      tx,
      scope,
      instanceId,
      id,
      model,
    );
    if (
      proof.candidateRevisionId !== content.candidateRevisionId ||
      proof.candidateDigest !== content.candidateDigest ||
      proof.dependencyDigest !== content.dependencyDigest
    )
      throw new EmployeeContentError('source_changed');
    tests.push(proof);
  }
  if (
    (changes.commonChanged ? content.scenes : changes.changedScenes).some(
      (s) => !tests.some((t) => t.sceneId === s.id),
    ) ||
    (changes.commonChanged && !content.scenes.length)
  )
    throw new EmployeeMethodActivationError('activation_test_coverage');
  return { content, changes, tests, modelSettings: currentModelSettings };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

function confirmationQuestion(id: string, name: string, s: Snapshot) {
  const changedPins = new Set(
    [
      ...(s.changes.commonChanged ? s.content.manifest.common : []),
      ...s.changes.changedScenes.flatMap((scene) => scene.references),
    ].map((r) => r.revisionId),
  );
  const descriptions = s.content.sources
    .filter((src) => changedPins.has(src.reference.revisionId))
    .map(
      (src) =>
        `${src.title ?? src.reference.sourceKind}：${src.body ?? '固定版本参考资料'} (${src.reference.revisionId.slice(0, 8)})`,
    )
    .join('\n');
  const question = [
    `是否启用「${name}」的个人工作方法？仅影响你自己的这个 AI 员工。`,
    `候选 r${s.content.setRevision} · ${s.content.candidateRevisionId.slice(0, 8)} · ${s.content.candidateDigest.slice(7, 19)}`,
    `通用要求：${s.changes.commonChanged ? '已调整' : '保持原样'}；新增或调整场景：${s.changes.changedScenes.map((scene) => scene.name.slice(0, 40)).join('、') || '无'}。`,
    `移除场景：${s.changes.removedScenes.map((scene) => scene.name.slice(0, 40)).join('、') || '无'}；其他场景及原始历史保留。`,
    descriptions.slice(0, 1400) +
      (descriptions.length > 1400
        ? '\n（文字节选，完整内容可在当前候选中查看。）'
        : ''),
    `测试：${s.tests.length ? `${s.tests.length} 项固定样例原断言通过（${[...new Set(s.tests.map((t) => t.caseId))].join('、')}）` : '本次仅移除已有场景，没有新增执行内容'}。`,
    '固定合成样例通过不代表所有真实业务已验证。当前任务保留原快照，启用后新的独立任务采用新版本。',
    '确认有效期 30 分钟；候选、依赖或授权变化时需重新查看并确认。',
  ].join('\n');
  return UserQuestionItemSchema.parse({
    id: methodActivationQuestionPrefix + id,
    header: '启用工作方法',
    question,
    multiSelect: false,
    options: [
      { label: methodActivationApprove },
      { label: methodActivationDecline },
    ],
  });
}

function askUserQuestionArguments(
  question: ReturnType<typeof UserQuestionItemSchema.parse>,
) {
  const { multiSelect, ...item } = question;
  return { questions: [{ ...item, multi_select: multiSelect }] };
}

/** Prepares a review only; even a successful call does not activate content. */
export async function prepareEmployeeMethodActivationFromChat(
  input: EmployeeChatCall,
) {
  const args = EmployeeMethodPrepareActivationSchema.parse(input.arguments);
  const { scope, requestId } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.employee.method.prepare_activation',
    true,
    async (tx, instance) => {
      const { snapshot: frozen } = await assertEmployeeChatExecution(
        tx,
        input,
        instance,
        'workspace.employee.method.prepare_activation',
      );
      const current = await snapshot(
        tx,
        input,
        instance.id,
        args,
        frozen.modelSnapshot,
      );
      const digest = runtimePolicyDigest(current),
        requestDigest = runtimePolicyDigest(args);
      const [old] =
        await tx`select * from allrice_employee_method_activations where id=${requestId}`;
      if (old) {
        if (
          old.request_digest !== requestDigest ||
          old.snapshot_digest !== digest
        )
          throw new EmployeeContentError('request_conflict');
        if (old.expires_at <= new Date())
          throw new EmployeeMethodActivationError('activation_expired');
        return {
          receiptId: old.id,
          enabled: false,
          question: UserQuestionItemSchema.parse(old.question),
          askUserQuestion: askUserQuestionArguments(
            UserQuestionItemSchema.parse(old.question),
          ),
          expiresAt: old.expires_at.toISOString(),
          preview: current,
        };
      }
      const question = confirmationQuestion(
        requestId,
        instance.profile.name ?? '小白',
        current,
      );
      const [row] = await tx`insert into allrice_employee_method_activations
      (id,organization_id,workspace_id,owner_id,instance_id,session_id,source_run_id,source_job_id,source_attempt,request_digest,snapshot,snapshot_digest,question)
      values(${requestId},${scope.organizationId},${scope.workspaceId},${scope.actor.id},${instance.id},${input.sessionId},${input.context.runId},${input.context.jobId},${input.worker.attempt},${requestDigest},${tx.json(current)},${digest},${tx.json(question)}) returning expires_at`;
      return {
        receiptId: requestId,
        enabled: false,
        question,
        askUserQuestion: askUserQuestionArguments(question),
        expiresAt: row!.expires_at.toISOString(),
        preview: current,
      };
    },
  );
}

/** Native Ask User supplies an immutable adopted-answer proof. validate,
 * activate and consume commit together, with receipt-derived idempotency IDs. */
export async function activateEmployeeMethodFromChat(input: EmployeeChatCall) {
  const args = EmployeeMethodActivateSchema.parse(input.arguments);
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.employee.method.activate',
    true,
    async (tx, instance) => {
      const { snapshot: frozen } = await assertEmployeeChatExecution(
        tx,
        input,
        instance,
        'workspace.employee.method.activate',
      );
      const [r] = await tx`select * from allrice_employee_method_activations
      where id=${args.receiptId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${scope.actor.id} and instance_id=${instance.id} and session_id=${input.sessionId}
      for update nowait`;
      if (!r) throw new DataAccessError('not_found');
      if (r.consumed_at) {
        const receipt = EmployeeContentReceiptSchema.parse(r.response);
        const [current] =
          await tx`select active_revision_id from allrice_employee_content_sets where id=${receipt.setId}`;
        return {
          receiptId: r.id,
          enabled: current?.active_revision_id === receipt.active?.id,
          replayed: true,
          receipt,
        };
      }
      if (r.source_run_id !== input.context.runId)
        throw new DataAccessError('not_found');
      if (r.expires_at <= new Date())
        throw new EmployeeMethodActivationError('activation_expired');
      const answerMessageId = await requireEmployeeMethodActivationAnswer(
        tx,
        r as Parameters<typeof requireEmployeeMethodActivationAnswer>[1],
      );
      const prepared = r.snapshot as Snapshot;
      if (runtimePolicyDigest(prepared) !== r.snapshot_digest)
        throw new EmployeeContentError('source_changed');
      const current = await snapshot(
        tx,
        input,
        instance.id,
        {
          expectedRevision: prepared.content.setRevision,
          candidateRevisionId: prepared.content.candidateRevisionId,
          candidateDigest: prepared.content.candidateDigest,
          testIds: prepared.tests.map((t) => t.testId),
        },
        frozen.modelSnapshot,
      );
      if (runtimePolicyDigest(current) !== r.snapshot_digest)
        throw new EmployeeContentError('source_changed');
      const base = {
        workspaceId: scope.workspaceId,
        setId: current.content.setId,
        ownership: {
          scope: 'personal' as const,
          organizationId: scope.organizationId,
          ownerId: scope.actor.id,
        },
        target: { kind: 'instance' as const, instanceId: instance.id },
        candidateRevisionId: current.content.candidateRevisionId,
        candidateDigest: current.content.candidateDigest,
        changeSummary: '用户确认准确候选与固定样例结果后启用',
      };
      const validated = await mutateEmployeeContentInTransaction(
        scope,
        {
          ...base,
          operation: 'validate',
          expectedRevision: current.content.setRevision,
          requestId: employeeChatUuid(r.id, 'validate'),
        },
        tx,
      );
      const receipt = await mutateEmployeeContentInTransaction(
        scope,
        {
          ...base,
          operation: 'activate',
          expectedRevision: validated.revision,
          requestId: employeeChatUuid(r.id, 'activate'),
        },
        tx,
      );
      await tx`update allrice_employee_method_activations set consumed_at=clock_timestamp(),answer_message_id=${answerMessageId},response=${tx.json(receipt)} where id=${r.id}`;
      return { receiptId: r.id, enabled: true, replayed: false, receipt };
    },
  );
}
