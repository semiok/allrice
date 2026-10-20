import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RiceToolHandlerContext } from '../types.js';

const { create, createRecurring } = vi.hoisted(() => ({
  create: vi.fn(),
  createRecurring: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createOnceTaskFromExecutionContext: create,
  createRecurringTaskFromExecutionContext: createRecurring,
}));
import {
  NativeOnceProductError,
  NativeRecurringProductError,
} from '@allrice/database';
import { createAutomation } from './automation.js';
import { isConfirmedToolFailure } from '../../errors.js';

function call(): RiceToolHandlerContext {
  const ownerId = randomUUID(),
    organizationId = randomUUID();
  const args = { name: '测试', prompt: '只回复校验词', delayMinutes: 15 };
  return {
    arguments: args,
    input: {
      context: {
        executionId: randomUUID(),
        runId: randomUUID(),
        jobId: randomUUID(),
        worker: { type: 'worker', id: randomUUID() },
        delegatedBy: { type: 'user', id: ownerId },
        organizationId,
        workspaceId: randomUUID(),
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: randomUUID(),
          organizationId,
          subjectId: ownerId,
          version: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          memberships: [],
          grants: [],
        },
      },
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      storageRoot: '/unused-synthetic',
      capabilities: ['automation:write'],
      call: { id: randomUUID(), name: 'automation.create', arguments: args },
      managedBrowserJobAttempt: 1,
      managedBrowserJobLeaseToken: randomUUID(),
    },
  };
}
beforeEach(() => vi.resetAllMocks());

it.each([
  ['intent_required', 'AUTOMATION_REQUEST_UNCLEAR'],
  ['time_mismatch', 'AUTOMATION_TIME_MISMATCH'],
] as const)(
  'explains a confirmed no-write rejection: %s',
  async (reason, code) => {
    create.mockRejectedValueOnce(new NativeOnceProductError(reason));
    const c = call();
    const rejected = await createAutomation(c).catch((error: unknown) => error);
    expect(rejected).toMatchObject({
      code,
      retryable: false,
    });
    const identity = {
      runId: c.input.context.runId,
      callId: c.input.call.id,
      toolName: c.input.call.name,
    };
    expect(isConfirmedToolFailure(rejected, identity)).toBe(true);
    expect(
      isConfirmedToolFailure(rejected, { ...identity, callId: randomUUID() }),
    ).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  },
);

it('keeps an unknown database write outcome unknown', async () => {
  const unknown = new Error('write response lost');
  create.mockRejectedValueOnce(unknown);
  const c = call();
  await expect(createAutomation(c)).rejects.toBe(unknown);
  expect(
    isConfirmedToolFailure(unknown, {
      runId: c.input.context.runId,
      callId: c.input.call.id,
      toolName: c.input.call.name,
    }),
  ).toBe(false);
  expect(create).toHaveBeenCalledTimes(1);
});

it('rejects previews or missing private lease before the database write', async () => {
  const c = call();
  c.input.platformTestRunId = randomUUID();
  await expect(createAutomation(c)).rejects.toMatchObject({
    code: 'AUTOMATION_UNAVAILABLE',
  });
  delete c.input.platformTestRunId;
  delete c.input.managedBrowserJobLeaseToken;
  await expect(createAutomation(c)).rejects.toMatchObject({
    code: 'AUTOMATION_UNAVAILABLE',
  });
  expect(create).not.toHaveBeenCalled();
});

it('reports the stored request and actual due time, not the model rewrite', async () => {
  const c = call();
  const saved = {
    id: randomUUID(),
    name: '测试',
    runAt: '2026-10-20T09:00:00.000Z',
    sessionId: c.input.sessionId,
    status: 'preparing',
    prompt: '请在十五分钟后只回复校验词。',
  };
  create.mockResolvedValueOnce(saved);
  const result = await createAutomation(c);
  expect(JSON.parse(result.modelContent)).toMatchObject({
    automationId: saved.id,
    runAt: saved.runAt,
    prompt: saved.prompt,
    sessionId: c.input.sessionId,
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      userMessageId: c.input.userMessageId,
      callId: c.input.call.id,
      worker: { attempt: 1, leaseToken: c.input.managedBrowserJobLeaseToken },
    }),
  );
});

