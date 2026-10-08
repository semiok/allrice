import { LocalCommandError } from './local-command-inputs.js';

const networkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
]);

/** Never retain arbitrary exception messages, URLs, headers or host paths. */
export function inputDownloadNetworkReason(error: unknown): string {
  for (
    let depth = 0;
    depth < 4 && error && typeof error === 'object';
    depth++
  ) {
    const value = error as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && networkCodes.has(value.code))
      return value.code;
    if (value.name === 'TimeoutError') return 'timeout';
    if (value.name === 'AbortError') return 'canceled';
    error = value.cause;
  }
  return 'network_unknown';
}

export function inputDownloadAbortReason(
  reason: unknown,
): 'timeout' | 'canceled' {
  return reason &&
    typeof reason === 'object' &&
    'name' in reason &&
    reason.name === 'TimeoutError'
    ? 'timeout'
    : 'canceled';
}

export class LocalPythonInputDownloadError extends LocalCommandError {
  constructor(
    code:
      | 'INPUT_DOWNLOAD_UNAVAILABLE'
      | 'INPUT_VERSION_CHANGED'
      | 'INPUT_LIMIT'
      | 'EXECUTION_REVOKED',
    readonly diagnostic: {
      objectId: string;
      stage: 'response' | 'body' | 'validation';
      reason: string;
      httpStatus: number | null;
      expectedBytes: number;
      receivedBytes: number;
      elapsedMs: number;
    },
  ) {
    super(code);
  }

  /** The existing durable summary carries diagnostics, never execution output.
   * Worker can still prove the known failure happened before container creation. */
  receiptSummary(purpose: 'office' | 'python_charts') {
    const d = this.diagnostic;
    return `本地 ${purpose === 'office' ? 'Office' : 'Python'} 输入下载失败；对象 ${d.objectId}；阶段 ${d.stage}；原因 ${d.reason}；HTTP ${d.httpStatus ?? '无响应'}；字节 ${d.receivedBytes}/${d.expectedBytes}；耗时 ${d.elapsedMs}ms。已确认未执行或换端。`;
  }
}
