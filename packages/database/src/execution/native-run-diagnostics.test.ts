import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from '../core/client.ts';
import * as queue from './queue.ts';
import {
  getRunNativeDiagnosticTarget,
  nativeDiagnosticReceiptSlices,
} from './native-run-diagnostics.ts';

afterEach(() => vi.restoreAllMocks());
const thread = 'dsh-11111111-1111-4111-8111-111111111111';
function receipt(seq = 7, attempt = 1, generation = 2, threadId = thread) {
  return {
    event_type: 'assistant.text.completed',
    payload: {
      source: 'dsh',
      threadId,
      generation,
      attempt,
      sourceEventId: `dsh:${seq}`,
      sourceEventType: 'assistant/message',
      nativePayload: { turn: 3 },
    },
  };
}
const start = {
  event_type: 'turn.started',
  payload: {
    source: 'dsh',
    threadId: thread,
    generation: 2,
    turnId: `${thread}:turn:3`,
  },
};
it('uses exact native seq and a unique recorded Run turn, never synthetic IDs or timestamps', () => {
  const slices = nativeDiagnosticReceiptSlices([
    start,
    receipt(),
    receipt(),
    {
      ...receipt(),
      payload: { ...receipt().payload, sourceEventId: 'dsh:buffer:abc' },
    },
    { ...receipt(), payload: { ...receipt().payload, attempt: undefined } },
  ]);
  expect(slices).toHaveLength(1);
  expect(slices[0]).toMatchObject({
    attempt: 1,
    generation: 2,
    nativeSessionId: thread,
    receipts: [{ seq: 7, type: 'assistant/message', turn: 3 }],
    verifiedTurns: [3],
    reasons: [],
  });
});
it('separates generations/threads and refuses conflicting attempt or Run turn attribution', () => {
  const slices = nativeDiagnosticReceiptSlices([
    start,
    receipt(),
    receipt(7, 2),
    receipt(7, 1, 3, `${thread}-next`),
  ]);
  expect(slices).toHaveLength(3);
  expect(slices[0]!.reasons).toContain('source_ambiguous');
  expect(slices[1]!.reasons).toContain('source_ambiguous');
  expect(slices[2]!.reasons).toEqual([]);
  const conflict = nativeDiagnosticReceiptSlices([
    { ...start, conflicting_turn: true },
    receipt(),
  ]);
  expect(conflict[0]!.verifiedTurns).toEqual([]);
  expect(conflict[0]!.reasons).toContain('source_ambiguous');
});
it('does not expose native reader details to a same-tenant peer even if Run visibility permits reading', async () => {
  vi.spyOn(queue, 'getRun').mockResolvedValue({
    id: 'run',
    ownerId: 'owner',
  } as Awaited<ReturnType<typeof queue.getRun>>);
  const database = vi.spyOn(client, 'getDatabase');
  await expect(
    getRunNativeDiagnosticTarget(
      { actor: { type: 'user', id: 'peer' } } as RequestContext,
      'workspace',
      'run',
    ),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(database).not.toHaveBeenCalled();
});
it('preserves the existing Run authorization refusal before any native lookup', async () => {
  vi.spyOn(queue, 'getRun').mockRejectedValue(
    new queue.QueueError('not_found'),
  );
  const database = vi.spyOn(client, 'getDatabase');
  await expect(
    getRunNativeDiagnosticTarget(
      { actor: { type: 'user', id: 'outsider' } } as RequestContext,
      'foreign',
      'run',
    ),
  ).rejects.toMatchObject({ code: 'not_found' });
  expect(database).not.toHaveBeenCalled();
});
