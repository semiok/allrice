import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import {
  AssistantFixtureCleanupError,
  AssistantFixtureInitializationError,
  createAssistantFixtureDatabase,
  type AssistantFixtureCleanupProof,
} from './assistant-runtime.fixture.ts';

const faults = vi.hoisted(() => ({ mode: 'none' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      if (
        faults.mode === 'mkdtemp' &&
        String(args[0]).includes('allrice-p25-artifacts-')
      )
        throw Error('synthetic_storage_creation_fault');
      return actual.mkdtemp(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (
        faults.mode === 'migrations' &&
        String(args[0]).endsWith('/packages/database/migrations/')
      )
        throw Error('synthetic_migration_read_fault');
      return actual.readdir(...args);
    },
  };
});
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'assistant fixture partial initialization cleanup (actual isolated PG)',
  () => {
    let observer: ReturnType<typeof postgres>;
    let url: string;
    beforeAll(() => {
      const value = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!value) throw Error('Dedicated fixture database required');
      assertRuntimeFixtureDatabase(new URL(value));
      url = value;
      observer = postgres(url, {
        max: 1,
        onnotice: () => {},
        connect_timeout: 5,
        connection: {
          application_name: `fixture-cleanup-observer-${randomUUID()}`,
        },
      });
    });
    afterEach(() => {
      faults.mode = 'none';
    });
    afterAll(async () => {
      await observer?.end({ timeout: 5 });
    });
    async function initializationFailure() {
      const result = await createAssistantFixtureDatabase().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if ('value' in result) {
        await result.value.close();
        throw Error('Expected injected initialization failure');
      }
      expect(result.error).toBeInstanceOf(AssistantFixtureInitializationError);
      return (result.error as AssistantFixtureInitializationError).cleanup;
    }
    async function verifyRemovedSchemaAndClosedConnections(
      proof: AssistantFixtureCleanupProof,
    ) {
      expect(proof.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      const [row] = await observer<
        { absent: boolean }[]
      >`select to_regnamespace(${proof.schema}) is null as absent`;
      expect(row!.absent).toBe(true);
      await expect
        .poll(
          async () => {
            const [connections] = await observer<
              { n: number }[]
            >`select count(*)::integer as n from pg_stat_activity where application_name=${proof.schema}`;
            return connections!.n;
          },
          { timeout: 2000 },
        )
        .toBe(0);
      expect(proof.schemaRemoved).toBe(true);
      expect(proof.databaseClosed).toBe(true);
      expect(proof.adminClosed).toBe(true);
    }
    it('cleans the real schema/admin after mkdtemp fails, but does not invent filesystem-absence proof', async () => {
      faults.mode = 'mkdtemp';
      const proof = await initializationFailure();
      await verifyRemovedSchemaAndClosedConnections(proof);
      expect(proof.storageRoot).toBeNull();
      expect(proof.storageRemoved).toBe(false);
    });
    it('cleans the independently allocated fixture storage after a migration read fails', async () => {
      faults.mode = 'migrations';
      const proof = await initializationFailure();
      await verifyRemovedSchemaAndClosedConnections(proof);
      expect(proof.storageRoot).toContain('allrice-p25-artifacts-');
      expect(proof.storageRemoved).toBe(true);
      await expect(lstat(proof.storageRoot!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('does not claim a DROP succeeded when a real competing PG lock blocks it', async () => {
      const database = await createAssistantFixtureDatabase();
      const [schemaRow] = await database.db<
        { name: string }[]
      >`select current_schema() as name`;
      const schema = schemaRow!.name;
      expect(schema).toMatch(/^p25_[a-f0-9]{32}$/);
      const blocker = postgres(url, {
        max: 1,
        onnotice: () => {},
        connect_timeout: 5,
      });
      let release!: () => void, locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = blocker.begin(async (tx) => {
        await tx.unsafe(
          `lock table "${schema}".allrice_users in access exclusive mode`,
        );
        locked();
        await released;
      });
      holding.catch(() => {});
      try {
        await lockReady;
        const failure = await database.close().then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(AssistantFixtureCleanupError);
        const proof = (failure as AssistantFixtureCleanupError).cleanup;
        expect(proof.schemaRemoved).toBe(false);
        expect(proof.databaseClosed).toBe(true);
        expect(proof.adminClosed).toBe(true);
        const [row] = await observer<
          { present: boolean }[]
        >`select to_regnamespace(${schema}) is not null as present`;
        expect(row!.present).toBe(true);
      } finally {
        release();
        await holding;
        await blocker.end({ timeout: 5 });
        await database.close().catch(() => {});
        // Only this test's validated fresh schema, after releasing our own lock.
        await observer.unsafe(`drop schema if exists "${schema}" cascade`);
      }
    }, 20000);
  },
);
