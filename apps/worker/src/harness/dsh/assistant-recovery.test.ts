import { describe, expect, it } from 'vitest';
import { assistantNativeCheckpointEvidence } from './assistant-recovery.js';
describe('assistant cold receipt evidence', () => {
  const message = {
    inputId: 'input',
    nativeMessageId: 'native',
    durableSeq: null,
    adoptedSeq: null,
  };
  it('rejects ID mentions in content and never guesses lost ACK identity', () => {
    expect(
      assistantNativeCheckpointEvidence(
        {
          events: [
            {
              seq: 2,
              type: 'agent/inbox/spliced',
              data: { inserted: [{ id: 'other', content: 'native' }] },
            },
          ],
        },
        [message],
      ),
    ).toEqual([]);
    expect(
      assistantNativeCheckpointEvidence(
        { events: [{ seq: 2, type: 'user/message', data: { id: 'native' } }] },
        [{ ...message, nativeMessageId: null }],
      ),
    ).toEqual([]);
  });
  it('preserves first durable identity and records later exact native adoption', () => {
    expect(
      assistantNativeCheckpointEvidence(
        { events: [{ seq: 9, type: 'user/message', data: { id: 'native' } }] },
        [{ ...message, durableSeq: 4 }],
      ),
    ).toEqual([
      {
        inputId: 'input',
        nativeMessageId: 'native',
        durableSeq: 4,
        adoptedSeq: 9,
      },
    ]);
  });
});
