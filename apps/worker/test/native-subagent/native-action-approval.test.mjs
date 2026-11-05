import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RuntimeActionApprovalRequestSchema } from '@allrice/contracts';
import { host, gate, text } from './fixture.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
function prepared(runId, user) {
  const task = {
    scope: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      projectId: null,
    },
    chatSessionId: randomUUID(),
    runId,
    rootRunId: runId,
    parentRunId: null,
    frozenConfiguration: { employeeVersionId: randomUUID(), digest },
  };
  const binding = {
    task,
    attempt: {
      operationId: randomUUID(),
      attemptId: randomUUID(),
      attemptNumber: 1,
      generation: 1,
      fence: 1,
    },
    requestedBy: { type: 'user', id: user },
    policy: { snapshotId: randomUUID(), digest },
    execution: {
      targetId: randomUUID(),
      targetKind: 'cloud_mcp',
      deviceId: null,
      grantId: randomUUID(),
      grantVersion: 1,
      scopeDigest: digest,
      workCopy: { id: randomUUID(), kind: 'remote_service' },
    },
    action: 'cloud.mcp.call',
    inputDigest: digest,
    dataScope: [],
    baseline: [],
    command: null,
  };
  return RuntimeActionApprovalRequestSchema.parse({
    contractVersion: 1,
    direction: 'request',
    kind: 'action_approval',
    requestId: randomUUID(),
    version: 1,
    requestDigest: digest,
    task,
    respondentId: user,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvalId: binding.attempt.operationId,
    binding,
  });
}
const response = (request, decision = 'approved') => ({
  contractVersion: 1,
  direction: 'response',
  kind: 'action_approval',
  requestId: request.requestId,
  version: 1,
  requestDigest: request.requestDigest,
  task: request.task,
  responseId: randomUUID(),
  respondedBy: request.respondentId,
  respondedAt: new Date().toISOString(),
  approvalId: request.approvalId,
  decision,
});

it.each(['approved', 'rejected'])(
  '“只追加一条记录”：the real native outcome is %s and the live answer disappears',
  async (decision) => {
    const runId = randomUUID(),
      user = randomUUID(),
      started = gate();
    let requested, result, h;
    const request = prepared(runId, user);
    h = await host({
      runId,
      nativeTools: ['cloud.mcp.call'],
      bridge: async (method, params) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        expect(method).toBe('allrice/tool-call');
        requested = h.server.handleRequest('native-action/request', {
          sessionId: h.root.id,
          callId: params.toolCallId,
          request,
        });
        started.resolve();
        result = await requested;
        if (result.outcome === 'allowed-once')
          await h.server.handleRequest('native-action/verify', {
            sessionId: h.root.id,
            callId: params.toolCallId,
            requestId: request.requestId,
          });
        return { modelContent: JSON.stringify(result), summary: 'controlled' };
      },
      model: async (_r, n) =>
        n === 1
          ? [
              {
                type: 'tool-call',
                id: 'append-call',
                name: 'cloud_mcp_call',
                arguments: JSON.stringify({
                  connectionId: randomUUID(),
                  tool: 'records.append',
                  arguments: { value: 'S-Q2' },
                }),
              },
            ]
          : text('完成'),
    });
    await h.prompt('向验收记录服务只追加一条 S-Q2，不要做其他修改。');
    await started.promise;
    const query = {
      sessionId: h.root.id,
      actorId: user,
      runId,
      approvalId: request.approvalId,
    };
    await expect
      .poll(async () => {
        try {
          return await h.server.handleRequest('native-action/read', query);
        } catch {
          return null;
        }
      })
      .toMatchObject({ request });
    await expect(
      h.server.handleRequest('native-action/answer', {
        ...query,
        actorId: randomUUID(),
        response: response(request, decision),
      }),
    ).rejects.toThrow();
    await expect(
      h.server.handleRequest('native-action/answer', {
        ...query,
        response: {
          ...response(request, decision),
          requestDigest: `sha256:${'b'.repeat(64)}`,
        },
      }),
    ).rejects.toThrow();
    await h.server.handleRequest('native-action/answer', {
      ...query,
      response: response(request, decision),
    });
    await h.wait();
    expect(result.outcome).toBe(
      decision === 'approved' ? 'allowed-once' : 'rejected',
    );
    expect(
      h.root.session
        .snapshotEvents()
        .filter((e) => e.type === 'approval/asked'),
    ).toHaveLength(1);
    expect(
      h.root.session
        .snapshotEvents()
        .filter((e) => e.type === 'approval/decided'),
    ).toHaveLength(1);
    await expect(
      h.server.handleRequest('native-action/read', query),
    ).rejects.toThrow();
    await expect(
      h.server.handleRequest('native-action/verify', {
        sessionId: h.root.id,
        callId: 'append-call',
        requestId: request.requestId,
      }),
    ).rejects.toThrow();
  },
);

it('native cancellation removes the borrowed answerer; late approval cannot execute', async () => {
  const runId = randomUUID(),
    started = gate(),
    request = prepared(runId, randomUUID());
  let h, outcome;
  h = await host({
    runId,
    nativeTools: ['cloud.mcp.call'],
    model: async (_r, n) =>
      n === 1
        ? [
            {
              type: 'tool-call',
              id: 'cancel-call',
              name: 'cloud_mcp_call',
              arguments: JSON.stringify({
                connectionId: randomUUID(),
                tool: 'records.append',
                arguments: { value: 'cancel' },
              }),
            },
          ]
        : text('完成'),
    bridge: async (method, params) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      const pending = h.server.handleRequest('native-action/request', {
        sessionId: h.root.id,
        callId: params.toolCallId,
        request,
      });
      started.resolve();
      outcome = await pending;
      return { modelContent: outcome.outcome, summary: 'not executed' };
    },
  });
  await h.prompt('只追加一条，取消后不要执行。');
  await started.promise;
  await h.server.handleRequest('session/interrupt', { sessionId: h.root.id });
  await h.wait();
  expect(outcome.outcome).toBe('cancelled');
  await expect(
    h.server.handleRequest('native-action/answer', {
      sessionId: h.root.id,
      actorId: request.respondentId,
      runId,
      approvalId: request.approvalId,
      response: response(request),
    }),
  ).rejects.toThrow();
});
