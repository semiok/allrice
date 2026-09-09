import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import {
  createBrowserOperation,
  createBrowserOperationLedger,
  listBrowserWorkspaces,
} from './browser-control.ts';
import { lockBrowserBindingOperations } from './browser-control-authority.ts';
import {
  localBrowserEffectStatus,
  ownedLocalBrowserOperation,
  renewLocalBrowserOperations,
  requestLocalBrowserEffect,
  startLocalBrowserOperation,
} from './local-browser-operations.ts';
import {
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  requestRuntimeActionApproval,
  runtimePolicyDigest,
} from './runtime-policy.ts';
import type * as Client from './core/client.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `browser_lock_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Instrument only the timing of actual PostgreSQL queries. Every production
 * SQL statement, lock, authority check and receipt still executes unchanged. */
function scheduleQueries(
  hook: (sql: string, execute: () => Promise<unknown>) => Promise<unknown>,
) {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'begin') return Reflect.get(target, key, target);
      return (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
        target.begin((tx) =>
          work(
            new Proxy(tx, {
              apply(query, thisArg, args: unknown[]) {
                const fragments = args[0];
                if (!Array.isArray(fragments))
                  return Reflect.apply(query, thisArg, args);
                const sql = fragments
                  .join('?')
                  .replaceAll(/\s+/g, ' ')
                  .toLowerCase();
                return hook(
                  sql,
                  async () => await Reflect.apply(query, thisArg, args),
                );
              },
            }),
          ),
        );
    },
  });
}

async function pendingSubmission() {
  const f = await createLocalBrowserFixture(db, storageRoot),
    b = f.browser!;
  const op = await createBrowserOperation(
    f.context,
    b.command,
    randomUUID(),
    db,
  );
  await f.approve(op);
  const operationId = op.snapshot.binding.attempt.operationId;
  const started = await startLocalBrowserOperation(
    f.device,
    { ...b.identity!, operationId },
    db,
  );
  const effect = await requestLocalBrowserEffect(
    f.device,
    {
      ...b.identity!,
      operationId,
      operationLeaseToken: started.operationLeaseToken!,
      requestId: randomUUID(),
      effect: {
        url: f.profile.origins[0] + '/submit',
        urlDigest: runtimePolicyDigest('synthetic-submit'),
        method: 'POST',
        bodyDigest: runtimePolicyDigest('synthetic'),
        bodyBytes: 9,
      },
    },
    db,
  );
  const snapshot = await createBrowserOperationLedger(
    f.context,
    db,
  ).readOperation(op.snapshot.binding.task.scope, effect.operationId);
  const [approval] = await db<
    { id: string }[]
  >`select id from allrice_approval_requests where resource_id=${effect.operationId} and resource_type='runtime_operation'`;
  const { request } = await getRuntimeActionApproval(
    f.context,
    approval!.id,
    db,
  );
  return {
    f,
    b,
    op,
    effect,
    snapshot,
    request,
    status: {
      ...b.identity!,
      operationId,
      approvalOperationId: effect.operationId,
    },
  };
}

