import { modelGovernanceFailureText } from '@allrice/contracts';

/**
 * Plain copy for a reply that did not finish: what happened, then what the
 * person can do. Presentation only; stored text, Run status and retry rules
 * are unchanged, and nothing here suggests resubmitting an unknown write.
 */
const kept = '已有的内容都保留了，可以展开「工作过程」查看。';
const tooLarge = '这次工作量太大，未完成。建议把任务拆小一点，分几次再试。';
const quota = '已达到公司的用量上限，这次未完成。请联系管理员调整。';
const usage =
  '之前的用量还没统计完，这次未完成。请联系管理员处理，反复重试也不会解除。';
const model = `AI 回复出错，这次未完成。${kept}你可以换个说法再试。`;
const waitChanged =
  '等待期间权限或设置有变化，这次未完成。已有的内容都保留了，请确认设置后重新发起。';
const delivery =
  '交付的成果没有通过检查，这次未完成。已有文件和回复都保留了，没有自动重做；你可以让员工补全后再交付。';
const skill =
  '引用的技能暂时用不了，这次未完成。请重新安装或刷新这个技能后再试。';

export const replyFailureFallback =
  '这次未完成。可以换个说法再试，或者把任务拆小一点。';
export const replyBudgetKept =
  '答案已保留。这次工作量太大，后面的步骤未完成，建议把任务拆小一点再试。';

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
  DSH_EXECUTION_OUTCOME_UNKNOWN:
    '任务中途中断，部分操作结果待确认，没有自动重做。请刷新查看，确认后再决定要不要重新发起。',
  ASSISTANT_EXECUTION_UNRESOLVED:
    '本轮已结束，部分操作结果待确认，请刷新查看。不会自动重试。',
  NATIVE_WAIT_RECOVERY_REJECTED: `等待中的任务没能恢复，这次未完成，也没有自动重做。${kept}你可以重新发起。`,
  NATIVE_WAIT_AUTHORITY_CHANGED: waitChanged,
  NATIVE_WAIT_CONFIGURATION_CHANGED: waitChanged,
  MODEL_OUTPUT_BUDGET_EXCEEDED: tooLarge,
  MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED: tooLarge,
  MODEL_COST_BUDGET_EXCEEDED: tooLarge,
  ASSISTANT_BUDGET_EXHAUSTED: tooLarge,
  JOB_TIMEOUT: '用时太长，这次未完成。建议把任务拆小一点，分几次再试。',
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
};

/** What happened and what to do next for a failure code; never empty. */
export function replyFailureCopy(code: string | null | undefined) {
  return (code && byCode[code]) || replyFailureFallback;
}

/** The server's catch-all text, stored when it has nothing more specific. */
export const savedGenericFailure = 'Rice 暂时无法完成这次请求，请稍后重试。';
// Fixed failure wording the server stores with the message (or contracts
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
]);

/** Swap stored platform failure wording for plain copy; a real reply passes through. */
export function plainFailureText(
  text: string,
  code: string | null | undefined,
): string;
export function plainFailureText(
  text: string | null,
  code: string | null | undefined,
): string | null;
export function plainFailureText(
  text: string | null,
  code: string | null | undefined,
) {
  if (text === null) return null;
  if (text === savedGenericFailure) return replyFailureCopy(code);
  const saved = savedCodes.get(text);
  return saved ? replyFailureCopy(saved) : text;
}
