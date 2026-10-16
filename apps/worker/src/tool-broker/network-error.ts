import { RuntimePolicyError } from '@allrice/database';
import {
  HandlerError,
  confirmToolFailure,
  isConfirmedToolFailure,
} from '../errors.js';

export function sandboxNetworkError(
  cause: unknown,
  identity: { runId: string; callId: string; toolName: string },
) {
  if (!(cause instanceof RuntimePolicyError)) return cause;
  const message =
    cause.code === 'sandbox_network_destination_blocked'
      ? '后台网络检查已拦截本次访问的地址。无需用户填写网址；请说明访问未获放行，不得更换地址或工具绕过。'
      : cause.code === 'sandbox_network_check_unavailable'
        ? '后台网络检查暂时不可用，本次未取得放行结果。无需用户修改联网设置；保留已完成工作，不得重跑结果未知的操作。'
        : null;
  if (!message) return cause;
  const error = new HandlerError(cause.code.toUpperCase(), message, false);
  // Preserve PR421's exact pre-dispatch proof. A code alone never proves a
  // write stopped or authorizes replay of an uncertain execution.
  if (isConfirmedToolFailure(cause, identity))
    confirmToolFailure(error, identity);
  return error;
}
