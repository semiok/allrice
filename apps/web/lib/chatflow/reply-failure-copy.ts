import { modelGovernanceFailureText } from '@allrice/contracts';

/**
 * Plain copy for a reply that did not finish: what happened, then what the
 * person can do. Presentation only; stored text, Run status and retry rules
 * are unchanged. When the outcome is unknown the copy asks for a refresh and
 * never suggests sending the work again.
 */
const kept = '已有的内容都保留了，可以展开「工作过程」查看。';
const tooLarge = '这次工作量太大，未完成。建议把任务拆小一点，分几次再试。';
const quota = '已达到用量上限，这次未完成。请联系管理员调整。';
const usage =
  '之前的用量还没统计完，这次未完成。请联系管理员处理，反复重试也不会解除。';
const model = `AI 回复出错，这次未完成。${kept}你可以让员工接着做。`;
const waitChanged =
  '等待期间权限或设置有变化，这次未完成。已有的内容都保留了，请确认设置，并展开「工作过程」看看做到了哪一步，再决定是否重新发起。';
const delivery =
  '交付的成果没有通过检查，这次未完成。已有文件和回复都保留了，没有自动重做；你可以让员工补全后再交付。';
const skill =
  '引用的技能暂时用不了，这次未完成。请重新安装或刷新这个技能后再试。';
const unknown =
  '这次未完成，部分操作结果待确认，没有自动重做。请刷新查看，展开「工作过程」看看做到了哪一步，再决定要不要重新发起。';
const unavailable =
  'AI 服务暂时不可用，这次未完成。请稍后再试；一直这样请联系管理员。';
const tooLong =
  '这次运行时间超过上限，未完成。建议把任务拆小一点，分几次再试。';

export const replyFailureFallback =
  '这次未完成。已有的内容都保留了，请稍后再试；一直这样请联系管理员。';
export const replyBudgetKept =
  '答案已保留。这次工作量超出了预期，下次可以把任务拆小一点。';
const stopped = '这次任务已停止。';

const byCode: Record<string, string> = {
  DOCUMENT_DELIVERY_INCOMPLETE:
    '文档还没生成完，这次未完成。回复和之前的文件都保留了，你可以让员工接着修改并重新导出。',
  FINAL_DELIVERY_RESPONSE_INVALID: delivery,
  FINAL_DELIVERY_EVIDENCE_UNAVAILABLE:
    '交付结果待确认，已有文件和回复都保留了，没有自动重做。请先打开文件看看，需要时让员工补全。',
  DSH_TRANSPORT: `连接中断，这次未完成。${kept}你可以让员工接着做。`,
  DSH_TIMEOUT: `等待回复超时，这次未完成。${kept}你可以稍后让员工接着做。`,
  DSH_PI_AI_ERROR: model,
  DSH_TURN_FAILED: model,
  DSH_RECOVERY_REQUIRED:
    '这次任务没法安全地接着做，未完成，也没有自动重做。已有的内容都保留了，可以展开「工作过程」看看做到了哪一步，再决定怎么继续。',
  DSH_UNKNOWN: unknown,
  DSH_EXECUTION_OUTCOME_UNKNOWN: unknown,
  ASSISTANT_EXECUTION_UNRESOLVED:
    '本轮已结束，部分操作结果待确认，请刷新查看。不会自动重试。',
  NATIVE_WAIT_RECOVERY_REJECTED:
    '等待中的任务没能恢复，部分操作结果待确认，没有自动重做。请先展开「工作过程」看看做到了哪一步，再决定要不要重新发起。',
  NATIVE_WAIT_AUTHORITY_CHANGED: waitChanged,
  NATIVE_WAIT_CONFIGURATION_CHANGED: waitChanged,
  MODEL_OUTPUT_BUDGET_EXCEEDED: tooLarge,
  MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED: tooLarge,
  MODEL_COST_BUDGET_EXCEEDED: tooLarge,
  ASSISTANT_BUDGET_EXHAUSTED: tooLarge,
  JOB_TIMEOUT: tooLong,
  MODEL_RUNTIME_LIMIT_EXCEEDED: tooLong,
  MODEL_RESOURCE_CONCURRENCY_EXCEEDED:
    '现在同时进行的任务太多，这次未完成。请稍后再试。',
  PROVIDER_CIRCUIT_OPEN: unavailable,
  PROVIDER_KILL_SWITCH: unavailable,
  PROVIDER_NOT_RELEASED: unavailable,
  PROVIDER_UNAVAILABLE: unavailable,
  MODEL_TOKEN_USAGE_UNKNOWN: usage,
  MODEL_COST_USAGE_UNKNOWN: usage,
  MODEL_RUN_QUOTA_EXCEEDED: quota,
  MODEL_REQUEST_QUOTA_EXCEEDED: quota,
  MODEL_TOKEN_QUOTA_EXCEEDED: quota,
  MODEL_COST_QUOTA_EXCEEDED: quota,
  REFERENCE_UNAVAILABLE:
    '引用的资料已不可用，这次未完成。请确认资料还在、你有权限查看，再重新发起。',
  SKILL_ARTIFACT_MISSING: skill,
  SKILL_ARTIFACT_MISMATCH: skill,
  SKILL_ARTIFACT_INVALID: skill,
  EMPLOYEE_ENQUEUE_FAILED:
    '这次任务没能开始，请稍后再试；一直这样请联系管理员。',
  CANCELED: stopped,
  APPROVAL_REJECTED: '你拒绝了这一步操作，任务已停止。',
  MCP_APPROVAL_REJECTED: '你拒绝了这一步操作，任务已停止。',
};
// The person stopped or declined the work themselves: nothing to add under a reply.
const quiet = new Set([
  'CANCELED',
  'APPROVAL_REJECTED',
  'MCP_APPROVAL_REJECTED',
  'INPUT_NOT_ADOPTED',
]);

