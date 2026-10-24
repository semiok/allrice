import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  steerDshAgent,
  structuredUserQuestionAnswer,
} from './allrice-dsh-runtime-compatibility.mjs';

describe('AllRice DSH runtime compatibility', () => {
  it('creates and submits one upstream user message for steering', () => {
    const messages = [];
    const messageId = steerDshAgent(
      {
        steer(message) {
          messages.push(message);
        },
      },
      'Continue with the revised scope.',
    );

    expect(messageId).toEqual(expect.any(String));
    expect(messageId).not.toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: 'Continue with the revised scope.' }],
      source: { kind: 'user' },
    });
  });

  it('validates a complete structured answer against the pending question batch', () => {
    const pending = {
      questionId: 'question-1',
      questions: [
        {
          id: 'format',
          question: 'Choose a format',
          options: [{ label: 'xlsx' }, { label: 'csv' }],
          multiSelect: false,
        },
        {
          id: 'extras',
          question: 'Choose extras',
          options: [{ label: 'chart' }, { label: 'summary' }],
          multiSelect: true,
        },
      ],
    };
    expect(
      structuredUserQuestionAnswer(
        pending,
        `allrice:user-question:v1:${JSON.stringify({
          questionId: 'question-1',
          answers: [
            { id: 'format', selected: ['xlsx'] },
            { id: 'extras', selected: ['chart'], custom: 'include sources' },
          ],
        })}`,
      ),
    ).toEqual({
      answers: [
        { id: 'format', selected: ['xlsx'] },
        { id: 'extras', selected: ['chart'], custom: 'include sources' },
      ],
    });
  });

  it('rejects a structured answer for another pending request', () => {
    expect(() =>
      structuredUserQuestionAnswer(
        {
          questionId: 'question-1',
          questions: [{ id: 'format', options: [{ label: 'xlsx' }] }],
        },
        'allrice:user-question:v1:{"questionId":"question-2","answers":[]}',
      ),
    ).toThrow('does not match');
  });
});

// Exercise the real entrypoint's close block with only its public API ports.
// Importing the entrypoint itself would start a Native Host, which this unit
// fixture intentionally does not do.
function closeHarness(failures = []) {
  const source = readFileSync(
    new URL('./allrice-jsonrpc-runtime.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('let initializeStarted = false;');
  const end = source.indexOf("process.stdin.on('end'", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls = [],
    exits = [],
    queued = [];
  let handler,
    flushes = 0;
  const stage = async (name) => {
    calls.push(name);
    if (failures.includes(name)) throw Error('PRIVATE plugin diagnostics');
  };
  const context = {
    server: { shutdown: () => stage('sdk'), handleRequest: async () => ({}) },
    ctx: { root: { fiber: { dispose: () => stage('root') } } },
    transport: {
      flush: () => stage(++flushes === 1 ? 'prior_flush' : 'final_flush'),
      onRequest: (value) => {
        handler = value;
      },
    },
    process: { exit: (code) => exits.push(code) },
    setImmediate: (operation) => queued.push(operation),
  };
  runInNewContext(
    source.slice(start, end) +
      `
      // Supply already-created public ports; never execute the SDK factory.
      initializeStarted = moduleLoadStarted = sdkCreated = rootCreated = true;
      ownedServer = server;
      ownedContext = ctx;
      runtimeTask = Promise.resolve({ server, ctx });
      globalThis.exitResult = () => exitTask;
      `,
    context,
    { timeout: 1000 },
  );
  return {
    calls,
    exits,
    request: (...args) => handler(...args),
    flushExit: async () => {
      queued.splice(0).forEach((operation) => operation());
      await context.exitResult();
    },
  };
}

describe('AllRice wrapper close receipt without Host or model', () => {
  it('waits SDK, root, prior frames and final response flush before normal zero exit', async () => {
    const f = closeHarness();
    expect(await f.request('shutdown')).toEqual({
      allriceClose: {
        version: 1,
        sdkShutdown: true,
        rootDisposed: true,
        priorFramesFlushed: true,
      },
    });
    expect(f.exits).toEqual([]);
    await f.flushExit();
    expect(f.calls).toEqual(['sdk', 'root', 'prior_flush', 'final_flush']);
    expect(f.exits).toEqual([0]);
  });
  it.each([
    ['sdk', 'sdkShutdown'],
    ['root', 'rootDisposed'],
    ['prior_flush', 'priorFramesFlushed'],
  ])(
    'retains false %s and still attempts all independent public stages',
    async (stage, key) => {
      const f = closeHarness([stage]),
        result = await f.request('shutdown');
      expect(result.allriceClose[key]).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      await f.flushExit();
      expect(f.calls).toEqual(['sdk', 'root', 'prior_flush', 'final_flush']);
      expect(f.exits).toEqual([1]);
    },
  );
  it('does not turn an earlier true receipt into success after final flush failure', async () => {
    const f = closeHarness(['final_flush']);
    expect((await f.request('shutdown')).allriceClose).toEqual({
      version: 1,
      sdkShutdown: true,
      rootDisposed: true,
      priorFramesFlushed: true,
    });
    await f.flushExit();
    expect(f.exits).toEqual([1]);
  });
  it('shares repeated shutdown and fences new business requests after close begins', async () => {
    const f = closeHarness();
    const [first, second] = await Promise.all([
      f.request('shutdown'),
      f.request('shutdown'),
    ]);
    expect(first).toEqual(second);
    await expect(f.request('session/new')).rejects.toThrow(
      'ALLRICE_RUNTIME_CLOSING',
    );
    await f.flushExit();
    expect(f.calls).toEqual(['sdk', 'root', 'prior_flush', 'final_flush']);
    expect(f.exits).toEqual([0]);
  });
});
