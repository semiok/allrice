import {
  preparePersonalSkillImport,
  reservePersonalSkillPackage,
  completePersonalSkillPackage,
  cancelPersonalSkillPackage,
  preparePersonalSkillImportCleanup,
  completePersonalSkillImportCleanup,
  installPersonalSkillFromChat,
  PersonalSkillError,
  EmployeeAccessBusyError,
  DataAccessError,
  ArtifactReviewError,
  EmployeeInstanceError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  personalSkillLimits,
  PersonalSkillInstallInputSchema,
} from '@allrice/contracts';
import { FileArchiveError } from '@allrice/file-archives';
import { ZodError } from 'zod';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import { parsePersonalSkill } from '../../personal-skill-import.js';
import { readPersonalSkillArchive } from '../../personal-skill-package.js';
import { readPersonalSkillBytes } from '../../personal-skill-storage.js';
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
  const storage = new LocalStorageAdapter(input.storageRoot);
  const cleanup = async () => {
    const unused = await preparePersonalSkillImportCleanup(call);
    for (const object of unused) {
      await storage.delete(object);
      await completePersonalSkillImportCleanup(call, [object.id]);
    }
  };
  try {
    if ('operation' in PersonalSkillInstallInputSchema.parse(args)) {
      const canceled = await cancelPersonalSkillPackage(call);
      const cleanupPending = await cleanup().then(
        () => false,
        () => true,
      );
      return {
        modelContent: JSON.stringify({ ...canceled, cleanupPending }),
        summary: '待选技能包已取消，未安装',
      };
    }
    const source = await preparePersonalSkillImport(call);
    let result = 'prior' in source ? source.prior : undefined;
    if (!result) {
      await cleanup();
      if (source.selection) {
        result = await installPersonalSkillFromChat(call, {
          originalText: source.selection.candidate.originalText!,
          definition: source.selection.candidate.definition!,
        });
      } else {
        if (!('object' in source))
          throw new PersonalSkillError('source_invalid');
        const zipped = /\.zip$/iu.test(source.source.fileName);
        const bytes = await readPersonalSkillBytes(
          input.storageRoot,
          source.object,
          zipped
            ? personalSkillLimits.archiveBytes
            : personalSkillLimits.sourceBytes,
          input.signal,
        );
        if (zipped) {
          const inspected = await readPersonalSkillArchive(bytes, input.signal);
          const candidates = inspected.map((candidate) => ({
            sourcePath: candidate.sourcePath,
            ...(candidate.parsed ?? {}),
            issues: candidate.issues,
            resources: candidate.resources.map(
              ({ path, byteLength, checksum }) => ({
                path,
                byteLength,
                checksum,
                mediaType: resourceMediaType(path),
              }),
            ),
          }));
          if (
            !candidates.some(
              (candidate) => candidate.definition && !candidate.issues.length,
            )
          )
            return {
              modelContent: JSON.stringify({
                status: 'incompatible',
                installed: false,
                candidates: candidates.map(({ sourcePath, issues }) => ({
                  sourcePath,
                  issues,
                })),
              }),
              summary: '技能包未安装，请查看缺失或不兼容的内容',
            };
          input.signal?.throwIfAborted();
          const reservation = await reservePersonalSkillPackage(
            call,
            candidates,
          );
          if (reservation.writeRequired)
            await storage.put(reservation.object, new Blob([bytes]).stream());
          input.signal?.throwIfAborted();
          const ready = await completePersonalSkillPackage(call).catch(
            async (error: unknown) => {
              // Re-read before cleaning a superseded late write. An installed
              // immutable version can never be selected by this cleanup query.
              await cleanup().catch(() => undefined);
              throw error;
            },
          );
          if (ready.candidates.length > 1)
            return {
              modelContent: JSON.stringify({
                status: 'selection_required',
                installed: false,
                importId: ready.importId,
                expiresAt: ready.expiresAt,
                candidates: ready.candidates.map((candidate) => ({
                  candidatePath: candidate.sourcePath,
                  name: candidate.definition?.name,
                  description: candidate.definition?.description,
                  issues: candidate.issues,
                })),
                note: '列出候选并结束本轮，等待下一条真人消息选择名称或准确路径并明确安装后，使用 importId + candidatePath。不要在本轮调用 ask_user_question 续办安装，不得代替用户选择或一次启用多个；明确取消时使用 importId + operation:cancel。',
              }),
              summary: '发现多个技能，等待选择后安装',
            };
          const candidate = ready.candidates[0]!;
          result = await installPersonalSkillFromChat(call, {
            originalText: candidate.originalText!,
            definition: candidate.definition!,
          });
        } else
          result = await installPersonalSkillFromChat(
            call,
            await parsePersonalSkill(bytes),
          );
      }
    }
    // A confirmed installation must stay confirmed if separate byte retirement
    // fails. Subsequent requests retry only unused copies, never the installation.
    const cleanupPending = await cleanup().then(
      () => false,
      () => true,
    );
    return {
      modelContent: JSON.stringify({
        status: 'installed',
        cleanupPending,
        skill: result,
        effectiveFrom: 'next_task',
        note: '仅绑定本人当前 AI 员工；格式检查通过不代表业务试用通过。可在设置→我的技能停用或卸载。',
      }),
      summary: '个人技能已安装，后续任务可采用',
    };
  } catch (error) {
    if (error instanceof FileArchiveError)
      throw rejected(
        `技能包未安装：${error.code}。请检查 ZIP 路径、文件数量、大小与完整性；不会运行包内代码。`,
      );
    if (
      error instanceof Error &&
      /^personal_skill_package_(?:unsafe_path|path_conflict|missing_skill|candidate_limit)$/u.test(
        error.message,
      )
    )
      throw rejected(
        `技能包未安装：${error.message}。需要合法且完整的 SKILL.md 和相对资源。`,
      );
    if (error instanceof PersonalSkillError)
      throw rejected(
        {
          intent_required:
            '尚未收到明确安装或选择指令。本次未安装；请用户随 SKILL.md / ZIP 说明“请安装我上传的技能包”，或在下一条消息明确选择候选名称并安装。阅读、评价或临时使用不代表安装。',
          source_invalid:
            '技能文件或包资源不完整或校验失败，本次未安装。SKILL.md 需为有效 UTF-8（不超过 256 KiB）；ZIP 不超过 8 MB，资源需在 references、assets 或 scripts 内。',
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

function resourceMediaType(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return (
    (
      {
        md: 'text/markdown',
        txt: 'text/plain',
        csv: 'text/csv',
        json: 'application/json',
        js: 'text/javascript',
        mjs: 'text/javascript',
        py: 'text/x-python',
        html: 'text/html',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      } as Record<string, string>
    )[extension ?? ''] ?? 'application/octet-stream'
  );
}
