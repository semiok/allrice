import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '../data.ts';
import { queryLegacyOriginForCaller } from './legacy-origin.ts';

// Explicit contract fixtures for the internal SQL seam, not current authority
// or a substitute Workflow caller binding. No production reader is installed.
const scope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
};
const selector = {
  sourceType: 'message',
  sourceId: '00000000-0000-4000-8000-000000000003',
};

function contractSql(value: Promise<unknown>) {
  const cancel = vi.fn();
  const pending = Object.assign(value, { cancel });
  const read = vi.fn(() => pending);
  return { tx: read as unknown as TransactionSql, read, cancel };
}

describe('package-internal legacy source query, explicit contract fixtures', () => {
  it.each(['message', 'checkpoint'])(
    '%s reports both actual association outcomes without proof/native prerequisites',
    async (sourceType) => {
      for (const excluded of [false, true]) {
        const fake = contractSql(Promise.resolve([{ excluded }]));
        expect(
          await queryLegacyOriginForCaller(fake.tx, scope, {
            ...selector,
            sourceType,
          }),
        ).toEqual({
          sourceCheck: 'checked',
          excludedByMethodAuthoring: excluded,
        });
        expect(fake.read).toHaveBeenCalledOnce();
      }
    },
  );

  it('still executes the source check for a null legacy source ID and returns a completed zero-match fact', async () => {
    const fake = contractSql(Promise.resolve([{ excluded: false }]));
    expect(
      await queryLegacyOriginForCaller(fake.tx, scope, {
        ...selector,
        sourceId: null,
      }),
    ).toEqual({ sourceCheck: 'checked', excludedByMethodAuthoring: false });
    expect(fake.read).toHaveBeenCalledOnce();
  });

  it('keeps the old non-message/checkpoint sources non-applicable without issuing source SQL', async () => {
    const read = vi.fn(() => {
      throw new Error('non-applicable must not query');
    });
    for (const sourceType of ['user', 'tool', 'connector', 'file'])
      expect(
        await queryLegacyOriginForCaller(
          read as unknown as TransactionSql,
          scope,
          { sourceType, sourceId: null },
        ),
      ).toEqual({
        sourceCheck: 'not-applicable',
        excludedByMethodAuthoring: false,
      });
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves SQL/permission failure and denies missing or incomplete query results', async () => {
    for (const failure of [
      new DataAccessError('authorization_denied'),
      Object.assign(new Error('source relation missing'), { code: '42P01' }),
    ]) {
      const fake = contractSql(Promise.reject(failure));
      await expect(
        queryLegacyOriginForCaller(fake.tx, scope, selector),
      ).rejects.toBe(failure);
    }
    for (const rows of [
      [],
      [{}],
      [{ excluded: null }],
      [{ excluded: false }, { excluded: false }],
    ]) {
      const fake = contractSql(Promise.resolve(rows));
      await expect(
        queryLegacyOriginForCaller(fake.tx, scope, selector),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }
  });

  it('stops admission before source SQL for an already aborted caller', async () => {
    const controller = new AbortController();
    const reason = new Error('original caller cancellation');
    controller.abort(reason);
    const fake = contractSql(Promise.resolve([{ excluded: false }]));
    await expect(
      queryLegacyOriginForCaller(fake.tx, scope, selector, controller.signal),
    ).rejects.toBe(reason);
    expect(fake.read).not.toHaveBeenCalled();
  });

  it('joins SQL settlement and preserves both original errors without attributing 57014 to the signal', async () => {
    let rejectSql!: (error: unknown) => void;
    const sqlSettlement = new Promise<unknown>((_resolve, reject) => {
      rejectSql = reject;
    });
    const fake = contractSql(sqlSettlement);
    const controller = new AbortController();
    const reason = new Error('original caller cancelled while SQL pending');
    let returned = false;
    const pending = queryLegacyOriginForCaller(
      fake.tx,
      scope,
      selector,
      controller.signal,
    ).then(
      () => {
        returned = true;
        return null;
      },
      (error: unknown) => {
        returned = true;
        return error;
      },
    );
    controller.abort(reason);
    await Promise.resolve();
    expect(fake.cancel).toHaveBeenCalledOnce();
    expect(returned).toBe(false);
    const sqlFailure = Object.assign(
      new Error('driver reported query cancellation'),
      {
        code: '57014',
        severity: 'ERROR',
        file: 'postgres.c',
      },
    );
    rejectSql(sqlFailure);
    const failure = await pending;
    expect(failure).toBeInstanceOf(AggregateError);
    const combined = failure as AggregateError;
    expect(combined.cause).toBe(sqlFailure);
    expect(combined.errors).toHaveLength(2);
    expect(combined.errors[0]).toBe(sqlFailure);
    expect(combined.errors[1]).toBe(reason);
  });

  it('does not hide an unrelated SQL failure behind a concurrent cancellation', async () => {
    let rejectSql!: (error: unknown) => void;
    const fake = contractSql(
      new Promise<unknown>((_resolve, reject) => {
        rejectSql = reject;
      }),
    );
    const controller = new AbortController();
    const failure = Object.assign(new Error('original permission failure'), {
      code: '42501',
    });
    const pending = queryLegacyOriginForCaller(
      fake.tx,
      scope,
      selector,
      controller.signal,
    );
    const result = pending.catch((error: unknown) => error);
    const reason = new Error('later cancellation');
    controller.abort(reason);
    rejectSql(failure);
    const combined = (await result) as AggregateError;
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined.cause).toBe(failure);
    expect(combined.errors[0]).toBe(failure);
    expect(combined.errors[1]).toBe(reason);
  });

  it('preserves the exact 57014 statement-timeout object and diagnostics when the signal is also aborted', async () => {
    let rejectSql!: (error: unknown) => void;
    const fake = contractSql(
      new Promise<unknown>((_resolve, reject) => {
        rejectSql = reject;
      }),
    );
    const controller = new AbortController();
    const reason = new Error('caller abort after database timeout fired');
    const timeout = Object.assign(
      new Error('canceling statement due to statement timeout'),
      {
        code: '57014',
        severity: 'ERROR',
        file: 'postgres.c',
        line: '3193',
        routine: 'ProcessInterrupts',
        detail: 'original diagnostic details',
      },
    );
    const pending = queryLegacyOriginForCaller(
      fake.tx,
      scope,
      selector,
      controller.signal,
    ).catch((error: unknown) => error);
    rejectSql(timeout);
    controller.abort(reason);
    const combined = (await pending) as AggregateError;
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined.cause).toBe(timeout);
    expect(combined.errors).toHaveLength(2);
    expect(combined.errors[0]).toBe(timeout);
    expect(combined.errors[1]).toBe(reason);
    expect(combined.cause).toMatchObject({
      code: '57014',
      message: 'canceling statement due to statement timeout',
      severity: 'ERROR',
      file: 'postgres.c',
      line: '3193',
      routine: 'ProcessInterrupts',
      detail: 'original diagnostic details',
    });
  });

  it('suppresses a late successful SQL result and returns a 57014-shaped signal reason without wrapping it as SQL failure', async () => {
    let resolveSql!: (value: unknown) => void;
    const fake = contractSql(
      new Promise<unknown>((resolve) => {
        resolveSql = resolve;
      }),
    );
    const controller = new AbortController();
    const reason = Object.assign(new Error('original caller reason'), {
      code: '57014',
    });
    const result = expect(
      queryLegacyOriginForCaller(fake.tx, scope, selector, controller.signal),
    ).rejects.toBe(reason);
    controller.abort(reason);
    resolveSql([{ excluded: false }]);
    await result;
  });
});
