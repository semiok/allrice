import { z } from 'zod';

export const McpFailureKindSchema = z.enum([
  'github_merge_permission',
  'authentication',
  'remote_error',
  'unavailable',
  'result_unknown',
]);
export type McpFailureKind = z.infer<typeof McpFailureKindSchema>;

/** Presentation only: a reported error does not prove rollback of remote effects.
 * Never use this classification to grant permission, change a receipt or retry.
 * Only fixed public copy is exposed; raw remote output is not user instructions.
 */
export function classifyMcpFailure(input: {
  code: string | null;
  output?: string | null;
  endpoint?: string | null;
  tool?: string | null;
}): McpFailureKind | null {
  if (input.code === 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN') {
    if (
      input.endpoint === 'https://api.githubcopilot.com/mcp/' &&
      ['mcp__app__merge_pull_request', 'merge_pull_request'].includes(
        input.tool ?? '',
      )
    ) {
      try {
        const result = JSON.parse((input.output ?? '').slice(0, 20_000));
        const message = result?.error?.message;
        if (
          result?.isError === true &&
          typeof message === 'string' &&
          /^failed to merge pull request: PUT https:\/\/api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/pulls\/\d+\/merge: 403 Resource not accessible by personal access token(?: \[\])?$/.test(
            message,
          )
        )
          return 'github_merge_permission';
      } catch {
        // Missing/malformed remote diagnostics retain the generic error label.
      }
    }
    return 'remote_error';
  }
  if (input.code === 'MCP_UNAVAILABLE') return 'unavailable';
  if (
    ['MCP_CREDENTIAL_UNAVAILABLE', 'MCP_AUTH_REQUIRED'].includes(
      input.code ?? '',
    )
  )
    return 'authentication';
  if (input.code === 'MCP_UNKNOWN') return 'result_unknown';
  return null;
}

export const mcpFailureCopy: Record<
  McpFailureKind,
  { title: string; detail: string }
> = {
  github_merge_permission: {
    title: 'GitHub 权限不足',
    detail:
      '这次合并请求被 GitHub 拒绝（403）。请检查访问令牌是否包含目标仓库，以及 Contents 的 Read and write 权限。如已更新权限，可重新发起任务；本次调用不会自动重试。',
  },
  authentication: {
    title: '应用授权需要更新',
    detail:
      '应用连接的凭据不可用。请到「设置 → 已连接应用」更新授权后，重新发起任务。',
  },
  remote_error: {
    title: '应用返回错误',
    detail:
      '已收到应用的错误回复。请核对应用中的操作结果，再决定如何继续；本次调用不会自动重试。',
  },
  unavailable: {
    title: '应用连接暂时不可用',
    detail:
      '连接应用时失败，本次调用尚未发出。请检查连接状态后，重新发起任务。',
  },
  result_unknown: {
    title: '未收到应用执行结果',
    detail:
      '未收到完整的执行结果，无法确认操作是否完成。请先到应用中核实；本次调用不会自动重试。',
  },
};
