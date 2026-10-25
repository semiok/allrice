import type postgres from 'postgres';
import { expect } from 'vitest';
import { createReadPathProbe } from './read-path-probe.fixture.ts';

/** Observe execution, preserving the PendingQuery used as a nested SQL
 * fragment. An async apply trap would turn `tx`for share`` into a bound Promise
 * parameter (or execute it as standalone SQL) before the outer query runs. */
export function scheduleReadPathQuery<T extends PromiseLike<unknown>>(
  query: T,
  sql: string,
  hook: (sql: string, execute: () => Promise<unknown>) => Promise<unknown>,
): T {
  let result: Promise<unknown> | undefined;
  // Include conditional SQL fragments in the scheduling key without executing
  // them. Data parameters remain placeholders, including JSON bindings.
  function rendered(value: unknown): string | null {
    if (!value || typeof value !== 'object' || !('strings' in value))
      return null;
    const q = value as { strings: unknown; args?: unknown[] };
    if (!Array.isArray(q.strings)) return null;
    const strings = q.strings;
    return strings
      .map(
        (part, index) =>
          String(part) +
          (index < strings.length - 1
            ? (rendered(q.args?.[index]) ?? '?')
            : ''),
      )
      .join('');
  }
  const statement = (rendered(query) ?? sql)
    .replaceAll(/\s+/g, ' ')
    .toLowerCase();
  return new Proxy(query, {
    get(target, key) {
      if (key === 'then')
        return (
          yes: (value: unknown) => unknown,
          no: (error: unknown) => unknown,
        ) =>
          (result ??= hook(statement, async () => await query)).then(yes, no);
      return Reflect.get(target, key, target);
    },
  });
}

export function readPathSignal<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Complete both transactions even when the lock regression under test fails. */
export async function settleReadPathRace(work: Promise<unknown>[]) {
  const results = await Promise.allSettled(work);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
}

export async function expectReadPathRowLocked(
  db: postgres.Sql,
  table: string,
  id: string,
) {
  await expect(
    db.begin(async (tx) => {
      await tx`select id from ${tx(table)} where id=${id} for update nowait`;
    }),
  ).rejects.toMatchObject({ code: '55P03' });
}

/** Hold the first operation open until its competitor has committed. These
 * gates are transaction hooks, not timing guesses or resource polling. */
export async function readWriteOverlap<T>(
  db: postgres.Sql,
  order: 'reader first' | 'writer first',
  read: (db: postgres.Sql) => Promise<T>,
  write: (db: postgres.Sql) => Promise<unknown>,
) {
  const firstOpen = readPathSignal(),
    secondDone = readPathSignal();
  let held = false;
  const hold = async (tx: postgres.TransactionSql) => {
    if (held) return;
    held = true;
    const [state] = await tx<{ blockers: number[] }[]>`
      select pg_blocking_pids(pg_backend_pid()) as blockers`;
    expect(state!.blockers).toEqual([]);
    firstOpen.resolve();
    await secondDone.promise;
  };
  const reader = createReadPathProbe(db, {
    lockTimeout: '1500ms',
    beforeCommit: order === 'reader first' ? hold : undefined,
  });
  const writer = createReadPathProbe(db, {
    lockTimeout: '1500ms',
    beforeCommit: order === 'writer first' ? hold : undefined,
  });
  const first = order === 'reader first' ? read(reader.db) : write(writer.db);
  void first.catch((error: unknown) => firstOpen.reject(error));
  const second = firstOpen.promise
    .then(() => (order === 'reader first' ? write(writer.db) : read(reader.db)))
    .finally(() => secondDone.resolve());
  await settleReadPathRace([first, second]);
  expect(held).toBe(true);
  reader.expectNoRowLocks();
  expect(writer.transactions.some((t) => t.xid !== null)).toBe(true);
  return (order === 'reader first' ? await first : await second) as T;
}
