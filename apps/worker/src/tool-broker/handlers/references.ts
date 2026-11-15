import {
  ReferenceRuntimeError,
  ReferenceArchiveInputError,
  ReferenceImageReadError,
  EmployeeRuntimeContentError,
  ReferenceToolResultLimitError,
  ReferenceReadOffsetError,
  DataAccessError,
} from '@allrice/database';
import {
  ReferenceSearchInputSchema,
  ReferenceReadInputSchema,
  ReferenceReadImageInputSchema,
  ReferenceArchiveReadInputSchema,
  ReferenceArchiveListInputSchema,
} from '@allrice/contracts';
import { HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';

export const executeReferenceTool: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const name = input.call.name;
  if (
    !input.executeReferenceTool ||
    (name !== 'workspace.reference.search' &&
      name !== 'workspace.reference.read' &&
      name !== 'workspace.reference.read_image' &&
      name !== 'workspace.reference.archive_list' &&
      name !== 'workspace.reference.archive_read')
  )
    throw new HandlerError(
      'REFERENCE_UNAVAILABLE',
      '企业资料读取未绑定到本次运行。',
      false,
    );
  const parsed = (
    name === 'workspace.reference.search'
      ? ReferenceSearchInputSchema
      : name === 'workspace.reference.archive_list'
        ? ReferenceArchiveListInputSchema
        : name === 'workspace.reference.archive_read'
          ? ReferenceArchiveReadInputSchema
          : name === 'workspace.reference.read_image'
            ? ReferenceReadImageInputSchema
            : ReferenceReadInputSchema
  ).parse(args);
  try {
    input.signal?.throwIfAborted();
    const result = await input.executeReferenceTool(name, parsed, input.signal);
    return {
      ...result,
      summary:
        name === 'workspace.reference.search'
          ? `已检索企业资料 · ${result.itemCount} 项`
          : name === 'workspace.reference.archive_list'
            ? `已读取企业资料目录 · ${result.itemCount} 项`
            : name === 'workspace.reference.archive_read'
              ? result.itemCount === 0
                ? '已到成员正文末尾'
                : '已读取企业资料 ZIP 成员'
              : name === 'workspace.reference.read_image'
                ? '已读取企业资料图片'
                : result.itemCount === 0
                  ? '已到资料正文末尾'
                  : '已读取企业资料正文',
    };
  } catch (error) {
    if (error instanceof ReferenceImageReadError)
      throw new HandlerError(error.code, error.message, error.retryable, {
        cause: error,
        reason: error.reason,
      });
    if (
      error instanceof ReferenceArchiveInputError ||
      error instanceof ReferenceRuntimeError ||
      error instanceof EmployeeRuntimeContentError ||
      error instanceof ReferenceToolResultLimitError ||
      error instanceof ReferenceReadOffsetError
    )
      throw new HandlerError(error.code, error.message, false, {
        cause: error,
      });
    if (error instanceof DataAccessError)
      throw new HandlerError(
        'REFERENCE_UNAVAILABLE',
        '企业资料当前不可读取。',
        false,
        { cause: error },
      );
    throw error;
  }
};
