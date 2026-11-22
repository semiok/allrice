import { describe, expect, it } from 'vitest';
import { WireUsageObserver, summarizeAttempts, unknownUsage } from './usage.ts';
import type { ModelAttemptReceipt } from './contract.ts';

const bytes = (value: string) => new TextEncoder().encode(value);
describe('wire usage facts, independent of provider synthesized totals', () => {
  it('Responses explicit failed frame is a failure fact; Codex done needs an explicit valid status', () => {
    const failed = new WireUsageObserver('openai-responses');
    failed.push(
      bytes(
        'data: {"type":"response.failed","response":{"status":"failed"}}\n\n',
      ),
    );
    expect(failed.terminal).toBe('failed');
    for (const status of [undefined, 'unrecognized', 'in_progress']) {
      const observer = new WireUsageObserver('openai-responses');
      observer.push(
        bytes(
          'data: ' +
            JSON.stringify({ type: 'response.done', response: { status } }) +
            '\n\n',
        ),
      );
      expect(observer.terminal).toBeNull();
      expect(observer.usage).toEqual(unknownUsage());
    }
  });
  it('Responses incomplete keeps real partial counters while completion remains incomplete', () => {
    const observer = new WireUsageObserver('openai-responses');
    const frame =
      'event: response.incomplete\r\ndata: ' +
      JSON.stringify({
        type: 'response.incomplete',
        response: {
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      }) +
      '\r\n\r\n';
    for (let index = 0; index < frame.length; index += 3)
      observer.push(bytes(frame.slice(index, index + 3)));
    expect(observer.terminal).toBe('incomplete');
    expect(observer.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cachedInputTokens: null,
      cacheUsageKnown: false,
    });
  });
  it('oversized tool/content frames pass observation without retaining body or inventing missing usage', () => {
    const observer = new WireUsageObserver('openai-responses');
    observer.push(
      bytes(
        'event: response.output_text.delta\ndata: ' +
          JSON.stringify({ text: 'a'.repeat(100_000) }) +
          '\n\n',
      ),
    );
    observer.push(
      bytes(
        'event: response.completed\ndata: ' +
          JSON.stringify({
            type: 'response.completed',
            response: { output: 'b'.repeat(100_000) },
          }) +
          '\n\n',
      ),
    );
    expect(observer.terminal).toBe('completed');
    expect(observer.usage).toEqual(unknownUsage());
  });
  it('mismatched counters/malformed frames stay unknown; real explicit zero is distinguishable from missing', () => {
    const observer = new WireUsageObserver('openai-chat-completions');
    observer.push(
      bytes(
        'data: invalid\n\ndata: ' +
          JSON.stringify({
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 9 },
          }) +
          '\n\n',
      ),
    );
    expect(observer.usage).toEqual(unknownUsage());
    observer.push(
      bytes(
        'data: ' +
          JSON.stringify({
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }) +
          '\n\n',
      ),
    );
    expect(observer.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      usageComplete: true,
    });
  });
  it('one missing retry usage makes totals unknown while retaining observed cache subtotal', () => {
    const base: ModelAttemptReceipt = {
      id: 'first',
      callId: 'call',
      personId: 'person',
      ownerId: 'owner',
      kind: 'model',
      protocol: 'opaque',
      dispatchObserved: true,
      httpStatus: 429,
      terminal: null,
      outcome: 'closed',
      usage: unknownUsage(),
    };
    const summary = summarizeAttempts([
      base,
      {
        ...base,
        id: 'second',
        httpStatus: 200,
        terminal: 'completed',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cachedInputTokens: 4,
          usageComplete: true,
          cacheUsageKnown: true,
        },
      },
    ]);
    expect(summary).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: 4,
      usageComplete: false,
      cacheUsageKnown: false,
      attemptCount: 2,
      receiptCount: 2,
    });
  });
});
