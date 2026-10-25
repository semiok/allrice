import type postgres from 'postgres';

const rowLock = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;

type Transaction = postgres.TransactionSql;
type Hook = (tx: Transaction, index: number) => Promise<void> | void;

/**
 * Test-only proof that a read path takes no row locks (MET-210 #4).
 *
 * Wraps a postgres.js client. Every transaction opened through `begin` reports
 * `pg_current_xact_id_if_assigned()` just before COMMIT: PostgreSQL assigns a
 * transaction id to any transaction that locks or writes a row, so a null id
 * proves the transaction did neither. Statements sent outside a transaction
 * cannot be probed after their implicit COMMIT, so their SQL text is checked
 * for row-lock clauses instead.
 *
 * `afterStart` / `beforeCommit` let a test interleave another connection at a
 * known point inside each transaction (index counts transactions in order).
 */
export function createReadPathProbe(
  db: postgres.Sql,
  options: {
    lockTimeout?: string;
    afterStart?: Hook;
    beforeCommit?: Hook;
  } = {},
) {
  const transactions: { index: number; xid: string | null }[] = [];
  const lockingStatements: string[] = [];
  let started = 0;
  const inspect = (text: string) => {
    if (rowLock.test(text)) lockingStatements.push(text);
  };
  const begin =
    (target: postgres.Sql) =>
    (...args: unknown[]) => {
      const work = args.at(-1) as (tx: Transaction) => unknown;
      const run = async (tx: Transaction) => {
        const index = started++;
        if (options.lockTimeout)
          await tx.unsafe(
            `set local lock_timeout = '${options.lockTimeout.replace(/'/g, '')}'`,
          );
        await options.afterStart?.(tx, index);
        const result = await work(tx);
        // postgres.js also accepts an array of pending queries as the result.
        if (Array.isArray(result)) await Promise.all(result);
        await options.beforeCommit?.(tx, index);
        const [row] = await tx<{ xid: string | null }[]>`
          select pg_current_xact_id_if_assigned()::text as xid`;
        transactions.push({ index, xid: row!.xid });
        return result;
      };
      return args.length > 1
        ? target.begin(args[0] as string, run)
        : target.begin(run);
    };
  const proxy = new Proxy(db, {
    apply(target, self, args: unknown[]) {
      const [strings] = args;
      if (Array.isArray(strings) && 'raw' in strings)
        inspect(strings.join(' $ '));
      return Reflect.apply(target, self, args);
    },
    get(target, key) {
      if (key === 'begin') return begin(target);
      if (key === 'unsafe')
        return (text: string, ...rest: unknown[]) => {
          inspect(text);
          return (target.unsafe as (...values: unknown[]) => unknown)(
            text,
            ...rest,
          );
        };
      return Reflect.get(target, key, target);
    },
  }) as postgres.Sql;
  return {
    db: proxy,
    transactions,
    lockingStatements,
    /** Every probed transaction committed without a transaction id. */
    expectNoRowLocks() {
      const assigned = transactions.filter((entry) => entry.xid !== null);
      if (assigned.length || lockingStatements.length)
        throw new Error(
          `read path locked or wrote rows: ${JSON.stringify({
            assigned,
            lockingStatements,
          })}`,
        );
      if (!transactions.length)
        throw new Error('read path opened no probed transaction');
    },
  };
}
