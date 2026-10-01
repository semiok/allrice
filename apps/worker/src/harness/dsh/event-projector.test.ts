import { describe, expect, it } from 'vitest';

import {
  nativeEventView,
  nativeContextView,
  safeDshSourcePayload,
  sourceMetadata,
  visibleModelText,
} from './event-projector.js';

describe('safeDshSourcePayload', () => {
  it('projects native retries without copying provider messages or credentials', () => {
    const retry = nativeEventView({
      seq: 30,
      type: 'llm/retry',
      data: {
        turn: 1,
        step: 2,
        retryId: 'native-retry',
        retry: 2,
        maxRetries: 2,
        delayMs: 1000,
        failure: { code: 'TRANSPORT', message: 'private-url-and-token' },
      },
    });
    expect(retry).toMatchObject({
      presentation: 'lifecycle',
      status: 'started',
      label: '正在重新连接模型',
      sourcePayload: { retry: 2, maxRetries: 2, delayMs: 1000 },
    });
    expect(JSON.stringify(retry)).not.toContain('private-url-and-token');
  });
  it('retains public task names and states, strips unrelated data and preserves clearing', () => {
    const source = nativeEventView({
      seq: 20,
      type: 'todo/write',
      data: {
        todos: [
          { content: '核对资料', status: 'completed', reasoning: 'private' },
          {
            content: '生成文件',
            status: 'in_progress',
            arguments: { secret: 'private' },
          },
          { content: '检查交付', status: 'pending' },
        ],
        credential: 'private',
      },
    });
    expect(source?.sourcePayload).toEqual({
      count: 3,
      completed: 1,
      todos: [
        { content: '核对资料', status: 'completed' },
        { content: '生成文件', status: 'in_progress' },
        { content: '检查交付', status: 'pending' },
      ],
    });
    expect(JSON.stringify(source)).not.toContain('private');
    expect(
      safeDshSourcePayload({ type: 'todo/write', data: { todos: [] } }),
    ).toEqual({ count: 0, completed: 0, todos: [] });
    expect(
      safeDshSourcePayload({
        type: 'todo/write',
        data: { todos: [{ content: 'bad', status: 'invented' }] },
      }),
    ).not.toHaveProperty('todos');
  });
  it('keeps tool presentation metadata without exposing arguments or results', () => {
    const callPayload = safeDshSourcePayload({
      seq: 7,
      type: 'tool/call',
      data: {
        turn: 2,
        step: 3,
        callId: 'call-1',
        name: 'web.search',
        arguments: {
          query: 'private acquisition target',
          apiKey: 'secret-token',
        },
      },
    });
    const resultPayload = safeDshSourcePayload({
      seq: 8,
      type: 'tool/result',
      data: {
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              result: 'confidential tool result',
            },
          ],
        },
        error: {
          name: 'ProviderError',
          code: 'SEARCH_FAILED',
          message: 'credential=secret-token',
          stack: 'private stack',
        },
      },
    });

    expect(callPayload).toEqual({
      turn: 2,
      step: 3,
      callId: 'call-1',
      name: 'web.search',
    });
    expect(resultPayload).toEqual({
      callId: 'call-1',
      error: { name: 'ProviderError', code: 'SEARCH_FAILED' },
    });
    expect(JSON.stringify([callPayload, resultPayload])).not.toMatch(
      /secret-token|acquisition target|confidential tool result|private stack/,
    );
  });

  it('fails closed for malformed and unknown event payloads', () => {
    expect(
      safeDshSourcePayload({
        type: ['tool/call'],
        data: 'prompt=private apiKey=secret-token',
        rawPrompt: 'private',
      }),
    ).toEqual({});
    expect(
      safeDshSourcePayload({
        type: 'provider/private-event',
        data: {
          turn: 4,
          step: 5,
          prompt: 'private prompt',
          reasoning: 'hidden reasoning',
          credential: 'secret-token',
        },
      }),
    ).toEqual({ turn: 4, step: 5 });
  });

  it('records content block types without retaining assistant text', () => {
    const payload = safeDshSourcePayload({
      type: 'assistant/message',
      data: {
        interrupted: true,
        message: {
          content: [
            { type: 'thinking', text: 'private reasoning' },
            { type: 'text', text: 'tenant-visible answer' },
          ],
        },
      },
    });

    expect(payload).toEqual({
      interrupted: true,
      contentTypes: ['thinking', 'text'],
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /private reasoning|tenant-visible answer/,
    );
  });
});

