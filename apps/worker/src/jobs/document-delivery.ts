import { HandlerError } from '../errors.js';
import type { HarnessToolCall } from '../harness/adapter.js';

/** Tracks actual export receipts, not the model's prose or an older download. */
export function documentDeliveryGuard() {
  const files = new Map<string, boolean>();
  return {
    async execute<T>(
      call: HarnessToolCall,
      execute: () => Promise<T>,
    ): Promise<T> {
      const format =
        call.name === 'workspace.export.create' &&
        typeof call.arguments.format === 'string'
          ? call.arguments.format
          : null;
      const file = format
        ? `${String(call.arguments.fileName ?? format)} (${format})`
        : null;
      try {
        const result = await execute();
        if (file) files.set(file, true);
        return result;
      } catch (error) {
        if (file) files.set(file, false);
        throw error;
      }
    },
    assertComplete() {
      const missing = [...files]
        .filter(([, completed]) => !completed)
        .map(([format]) => format);
      if (missing.length)
        throw new HandlerError(
          'DOCUMENT_DELIVERY_INCOMPLETE',
          `本轮 ${missing.join('、')} 文件未收到成功交付回执，已有内容和历史文件已保留。`,
          false,
        );
    },
  };
}
