/** Isolated real PG preparation only; never invokes Worker/model/native hosts. */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createP27CodexWorkerFixture,
  type P27CodexWorkerFixture,
} from './p27-codex-worker-fixture.ts';
import { P27_CODEX_ORDINARY_PROMPT } from './p27-codex-worker-preflight.ts';
import { codexWorkerFailureSnapshot } from './p27-codex-worker-smoke.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

describe.sequential(
  'Codex fixture database authorization (zero database I/O)',
  () => {
    const local = 'postgres://a123@127.0.0.1:5432/allrice_b2';
    const ci = 'postgres://allrice:allrice@127.0.0.1:54329/allrice';
    beforeEach(() => {
      vi.stubEnv('DATABASE_URL', undefined);
      vi.stubEnv('ALLRICE_TEST_DATABASE_URL', local);
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      // A valid URL must stop here, before ownership, pools, schema or imports.
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each([undefined, false])(
      'does not authorize CI through the environment when opt-in is %s',
      async (allowCiDatabase) => {
        vi.stubEnv('ALLRICE_TEST_DATABASE_URL', ci);
        await expect(
          createP27CodexWorkerFixture({ allowCiDatabase }),
        ).rejects.toMatchObject({
          code: 'P27_CODEX_WORKER_DATABASE_NOT_AUTHORIZED',
        });
      },
    );
    it.each([
      { url: local, allowCiDatabase: undefined },
      { url: local, allowCiDatabase: true },
      { url: ci, allowCiDatabase: true },
    ])(
      'accepts only an authorized URL before the no-I/O safety stop: $url',
      async ({ url, allowCiDatabase }) => {
        vi.stubEnv('ALLRICE_TEST_DATABASE_URL', url);
        await expect(
          createP27CodexWorkerFixture({ allowCiDatabase }),
        ).rejects.toMatchObject({
          code: 'P27_CODEX_WORKER_FIXTURE_FLAGS_REQUIRED',
        });
        expect(process.env.DATABASE_URL).toBeUndefined();
      },
    );
    it.each([
      'postgres://test-only@dev.invalid:5432/allrice',
      'postgres://test-only@prod.invalid:5432/allrice',
      'postgres://a123@127.0.0.1:5432/allrice_dev',
      'postgres://a123@127.0.0.1:5432/allrice_prod',
      'postgres://allrice:allrice@localhost:54329/allrice',
      'postgres://allrice:allrice@127.0.0.1:54329/arbitrary',
      `${ci}?options=-csearch_path%3Dpublic`,
      `${local}?application_name=not-the-exact-whitelist`,
    ])(
      'rejects non-whitelisted URLs even with explicit test opt-in: %s',
      async (url) => {
        vi.stubEnv('ALLRICE_TEST_DATABASE_URL', url);
        await expect(
          createP27CodexWorkerFixture({ allowCiDatabase: true }),
        ).rejects.toMatchObject({
          code: 'P27_CODEX_WORKER_DATABASE_NOT_AUTHORIZED',
        });
        expect(process.env.DATABASE_URL).toBeUndefined();
      },
    );
    it('cannot override an ambient deployment database with test opt-in', async () => {
      vi.stubEnv('ALLRICE_TEST_DATABASE_URL', ci);
      vi.stubEnv(
        'DATABASE_URL',
        'postgres://test-only@prod.invalid:5432/allrice',
      );
      await expect(
        createP27CodexWorkerFixture({ allowCiDatabase: true }),
      ).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_AMBIENT_DATABASE',
      });
    });
  },
);

