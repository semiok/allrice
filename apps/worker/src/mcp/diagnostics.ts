import { setTimeout as delay } from 'node:timers/promises';
import { McpError } from '@allrice/contracts';

type Phase = 'initialize' | 'tools_list' | 'tools_call';
const networkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
]);
type Diagnostic = {
  phase: Phase;
  reason: 'http_error' | 'network' | 'timeout' | 'protocol';
  httpStatus?: number;
  retryAfterMs?: number;
  networkCode?: string;
  requestDispatched: boolean;
  connectionAttempts: number;
};

/** Only allowlisted facts leave the transport. Never retain SDK messages,
 * server bodies, headers, endpoint URLs or credentials in diagnostics. */
export class McpTransportError extends McpError {
  constructor(
    code: McpError['code'],
    public readonly diagnostic: Diagnostic,
  ) {
    super(code);
  }
}

export function mcpNetworkError(error: unknown, phase: Phase = 'initialize') {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  return new McpTransportError('MCP_UNAVAILABLE', {
    phase,
    reason: code.includes('TIME') ? 'timeout' : 'network',
    ...(networkCodes.has(code) ? { networkCode: code } : {}),
    requestDispatched: phase === 'tools_call',
    connectionAttempts: 1,
  });
}

export function mcpRequestDiagnostics(request: typeof fetch) {
  let phase: Phase = 'initialize';
  let failure: McpError | undefined;
  const fetch: typeof request = async (url, init) => {
    let method: unknown;
    try {
      method = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      ).method;
    } catch {
      // Non-JSON OAuth bodies and notifications are outside MCP call tracing.
    }
    const tracked = ['initialize', 'tools/list', 'tools/call'].includes(
      String(method),
    );
    if (tracked)
      phase =
        method === 'tools/call'
          ? 'tools_call'
          : method === 'tools/list'
            ? 'tools_list'
            : 'initialize';
    try {
      const response = await request(url, init);
      if (tracked) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs =
          retryAfter === null
            ? undefined
            : /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now());
        failure = response.ok
          ? undefined
          : new McpTransportError(
              response.status === 401
                ? 'MCP_CREDENTIAL_UNAVAILABLE'
                : response.status === 403
                  ? 'MCP_DENIED'
                  : 'MCP_UNAVAILABLE',
              {
                phase,
                reason: 'http_error',
                httpStatus: response.status,
                ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
                requestDispatched: phase === 'tools_call',
                connectionAttempts: 1,
              },
            );
      }
      return response;
    } catch (error) {
      if (tracked)
        failure =
          error instanceof McpTransportError
            ? new McpTransportError(error.code, {
                ...error.diagnostic,
                phase,
                requestDispatched: phase === 'tools_call',
              })
            : error instanceof McpError
              ? error
              : error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  networkCodes.has(String(error.code))
                ? mcpNetworkError(error, phase)
                : new McpTransportError('MCP_UNAVAILABLE', {
                    phase,
                    reason: 'protocol',
                    requestDispatched: phase === 'tools_call',
                    connectionAttempts: 1,
                  });
      throw error;
    }
  };
  return {
    fetch,
    error(error: unknown): McpError {
      return (
        failure ??
        (error instanceof McpError
          ? error
          : new McpTransportError('MCP_UNAVAILABLE', {
              phase,
              reason: 'protocol',
              requestDispatched: phase === 'tools_call',
              connectionAttempts: 1,
            }))
      );
    },
  };
}

export function mcpUnknownError(error: unknown) {
  return new McpTransportError('MCP_UNKNOWN', {
    ...(error instanceof McpTransportError
      ? error.diagnostic
      : { reason: 'protocol' as const, connectionAttempts: 1 }),
    phase: 'tools_call',
    requestDispatched: true,
  });
}

export async function withMcpConnectionRetry<T>(
  signal: AbortSignal,
  action: () => Promise<T>,
  allowRetry = true,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (signal.aborted) throw new McpError('MCP_CANCELED');
      return await action();
    } catch (error) {
      if (!(error instanceof McpTransportError)) throw error;
      error.diagnostic.connectionAttempts = attempt;
      const d = error.diagnostic;
      const transient =
        d.reason === 'network' ||
        d.reason === 'timeout' ||
        (d.reason === 'http_error' &&
          [429, 502, 503, 504].includes(d.httpStatus ?? 0));
      if (
        !allowRetry ||
        attempt >= 2 ||
        signal.aborted ||
        error.code !== 'MCP_UNAVAILABLE' ||
        d.requestDispatched ||
        (d.retryAfterMs ?? 0) > 2000 ||
        !transient
      )
        throw error;
      try {
        await delay(Math.max(500, d.retryAfterMs ?? 0), undefined, { signal });
      } catch {
        throw new McpError('MCP_CANCELED');
      }
    }
  }
}

export function mcpDiagnosticOutput(error: McpTransportError) {
  return JSON.stringify({
    diagnostic: error.diagnostic,
    notice: error.diagnostic.requestDispatched
      ? '工具请求已发出，但没有收到完整结果。请先核实远端结果，不得自动重试。'
      : '连接应用失败，工具请求尚未发出。请依据诊断信息判断原因，不要推断为账号权限不足。',
  });
}
