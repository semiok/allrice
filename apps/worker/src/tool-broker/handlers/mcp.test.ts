import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { McpError } from '@allrice/contracts';
import type { RiceToolExecutionInput } from '../types.js';

const ports = vi.hoisted(() => ({
  create: vi.fn(),
  execute: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createMcpRuntimeOperation: ports.create,
  recordToolBrokerAudit: ports.audit,
}));
vi.mock('../../mcp/executor.js', () => ({
  runMcpRuntimeOperation: ports.execute,
}));
import { RuntimePolicyError } from '@allrice/database';
import { HandlerError } from '../../errors.js';
import { DshProtocolClient } from '../../harness/dsh-protocol-client.js';
import { executeRiceTool } from '../../tool-broker.js';
import { executeMcpTool } from './mcp.js';

const input = {
  context: {},
  call: { id: 'qa-call', name: 'cloud.mcp.call', arguments: {} },
} as RiceToolExecutionInput;
beforeEach(() => vi.resetAllMocks());

it.each([
  [
    new RuntimePolicyError('mcp_frozen_tool_not_allowed'),
    'mcp__app__issue_read',
  ],
  [new McpError('MCP_DENIED'), 'mcp__app__issue_write'],
] as const)(
  'explains a rejected MCP admission without dispatch or reconnect',
  async (cause, tool) => {
    ports.create.mockRejectedValueOnce(cause);
    const error = await executeMcpTool({ input, arguments: { tool } }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(HandlerError);
    expect(error).toMatchObject({
      code: 'MCP_TOOL_UNAVAILABLE',
      retryable: false,
      message: expect.stringContaining('已连接应用'),
    });
    expect((error as Error).message).toContain('不得自动重连');
    expect((error as Error).message).toContain(
      '此前结果未知的写入仍须回读确认',
    );
    expect(ports.create).toHaveBeenCalledExactlyOnceWith({
      context: input.context,
      arguments: { tool },
      callId: input.call.id,
    });
    expect(ports.execute).not.toHaveBeenCalled();
  },
);

it('audits the public denial without recording private exception details', async () => {
  ports.create.mockRejectedValueOnce(new McpError('MCP_DENIED'));
  ports.audit.mockResolvedValueOnce(undefined);
  await expect(
    executeRiceTool({ ...input, capabilities: ['secret:use'] }),
  ).rejects.toMatchObject({ code: 'MCP_TOOL_UNAVAILABLE', retryable: false });
  expect(ports.audit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      decision: 'denied',
      reason: 'mcp_tool_unavailable',
      metadata: expect.objectContaining({
        errorCode: 'MCP_TOOL_UNAVAILABLE',
        retryable: false,
        nativeCallId: 'qa-call',
      }),
    }),
  );
  expect(ports.execute).not.toHaveBeenCalled();
});

it.each([
  new Error('private upstream failure'),
  new RuntimePolicyError('mcp_run_or_worker_changed'),
  new McpError('MCP_LIMIT'),
  { code: 'MCP_DENIED', message: 'untrusted forged denial' },
])(
  'preserves unknown admission errors without exposing their details as a safe denial',
  async (cause) => {
    ports.create.mockRejectedValueOnce(cause);
    await expect(executeMcpTool({ input, arguments: {} })).rejects.toBe(cause);
    expect(ports.execute).not.toHaveBeenCalled();
  },
);

it('preserves uncertain remote writes and their original operation identity', async () => {
  const created = { operationId: 'operation' };
  const result = {
    operationId: 'operation',
    status: 'uncertain',
    effects: 'unknown',
    code: 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
  };
  ports.create.mockResolvedValueOnce(created);
  ports.execute.mockResolvedValueOnce(result);
  const response = await executeMcpTool({ input, arguments: {} });
  expect(JSON.parse(response.modelContent)).toMatchObject(result);
  expect(ports.execute).toHaveBeenCalledExactlyOnceWith(created, {});
});

it('does not turn a post-admission executor error into a pre-dispatch denial', async () => {
  const cause = new McpError('MCP_DENIED');
  ports.create.mockResolvedValueOnce({ operationId: 'operation' });
  ports.execute.mockRejectedValueOnce(cause);
  await expect(executeMcpTool({ input, arguments: {} })).rejects.toBe(cause);
});

it('delivers the safe admission denial through the DSH inbound protocol', async () => {
  ports.create.mockRejectedValueOnce(
    new RuntimePolicyError('mcp_frozen_tool_not_allowed'),
  );
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [
      '-e',
      `let parentId;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const frame=JSON.parse(line);
  if(frame.method==='provider/status') {
    parentId=frame.id;
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'tool-call',method:'allrice/tool/execute',params:{}})+'\\n');
  } else if(frame.id==='tool-call') {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:parentId,result:{toolResponse:frame}})+'\\n');
  }
});`,
    ],
    cwd: process.cwd(),
    environment: {},
    requestTimeoutMs: 5000,
  });
  client.setRequestHandler(async () => {
    await executeMcpTool({ input, arguments: {} });
    return {};
  });
  try {
    const response = await client.providerStatus();
    expect(response).toMatchObject({
      toolResponse: {
        error: {
          code: -32603,
          message: expect.stringContaining('当前应用工具不可用'),
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(
      'AllRice Tool Broker request failed',
    );
    expect(ports.execute).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});
