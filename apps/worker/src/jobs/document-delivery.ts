import { HandlerError } from '../errors.js';
import type { HarnessToolCall } from '../harness/adapter.js';

/** Tracks actual export receipts, not the model's prose or an older download. */
export function documentDeliveryGuard() {
  const formats = new Map<string, boolean>();
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
      try {
        const result = await execute();
        if (format) formats.set(format, true);
        return result;
      } catch (error) {
        if (format) formats.set(format, false);
        throw error;
      }
    },
    assertComplete() {
      const missing = [...formats]
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
