import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getDatabase } from './client.ts';
import {
  recordTransactionRetry,
  transactionRetryCounts,
} from './transaction-retries.ts';
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';
import { retryArchiveTransaction } from '../workspace/session-archive.ts';

const rollback = (code: string) =>
  Object.assign(new Error('rolled back'), { code });

describe('MET-210 #4 transaction retry counters', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });
  const delta = (key: string, before: Record<string, number>) =>
    (transactionRetryCounts()[key] ?? 0) - (before[key] ?? 0);

  it('counts each rollback by site, SQLSTATE and outcome under one log tag', () => {
    const before = transactionRetryCounts();
    recordTransactionRetry({
      site: 'unit_site',
      sqlState: '40P01',
      attempt: 1,
      outcome: 'retrying',
    });
    recordTransactionRetry({
      site: 'unit_site',
      sqlState: '40P01',
      attempt: 2,
      outcome: 'retrying',
    });
    expect(delta('unit_site:40P01:retrying', before)).toBe(2);
    expect(warn).toHaveBeenLastCalledWith(
      '[TransactionRetry] PostgreSQL rolled back a transaction',
      expect.objectContaining({
        site: 'unit_site',
        sqlState: '40P01',
        attempt: 2,
        outcome: 'retrying',
      }),
    );
  });

  it('records a retried and an exhausted 40P01 for the named admission site', async () => {
    const begin = vi.fn();
    const sql = { begin } as unknown as ReturnType<typeof getDatabase>;
    let before = transactionRetryCounts();
    begin
      .mockRejectedValueOnce(rollback('40P01'))
      .mockResolvedValueOnce('fresh');
    const retried = employeeAccessTransaction(sql, vi.fn(), {
      retryDeadlock: true,
      retrySite: 'unit_start',
    });
    await vi.runAllTimersAsync();
    await expect(retried).resolves.toBe('fresh');
    expect(delta('unit_start:40P01:retrying', before)).toBe(1);
    expect(delta('unit_start:40P01:exhausted', before)).toBe(0);

    before = transactionRetryCounts();
    begin.mockReset().mockRejectedValue(rollback('40P01'));
    const exhausted = expect(
      employeeAccessTransaction(sql, vi.fn(), {
        retryDeadlock: true,
        retrySite: 'unit_start',
      }),
    ).rejects.toMatchObject({ code: '40P01' });
    await vi.runAllTimersAsync();
    await exhausted;
    expect(delta('unit_start:40P01:retrying', before)).toBe(4);
    expect(delta('unit_start:40P01:exhausted', before)).toBe(1);
  });

  it('does not count lock-busy retries or unretried deadlocks', async () => {
    const begin = vi.fn();
    const sql = { begin } as unknown as ReturnType<typeof getDatabase>;
    const before = transactionRetryCounts();
    begin.mockRejectedValueOnce(rollback('55P03')).mockResolvedValueOnce('ok');
    const busy = employeeAccessTransaction(sql, vi.fn());
    await vi.runAllTimersAsync();
    await expect(busy).resolves.toBe('ok');
    begin.mockReset().mockRejectedValue(rollback('40P01'));
    await expect(employeeAccessTransaction(sql, vi.fn())).rejects.toMatchObject(
      { code: '40P01' },
    );
    expect(transactionRetryCounts()).toEqual(before);
  });

  it('counts session archive retries and their exhaustion', async () => {
    const before = transactionRetryCounts();
    const run = vi
      .fn()
      .mockRejectedValueOnce(rollback('40001'))
      .mockResolvedValueOnce('archived');
    await expect(retryArchiveTransaction(run)).resolves.toBe('archived');
    expect(delta('session_archive:40001:retrying', before)).toBe(1);

    const failing = vi.fn().mockRejectedValue(rollback('40P01'));
    await expect(retryArchiveTransaction(failing)).rejects.toMatchObject({
      code: '40P01',
    });
    expect(failing).toHaveBeenCalledTimes(3);
    expect(delta('session_archive:40P01:retrying', before)).toBe(2);
    expect(delta('session_archive:40P01:exhausted', before)).toBe(1);
  });
});
