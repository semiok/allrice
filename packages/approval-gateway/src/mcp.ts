import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodError } from 'zod';
import {
  ApprovalError,
  ApprovalRefSchema,
  ApprovalStageSchema,
  type ApprovalBinding,
  type ApprovalView,
} from './contract.js';
import type { ApprovalGateway } from './gateway.js';

/** Attach only after the managed host connection is authenticated by MET-269.
 * Native MCP request IDs correlate calls; they never authenticate a person. */
export function createApprovalMcpServer(options: {
  gateway: ApprovalGateway;
  resolveCall(
    requestId: string | number,
    signal: AbortSignal,
  ): Promise<ApprovalBinding>;
}) {
  const server = new McpServer({
    name: 'allrice-outbound-approval',
    version: '1.0.0',
  });
  async function result(run: () => Promise<ApprovalView>) {
    try {
      const view = await run();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(view) }],
        structuredContent: { ...view },
      };
    } catch (error) {
      const code =
        error instanceof ApprovalError
          ? error.code
          : error instanceof ZodError
            ? 'INVALID_INPUT'
            : 'UNAVAILABLE';
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ code }) }],
        structuredContent: { code },
      };
    }
  }
  server.registerTool(
    'outbound.stage',
    {
      description:
        '冻结待外发的目标、正文和附件版本，交由用户在可信页面确认。此工具不能批准外发。',
      inputSchema: ApprovalStageSchema,
    },
    (input, extra) =>
      result(async () =>
        options.gateway.stage(
          await options.resolveCall(extra.requestId, extra.signal),
          input,
          extra.signal,
        ),
      ),
  );
  server.registerTool(
    'outbound.execute',
    {
      description: '执行已由真人确认的精确请求；结果未知时不重新发送。',
      inputSchema: ApprovalRefSchema,
    },
    (input, extra) =>
      result(async () =>
        options.gateway.execute(
          await options.resolveCall(extra.requestId, extra.signal),
          input,
          extra.signal,
        ),
      ),
  );
  server.registerTool(
    'outbound.status',
    {
      description: '读取当前有权访问的冻结请求及实际外发回执。',
      inputSchema: ApprovalRefSchema,
    },
    (input, extra) =>
      result(async () =>
        options.gateway.status(
          await options.resolveCall(extra.requestId, extra.signal),
          input,
          extra.signal,
        ),
      ),
  );
  return server;
}
