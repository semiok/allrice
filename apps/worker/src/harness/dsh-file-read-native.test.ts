import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
const ports = vi.hoisted(() => ({
  file: vi.fn(),
  audit: vi.fn(async () => undefined),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<object>()),
  getToolBrokerFile: ports.file,
  recordToolBrokerAudit: ports.audit,
}));
import { DataAccessError } from '@allrice/database';
import { executeRiceTool } from '../tool-broker.js';
import { HandlerError, isConfirmedToolFailure } from '../errors.js';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
import { dshInboundToolHandler, parseDshToolCall } from './dsh/tool-bridge.js';
import { textBlocks } from './dsh/event-projector.js';

beforeEach(() => vi.clearAllMocks());
function fixture() {
  const organizationId = randomUUID(),
    owner = randomUUID();
  const input: RiceToolExecutionInput = {
    capabilities: ['storage:read'],
    storageRoot: '/must-not-read-on-denial',
    context: {
      executionId: randomUUID(),
      runId: randomUUID(),
      jobId: randomUUID(),
      worker: { type: 'worker', id: randomUUID() },
      delegatedBy: { type: 'user', id: owner },
      organizationId,
      workspaceId: randomUUID(),
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: randomUUID(),
        organizationId,
        subjectId: owner,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        memberships: [],
        grants: [],
      },
    },
    call: {
      id: 'read-saved-material-entry',
      nativeSessionId: randomUUID(),
      name: 'workspace.file.read',
      arguments: { objectId: randomUUID(), offset: 0, limit: 4000 },
    },
  };
  return input;
}
it('the real Broker confirms only the actual native file ACL rejection, bound to this Run/call/tool', async () => {
  const input = fixture();
  ports.file.mockRejectedValueOnce(new DataAccessError('authorization_denied'));
  const error = await executeRiceTool(input).catch((e: unknown) => e);
  const identity = {
    runId: input.context.runId,
    callId: input.call.id,
    toolName: input.call.name,
  };
  expect(error).toBeInstanceOf(HandlerError);
  expect(error).toMatchObject({
    code: 'TOOL_FILE_ACCESS_DENIED',
    retryable: false,
  });
  expect(isConfirmedToolFailure(error, identity)).toBe(true);
  for (const mismatch of [
    { runId: randomUUID() },
    { callId: 'other' },
    { toolName: 'workspace.export.create' },
  ])
    expect(isConfirmedToolFailure(error, { ...identity, ...mismatch })).toBe(
      false,
    );
  expect(
    isConfirmedToolFailure({ code: 'TOOL_FILE_ACCESS_DENIED' }, identity),
  ).toBe(false);
  expect(ports.file).toHaveBeenCalledOnce();
  expect(ports.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      decision: 'denied',
      reason: 'tool_file_access_denied',
    }),
  );
});
it.each(['legacy', 'not-found', 'unknown', 'canceled'])(
  'does not relabel %s as confirmed ACL rejection',
  async (kind) => {
    const input = fixture();
    const cause =
      kind === 'unknown'
        ? Error('unknown read state')
        : new DataAccessError(
            kind === 'not-found' ? 'not_found' : 'authorization_denied',
          );
    if (kind === 'legacy') delete input.call.nativeSessionId;
    const controller = new AbortController();
    if (kind === 'canceled') {
      controller.abort(Error('canceled'));
      input.signal = controller.signal;
    }
    ports.file.mockRejectedValueOnce(cause);
    const error = await executeRiceTool(input).catch((e: unknown) => e);
    expect(error).toBe(kind === 'canceled' ? controller.signal.reason : cause);
    expect(
      isConfirmedToolFailure(error, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      }),
    ).toBe(false);
  },
);
it('读取我之前保存的资料入口并完成核对: one native denied read, safe error, normal final response; no envelope dispatch', async () => {
  const input = fixture();
  ports.file.mockRejectedValue(new DataAccessError('authorization_denied'));
  await nativeBrokerRoundtrip({
    prompt: '读取我之前保存的资料入口并完成核对。',
    fileReadRunId: input.context.runId,
    canonicalName: input.call.name,
    wireName: 'workspace_file_read',
    args: input.call.arguments,
    invalidArgs: { ...input.call.arguments, limit: 4001 },
    expectedToolError: 'TOOL_FILE_ACCESS_DENIED',
    onToolCall: (call) => executeRiceTool({ ...input, call }),
    inspectSchema(schema) {
      expect(Object.keys(schema.properties as object).sort()).toEqual([
        'limit',
        'objectId',
        'offset',
      ]);
      expect(schema.additionalProperties).toBe(false);
    },
  });
  expect(ports.file).toHaveBeenCalledOnce();
  expect(ports.audit).toHaveBeenCalledWith(
    expect.objectContaining({ decision: 'denied' }),
  );
}, 45000);
it('an unknown native read terminates before any further model request and is not returned as a safe tool error', async () => {
  const input = fixture();
  ports.file.mockRejectedValue(Error('synthetic unknown file read'));
  await nativeBrokerRoundtrip({
    fileReadRunId: input.context.runId,
    canonicalName: input.call.name,
    wireName: 'workspace_file_read',
    args: input.call.arguments,
    invalidArgs: {},
    expectedTerminalError: 'synthetic unknown file read',
    onToolCall: (call) => executeRiceTool({ ...input, call }),
  });
  expect(ports.file).toHaveBeenCalledOnce();
}, 45000);
it('rejects a child/foreign native file invocation before entering the Broker', async () => {
  const input = fixture(),
    call = vi.fn();
  const inbound = dshInboundToolHandler({
    tools: [{ name: input.call.name, description: '', inputSchema: {} }],
    onToolCall: call,
    fileReadRoot: {
      nativeSessionId: 'root',
      runId: input.context.runId,
      signal: new AbortController().signal,
    },
  });
  await expect(
    inbound('allrice/tool-call', {
      name: input.call.name,
      nativeSessionId: 'child',
      toolCallId: 'call',
      arguments: input.call.arguments,
    }),
  ).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
  expect(call).not.toHaveBeenCalled();
});
it('the old two-phase/multiple-envelope path remains fail-closed, including other tools', () => {
  for (const name of ['workspace.file.read', 'automation.create']) {
    const envelope = `<allrice_tool_call>${JSON.stringify({ id: 'same', name, arguments: {} })}</allrice_tool_call>`;
    expect(() =>
      parseDshToolCall(
        textBlocks([
          { type: 'text', text: envelope + ' \n' },
          { type: 'text', text: envelope },
        ]),
      ),
    ).toThrow('more than one AllRice tool envelope');
  }
});
