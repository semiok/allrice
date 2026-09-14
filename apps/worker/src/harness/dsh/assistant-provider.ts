import { HandlerError } from '../../errors.js';
import type { HarnessExecutionInput } from '../adapter.js';

/** Server-owned route only. A client preference cannot declare protocol support.
 * This must run before credentials/native acquisition AND before accounting is
 * marked unknown: a refused preflight has made exactly zero model calls. */
export function assertAssistantProviderOutputBound(
  provider: HarnessExecutionInput['providerSnapshot'],
  enabled: boolean,
) {
  if (!enabled) return;
  if (
    provider.provider !== 'dsh' ||
    !['openai-compatible', 'gemini'].includes(provider.route)
  )
    throw new HandlerError(
      'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED',
      '当前模型协议尚未验证助手输出上限；本次未启动模型或原生助手。',
      false,
    );
}
