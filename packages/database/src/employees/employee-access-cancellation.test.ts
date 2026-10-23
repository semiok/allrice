import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getDatabase } from '../core/client.ts';
import {
  employeeAccessTransaction,
  EmployeeAccessBusyError,
} from './employee-access-cancellation.ts';

describe('SQL-only admission transaction retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function database(begin = vi.fn()) {
    return {
      begin,
      sql: { begin } as unknown as ReturnType<typeof getDatabase>,
    };
  }
  it('restarts the complete rolled-back transaction after an early admission deadlock', async () => {
    const { begin, sql } = database();
    const failure = Object.assign(new Error('deadlock'), { code: '40P01' });
    begin.mockRejectedValueOnce(failure).mockResolvedValueOnce('fresh claim');
    const result = employeeAccessTransaction(sql, vi.fn(), {
      retryLockBusy: () => false, // Admission has not returned its scheduled flag.
      retryDeadlock: true,
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('fresh claim');
    expect(begin).toHaveBeenCalledTimes(2);
  });
  it('preserves SQLSTATE on bounded deadlock exhaustion for claimed-only settlement', async () => {
    const { begin, sql } = database();
    const failure = Object.assign(new Error('deadlock'), { code: '40P01' });
    begin.mockRejectedValue(failure);
    const checked = expect(
      employeeAccessTransaction(sql, vi.fn(), {
        retryDeadlock: true,
      }),
    ).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await checked;
    expect(begin).toHaveBeenCalledTimes(5);
  });
  it('does not enable deadlock retries for existing mutation callers implicitly', async () => {
    const { begin, sql } = database();
    const failure = Object.assign(new Error('deadlock'), { code: '40P01' });
    begin.mockRejectedValue(failure);
    await expect(employeeAccessTransaction(sql, vi.fn())).rejects.toBe(failure);
    expect(begin).toHaveBeenCalledOnce();
  });
  it.each(['08006', '40001', '23505'])(
    'does not replay an unrelated or uncertain transaction (%s)',
    async (code) => {
      const { begin, sql } = database();
      const failure = Object.assign(
        new Error('not a known deadlock rollback'),
        { code },
      );
      begin.mockRejectedValue(failure);
      await expect(
        employeeAccessTransaction(sql, vi.fn(), {
          retryDeadlock: true,
        }),
      ).rejects.toBe(failure);
      expect(begin).toHaveBeenCalledOnce();
    },
  );
  it('retains the existing bounded lock-busy contract', async () => {
    const { begin, sql } = database();
    begin.mockRejectedValue(
      Object.assign(new Error('busy'), { code: '55P03' }),
    );
    const checked = expect(
      employeeAccessTransaction(sql, vi.fn()),
    ).rejects.toBeInstanceOf(EmployeeAccessBusyError);
    await vi.runAllTimersAsync();
    await checked;
    expect(begin).toHaveBeenCalledTimes(5);
  });
  it('keeps a later lock-busy exhaustion distinct from a deadlock receipt', async () => {
    const { begin, sql } = database();
    begin
      .mockRejectedValueOnce(
        Object.assign(new Error('deadlock'), { code: '40P01' }),
      )
      .mockRejectedValue(Object.assign(new Error('busy'), { code: '55P03' }));
    const checked = expect(
      employeeAccessTransaction(sql, vi.fn(), { retryDeadlock: true }),
    ).rejects.toBeInstanceOf(EmployeeAccessBusyError);
    await vi.runAllTimersAsync();
    await checked;
    expect(begin).toHaveBeenCalledTimes(5);
  });
});