describe('nativeEventView', () => {
  it('accepts only native occupancy counts without forwarding unrelated payloads', () => {
    expect(
      nativeContextView({
        asOfSeq: 17,
        contextPressure: {
          projectedTokens: 0,
          pressureTokens: 156000,
          contextWindow: 200000,
          secret: 'private',
        },
      }),
    ).toMatchObject({
      sourceEventType: 'session/projection',
      sourcePayload: {
        asOfSeq: 17,
        projectedTokens: 0,
        pressureTokens: 156000,
        contextWindow: 200000,
      },
    });
    expect(
      nativeContextView({ contextPressure: { contextWindow: 200000 } }),
    ).toBeNull();
    expect(
      nativeContextView({
        contextPressure: { projectedTokens: -1, contextWindow: 200000 },
      }),
    ).toBeNull();
    expect(
      nativeContextView({
        contextPressure: { projectedTokens: 10, contextWindow: 0 },
      }),
    ).toBeNull();
  });
  it('distinguishes atomic pruning from ongoing compaction and closes failed compaction', () => {
    const project = (phase: string, error?: string) =>
      nativeEventView({
        type: `compaction/${phase}`,
        data: { compactionId: 'compact-1', error },
      });
    expect(project('prune')).toMatchObject({
      presentation: 'compaction',
      status: 'completed',
      label: '工具结果已精简',
    });
    expect(project('start')).toMatchObject({ status: 'started' });
    expect(project('summary')).toMatchObject({ status: 'updated' });
    expect(project('end')).toMatchObject({ status: 'completed' });
    expect(project('end', 'private error details')).toMatchObject({
      status: 'failed',
      label: '上下文整理未完成',
    });
    expect(
      JSON.stringify(project('end', 'private error details')),
    ).not.toContain('private error details');
  });

  it('projects safe context metadata with stable DSH source identity', () => {
    expect(
      nativeEventView({
        seq: 19,
        time: '2026-08-31T12:34:56.000Z',
        type: 'request/context',
        data: {
          provider: 'openai-codex',
          model: 'gpt-5.6-luna',
          contextWindow: 200_000,
          systemPrompt: 'private system instructions',
          apiKey: 'secret-token',
        },
      }),
    ).toEqual({
      type: 'native.event',
      presentation: 'context',
      status: 'info',
      label: '模型上下文',
      summary: 'openai-codex · gpt-5.6-luna',
      sourceEventId: 'dsh:19',
      sourceEventType: 'request/context',
      sourceOccurredAt: '2026-08-31T12:34:56.000Z',
      sourcePayload: {
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        contextWindow: 200_000,
      },
    });
  });

  it('ignores human user messages and unsupported events', () => {
    expect(
      nativeEventView({
        type: 'user/message',
        data: { source: { kind: 'human' }, content: 'private prompt' },
      }),
    ).toBeNull();
    expect(
      nativeEventView({
        type: 'assistant/private-reasoning',
        data: { text: 'hidden reasoning' },
      }),
    ).toBeNull();
  });

  it('uses safe fallbacks for malformed source metadata', () => {
    const metadata = sourceMetadata({
      seq: { invalid: true },
      time: 'not-a-date',
      type: 42,
      data: ['invalid'],
    });

    expect(metadata.sourceEventId).toMatch(/^dsh:[0-9a-f-]{36}$/);
    expect(metadata.sourceEventType).toBe('dsh/session-event');
    expect(Number.isNaN(Date.parse(metadata.sourceOccurredAt))).toBe(false);
    expect(metadata.sourcePayload).toEqual({});
  });
});

describe('visibleModelText', () => {
  it.each(['', '<', '<thi', '<think>', '<think>private reasoning'])(
    'withholds a partial reasoning prefix: %j',
    (text) => {
      expect(visibleModelText(text)).toEqual({ ready: false, text: '' });
    },
  );

  it('releases only text after a completed reasoning block', () => {
    expect(
      visibleModelText(
        '  <think>private reasoning\nsecret-token</think>\nVisible answer',
      ),
    ).toEqual({ ready: true, text: 'Visible answer' });
  });

  it('passes ordinary model text through unchanged', () => {
    expect(visibleModelText('  Visible answer')).toEqual({
      ready: true,
      text: '  Visible answer',
    });
  });
});
