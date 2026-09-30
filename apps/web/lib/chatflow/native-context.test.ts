import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { projectNativeContext } from './native-context';

const sample = (
  sequence: number,
  projectedTokens: number,
): ChatFlowEventEnvelope => ({
  schemaVersion: 3,
  eventId: `e${sequence}`,
  organizationId: 'org',
  workspaceId: 'workspace',
  conversationId: 'session',
  runId: 'run',
  generation: 1,
  cursor: `run:${sequence}`,
  sequence,
  harness: 'dsh',
  type: 'harness.native',
  occurredAt: `2026-09-28T05:00:0${sequence}.000Z`,
  sourceEvent: {
    id: `dsh:${sequence}`,
    type: 'session/projection',
    occurredAt: `2026-09-28T05:00:0${sequence}.000Z`,
    payload: {
      asOfSeq: sequence,
      pressureTokens: 152000,
      projectedTokens,
      contextWindow: 200000,
    },
  },
  payload: { presentation: 'context', status: 'info', label: '上下文占用' },
});
describe('DSH native context occupancy', () => {
  it('replaces last-turn occupancy during work and follows native pruning instead of pinning at the threshold', () => {
    const stored = projectNativeContext(null, [sample(1, 152000)]);
    expect(stored?.percentage).toBe(76);
    const live = projectNativeContext(stored, [sample(2, 164000)]);
    expect(live?.percentage).toBe(82);
    const pruned = projectNativeContext(live, [sample(3, 42000)]);
    expect(pruned?.percentage).toBe(21);
    expect(projectNativeContext(pruned, [sample(1, 152000)])).toEqual(pruned);
    expect(projectNativeContext(pruned, [sample(4, -1)])).toEqual(pruned);
    expect(projectNativeContext(pruned, [sample(5, 0)])?.percentage).toBe(0);
  });
});
