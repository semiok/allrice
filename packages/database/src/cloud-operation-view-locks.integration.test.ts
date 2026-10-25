import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import {
  cancelCloudRuntimeRun,
  listCloudRuntimeOperations,
} from './cloud-operation-view.ts';
import { createReadPathProbe } from './read-path-probe.fixture.ts';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>,
  current: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  // Helpers that open their own connection must use the probed client too.
  getDatabase: () => current,
}));
const schema = `read_locks_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

function signal<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function settle(work: readonly Promise<unknown>[]) {
  // Await every transaction before the next case reuses the schema.
  const results = await Promise.allSettled(work);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
}

suite(
  'cloud operation polling takes no row locks — isolated PostgreSQL',
  () => {
    beforeAll(async () => {
      if (!process.env.ALLRICE_TEST_DATABASE_URL)
        throw Error('dedicated DB required');
      vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
        max: 2,
        onnotice: () => {},
      });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 12, onnotice: () => {} });
      current = db;
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-read-locks-'));
    }, 60_000);

    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^read_locks_[a-f0-9]{32}$/.test(schema))
          throw Error('bad test schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-read-locks-'))
        await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    async function pendingOperation() {
      const f = await createCloudExecutionFixture(db, storageRoot);
      const created = await f.create();
      expect(created.snapshot.status).toBe('waiting_user');
      const [membership] = await db<{ id: string }[]>`
      select id from allrice_memberships where user_id=${f.user} and organization_id=${f.org}`;
      return { f, created, membership: membership!.id };
    }

    async function poll(
      f: Awaited<ReturnType<typeof pendingOperation>>['f'],
      options: Parameters<typeof createReadPathProbe>[1] = {},
    ) {
      const probe = createReadPathProbe(db, options);
      current = probe.db;
      try {
        const views = await listCloudRuntimeOperations(
          f.context,
          f.run,
          probe.db,
        );
        return { views, probe };
      } finally {
        current = db;
      }
    }

    it('commits every polling transaction without a transaction id, before and after approval', async () => {
      const { f, created } = await pendingOperation();
      const pending = await poll(f);
      expect(pending.views).toHaveLength(1);
      expect(pending.views[0]?.approval?.response).toBeNull();
      pending.probe.expectNoRowLocks();

      await f.approve(created);
      const approved = await poll(f);
      expect(approved.views[0]?.approval?.response?.decision).toBe('approved');
      approved.probe.expectNoRowLocks();
    }, 30_000);

    it('worker first: polling never waits on identity rows an admission-style writer holds', async () => {
      const { f, membership } = await pendingOperation();
      const writerLocked = signal(),
        pageDone = signal();
      // Old order: Worker locks identity rows, then updates the Run. Page polling
      // used to share-lock the Run and then wait on those identity rows.
      const writer = db.begin(async (tx) => {
        await tx`set local lock_timeout='5s'`;
        await tx`update allrice_users set updated_at=clock_timestamp() where id=${f.user}`;
        await tx`update allrice_memberships set updated_at=clock_timestamp() where id=${membership}`;
        await tx`update allrice_organizations set revision=revision where id=${f.org}`;
        await tx`update allrice_workspaces set name=name where id=${f.workspace}`;
        writerLocked.resolve();
        // Hold every identity row until the page has fully finished.
        await pageDone.promise;
        const updated = await tx`
        update allrice_runs set updated_at=clock_timestamp() where id=${f.run} returning id`;
        expect(updated).toHaveLength(1);
      });
      const page = writerLocked.promise.then(async () => {
        try {
          const { views, probe } = await poll(f, { lockTimeout: '2s' });
          expect(views).toHaveLength(1);
          probe.expectNoRowLocks();
        } finally {
          pageDone.resolve();
        }
      });
      await settle([writer, page]);
    }, 30_000);

    it('page first: an open polling transaction never blocks identity and Run writes', async () => {
      const { f, membership } = await pendingOperation();
      const pageOpen = signal(),
        writerDone = signal();
      let paused = false;
      const page = poll(f, {
        beforeCommit: async () => {
          if (paused) return;
          paused = true;
          // The polling transaction stays open while the writer commits.
          pageOpen.resolve();
          await writerDone.promise;
        },
      });
      void page.catch((error: unknown) => pageOpen.reject(error));
      const writer = pageOpen.promise
        .then(() =>
          db.begin(async (tx) => {
            await tx`set local lock_timeout='2s'`;
            await tx`update allrice_users set updated_at=clock_timestamp() where id=${f.user}`;
            await tx`update allrice_memberships set updated_at=clock_timestamp() where id=${membership}`;
            const updated = await tx`
            update allrice_runs set state=state,updated_at=clock_timestamp() where id=${f.run} returning id`;
            expect(updated).toHaveLength(1);
          }),
        )
        .finally(() => writerDone.resolve());
      await settle([page, writer]);
      const { views, probe } = await page;
      expect(views).toHaveLength(1);
      probe.expectNoRowLocks();
    }, 30_000);

    it('cancel does not wait on identity rows and still requires current ownership', async () => {
      const { f, membership } = await pendingOperation();
      const writerLocked = signal(),
        cancelDone = signal();
      const writer = db.begin(async (tx) => {
        await tx`update allrice_users set updated_at=clock_timestamp() where id=${f.user}`;
        await tx`update allrice_memberships set updated_at=clock_timestamp() where id=${membership}`;
        writerLocked.resolve();
        await cancelDone.promise;
      });
      const cancel = writerLocked.promise.then(async () => {
        const probe = createReadPathProbe(db, { lockTimeout: '2s' });
        try {
          expect(
            await cancelCloudRuntimeRun(f.context, f.run, probe.db),
          ).toMatchObject({ accepted: true, status: 'cancel_requested' });
        } finally {
          cancelDone.resolve();
        }
      });
      await settle([writer, cancel]);
      const [root] = await db<{ cancel_request_id: string | null }[]>`
      select cancel_request_id from allrice_runtime_roots where root_run_id=${f.run}`;
      expect(root?.cancel_request_id).toBeTypeOf('string');

      await db`update allrice_memberships set active=false where id=${membership}`;
      await expect(
        cancelCloudRuntimeRun(f.context, f.run, db),
      ).rejects.toMatchObject({ code: 'run_not_owned' });
      await expect(
        listCloudRuntimeOperations(f.context, f.run, db),
      ).rejects.toMatchObject({ code: 'run_not_owned' });
    }, 30_000);

    it('another owner cannot read or cancel the Run', async () => {
      const { f } = await pendingOperation();
      const stranger = {
        ...f.context,
        actor: { type: 'user' as const, id: randomUUID() },
      };
      await expect(
        listCloudRuntimeOperations(stranger, f.run, db),
      ).rejects.toMatchObject({ code: 'run_not_owned' });
      await expect(
        cancelCloudRuntimeRun(stranger, f.run, db),
      ).rejects.toMatchObject({ code: 'run_not_owned' });
    }, 30_000);
  },
);