integration(
  'ordinary Codex fixture preparation without model execution',
  () => {
    let fixture: P27CodexWorkerFixture;
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      // A rejected checkpoint owns no pools/schema and must not poison the
      // subsequent normal fixture's process-local ownership fence.
      await expect(
        createP27CodexWorkerFixture({
          throughMigration: '0095_assistant_model_admissions.sql' as never,
        }),
      ).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_MIGRATION_CHECKPOINT_INVALID',
      });
      expect(process.env.DATABASE_URL).toBeUndefined();
      const dedicatedDatabase = process.env.ALLRICE_TEST_DATABASE_URL;
      vi.stubEnv(
        'ALLRICE_TEST_DATABASE_URL',
        'postgres://allrice:allrice@127.0.0.1:54329/allrice',
      );
      // Merely inheriting CI's URL cannot redirect a live/default driver.
      await expect(createP27CodexWorkerFixture()).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_DATABASE_NOT_AUTHORIZED',
      });
      vi.stubEnv('ALLRICE_TEST_DATABASE_URL', dedicatedDatabase);
      vi.stubEnv('DATABASE_URL', 'postgres://forbidden.invalid/prod');
      await expect(createP27CodexWorkerFixture()).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_AMBIENT_DATABASE',
      });
      vi.stubEnv('DATABASE_URL', undefined);
      fixture = await createP27CodexWorkerFixture({ allowCiDatabase: true });
    }, 30000);
    afterAll(async () => {
      if (fixture) {
        const proof = await fixture.close();
        expect(proof).toMatchObject({
          globalDatabaseClosed: true,
          databaseEnvironmentRestored: true,
          fixture: {
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          },
        });
        expect(await fixture.close()).toEqual(proof);
        expect(process.env.DATABASE_URL).toBeUndefined();
        await expect(fixture.db`select 1`).rejects.toBeDefined();
      }
      vi.unstubAllEnvs();
    }, 20000);

    it('pins both pools to an explicitly authorized test database and random schema without work or pricing', async () => {
      const { getDatabase } =
        await import('../../../packages/database/src/index.ts');
      const [identity] =
        await getDatabase()`select current_schema() as schema,current_database() as database`;
      expect(identity).toEqual({
        schema: fixture.schema,
        database: new URL(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        ).pathname.slice(1),
      });
      expect(fixture.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_runs) as runs,
      (select count(*)::int from allrice_jobs) as jobs,
      (select count(*)::int from allrice_assistant_roots) as roots,
      (select count(*)::int from allrice_assistant_price_snapshots) as prices`;
      expect(counts).toEqual({ runs: 0, jobs: 0, roots: 0, prices: 0 });
      await expect(createP27CodexWorkerFixture()).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_FIXTURE_ALREADY_OWNED',
      });
    });

    it('freezes an ordinary-only subscription task with no tools/fallbacks/retries', async () => {
      const task = await fixture.prepareOrdinaryTask(P27_CODEX_ORDINARY_PROMPT);
      const api = await import('../../../packages/database/src/index.ts');
      const resolved = await api.resolveEmployeeExecution({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        ownerId: fixture.ownerId,
        runId: task.runId,
      });
      expect(resolved.executionSnapshot?.schemaVersion).toBe(2);
      expect(task.binding.executionSnapshot.modelSnapshot).toMatchObject({
        provider: 'openai-codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        connectionId: fixture.connectionId,
        modelCatalogEntryId: fixture.catalogId,
        fallbackPolicy: 'disabled',
        resolvedFallbacks: [],
        fallbackOn: [],
        runLimits: fixture.runLimits,
      });
      expect(resolved.providerSnapshot).toMatchObject({
        provider: 'dsh',
        route: 'openai-codex',
        authMode: 'platform_subscription',
        credentialReference: 'deployment:codex-default',
        baseUrl: null,
      });
      const definition = resolved.executionSnapshot!.employee.definition;
      expect(definition.schemaVersion).toBe(2);
      if (definition.schemaVersion === 2)
        expect(definition.capabilityBindings.toolNames).toEqual([]);
      expect(resolved.grantedCapabilities).toEqual(['model:invoke']);
      const { riceToolDefinitionsForCapabilities } =
        await import('../../../apps/worker/src/tool-broker/definitions.ts');
      expect(
        riceToolDefinitionsForCapabilities(resolved.grantedCapabilities, []),
      ).toEqual([]);
      expect(task.execution.payload.input).toMatchObject({
        assistantConfiguration: { allowAssistants: false },
      });
      const [job] = await fixture.db`select status,attempt,max_attempts,
      lease_expires_at>clock_timestamp() as live from allrice_jobs where id=${task.workflowLease.jobId}`;
      expect(job).toEqual({
        status: 'running',
        attempt: 1,
        max_attempts: 1,
        live: true,
      });
      await expect(
        fixture.prepareOrdinaryTask('not a retry'),
      ).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_ALREADY_ATTEMPTED',
      });
      await api.failJob({
        ...task.workflowLease,
        code: 'P27_SYNTHETIC_PREPARATION_ONLY',
        message: 'No provider was executed by this fixture test',
        retryable: false,
      });
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_runs) as runs,
      (select count(*)::int from allrice_jobs) as jobs,
      (select count(*)::int from allrice_route_decisions) as routes,
      (select count(*)::int from allrice_model_usage_ledger) as ledgers,
      (select count(*)::int from allrice_assistant_roots) as roots`;
      expect(counts).toEqual({
        runs: 1,
        jobs: 1,
        routes: 0,
        ledgers: 0,
        roots: 0,
      });
      await expect(codexWorkerFailureSnapshot(fixture, task)).resolves.toEqual({
        runId: task.runId,
        routes: [],
        ledgers: [],
      });
    });
  },
);
