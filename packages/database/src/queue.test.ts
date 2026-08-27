import { describe, expect, it } from 'vitest';

import { queueMaintenanceAction } from './queue.js';

const now = new Date('2026-08-05T12:00:00.000Z');
const later = new Date('2026-08-05T12:01:00.000Z');
const earlier = new Date('2026-08-05T11:59:00.000Z');

function job(
  overrides: Partial<Parameters<typeof queueMaintenanceAction>[0]> = {},
): Parameters<typeof queueMaintenanceAction>[0] {
  return {
    status: 'queued',
    attempt: 0,
    max_attempts: 3,
    available_at: later,
    timeout_at: later,
    lease_expires_at: null,
    cancel_requested_at: null,
    ...overrides,
  };
}

describe('persistent queue maintenance decisions', () => {
  it('promotes due retries and prioritizes cancellation and timeout', () => {
    expect(
      queueMaintenanceAction(
        job({ status: 'retry_wait', available_at: earlier }),
        now,
      ),
    ).toBe('promote_retry');
    expect(
      queueMaintenanceAction(
        job({ cancel_requested_at: earlier, timeout_at: earlier }),
        now,
      ),
    ).toBe('cancel');
    expect(queueMaintenanceAction(job({ timeout_at: earlier }), now)).toBe(
      'timeout',
    );
  });

  it('recovers an expired lease until attempts are exhausted', () => {
    expect(
      queueMaintenanceAction(
        job({
          status: 'running',
          attempt: 1,
          lease_expires_at: earlier,
        }),
        now,
      ),
    ).toBe('recover_lease');
    expect(
      queueMaintenanceAction(
        job({
          status: 'claimed',
          attempt: 3,
          lease_expires_at: earlier,
        }),
        now,
      ),
    ).toBe('dead_letter');
  });

  it('never changes a terminal job or steals a live lease', () => {
    expect(queueMaintenanceAction(job({ status: 'succeeded' }), now)).toBe(
      'none',
    );
    expect(
      queueMaintenanceAction(
        job({ status: 'running', lease_expires_at: later }),
        now,
      ),
    ).toBe('none');
    expect(
      queueMaintenanceAction(job({ status: 'waiting_approval' }), now),
    ).toBe('none');
  });
});
