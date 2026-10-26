import type postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseErrorCode,
  maxLeaseLockAttempts,
  retryLeaseLockTimeout,
} from './lease-lock-retry.ts';

const lease = {
  workerId: '00000000-0000-4000-a000-000000000001',
  jobId: '00000000-0000-4000-a000-000000000002',
  leaseToken: '00000000-0000-4000-a000-000000000003',
};
const lockTimeout = () =>
  Object.assign(new Error('canceling statement due to lock timeout'), {
    code: '55P03',
  });
const leaseLost = () =>
  Object.assign(new Error('lease_lost'), { code: 'lease_lost' });

/** The lease row the retry reads; `remainingMs` of lease left at `now`. */
function jobRow(remainingMs: number, extra: Record<string, unknown> = {}) {
  const now = new Date('2026-10-26T12:00:00Z');
  return {
    status: 'running',
    worker_id: lease.workerId,
    lease_token: lease.leaseToken,
    lease_expires_at: new Date(now.getTime() + remainingMs),
    drain_deadline_at: null,
    drain_reason: null,
    cancel_requested_at: null,
    timeout_at: new Date(now.getTime() + 3_600_000),
    now,
    ...extra,
  };
}
/** The lease read runs in its own bounded transaction: settings, then read. */
function fakeSql(read: () => Promise<unknown[]>) {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('pg_backend_pid'))
      return Promise.resolve([{ pid: 4242, run_id: null }]);
    return text.includes('set_config') ? Promise.resolve([]) : read();
  };
  return {
    begin: (run: (t: typeof tx) => unknown) => run(tx),
  } as unknown as postgres.Sql;
}

