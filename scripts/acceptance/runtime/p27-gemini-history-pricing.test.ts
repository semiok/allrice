/** Synthetic historical Run only. Gemini new-task dispatch was retired by
 * MET-163 / 0117. No Worker entrypoint, model, credential or real tariff here. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EmployeeExecutionSnapshotSchema,
  RouteDecisionSchema,
  SessionModelSnapshotSchema,
  selectAssistantPriceSnapshot,
  type AssistantPriceCatalog,
} from '../../../packages/contracts/src/index.ts';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../packages/database/src/assistant-authority.fixture.ts';
import { createAssistantPricing } from '../../../packages/database/src/assistant-pricing.ts';
import { runtimePolicyDigest } from '../../../packages/database/src/runtime-policy.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from '../../../packages/database/src/execution/route-decision.ts';
import {
  preflightAssistantPricing,
  assistantResultCostCents,
} from '../../../apps/worker/src/assistant-pricing-preflight.ts';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('P27 synthetic historical Gemini Run accounting', () => {
  it('selects and freezes a finite synthetic tariff, authorizes usage and checks receipts and the ledger', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    let database:
      Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined;
    try {
      database = await createAssistantFixtureDatabase();
      const { db } = database;
      const [catalogEntry] = await db<
        { id: string; provider_id: string; enabled: boolean }[]
      >`
        select m.id,m.provider_id,m.enabled from allrice_model_catalog_entries m
        join allrice_model_providers p on p.id=m.provider_id
        where p.provider_key='gemini' and p.auth_mode='api_key' and m.model='gemini-3.8-flash'`;
      expect(catalogEntry).toMatchObject({ enabled: false });
      const connectionId = randomUUID();
      await db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,status)
        values(${connectionId},${catalogEntry!.provider_id},'platform','Synthetic historical Gemini Run',
        'test:synthetic-history-never-resolved','disabled')`;
      const f = await createAssistantAuthorityFixture(db, {
        runtimePolicy: {
          harness: 'dsh',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          reasoningEffort: 'low',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'test:synthetic-history-never-resolved',
          baseUrl: null,
        },
        // Explicit first-INSERT historical data, never a fabricated return
        // value from today's prepareEmployeeRunBinding / platform router.
        snapshot: (value, { sessionId }) => ({
          ...value,
          modelSnapshot: SessionModelSnapshotSchema.parse({
            schemaVersion: 1,
            sessionId,
            employeeId: value.employee.id,
            policyRevision: 1,
            connectionId,
            modelCatalogEntryId: catalogEntry!.id,
            harness: 'dsh',
            provider: 'gemini',
            authMode: 'api_key',
            model: 'gemini-3.8-flash',
            reasoningEffort: 'low',
            credentialReference: 'test:synthetic-history-never-resolved',
            baseUrl: null,
            fallbackPolicy: 'disabled',
            fallbackTargets: [],
            resolvedFallbacks: [],
            frozenAt: new Date().toISOString(),
          }),
        }),
      });
      await db`update allrice_chat_sessions set title='Synthetic historical Gemini Run' where id=${f.session}`;
      const [stored] =
        await db`select execution_snapshot,provider_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`;
      const historical = EmployeeExecutionSnapshotSchema.parse(
        stored!.execution_snapshot,
      );
      if (historical.schemaVersion !== 2 || !historical.modelSnapshot)
        throw Error('Missing synthetic historical model snapshot');
      const modelSnapshot = historical.modelSnapshot;
      const decision = RouteDecisionSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        runId: f.rootRunId,
        organizationId: f.org,
        workspaceId: f.workspace,
        actorId: f.user,
        employeeId: f.employee,
        inputChecksum: runtimePolicyDigest({ syntheticHistoricalRun: true }),
        candidates: [
          {
            id: 'direct:synthetic-history',
            kind: 'direct',
            name: 'Synthetic historical Run',
            bindingId: null,
            requiredCapabilities: ['model:invoke'],
            risk: 'low',
            requiresApproval: false,
            authorized: true,
            exclusionReason: null,
            score: 1,
          },
        ],
        selectedKind: 'direct',
        selectedCandidateId: 'direct:synthetic-history',
        harness: 'dsh',
        provider: modelSnapshot.provider,
        model: modelSnapshot.model,
        modelConnectionId: connectionId,
        modelCatalogEntryId: catalogEntry!.id,
        modelPolicyRevision: modelSnapshot.policyRevision,
        generation: f.worker.generation,
        attempt: 1,
        reasonCodes: ['direct_no_capability_match'],
        createdAt: new Date().toISOString(),
      });
      // Recreate the stored route for accounting; this does not route or dispatch work.
      await recordRouteDecision(decision, db);
      const [clock] = await db<
        { now: Date }[]
      >`select clock_timestamp() as now`;
      const now = clock!.now.getTime();
      const target = {
        connectionId,
        catalogId: catalogEntry!.id,
        harness: 'dsh' as const,
        provider: 'gemini',
        authMode: 'api_key' as const,
        model: modelSnapshot.model,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        serviceTier: 'default',
        modality: 'text' as const,
      };
      const rates = {
        uncachedInputMicrounitsPerMillion: '2000000',
        cacheReadMicrounitsPerMillion: '500000',
        cacheWriteMicrounitsPerMillion: '3000000',
        outputMicrounitsPerMillion: '8000000',
      };
      const catalog: AssistantPriceCatalog = {
        version: 1,
        catalogVersion: 'synthetic-historical-run-not-provider-prices',
        entries: [
          {
            id: 'synthetic-historical-gemini',
            target,
            billingMode: 'token_metered',
            currency: 'USD',
            effectiveAt: new Date(now - 60000).toISOString(),
            expiresAt: new Date(now + 3600000).toISOString(),
            maxInputTokens: 100000,
            maxOutputTokens: 100000,
            rates,
            source: {
              reference: 'synthetic-historical-run-only',
              digest: runtimePolicyDigest(rates),
            },
          },
        ],
      };
      vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', JSON.stringify(catalog));
      vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'USD');
      const preflight = {
        enabled: true,
        sessionId: f.session,
        deadlineAt: new Date(now + 300000).toISOString(),
        modelSnapshot,
        decision,
        providerSnapshot: stored!.provider_snapshot,
        hasNonTextInput: false,
        at: new Date(now).toISOString(),
      };
      const snapshot = preflightAssistantPricing(preflight)!;
      expect(snapshot).toEqual(
        selectAssistantPriceSnapshot({
          catalog,
          target,
          currency: 'USD',
          at: preflight.at,
        }),
      );
      expect(() =>
        preflightAssistantPricing({
          ...preflight,
          decision: { ...decision, modelConnectionId: randomUUID() },
        }),
      ).toThrow('ASSISTANT_PRICE_ROUTE_UNVERIFIED');
      expect(() =>
        selectAssistantPriceSnapshot({
          catalog,
          target,
          currency: 'USD',
          at: snapshot.price.expiresAt,
        }),
      ).toThrow();
      const pricing = createAssistantPricing({ database: db });
      await expect(
        pricing.freeze({
          ...f.base,
          snapshot: {
            ...snapshot,
            selectedAt: new Date(now - 120000).toISOString(),
            price: {
              ...snapshot.price,
              effectiveAt: new Date(now - 180000).toISOString(),
              expiresAt: new Date(now - 60000).toISOString(),
            },
          },
        }),
      ).rejects.toThrow('ASSISTANT_PRICE_FREEZE_TOO_LATE');
      const frozen = await pricing.freeze({ ...f.base, snapshot });
      expect(frozen).toEqual({
        frozen: true,
        snapshotDigest: runtimePolicyDigest(snapshot),
      });
      await expect(f.authorize('model', [])).resolves.toBeUndefined();

      for (const complete of [true, false]) {
        const callId = randomUUID(),
          requestDigest = runtimePolicyDigest({
            callId,
            syntheticHistoricalRun: true,
          });
        await f.runtime.prepareModelUsage({
          ...f.base,
          runId: f.rootRunId,
          callId,
          requestedOutputTokens: 100,
        });
        await f.runtime.dispatchModelUsage({
          ...f.base,
          runId: f.rootRunId,
          callId,
          requestDigest,
          inputTokens: 1000,
          outputTokens: 100,
        });
        await f.runtime.settleUsage({
          ...f.base,
          runId: f.rootRunId,
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 100,
            ...(complete ? { output_tokens: 30 } : {}),
          },
        });
        const receipt = {
          ...f.base,
          runId: f.rootRunId,
          callId,
          requestDigest,
          snapshotDigest: frozen.snapshotDigest,
          usage: {
            inputTokens: 100,
            outputTokens: complete ? 30 : null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            usageComplete: complete,
          },
        };
        await expect(
          pricing.recordUsage({
            ...receipt,
            requestDigest: runtimePolicyDigest({ wrong: true }),
          }),
        ).rejects.toThrow('ASSISTANT_PRICING_CALL_CONFLICT');
        await expect(
          pricing.recordUsage({
            ...receipt,
            usage: { ...receipt.usage, inputTokens: 101 },
          }),
        ).rejects.toThrow('ASSISTANT_PRICING_USAGE_UNCONFIRMED');
        expect(await pricing.recordUsage(receipt)).toMatchObject({
          recorded: true,
        });
        expect(await pricing.recordUsage(receipt)).toMatchObject({
          recorded: false,
        });
        const [row] =
          await db`select snapshot_digest,usage_complete,cost_basis,cost_picounits,actual_cost_known,cache_usage_known
          from allrice_assistant_cost_receipts where call_id=${callId}`;
        expect(row).toMatchObject({
          snapshot_digest: frozen.snapshotDigest,
          usage_complete: complete,
          cost_basis: complete ? 'conservative_upper_bound' : 'unknown',
          cost_picounits: complete ? '540000000' : null,
          actual_cost_known: false,
          cache_usage_known: false,
        });
        const summary = await pricing.summarize(f.base);
        expect(summary).toMatchObject({
          snapshotDigest: frozen.snapshotDigest,
          usageComplete: complete,
          callCount: complete ? 1 : 2,
          costCentsDecimal: complete ? '0.054000' : null,
        });
        if (complete) {
          const result: HarnessExecutionResult = {
            answer: 'Synthetic historical receipt',
            provider: 'gemini',
            model: modelSnapshot.model,
            assistantStatus: 'completed',
            usage: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 0 },
            usageComplete: true,
            cacheUsageKnown: false,
            actualCostKnown: false,
            costEstimateAvailable: true,
            estimatedCostCents: 0.054,
            costBasis: 'conservative_upper_bound',
            costCurrency: 'USD',
            priceSnapshotDigest: frozen.snapshotDigest,
          };
          expect(assistantResultCostCents(snapshot, result)).toBe(0.054);
          expect(
            assistantResultCostCents(snapshot, {
              ...result,
              priceSnapshotDigest: runtimePolicyDigest({ wrong: true }),
            }),
          ).toBeNull();
          await completeRouteDecision(
            {
              organizationId: f.org,
              workspaceId: f.workspace,
              outcome: {
                decisionId: decision.id,
                status: 'succeeded',
                errorCode: null,
                completedAt: new Date().toISOString(),
                inputTokens: 100,
                outputTokens: 30,
                cachedInputTokens: 0,
                costCents: assistantResultCostCents(snapshot, result),
                usageComplete: true,
                cacheUsageKnown: false,
              },
            },
            db,
          );
          const [ledger] =
            await db`select cost_cents::text,input_tokens,output_tokens,usage_complete
            from allrice_model_usage_ledger where route_decision_id=${decision.id} and organization_id=${f.org}`;
          expect(ledger).toEqual({
            cost_cents: '0.054000',
            input_tokens: 100,
            output_tokens: 30,
            usage_complete: true,
          });
        }
      }
      await expect(
        pricing.summarize({
          ...f.base,
          worker: { ...f.worker, leaseToken: randomUUID() },
        }),
      ).rejects.toThrow('ASSISTANT_PRICING_LEASE_LOST');
      await f.setControls({
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'assistant.delegate', effect: 'deny' }],
      });
      await expect(
        f.runtime.prepareModelUsage({
          ...f.base,
          runId: f.rootRunId,
          callId: randomUUID(),
          requestedOutputTokens: 100,
        }),
      ).rejects.toThrow('assistant_authority_denied');
      expect(
        await db`select provider_snapshot,execution_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`,
      ).toEqual([stored]);
      const [connection] =
        await db`select status from allrice_model_connections where id=${connectionId}`;
      expect(connection!.status).toBe('disabled');
    } finally {
      try {
        if (database)
          expect(await database.close()).toMatchObject({
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  }, 30000);
});