suite(
  'browser root / operation / authority lock ordering (real PostgreSQL)',
  () => {
    beforeAll(async () => {
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw Error('dedicated database required');
      const url = new URL(source);
      assertRuntimeFixtureDatabase(url);
      for (const key of [
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
      ])
        vi.stubEnv(key, '1');
      vi.stubEnv('ALLRICE_BROWSER_CONTROL_KEY', '17'.repeat(32));
      admin = postgres(source, { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set(
        'options',
        `-csearch_path=${schema},public -cstatement_timeout=10000`,
      );
      db = postgres(url.toString(), { max: 8, onnotice: () => {} });
      const dir = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(dir))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, dir), 'utf8'));
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-browser-locks-'));
      vi.stubEnv('ALLRICE_STORAGE_ROOT', storageRoot);
    }, 60000);
    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^browser_lock_[a-f0-9]{32}$/.test(schema))
          throw Error('unsafe schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-browser-locks-'))
        await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it.each([
      'request_status',
      'projection',
      'approval_request',
      'approval_decision',
    ] as const)(
      '%s enters root before browser/controls while real heartbeat holds parent UPDATE',
      async (kind) => {
        const { f, b, op, effect, snapshot, request, status } =
          await pendingSubmission();
        const parentLocked = deferred<void>(),
          releaseHeartbeat = deferred<void>(),
          firstContendedLock = deferred<string>();
        let paused = false,
          reachedBrowser = false,
          reachedControls = false,
          contenderFinished = false;
        const heartbeatDb = scheduleQueries(async (sql, execute) => {
          const result = await execute();
          if (
            !paused &&
            sql.includes(
              'select * from allrice_runtime_operations where id = ? for update',
            )
          ) {
            paused = true;
            parentLocked.resolve();
            await releaseHeartbeat.promise;
          }
          return result;
        });
        const contenderDb = scheduleQueries(async (sql, execute) => {
          if (
            sql.includes('from allrice_browser_workspaces') &&
            sql.includes('for update')
          )
            reachedBrowser = true;
          if (
            sql.includes('from allrice_runtime_policy_controls') &&
            sql.includes('for update')
          )
            reachedControls = true;
          if (
            sql.includes('from allrice_runtime_roots') &&
            sql.includes('for update')
          )
            firstContendedLock.resolve('root');
          else if (
            sql.includes('from allrice_runtime_operations o') &&
            sql.includes('for share of o,i')
          )
            firstContendedLock.resolve('parent-after-browser');
          return execute();
        });
        const heartbeat = renewLocalBrowserOperations(
          f.device,
          b.identity!,
          heartbeatDb,
        );
        void heartbeat.catch(() => undefined);
        await parentLocked.promise;
        const contender = (async () => {
          if (kind === 'request_status')
            return localBrowserEffectStatus(f.device, status, contenderDb);
          if (kind === 'projection')
            return listBrowserWorkspaces(f.context, f.run, contenderDb);
          if (kind === 'approval_request')
            return requestRuntimeActionApproval(
              createBrowserOperationLedger(f.context, contenderDb)
                .policyOptions,
              snapshot.binding,
              120000,
              contenderDb,
            );
          return decideRuntimeActionApproval(
            f.context,
            request.approvalId,
            {
              contractVersion: 1,
              direction: 'response',
              kind: 'action_approval',
              requestId: request.requestId,
              version: request.version,
              requestDigest: request.requestDigest,
              task: request.task,
              responseId: randomUUID(),
              respondedBy: f.user,
              respondedAt: new Date().toISOString(),
              approvalId: request.approvalId,
              decision: 'approved',
            },
            contenderDb,
          );
        })();
        void contender.then(
          () => {
            contenderFinished = true;
          },
          () => {
            contenderFinished = true;
          },
        );
        try {
          expect(await firstContendedLock.promise).toBe('root');
          // Projection first checks the workspace in a separate completed read
          // transaction. The binding transaction itself must begin at root.
          if (kind !== 'projection') expect(reachedBrowser).toBe(false);
          expect(reachedControls).toBe(false);
          expect(contenderFinished).toBe(false);
          releaseHeartbeat.resolve();
          const [, result] = await Promise.all([heartbeat, contender]);
          if (kind === 'request_status')
            expect(result).toMatchObject({ status: 'pending' });
          if (kind === 'projection')
            expect(result).toEqual(
              expect.arrayContaining([expect.objectContaining({ id: b.w.id })]),
            );
          const [child] =
            await db`select i.started_at,i.lease_token,a.runtime_consumed_at from allrice_browser_operation_inputs i
        join allrice_approval_requests a on a.resource_id=i.operation_id and a.resource_type='runtime_operation' where i.operation_id=${effect.operationId}`;
          expect(child).toMatchObject({
            started_at: null,
            lease_token: null,
            runtime_consumed_at: null,
          });
          expect(
            (
              await createBrowserOperationLedger(f.context, db).readOperation(
                op.snapshot.binding.task.scope,
                status.operationId,
              )
            ).status,
          ).toBe('running');
        } finally {
          releaseHeartbeat.resolve();
          await Promise.allSettled([heartbeat, contender]);
        }
      },
      15000,
    );

    it('rejects foreign device, owner, altered root and changed immutable inputs before browser locks', async () => {
      const { f, b, snapshot } = await pendingSubmission();
      const locks: string[] = [];
      const watched = scheduleQueries(async (sql, execute) => {
        if (sql.includes('for update')) locks.push(sql);
        return execute();
      });
      await expect(
        ownedLocalBrowserOperation(
          { ...f.device, id: randomUUID() },
          { ...b.identity!, operationId: snapshot.binding.attempt.operationId },
          true,
          watched,
        ),
      ).rejects.toThrow('local_browser_operation_denied');
      await expect(
        watched.begin((tx) =>
          lockBrowserBindingOperations(
            tx,
            { ...f.context, actor: { type: 'user', id: randomUUID() } },
            snapshot.binding,
          ),
        ),
      ).rejects.toThrow('binding_scope_mismatch');
      await expect(
        watched.begin((tx) =>
          lockBrowserBindingOperations(tx, f.context, {
            ...snapshot.binding,
            task: {
              ...snapshot.binding.task,
              rootRunId: randomUUID(),
              parentRunId: randomUUID(),
            },
          }),
        ),
      ).rejects.toThrow('browser_input_changed');
      expect(locks).toEqual([]);
      let changed = false;
      const racing = scheduleQueries(async (sql, execute) => {
        const result = await execute();
        if (
          !changed &&
          sql.includes('from allrice_runtime_roots') &&
          sql.includes('for update')
        ) {
          changed = true;
          await db`update allrice_browser_operation_inputs set payload=jsonb_set(payload,'{fence}','2') where operation_id=${snapshot.binding.attempt.operationId}`;
        }
        return result;
      });
      await expect(
        racing.begin((tx) =>
          lockBrowserBindingOperations(tx, f.context, snapshot.binding),
        ),
      ).rejects.toThrow('browser operation inputs are immutable');
    }, 15000);
  },
);