describe('MET-210 lease-bounded lock-timeout retry', () => {
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  it('retries a 55P03 inside the lease, splitting what is left across the lock waits', async () => {
    quiet();
    const waits: number[] = [];
    const result = await retryLeaseLockTimeout({
      sql: fakeSql(async () => [jobRow(15_000)]),
      site: 'job_heartbeat',
      lease,
      mode: 'stop',
      leaseLost,
      run: async (_trace, lockWaitMs) => {
        waits.push(lockWaitMs);
        if (waits.length === 1) throw lockTimeout();
        return 'renewed';
      },
    });
    expect(result).toBe('renewed');
    // First attempt keeps the normal 5 s; the retry gets (15 - 1.5) / 3 s.
    expect(waits).toEqual([5_000, 4_500]);
  });

  it('never retries a failure whose outcome is not a confirmed rollback', async () => {
    quiet();
    const read = vi.fn(async () => [jobRow(15_000)]);
    for (const error of [
      Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }),
      Object.assign(new Error('deadlock'), { code: '40P01' }),
      leaseLost(),
    ]) {
      let calls = 0;
      await expect(
        retryLeaseLockTimeout({
          sql: fakeSql(read),
          site: 'job_event',
          lease,
          mode: 'receipt',
          leaseLost,
          run: async () => {
            calls++;
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['another token holds the Job', { lease_token: 'replaced' }, 'lease_lost'],
    ['the lease expired', { lease_expires_at: new Date(0) }, 'lease_lost'],
    [
      'the drain window closed',
      { drain_deadline_at: new Date(0) },
      'lease_lost',
    ],
    ['a cancel is requested', { cancel_requested_at: new Date(0) }, '55P03'],
    [
      'a receipt drain is under way',
      {
        drain_reason: 'timeout',
        drain_deadline_at: new Date('2026-10-26T12:00:20Z'),
      },
      '55P03',
    ],
    [
      'too little lease is left',
      { lease_expires_at: new Date('2026-10-26T12:00:02Z') },
      '55P03',
    ],
  ] as const)(
    'a heartbeat does not retry when %s',
    async (_case, extra, code) => {
      quiet();
      let calls = 0;
      await expect(
        retryLeaseLockTimeout({
          sql: fakeSql(async () => [jobRow(15_000, extra)]),
          site: 'job_heartbeat',
          lease,
          mode: 'stop',
          leaseLost,
          run: async () => {
            calls++;
            throw lockTimeout();
          },
        }),
      ).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    },
  );

  it('an event write keeps retrying inside a drain window, but a heartbeat stops', async () => {
    quiet();
    const draining = jobRow(15_000, {
      drain_reason: 'cancel',
      cancel_requested_at: new Date(0),
      drain_deadline_at: new Date('2026-10-26T12:00:20Z'),
    });
    let calls = 0;
    await expect(
      retryLeaseLockTimeout({
        sql: fakeSql(async () => [draining]),
        site: 'job_event',
        lease,
        mode: 'receipt',
        leaseLost,
        run: async () => {
          if (++calls === 1) throw lockTimeout();
          return 'written';
        },
      }),
    ).resolves.toBe('written');
    expect(calls).toBe(2);
  });

  it('a heartbeat still retries when only the stored task deadline passed: its transaction refreshes the clock and decides', async () => {
    quiet();
    let calls = 0;
    await expect(
      retryLeaseLockTimeout({
        sql: fakeSql(async () => [jobRow(15_000, { timeout_at: new Date(0) })]),
        site: 'job_heartbeat',
        lease,
        mode: 'stop',
        leaseLost,
        run: async () => {
          if (++calls === 1) throw lockTimeout();
          return 'stopped by its own transaction';
        },
      }),
    ).resolves.toBe('stopped by its own transaction');
    expect(calls).toBe(2);
  });

  it('gives up with the original SQLSTATE when the lease cannot be read', async () => {
    quiet();
    let calls = 0;
    const timeout = lockTimeout();
    await expect(
      retryLeaseLockTimeout({
        sql: fakeSql(async () => {
          throw Object.assign(new Error('statement timeout'), {
            code: '57014',
          });
        }),
        site: 'job_heartbeat',
        lease,
        mode: 'stop',
        leaseLost,
        run: async () => {
          calls++;
          throw timeout;
        },
      }),
    ).rejects.toBe(timeout);
    expect(calls).toBe(1);
    // The failed read is recorded on its own, with its own backend.
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map(([, record]) => [
          record.site,
          record.sqlState,
          record.outcome,
        ]),
    ).toEqual([
      ['lease_read', '57014', 'failed'],
      ['job_heartbeat', '55P03', 'exhausted'],
    ]);
  });

  it(`stops after ${maxLeaseLockAttempts} attempts with the original SQLSTATE`, async () => {
    quiet();
    let calls = 0;
    await expect(
      retryLeaseLockTimeout({
        sql: fakeSql(async () => [jobRow(25_000)]),
        site: 'job_heartbeat',
        lease,
        mode: 'stop',
        leaseLost,
        run: async () => {
          calls++;
          throw lockTimeout();
        },
      }),
    ).rejects.toMatchObject({ code: '55P03' });
    expect(calls).toBe(maxLeaseLockAttempts);
  });

  it('starts no attempt after an abort that lands while the lease is being read', async () => {
    quiet();
    const stop = new AbortController();
    let release!: (rows: unknown[]) => void;
    const reading = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const retry = retryLeaseLockTimeout({
      sql: fakeSql(() => reading),
      site: 'job_heartbeat',
      lease,
      mode: 'stop',
      signal: stop.signal,
      leaseLost,
      run: async () => {
        if (++calls === 1) throw lockTimeout();
        return 'renewed';
      },
    });
    retry.catch(() => {});
    await vi.waitFor(() => expect(calls).toBe(1));
    // Past the backoff: the lease read is now in flight.
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop.abort();
    release([jobRow(15_000)]);
    await expect(retry).rejects.toMatchObject({ code: '55P03' });
    expect(calls).toBe(1);
    expect(vi.mocked(console.warn).mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: 'aborted',
    });
  });

  it('records IDs, codes and timings only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    await retryLeaseLockTimeout({
      sql: fakeSql(async () => [jobRow(15_000)]),
      site: 'job_event',
      lease,
      mode: 'receipt',
      leaseLost,
      run: async () => {
        if (++calls === 1)
          throw Object.assign(lockTimeout(), {
            parameters: ['business secret'],
            query: 'insert into allrice_run_events ...',
          });
        return 'written';
      },
    });
    const [tag, record] = warn.mock.calls[0]!;
    expect(tag).toBe('[MET-210] Worker lease transaction rolled back');
    expect(record).toMatchObject({
      site: 'job_event',
      sqlState: '55P03',
      jobId: lease.jobId,
      attempt: 1,
      outcome: 'retrying',
    });
    expect(JSON.stringify(record)).not.toContain('business secret');
    expect(JSON.stringify(record)).not.toContain('insert into');
  });

  it('reads only SQLSTATEs and driver codes as database error codes', () => {
    expect(databaseErrorCode(lockTimeout())).toBe('55P03');
    expect(databaseErrorCode({ code: 'CONNECTION_CLOSED' })).toBe(
      'CONNECTION_CLOSED',
    );
    expect(databaseErrorCode(leaseLost())).toBeNull();
    expect(databaseErrorCode(new Error('plain'))).toBeNull();
    expect(databaseErrorCode(null)).toBeNull();
  });
});
