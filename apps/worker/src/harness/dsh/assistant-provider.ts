import {
  AssistantSubscriptionSnapshotSchema,
  type AssistantSubscriptionSnapshot,
} from '@allrice/contracts';
import { HandlerError } from '../../errors.js';
import type { HarnessExecutionInput } from '../adapter.js';

/** Server-owned route only. A client preference cannot declare protocol support.
 * This must run before credentials/native acquisition AND before accounting is
 * marked unknown: a refused preflight has made exactly zero model calls.
 * Codex subscription uses call/concurrency limits and observed-token thresholds,
 * NOT a claimed provider-enforced output cap. Its exact frozen identity is
 * independently verified by the Worker and controller before dispatch. */
export function assertAssistantProviderOutputBound(
  provider: HarnessExecutionInput['providerSnapshot'],
  enabled: boolean,
  subscriptionSnapshot?: AssistantSubscriptionSnapshot,
) {
  if (!enabled) return;
  if (subscriptionSnapshot !== undefined) {
    const parsed =
      AssistantSubscriptionSnapshotSchema.safeParse(subscriptionSnapshot);
    if (
      !parsed.success ||
      provider.provider !== 'dsh' ||
      provider.route !== 'openai-codex' ||
      provider.authMode !== 'platform_subscription' ||
      provider.model !== parsed.data.model ||
      provider.credentialReference !== parsed.data.credentialReference ||
      provider.baseUrl !== null
    )
      throw new HandlerError(
        'ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED',
        '订阅身份与冻结执行路线不一致；本次未启动助手。',
        false,
      );
    return;
  }
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
