import { describe, expect, it } from 'vitest';

import {
  nativeEventView,
  safeDshSourcePayload,
  sourceMetadata,
  visibleModelText,
} from './event-projector.js';

describe('safeDshSourcePayload', () => {
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
