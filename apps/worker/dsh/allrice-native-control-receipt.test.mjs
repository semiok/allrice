/* global AbortController */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { host, text } from '../test/native-subagent/fixture.mjs';
import {
  readNativeSubagentControlReceipt,
  withNativeQueryReader,
} from './allrice-native-query.mjs';
import { join } from 'node:path';

it('recovers only the original own child suffix, excluding a fork-inherited matching rpcId', async () => {
  const h = await host();
  const requestId = randomUUID();
  h.root.inject(
    createUserMessage({
      content: text('这条在父会话里。'),
      source: { kind: 'user', rpcId: requestId },
    }),
  );
  await h.root.whenIdle();
  const child = await h.spawn(h.root, '分叉任务', { provider: 'fork' });
  await child.result;
  const request = {
    scope: { nativeRootId: h.root.id },
    input: {
      kind: 'prompt',
      requestId,
      parentSessionId: h.root.id,
      childSessionId: child.childId,
      mode: 'continuable',
      delivery: 'queue',
      content: text('独立子消息'),
    },
  };
  const signal = new AbortController().signal;
  expect(
    await readNativeSubagentControlReceipt(h.ctx, request, signal),
  ).toBeNull();
  const { kind: _kind, ...prompt } = request.input;
  const received = await h.ctx.subagents.prompt(prompt, signal);
  await h.wait();
  const proof = await withNativeQueryReader(
    join(h.directory, 'sessions'),
    (ctx) => readNativeSubagentControlReceipt(ctx, request, signal),
  );
  expect(proof).toMatchObject({
    status: 'accepted',
    acceptance: { kind: 'prompt', messageId: received.messageId },
    source: {
      kind: 'user_rpc',
      rpcId: requestId,
      sequence: expect.any(Number),
    },
  });
  expect(
    await readNativeSubagentControlReceipt(
      h.ctx,
      {
        ...request,
        input: { ...request.input, parentSessionId: 'wrong-parent' },
      },
      signal,
    ),
  ).toBeNull();
});

it('preserves exact native rpcId and refuses two different messageIds instead of hiding a duplicate', async () => {
  const h = await host();
  const child = await h.spawn();
  await child.result;
  const requestId = randomUUID().toUpperCase(),
    signal = new AbortController().signal;
  const prompt = {
    requestId,
    parentSessionId: h.root.id,
    childSessionId: child.childId,
    mode: 'continuable',
    delivery: 'queue',
    content: text('原生 requestId 不是幂等键。'),
  };
  const request = {
    scope: { nativeRootId: h.root.id },
    input: { ...prompt, kind: 'prompt' },
  };
  const first = await h.ctx.subagents.prompt(prompt, signal);
  await h.wait();
  expect(
    (await readNativeSubagentControlReceipt(h.ctx, request, signal)).source
      .rpcId,
  ).toBe(requestId);
  expect(
    await readNativeSubagentControlReceipt(
      h.ctx,
      {
        ...request,
        input: { ...request.input, requestId: requestId.toLowerCase() },
      },
      signal,
    ),
  ).toBeNull();
  const second = await h.ctx.subagents.prompt(prompt, signal);
  expect(second.messageId).not.toBe(first.messageId);
  await h.wait();
  await expect(
    readNativeSubagentControlReceipt(h.ctx, request, signal),
  ).rejects.toThrow('NATIVE_CONTROL_RECEIPT_CONFLICT');
});
