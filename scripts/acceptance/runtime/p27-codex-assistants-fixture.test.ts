/** Isolated real PG preparation only; never invokes Worker/model/native hosts. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createP27CodexAssistantsFixture,
  type P27CodexAssistantsFixture,
} from './p27-codex-assistants-fixture.ts';
import { codexAssistantsFailureSnapshot } from './p27-codex-assistants-smoke.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'assistant Codex fixture preparation without model execution',
  () => {
    let fixture: P27CodexAssistantsFixture;
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('DATABASE_URL', 'postgres://forbidden.invalid/prod');
      await expect(createP27CodexAssistantsFixture()).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_AMBIENT_DATABASE',
      });
      vi.stubEnv('DATABASE_URL', undefined);
      fixture = await createP27CodexAssistantsFixture();
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

    it('pins both pools to a generated allrice_b2 schema without work or pricing', async () => {
      const { getDatabase } =
        await import('../../../packages/database/src/index.ts');
      const [identity] =
        await getDatabase()`select current_schema() as schema,current_database() as database`;
      expect(identity).toEqual({
        schema: fixture.schema,
        database: 'allrice_b2',
      });
      expect(fixture.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_runs) as runs,
      (select count(*)::int from allrice_jobs) as jobs,
      (select count(*)::int from allrice_assistant_roots) as roots,
      (select count(*)::int from allrice_assistant_price_snapshots) as prices`;
      expect(counts).toEqual({ runs: 0, jobs: 0, roots: 0, prices: 0 });
      await expect(createP27CodexAssistantsFixture()).rejects.toMatchObject({
        code: 'P27_CODEX_WORKER_FIXTURE_ALREADY_OWNED',
      });
    });

    it('freezes an two-child subscription task with no tools/fallbacks/retries', async () => {
      const task = await fixture.prepareAssistantTask();
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
        expect(definition.capabilityBindings.toolNames).toEqual([
          'assistant.delegate',
          'assistant.report',
        ]);
      expect(resolved.grantedCapabilities).toEqual(['model:invoke']);
      const { riceToolDefinitionsForCapabilities } =
        await import('../../../apps/worker/src/tool-broker/definitions.ts');
      expect(
        riceToolDefinitionsForCapabilities(resolved.grantedCapabilities, [
          'assistant.delegate',
          'assistant.report',
        ]).map((tool) => tool.name),
      ).toEqual(['assistant.delegate', 'assistant.report']);
      expect(task.execution.payload.input).toMatchObject({
        assistantConfiguration: {
          allowAssistants: true,
          maxChildren: 2,
          maxConcurrent: 2,
          maxDepth: 1,
        },
      });
      const [job] = await fixture.db`select status,attempt,max_attempts,
      lease_expires_at>clock_timestamp() as live from allrice_jobs where id=${task.workflowLease.jobId}`;
      expect(job).toEqual({
        status: 'running',
        attempt: 1,
        max_attempts: 1,
        live: true,
      });
      await expect(fixture.prepareAssistantTask()).rejects.toMatchObject({
        code: 'already_attempted',
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
      await expect(
        codexAssistantsFailureSnapshot(fixture, task),
      ).resolves.toMatchObject({
        runId: task.runId,
        routes: [],
        ledgers: [],
        instances: [],
        admissions: [],
        usage: [],
        receiptContract: 'not_applicable_subscription',
        nativeDiagnostics: { status: 'unavailable' },
      });
      await expect(
        fixture.prepareOrdinaryTask({ afterRunId: task.runId }),
      ).rejects.toMatchObject({ code: 'first_not_terminal' });
      await expect(
        fixture.prepareOrdinaryTask({ afterRunId: fixture.ownerId }),
      ).rejects.toMatchObject({ code: 'first_run_mismatch' });
    });
  },
);
