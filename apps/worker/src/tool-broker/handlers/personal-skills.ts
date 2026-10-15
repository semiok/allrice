import {
  preparePersonalSkillImport,
  installPersonalSkillFromChat,
  PersonalSkillError,
  EmployeeAccessBusyError,
  DataAccessError,
  ArtifactReviewError,
  EmployeeInstanceError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { personalSkillLimits } from '@allrice/contracts';
import { ZodError } from 'zod';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import { parsePersonalSkill } from '../../personal-skill-import.js';
import type { RiceToolHandler } from '../types.js';

export const installPersonalSkill: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const rejected = (message: string) => {
    const error = new HandlerError('PERSONAL_SKILL_REJECTED', message, false);
    confirmToolFailure(error, {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: input.call.name,
    });
    return error;
  };
  if (
    !input.sessionId ||
    !input.userMessageId ||
    input.platformTestRunId ||
    input.managedBrowserJobAttempt === undefined ||
    !input.managedBrowserJobLeaseToken
  )
    throw rejected('当前任务不能安装个人技能。');
  const call = {
    context: input.context,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    callId: input.call.id,
    arguments: args,
    worker: {
      attempt: input.managedBrowserJobAttempt,
      leaseToken: input.managedBrowserJobLeaseToken,
    },
  };
  try {
    const source = await preparePersonalSkillImport(call);
    let result = 'prior' in source ? source.prior : undefined;
    if (!result) {
      if (!('object' in source)) throw new PersonalSkillError('source_invalid');
      const stream = await new LocalStorageAdapter(input.storageRoot).get(
        source.object,
      );
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > personalSkillLimits.sourceBytes)
            throw new PersonalSkillError('source_invalid');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      result = await installPersonalSkillFromChat(
        call,
        await parsePersonalSkill(Buffer.concat(chunks)),
      );
    }
    return {
      modelContent: JSON.stringify({
        skill: result,
        effectiveFrom: 'next_task',
        note: '仅绑定本人当前 AI 员工；格式检查通过不代表业务试用通过。可在设置→我的技能停用或卸载。',
      }),
      summary: '个人技能已安装，后续任务可采用',
    };
  } catch (error) {
    if (error instanceof PersonalSkillError)
      throw rejected(
        {
          intent_required:
            '尚未收到明确安装指令。本次未安装；请用户随 SKILL.md 直接说明“请安装我上传的 SKILL.md”。阅读、评价或临时使用不代表安装。',
          source_invalid:
            '附件需为一份有效 UTF-8 SKILL.md（不超过 256 KiB），包含名称、说明及正文；本次未安装。',
          name_conflict:
            '已有同名技能或当前平台技能占用该名称，本次未覆盖。请使用不同名称。',
          limit:
            '个人技能或当前员工启用数量已达上限，本次未安装。请在“我的技能”停用不需要的技能。',
          conflict: '技能状态已变化，本次未覆盖。请刷新“我的技能”后重试。',
          unavailable: '当前技能、员工或授权已失效，本次未安装。',
        }[error.code],
      );
    if (
      error instanceof EmployeeAccessBusyError ||
      error instanceof DataAccessError ||
      error instanceof ArtifactReviewError ||
      error instanceof EmployeeInstanceError ||
      error instanceof ZodError
    )
      throw rejected('当前参数、附件或授权不允许安装，本次未保存。');
    // Unknown commit outcome stays unknown; do not declare a rolled-back write.
    throw error;
  }
};