/** What happened and what to do next for a failure code; never empty. */
export function replyFailureCopy(code: string | null | undefined) {
  return (code && byCode[code]) || replyFailureFallback;
}

/** The server's catch-all text, stored when it has nothing more specific. */
export const savedGenericFailure = 'Rice 暂时无法完成这次请求，请稍后重试。';
// Fixed wording the server stores with a failed message (or contracts
// return), mapped back to the failure it describes.
const savedCodes = new Map<string, string>([
  ...Object.keys(byCode).flatMap((code) => {
    const text = modelGovernanceFailureText(code);
    return text ? [[text, code] as [string, string]] : [];
  }),
  [
    'Rice 暂时无法使用已引用的 Skill：Skill 文件在本地存储中缺失。请重新安装或刷新该 Skill 后重试。',
    'SKILL_ARTIFACT_MISSING',
  ],
  [
    'Rice 暂时无法使用已引用的 Skill：Skill 文件校验失败。请重新安装或刷新该 Skill 后重试。',
    'SKILL_ARTIFACT_INVALID',
  ],
  ['Rice 暂时无法开始这次执行，请稍后重试。', 'EMPLOYEE_ENQUEUE_FAILED'],
  ['Rice 的这次执行已取消。', 'CANCELED'],
]);

/**
 * One reading of a failed reply, shared by its body and the notice under it.
 * `nativeText` is the contracts wording for this code or its diagnostics; it
 * may name a more specific failure than the stored code (a masked disconnect).
 * `body` only stands in until the run's own reply loads, so the notice is
 * always kept here; the caller drops it when the shown reply already says it.
 */
export function presentReplyFailure(input: {
  code: string | null | undefined;
  text: string;
  nativeText: string | null;
  budgetWarning: boolean;
}): { body: string; notice: string | null } {
  const stored =
    input.text === savedGenericFailure || savedCodes.has(input.text);
  const kind =
    (input.nativeText && savedCodes.get(input.nativeText)) ||
    savedCodes.get(input.text) ||
    input.code ||
    null;
  const copy = replyFailureCopy(kind);
  // Platform limits replace the stored text even when a reply was kept.
  const governs =
    !input.budgetWarning &&
    !input.nativeText &&
    modelGovernanceFailureText(input.code) !== null;
  const body = stored || governs ? copy : input.text;
  return {
    body,
    notice: kind && quiet.has(kind) ? null : copy,
  };
}
