import { createHash } from 'node:crypto';
import {
  canonicalRuntimeBridgeJson,
  resolveSubscriptionSnapshot,
  type SubscriptionSnapshot,
} from '@allrice/contracts';
import { HandlerError } from './errors.js';

export function subscriptionSnapshotDigest(snapshot: SubscriptionSnapshot) {
  return `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(snapshot)).digest('hex')}`;
}

/** Every ordinary Run keeps its server-frozen Codex subscription identity. */
export function preflightSubscription(
  input: Parameters<typeof resolveSubscriptionSnapshot>[0],
) {
  try {
    return resolveSubscriptionSnapshot(input);
  } catch {
    throw new HandlerError(
      'ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED',
      '订阅身份与冻结执行路线不一致；本次未授权新的模型调用。',
      false,
    );
  }
}
