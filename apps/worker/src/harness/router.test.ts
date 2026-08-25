import { describe, expect, it } from 'vitest';

import type { HarnessAdapter, HarnessExecutionResult } from './adapter.js';
import { CodexHarnessAdapter } from './codex-adapter.js';
import { HarnessRouter } from './router.js';

class FakeDshAdapter implements HarnessAdapter {
  readonly kind = 'dsh' as const;
  readonly capabilities = {
    persistentThreads: true,
    assistantDeltas: true,
    toolEvents: true,
    usageEvents: true,
    interrupt: true,
    steer: true,
    compact: true,
    recover: true,
  } as const;

  async execute(): Promise<HarnessExecutionResult> {
    return {
      answer: 'fake',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      provider: 'fake',
      model: 'fake',
    };
  }
}

describe('HarnessRouter', () => {
  it('routes by employee runtime policy, not by worker implementation details', () => {
    const codex = new CodexHarnessAdapter();
    const dsh = new FakeDshAdapter();
    const router = new HarnessRouter([codex, dsh]);
    expect(router.resolve('codex')).toBe(codex);
    expect(router.resolve('dsh')).toBe(dsh);
  });

  it('advertises unsupported Codex V2 operations instead of simulating them', () => {
    const capabilities = new CodexHarnessAdapter().capabilities;
    expect(capabilities).toMatchObject({
      persistentThreads: true,
      interrupt: true,
      assistantDeltas: true,
      steer: false,
      compact: false,
    });
  });

  it('fails closed when a requested harness is not deployed', () => {
    expect(() => new HarnessRouter([]).resolve('dsh')).toThrow(
      'Harness dsh is not available',
    );
  });
});
