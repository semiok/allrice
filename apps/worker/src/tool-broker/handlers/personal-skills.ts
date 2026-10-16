import {
  personalSkillVersionFromChat,
  personalSkillVersionConfirmationFiles,
  type PersonalSkillImportCall,
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
  skillBytesChecksum,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  personalSkillLimits,
  PersonalSkillInstallInputSchema,
  PersonalSkillVersionInputSchema,
  PersonalSkillGitHubSourceSchema,
  parsePersonalSkillGitHubUrl,
  type PersonalSkillGitHubSource,
} from '@allrice/contracts';
import { FileArchiveError, createFileArchive } from '@allrice/file-archives';
import { ZodError } from 'zod';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import { parsePersonalSkill } from '../../personal-skill-import.js';
import {
  readPersonalSkillArchive,
  inspectPersonalSkillPackage,
} from '../../personal-skill-package.js';
import {
  readPublicGitHubSource,
  PersonalSkillSourceError,
} from '../../personal-skill-github.js';
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
  const versionArgs =
    input.call.name === 'workspace.personal_skill.version'
      ? PersonalSkillVersionInputSchema.parse(args)
      : null;
  const importArgs =
    versionArgs?.operation === 'update'
      ? 'url' in versionArgs
        ? { url: versionArgs.url }
        : { objectId: versionArgs.objectId }
      : args;
  const call: PersonalSkillImportCall = {
    context: input.context,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    callId: input.call.id,
    arguments: importArgs,
    ...(versionArgs?.operation === 'update'
      ? {
          versionUpdate: {
            installationId: versionArgs.installationId,
            expectedRevision: versionArgs.expectedRevision,
          },
        }
      : {}),
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
    if (versionArgs && versionArgs.operation !== 'update') {
      for (const object of await personalSkillVersionConfirmationFiles({
        ...call,
        arguments: versionArgs,
      }))
        await readPersonalSkillBytes(
          input.storageRoot,
          object,
          personalSkillLimits.archiveBytes,
          input.signal,
        );
      input.signal?.throwIfAborted();
      const result = await personalSkillVersionFromChat({
        ...call,
        arguments: versionArgs,
      });
      return {
        modelContent: JSON.stringify(result),
        summary:
          'status' in result && result.status === 'applied'
            ? '技能版本已变更，下一个任务采用'
            : '个人技能版本信息',
      };
    }
    if ('operation' in PersonalSkillInstallInputSchema.parse(importArgs)) {
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
        let packageData:
          | {
              bytes: Uint8Array;
              inspected: Awaited<
                ReturnType<typeof inspectPersonalSkillPackage>
              >;
              github?: PersonalSkillGitHubSource;
            }
          | undefined;
        let ready:
          Awaited<ReturnType<typeof completePersonalSkillPackage>> | undefined;
        if ('github' in source) {
          if (source.github.previous?.ready) {
            // A previous confirmed staging result is reused before another network read.
            ready = await completePersonalSkillPackage(call);
          } else {
            const frozen = source.github.previous?.source;
            let readUrl = source.github.url;
            if (frozen) {
              const location = parsePersonalSkillGitHubUrl(frozen.requestedUrl);
              const kind = location.kind === 'blob' ? 'blob' : 'tree';
              const path = frozen.sourcePath
                .split('/')
                .map(encodeURIComponent)
                .join('/');
              readUrl = `https://github.com/${frozen.owner}/${frozen.repository}/${kind}/${frozen.commitSha}${path ? '/' + path : ''}`;
            }
            const fetched = await readPublicGitHubSource(readUrl, {
              signal: input.signal,
            }).catch((error: unknown) => {
              if (
                !input.signal?.aborted &&
                error instanceof Error &&
                error.name === 'TimeoutError'
              )
                throw new PersonalSkillSourceError('source_read_timeout');
              throw error;
            });
            if (
              frozen &&
              (frozen.commitSha !== fetched.provenance.commitSha ||
                frozen.treeSha !== fetched.provenance.treeSha ||
                frozen.sourcePath !== fetched.provenance.sourcePath)
            )
              throw new PersonalSkillSourceError('source_snapshot_changed');
            const inspected = await inspectPersonalSkillPackage(
              fetched.files,
              input.signal,
              fetched.candidatePaths,
            );
            const bytes = await createFileArchive(fetched.files, {
              signal: input.signal,
            });
            const github = PersonalSkillGitHubSourceSchema.parse(
              frozen ?? {
                ...fetched.provenance,
                kind: 'github',
                fileName: `github-${fetched.provenance.repository}.zip`,
                originalChecksum: skillBytesChecksum(bytes),
                byteLength: bytes.byteLength,
              },
            );
            if (
              github.originalChecksum !== skillBytesChecksum(bytes) ||
              github.byteLength !== bytes.byteLength
            )
              throw new PersonalSkillSourceError('source_snapshot_changed');
            packageData = { bytes, inspected, github };
          }
        } else {
          if (!('object' in source) || !source.object)
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
          if (zipped)
            packageData = {
              bytes,
              inspected: await readPersonalSkillArchive(bytes, input.signal),
            };
          else
            result = await installPersonalSkillFromChat(
              call,
              await parsePersonalSkill(bytes),
            );
        }
        if (packageData) {
          const candidates = packageData.inspected.map((candidate) => ({
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
            packageData.github,
          );
          if (reservation.writeRequired)
            await storage.put(
              reservation.object,
              new Blob([new Uint8Array(packageData.bytes)]).stream(),
            );
          input.signal?.throwIfAborted();
          ready = await completePersonalSkillPackage(call).catch(
            async (error: unknown) => {
              // Reconcile a late write before retiring only unused private bytes.
              await cleanup().catch(() => undefined);
              throw error;
            },
          );
        }
        if (ready) {
          const targetName =
            'updateName' in source ? source.updateName : undefined;
          const choices = versionArgs
            ? ready.candidates.filter((c) => c.definition?.name === targetName)
            : ready.candidates;
          if (versionArgs && choices.length !== 1)
            throw new PersonalSkillError('source_invalid');
          if (!versionArgs && ready.candidates.length > 1)
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
          const candidate = choices[0]!;
          result = await installPersonalSkillFromChat(call, {
            originalText: candidate.originalText!,
            definition: candidate.definition!,
          });
        }
      }
    }
    if (!result) throw new PersonalSkillError('source_invalid');
    // A confirmed installation must stay confirmed if separate byte retirement
    // fails. Subsequent requests retry only unused copies, never the installation.
    const cleanupPending = await cleanup().then(
      () => false,
      () => true,
    );
    if ('operationId' in result)
      return {
        modelContent: JSON.stringify({
          ...result,
          cleanupPending,
          note: '展示全部受影响员工及固定来源，结束本轮。等待下一条真人按 confirmationText 明确确认，再传 operationId 与 digest；本轮 ask_user 不构成确认。待确认不是更新成功；仅 applied 表示已变更，新任务采用，当前任务仍使用旧版本。',
        }),
        summary:
          result.status === 'unchanged'
            ? '来源与当前版本一致，无需更新'
            : '版本候选已准备，等待确认全部绑定范围',
      };
    return {
      modelContent: JSON.stringify({
        status: 'installed',
        cleanupPending,
        skill: result,
        ...('current' in source
          ? { currentSkill: source.current, receipt: 'original_applied_result' }
          : {}),
        effectiveFrom: 'next_task',
        note:
          'current' in source
            ? '这是原安装操作的固定回执，没有重复安装；当前采用版本及状态以 currentSkill 为准。'
            : '仅绑定本人当前 AI 员工；格式检查通过不代表业务试用通过。可在设置→我的技能停用或卸载。',
      }),
      summary: '个人技能已安装，后续任务可采用',
    };
  } catch (error) {
    if (error instanceof PersonalSkillSourceError) {
      const detail =
        error.code === 'source_ref_ambiguous'
          ? '分支和目录无法唯一确定，请提供固定提交版本的 GitHub 链接。'
          : error.code === 'source_redirect_unsupported'
            ? '链接已重定向，请提供实际公开仓库的链接。'
            : /(?:limit|large)$/u.test(error.code)
              ? '来源超出文件数量或大小限制，请提供更小的技能目录。'
              : /(?:link|lfs)_unsupported$/u.test(error.code)
                ? '包含不支持的链接、子模块或 LFS 文件，请提供完整的普通文件。'
                : '公开来源暂时无法完整读取或校验，请检查链接和可用性。';
      throw rejected(`技能未安装：${detail}`);
    }
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
          intent_required: versionArgs
            ? '需要用户直接明确目标技能、更新来源或回退版本。版本候选必须在下一条真人消息中按展示的确认文字确认全部绑定范围；引用、临时使用、本轮询问和泛泛同意不算授权。'
            : '尚未收到明确安装或选择指令。本次未安装；请用户随公开 GitHub 链接或 SKILL.md / ZIP 说明“请安装我上传的技能包”，或在下一条消息明确选择候选名称并安装。阅读、评价或临时使用不代表安装。',
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

export const versionPersonalSkill = installPersonalSkill;