function recurringCall(): RiceToolHandlerContext {
  const c = call();
  c.arguments = {
    name: '周期核对',
    prompt: '模型改写',
    rule: { kind: 'every', seconds: 120 },
  };
  c.input.call.arguments = c.arguments;
  return c;
}

it.each([
  ['intent_required', 'AUTOMATION_REQUEST_UNCLEAR'],
  ['rule_mismatch', 'AUTOMATION_RULE_MISMATCH'],
] as const)(
  'explains a confirmed recurring no-write rejection: %s',
  async (reason, code) => {
    const c = recurringCall();
    createRecurring.mockRejectedValueOnce(
      new NativeRecurringProductError(reason),
    );
    const error = await createAutomation(c).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, retryable: false });
    expect(
      isConfirmedToolFailure(error, {
        runId: c.input.context.runId,
        callId: c.input.call.id,
        toolName: c.input.call.name,
      }),
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
  },
);

it.each([
  {
    name: 'x',
    prompt: 'x',
    delayMinutes: 1,
    rule: { kind: 'every', seconds: 120 },
  },
  { name: 'x', prompt: 'x' },
  { name: 'x', prompt: 'x', rule: { kind: 'every', seconds: 30 } },
  {
    name: 'x',
    prompt: 'x',
    rule: { kind: 'daily', time: '09:30:00', timezone: 'invalid/zone' },
  },
  {
    name: 'x',
    prompt: 'x',
    rule: { kind: 'every', seconds: 120, ownerId: 'foreign' },
  },
  { name: 'x', prompt: 'x', delayMinutes: 15, sessionId: 'foreign' },
])(
  'rejects ambiguous, out-of-scope or invalid arguments before writes: %j',
  async (args) => {
    const c = call();
    c.arguments = args;
    await expect(createAutomation(c)).rejects.toMatchObject({
      code: 'TOOL_INPUT_INVALID',
    });
    expect(create).not.toHaveBeenCalled();
    expect(createRecurring).not.toHaveBeenCalled();
  },
);

it('reports the saved recurring rule and preparing fact without inventing a next time', async () => {
  const c = recurringCall();
  const saved = {
    id: randomUUID(),
    clientRequestId: randomUUID(),
    sessionId: c.input.sessionId,
    name: '周期核对',
    prompt:
      '请每隔两分钟，在当前对话中只回复校验词「RECURRING-NL-A」。请实际创建周期任务，不要现在执行。',
    rule: { kind: 'every', seconds: 120 },
    status: 'preparing',
    nextRunAt: null,
  };
  createRecurring.mockResolvedValueOnce(saved);
  const result = await createAutomation(c);
  expect(JSON.parse(result.modelContent)).toMatchObject({
    automationId: saved.id,
    clientRequestId: saved.clientRequestId,
    rule: saved.rule,
    status: 'preparing',
    nextRunAt: null,
    prompt: saved.prompt,
  });
  expect(result.summary).toContain('等待调度确认');
  expect(createRecurring).toHaveBeenCalledWith(
    expect.objectContaining({
      arguments: c.arguments,
      rule: saved.rule,
      userMessageId: c.input.userMessageId,
      callId: c.input.call.id,
      worker: { attempt: 1, leaseToken: c.input.managedBrowserJobLeaseToken },
    }),
  );
  expect(create).not.toHaveBeenCalled();
});

it('does not retry or relabel an unknown recurring COMMIT as a confirmed failure', async () => {
  const c = recurringCall();
  const error = new Error('lost recurring COMMIT ACK');
  createRecurring.mockRejectedValueOnce(error);
  await expect(createAutomation(c)).rejects.toBe(error);
  expect(createRecurring).toHaveBeenCalledTimes(1);
  expect(
    isConfirmedToolFailure(error, {
      runId: c.input.context.runId,
      callId: c.input.call.id,
      toolName: c.input.call.name,
    }),
  ).toBe(false);
});
