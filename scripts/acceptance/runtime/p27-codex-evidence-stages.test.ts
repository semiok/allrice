/** Synthetic SQL/storage observations only: no DB, Worker, native or provider.
 * The real validators and frozen subscription schemas remain unmocked. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import { runtimePolicyDigest } from '../../../packages/database/src/runtime-policy.ts';
import type {
  P27CodexWorkerFixture,
  P27PreparedCodexWorkerTask,
} from './p27-codex-worker-fixture.ts';
import { verifyCodexAssistantExecution } from './p27-codex-assistants-verification.ts';
import {
  P27_CODEX_ORDINARY_SOURCE_FILES,
  verifyCodexOrdinary,
} from './p27-codex-worker-smoke.ts';

vi.mock('../../../packages/database/src/assistant-runtime.ts', () => ({
  createAssistantRuntime: () => ({ getTree: async () => current.tree }),
}));
vi.mock('../../../packages/database/src/assistant-authority.ts', () => ({
  assertAssistantAuthority: () => undefined,
}));
vi.mock('../../../packages/storage/src/index.ts', () => ({
  LocalStorageAdapter: class {},
}));
vi.mock('../../../packages/database/src/artifact-review.ts', () => ({
  getWorkbenchArtifact: async (
    _context: unknown,
    _session: unknown,
    id: string,
  ) => current.artifacts.get(id),
  readArtifactBytes: async (_storage: unknown, object: { id: string }) =>
    current.artifacts.get(object.id)!.bytes,
}));
const hash = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sourceSha = 'a'.repeat(40);

function syntheticFixture() {
  const runIds = [randomUUID(), randomUUID(), randomUUID()];
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  const snapshot = {
    version: 1,
    billingMode: 'subscription',
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    sessionId: randomUUID(),
    employeeId: randomUUID(),
    connectionId: randomUUID(),
    modelCatalogEntryId: randomUUID(),
    policyRevision: 1,
    model: 'gpt-5.6-luna',
    credentialReference: 'synthetic-no-credential',
    baseUrl: null,
    frozenAt: '2026-09-01T00:00:00.000Z',
  } as const;
  const modelSnapshot = {
    schemaVersion: 1,
    sessionId: snapshot.sessionId,
    employeeId: snapshot.employeeId,
    policyRevision: 1,
    connectionId: snapshot.connectionId,
    modelCatalogEntryId: snapshot.modelCatalogEntryId,
    harness: snapshot.harness,
    provider: snapshot.provider,
    authMode: snapshot.authMode,
    model: snapshot.model,
    reasoningEffort: 'low',
    credentialReference: snapshot.credentialReference,
    baseUrl: null,
    fallbackPolicy: 'disabled',
    fallbackTargets: [],
    resolvedFallbacks: [],
    frozenAt: snapshot.frozenAt,
  };
  const task = {
    runId: runIds[0],
    sessionId: snapshot.sessionId,
    binding: {
      executionSnapshot: { modelSnapshot },
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: snapshot.model,
        reasoningEffort: 'low',
        credentialReference: snapshot.credentialReference,
        baseUrl: null,
      },
    },
  } as unknown as P27PreparedCodexWorkerTask;
  const id = randomUUID(),
    snapshotDigest = runtimePolicyDigest(snapshot);
  const row = {
    id,
    organization_id: organizationId,
    workspace_id: workspaceId,
    run_id: task.runId,
    provider: snapshot.provider,
    model: snapshot.model,
    harness: snapshot.harness,
    status: 'succeeded',
    employee_id: snapshot.employeeId,
    model_connection_id: snapshot.connectionId,
    model_catalog_entry_id: snapshot.modelCatalogEntryId,
    model_policy_revision: 1,
    input_tokens: 30,
    output_tokens: 15,
    cached_input_tokens: 0,
    cost: null,
    usage_complete: true,
    cache_usage_known: false,
    ledger_input: 30,
    ledger_output: 15,
    ledger_cached: 0,
    ledger_cost: null,
    ledger_complete: true,
    ledger_cache_known: false,
    ledger_status: 'succeeded',
    ledger_route_decision_id: id,
    ledger_organization_id: organizationId,
    ledger_workspace_id: workspaceId,
    snapshot,
    snapshot_digest: snapshotDigest,
  };
  const ordinaryRow = {
    ...row,
    connection_id: snapshot.connectionId,
    auth_mode: snapshot.authMode,
    ledger_input_tokens: 30,
    ledger_output_tokens: 15,
    ledger_cached_input_tokens: 0,
    ledger_cache_usage_known: false,
  };
  const totals = {
    model_calls: 3,
    input_tokens: 30,
    output_tokens: 15,
    tool_calls: 3,
  };
  const artifacts = new Map<
    string,
    {
      bytes: Buffer;
      object: {
        id: string;
        immutable: boolean;
        checksum: string;
        organizationId: string;
        workspaceId: string;
        ownerId: string;
      };
      version: { sessionId: string };
      provenance: { runId: string; stepId: string };
    }
  >();
  const results = runIds.slice(1).map((runId, index) => {
    const artifactId = randomUUID(),
      deliveryId = randomUUID();
    const content =
      index === 0
        ? { case: 'A', totalCents: 875, rows: 2 }
        : {
            case: 'B',
            invoiceCents: 1900,
            paidCents: 1300,
            outstandingCents: 600,
          };
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'assistant_generated',
        independentlyVerified: false,
        name: 'report',
        rootRunId: task.runId,
        childRunId: runId,
        deliveryId,
        content: JSON.stringify(content),
      }),
    );
    const digest = hash(bytes);
    artifacts.set(artifactId, {
      bytes,
      object: {
        id: artifactId,
        immutable: true,
        checksum: digest,
        organizationId,
        workspaceId,
        ownerId,
      },
      version: { sessionId: task.sessionId },
      provenance: { runId, stepId: deliveryId },
    });
    return {
      runId,
      deliveryId,
      status: 'completed',
      incomplete: [],
      parentAdoptedSeq: 2 as number | null,
      evidence: [{ id: artifactId, digest }],
    };
  });
  const tree = {
    cancelRequested: false,
    instances: runIds.map((runId, index) => ({
      runId,
      parentRunId: index ? task.runId : null,
      depth: index ? 1 : 0,
      status: 'completed',
      allowedTools: ['assistant.report'],
    })),
    results,
    messages: results.map(() => ({
      status: 'adopted',
      nativeMessageId: randomUUID(),
      adoptedSeq: 2,
    })),
    budgets: Object.entries(totals).map(([metric, spent]) => ({
      metric,
      currency: null,
      reserved: 0,
      usageComplete: true,
      spent,
    })),
  };
  const usage = runIds.flatMap((run_id) =>
    Object.entries(totals).map(([metric, total]) => ({
      run_id,
      metric,
      amount: String(total / 3),
      settled_amount: String(total / 3),
    })),
  );
  const admissions = runIds.map((run_id) => ({
    call_id: randomUUID(),
    run_id,
    request_digest: hash('request'),
    dispatched: true,
    finished: true,
    identity_matches: true,
    model_calls: '1',
    input_tokens: '10',
    output_tokens: '5',
  }));
  const counts = { roots: 0, jobs: 1, runs: 1 };
  const prices = { prices: 0, receipts: 0, routes: 1 };
  const unsettled = { count: 0 };
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('s.snapshot')) return [row];
    if (query.includes('as prices')) return [prices];
    if (query.includes('as roots')) return [counts];
    if (query.includes('p.auth_mode')) return [ordinaryRow];
    if (query.includes('allrice_assistant_model_admissions a'))
      return admissions;
    if (query.includes('as count')) return [unsettled];
    if (query.includes('select run_id,metric,amount,settled_amount'))
      return usage;
    throw Error('Unexpected synthetic SQL');
  });
  const fixture = {
    db: sql,
    context: {},
    organizationId,
    workspaceId,
    ownerId,
    employeeId: snapshot.employeeId,
    connectionId: snapshot.connectionId,
    catalogId: snapshot.modelCatalogEntryId,
  } as unknown as P27CodexWorkerFixture;
  const result = {
    provider: snapshot.provider,
    model: snapshot.model,
    assistantStatus: 'completed',
    answer: '{"salesTotalCents":875,"outstandingCents":600,"reports":2}',
    usage: { inputTokens: 30, outputTokens: 15, cachedInputTokens: 0 },
    usageComplete: true,
    cacheUsageKnown: false,
    actualCostKnown: false,
    costEstimateAvailable: false,
    estimatedCostCents: null,
    billingMode: 'subscription',
    costBasis: 'not_applicable',
    subscriptionSnapshotDigest: snapshotDigest,
  } as HarnessExecutionResult;
  return {
    fixture,
    task,
    row,
    ordinaryRow,
    tree,
    artifacts,
    admissions,
    counts,
    prices,
    unsettled,
    result,
  };
}
let current: ReturnType<typeof syntheticFixture>;
beforeEach(() => {
  current = syntheticFixture();
});
const verify = (
  saved = vi.fn(async (proof: unknown) => {
    void proof;
  }),
) =>
  verifyCodexAssistantExecution(
    current.fixture,
    current.task,
    current.result,
    undefined,
    { sourceSha, onPlatformVerified: saved },
  );

describe('platform evidence is retained before strict parent business validation', () => {
  it.each([
    '已完成。',
    '{"salesTotalCents":0,"outstandingCents":600,"reports":2}',
  ])(
    'saves fully checked tree/accounting and still fails the wrong parent answer %#',
    async (answer) => {
      current.result.answer = answer;
      const saved = vi.fn(async (proof: unknown) => {
        void proof;
      });
      await expect(verify(saved)).rejects.toThrow();
      expect(saved).toHaveBeenCalledTimes(1);
      const proof = saved.mock.calls[0]![0] as Awaited<
        ReturnType<typeof verifyCodexAssistantExecution>
      >;
      expect(proof.tree).toEqual(current.tree);
      expect(proof.artifacts.map((artifact) => artifact.case)).toEqual([
        'A',
        'B',
      ]);
      expect(proof.subscriptionAccountingProof).toMatchObject({
        sourceSha,
        route: { costCents: null },
        ledger: { costCents: null },
        tree: {
          modelCalls: 3,
          inputTokens: 30,
          outputTokens: 15,
          unsettledUsageCount: 0,
        },
      });
      expect(proof.subscriptionAccountingProof!.admissions).toHaveLength(3);
      expect(proof).not.toHaveProperty('answerDigest');
      expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
      const parserPath = '../platform/p28-subscription-evidence.mjs';
      const { validSubscriptionEvidence } = await import(parserPath);
      expect(
        validSubscriptionEvidence(proof.subscriptionAccountingProof, {
          sourceSha,
          runId: current.task.runId,
          tenantId: current.fixture.organizationId,
          observedAt: '2026-09-20T00:00:00.000Z',
        }),
      ).toBe(true);
    },
  );
  it('awaits the durable save before inspecting the parent answer and does not swallow write failure', async () => {
    const observed: string[] = [];
    await expect(
      verifyCodexAssistantExecution(
        current.fixture,
        current.task,
        current.result,
        (entry) => observed.push(entry.stage),
        {
          sourceSha,
          onPlatformVerified: async () => {
            throw Error('write_failed');
          },
        },
      ),
    ).rejects.toThrow('write_failed');
    expect(observed).not.toContain('parent_answer');
  });
  it('retains the full strict successful result', async () => {
    const proof = await verify();
    expect(proof.answerDigest).toBe(hash(current.result.answer));
    expect(proof.parseDiagnostics.at(-1)).toMatchObject({
      stage: 'parent_answer',
      accepted: true,
    });
  });
  const mutations: [string, (state: typeof current) => void][] = [
    [
      'parent adoption',
      (s) => {
        s.tree.results[0]!.parentAdoptedSeq = null;
      },
    ],
    [
      'child authority',
      (s) => {
        s.tree.instances[1]!.allowedTools.push('shell.exec');
      },
    ],
    [
      'message delivery',
      (s) => {
        s.tree.messages[0]!.status = 'pending';
      },
    ],
    [
      'second report',
      (s) => {
        s.tree.results.pop();
      },
    ],
    [
      'two copies of report A',
      (s) => {
        const reference = s.tree.results[1]!.evidence[0]!;
        const artifact = s.artifacts.get(reference.id)!;
        const envelope = JSON.parse(artifact.bytes.toString('utf8'));
        envelope.content = JSON.stringify({
          case: 'A',
          totalCents: 875,
          rows: 2,
        });
        artifact.bytes = Buffer.from(JSON.stringify(envelope));
        artifact.object.checksum = reference.digest = hash(artifact.bytes);
      },
    ],
    [
      'artifact bytes',
      (s) => {
        s.artifacts.values().next().value!.bytes = Buffer.from('{}');
      },
    ],
    [
      'artifact source',
      (s) => {
        s.artifacts.values().next().value!.provenance.runId = randomUUID();
      },
    ],
    [
      'ledger usage',
      (s) => {
        s.row.ledger_input++;
      },
    ],
    [
      'admission settlement',
      (s) => {
        s.admissions[0]!.finished = false;
      },
    ],
    [
      'budget total',
      (s) => {
        s.tree.budgets[0]!.spent++;
      },
    ],
    [
      'unsettled usage',
      (s) => {
        s.unsettled.count = 1;
      },
    ],
    [
      'subscription identity',
      (s) => {
        s.row.snapshot_digest = hash('wrong');
      },
    ],
  ];
  it.each(mutations)(
    'never saves passed platform evidence after invalid %s',
    async (_name, mutate) => {
      mutate(current);
      const saved = vi.fn(async (proof: unknown) => {
        void proof;
      });
      await expect(verify(saved)).rejects.toThrow();
      expect(saved).not.toHaveBeenCalled();
    },
  );
});

describe('independent ordinary-only verification, no assistant replay', () => {
  beforeEach(() => {
    current.result.answer = '{"sum":579}';
    current.result.assistantStatus = undefined;
  });
  it('accepts immutable subscription N/A plus complete usage, not a zero price', async () => {
    const proof = await verifyCodexOrdinary(
      current.fixture,
      current.task,
      current.result,
    );
    expect(proof.accounting).toMatchObject({
      billingMode: 'subscription',
      costBasis: 'not_applicable',
      estimatedCostCents: null,
    });
    expect(proof.subscriptionIdentityAndUsageVerified).toBe(true);
    expect(proof.actualSubscriptionCostKnown).toBe(false);
  });
  const mutations: [string, (state: typeof current) => void][] = [
    [
      'assistant result',
      (s) => {
        s.result.assistantStatus = 'completed';
      },
    ],
    [
      'assistant root',
      (s) => {
        s.counts.roots = 1;
      },
    ],
    [
      'second execution',
      (s) => {
        s.counts.jobs = 2;
        s.counts.runs = 2;
      },
    ],
    [
      'wrong answer',
      (s) => {
        s.result.answer = '{"sum":580}';
      },
    ],
    [
      'API auth',
      (s) => {
        Reflect.set(s.ordinaryRow, 'auth_mode', 'api_key');
      },
    ],
    [
      'zero cost disguised as N/A',
      (s) => {
        s.result.estimatedCostCents = 0;
      },
    ],
    [
      'zero ledger cost disguised as N/A',
      (s) => {
        Reflect.set(s.row, 'cost', '0');
        Reflect.set(s.row, 'ledger_cost', '0');
      },
    ],
    [
      'unknown usage',
      (s) => {
        s.result.usageComplete = false;
      },
    ],
    [
      'ledger drift',
      (s) => {
        s.row.ledger_output++;
      },
    ],
    [
      'foreign subscription',
      (s) => {
        s.row.snapshot_digest = hash('wrong');
      },
    ],
    [
      'price invention',
      (s) => {
        s.prices.prices = 1;
      },
    ],
  ];
  it.each(mutations)('rejects %s', async (_name, mutate) => {
    mutate(current);
    await expect(
      verifyCodexOrdinary(current.fixture, current.task, current.result),
    ).rejects.toThrow();
  });
  it('pins existing source files including the complete shared subscription verification path', async () => {
    expect(P27_CODEX_ORDINARY_SOURCE_FILES).toEqual(
      expect.arrayContaining([
        'packages/contracts/src/assistant-subscription.ts',
        'packages/database/src/execution/route-subscription.ts',
        'packages/database/migrations/0097_route_subscription_snapshots.sql',
        'scripts/acceptance/runtime/p27-codex-assistants-verification.ts',
        'scripts/acceptance/runtime/p27-codex-assistants-preflight.ts',
      ]),
    );
    const root = new URL('../../../', import.meta.url);
    for (const file of P27_CODEX_ORDINARY_SOURCE_FILES)
      expect(hash(await readFile(new URL(file, root)))).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
  });
});
