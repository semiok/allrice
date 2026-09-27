import {
  CodexImageReceiptSchema,
  type PlatformModelConfiguration,
} from '@allrice/contracts';
import { createCodexProviderClient } from './codex-search-broker.js';
import { HandlerError } from './errors.js';

export async function requestCodexImage(input: {
  configuration: PlatformModelConfiguration;
  prompt: string;
  source?: { mediaType: string; data: string };
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted)
    throw new HandlerError('IMAGE_CANCELED', '图片任务已取消', false);
  const client = await createCodexProviderClient('codex-images');
  const cancel = () => {
    void client.close();
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (input.signal?.aborted)
      throw new HandlerError('IMAGE_CANCELED', '图片任务已取消', false);
    return CodexImageReceiptSchema.parse(
      await client.generateCodexImage({
        workModel: input.configuration.workModel,
        imageModel: input.configuration.imageModel,
        prompt: input.prompt,
        ...(input.source ? { source: input.source } : {}),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code =
      [
        'IMAGE_AUTH_REQUIRED',
        'IMAGE_RATE_LIMITED',
        'IMAGE_MODEL_UNAVAILABLE',
        'IMAGE_GENERATION_FAILED',
        'IMAGE_RESULT_INVALID',
        'IMAGE_CANCELED',
      ].find((c) => message.includes(c)) ?? 'IMAGE_RESULT_UNKNOWN';
    const descriptions: Record<string, string> = {
      IMAGE_AUTH_REQUIRED: '图片授权不可用，请在平台设置中检查 Codex 订阅。',
      IMAGE_RATE_LIMITED: '图片服务额度或速率受限，请稍后再试。',
      IMAGE_MODEL_UNAVAILABLE: '当前订阅暂不支持所选图片模型或参数。',
      IMAGE_GENERATION_FAILED: '图片服务未完成本次请求。',
      IMAGE_RESULT_INVALID: '图片服务返回的结果无法验证。',
      IMAGE_CANCELED: '图片任务已取消。',
      IMAGE_RESULT_UNKNOWN:
        '未取得完整图片回执，结果待核对，请勿自动重复生成。',
    };
    throw new HandlerError(code, descriptions[code]!, false);
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    await client.close();
  }
}
