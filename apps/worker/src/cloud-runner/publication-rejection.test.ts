import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ContractsModule from '@allrice/contracts';
import type * as DatabaseModule from '@allrice/database';
import {
  RuntimeOperationSignalSchema,
  type StoragePort,
} from '@allrice/contracts';
import {
  ProjectWorkspaceError,
  RuntimeLedgerError,
  cloudStableId as cloudStableIdForTest,
} from '@allrice/database';
const ports = vi.hoisted(() => ({
  publish: vi.fn(),
  recoveryLedger: undefined as unknown,
  snapshotParse: vi.fn((x: unknown) => x),
  payloadParse: vi.fn((x: unknown) => x),
}));
vi.mock('@allrice/contracts', async (importOriginal) => ({
  ...(await importOriginal<typeof ContractsModule>()),
  RuntimeOperationSnapshotSchema: { parse: ports.snapshotParse },
  CloudExecutionPayloadSchema: { parse: ports.payloadParse },
}));
vi.mock('@allrice/database', async (importOriginal) => {
  // Keep real error identities through the public package; expose only inert ports.
  const [{ ProjectWorkspaceError, RuntimeLedgerError }, { createHash }] =
    await Promise.all([
      importOriginal<typeof DatabaseModule>(),
      import('node:crypto'),
    ]);
  const canonical = (x: unknown): string => {
    if (
      x === null ||
      ['string', 'boolean'].includes(typeof x) ||
      (typeof x === 'number' && Number.isFinite(x))
    )
      return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
    if (
      x &&
      typeof x === 'object' &&
      Object.getPrototypeOf(x) === Object.prototype
    )
      return (
        '{' +
        Object.keys(x)
          .sort()
          .map(
            (k) =>
              JSON.stringify(k) +
              ':' +
              canonical((x as Record<string, unknown>)[k]),
          )
          .join(',') +
        '}'
      );
    throw Error('non_json_binding');
  };
  const digest = (x: unknown) =>
    'sha256:' + createHash('sha256').update(canonical(x)).digest('hex');
  const forbidden = () => {
    throw Error('Unexpected live DB/execution dependency');
  };
  return {
    ProjectWorkspaceError,
    RuntimeLedgerError,
    publishCloudOperationArtifacts: ports.publish,
    cloudStableId: (key: string) => {
      const h = createHash('sha256').update(key).digest('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    runtimePolicyDigest: digest,
    getDatabase: forbidden,
    createCloudOperationLedger: () => {
      if (!ports.recoveryLedger) forbidden();
      return ports.recoveryLedger;
    },
    loadCloudCommandInputs: forbidden,
    executionResourceObserver: forbidden,
    taskDeadlineOpen: forbidden,
    readProjectService: forbidden,
    projectServiceUserAction: forbidden,
    resolvePlatformRepositoryExecutionProof: forbidden,
  };
});
vi.mock('@allrice/project-runtime', () => ({
  readResolvedProject: () => {
    throw Error('No project recomputation allowed');
  },
}));
vi.mock('./backend.js', () => ({
  CloudRunnerBackend: class {},
  CloudProjectPreparationError: class extends Error {},
}));
import {
  runCloudCommandOperation,
  recoverCloudCommandOperations,
} from './executor.js';

function fixture({
  project = false,
  outputs = 2,
}: { project?: boolean; outputs?: number } = {}) {
  const operationId = randomUUID(),
    attemptId = randomUUID(),
    runId = randomUUID(),
    owner = randomUUID(),
    scope = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: owner,
    };
  const outputSpecs = Array.from({ length: outputs }, (_, n) => ({
    path: `result-${n}.json`,
    fileName: `result-${n}.json`,
    format: 'json',
    parentObjectId: randomUUID(),
  }));
  const payload = {
    ...(project ? { kind: 'project' } : {}),
    network: 'none',
    arguments: {
      outputs: outputSpecs,
      ...(project
        ? { projectSource: { project: { snapshot: { id: randomUUID() } } } }
        : {}),
    },
  };
  const outcome = {
    containerId: 'a'.repeat(64),
    exitCode: 0,
    stopped: true,
    reason: 'completed',
    output: 'Physical stdout must remain unchanged',
    artifacts: outputSpecs.map((o) => ({
      path: o.path,
      contentBase64: Buffer.from(
        JSON.stringify({ path: o.path, unchanged: true }),
      ).toString('base64'),
    })),
    elapsedMs: 1500,
    ...(project ? { imageDigest: 'sha256:' + 'b'.repeat(64) } : {}),
  };
  const journal = {
    lease_token: randomUUID(),
    container_id: outcome.containerId,
    outcome,
    artifacts: [] as unknown[],
    published: 0,
    cleanup_confirmed_at: null as Date | null,
  };
  const attempt = { operationId, attemptId, attempt: 1 },
    binding = {
      task: { scope, runId, rootRunId: runId, chatSessionId: randomUUID() },
      attempt,
      requestedBy: { type: 'user', id: owner },
      execution: { targetKind: 'cloud_sandbox' },
    };
  type Ledger = ReturnType<typeof DatabaseModule.createCloudOperationLedger>;
  type PublicationRejection = {
    version: 1;
    code: 'project_output_parent_stale';
    physicalOutcomeDigest: string;
    payloadDigest: string;
    storageWrites: 0;
    publishedArtifacts: 0;
    absentStorageObjectsDigest: string;
  };
  type OutcomeReceipt = {
    receiptId: string;
    attempt: typeof attempt;
    signal: Extract<
      ContractsModule.RuntimeOperationSignal,
      { type: 'operation.outcome' }
    >;
    evidence: Pick<
      typeof outcome,
      'exitCode' | 'stopped' | 'reason' | 'output' | 'imageDigest'
    > & {
      backend: 'cloud-gvisor-v1';
      workCopy: 'cloud_copy';
      errorCode?: string;
      publicationRejection?: PublicationRejection;
      artifacts: {
        objectId: string;
        versionId: string;
        fileName: string;
        checksum: string;
      }[];
    };
  };
  type StoredReceipt = {
    receipt_id: string;
    payload: Omit<OutcomeReceipt, 'receiptId'>;
    disposition: string;
    received_at: Date;
  };
  const receipts: StoredReceipt[] = [],
    meter = {
      accounting_id: randomUUID(),
      source: { type: 'fixture', id: 'measured-tool-port' },
      observation: null as ContractsModule.RuntimeUsageObservation | null,
      created_at: new Date('2026-10-19T00:00:00Z'),
    };
  const state = {
    status: 'running',
    recordError: null as Error | null,
    recordErrorAfterCommit: false,
    recordDisposition: 'applied',
    settleError: null as Error | null,
    settleErrorAfterCommit: false,
    cleanupError: null as Error | null,
    confirmError: null as Error | null,
    proofError: null as Error | null,
  };
  const ledger = {
    readReceipts: vi.fn(async () => structuredClone(receipts)),
    recordReceipt: vi.fn(async (input: OutcomeReceipt) => {
      RuntimeOperationSignalSchema.parse(input.signal);
      if (state.recordError && !state.recordErrorAfterCommit)
        throw state.recordError;
      receipts.push({
        receipt_id: input.receiptId,
        payload: {
          attempt: structuredClone(input.attempt),
          signal: structuredClone(input.signal),
          evidence: structuredClone(input.evidence),
        },
        disposition: state.recordDisposition,
        received_at: new Date(),
      });
      if (state.recordDisposition === 'applied')
        state.status = input.signal.result.status;
      if (state.recordError) throw state.recordError;
      return {
        disposition: state.recordDisposition,
        snapshot: { status: state.status },
      };
    }),
    settleUsage: vi.fn(async (input: Parameters<Ledger['settleUsage']>[0]) => {
      if (state.settleError && !state.settleErrorAfterCommit)
        throw state.settleError;
      meter.observation = structuredClone(input.observation);
      if (state.settleError) throw state.settleError;
      return { duplicate: false };
    }),
    readOperation: vi.fn(async () => ({ status: state.status })),
    startOperation: vi.fn(async () => {
      throw Error('Stored physical outcome must never restart');
    }),
  };
  const queries: string[] = [];
  const database = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join('?').replace(/\s+/g, ' ');
      queries.push(query);
      if (query.startsWith('select a.operation_id,a.lease_token,o.snapshot'))
        return journal.cleanup_confirmed_at
          ? []
          : [
              {
                operation_id: operationId,
                lease_token: journal.lease_token,
                snapshot: { binding, status: state.status },
                payload: structuredClone(payload),
                outcome: structuredClone(journal.outcome),
              },
            ];
      if (
        query.startsWith(
          'update allrice_cloud_execution_attempts set outcome=coalesce',
        )
      )
        return [];
      if (
        query.startsWith(
          'select lease_token,container_id,outcome,cleanup_confirmed_at',
        )
      )
        return [{ ...journal, outcome: structuredClone(journal.outcome) }];
      if (query.includes('as published')) {
        if (state.proofError) throw state.proofError;
        return [
          {
            outcome: structuredClone(journal.outcome),
            artifacts: structuredClone(journal.artifacts),
            published: journal.published,
          },
        ];
      }
      if (query.startsWith('select r.accounting_id'))
        return [structuredClone(meter)];
      if (
        query.startsWith(
          'update allrice_cloud_execution_attempts set cleanup_confirmed_at',
        )
      ) {
        journal.cleanup_confirmed_at = new Date();
        if (state.confirmError) throw state.confirmError;
        return [];
      }
      throw Error(
        'Unexpected SQL in isolated executor test: ' + query.slice(0, 100),
      );
    }),
    {
      json: (x: unknown) => x,
      reserve: vi.fn(async () =>
        Object.assign(
          vi.fn(async (strings: TemplateStringsArray) =>
            strings.join('?').includes('pg_try_advisory_lock')
              ? [{ locked: true }]
              : [],
          ),
          { release: vi.fn() },
        ),
      ),
    },
  );
  const unexpected = vi.fn(async () => {
    throw Error(
      'No script, inspect, stop or collect is allowed on saved outcome replay',
    );
  });
  const backend = {
    execute: vi.fn(async () => unexpected()),
    inspect: vi.fn(async () => unexpected()),
    stop: vi.fn(async () => unexpected()),
    collect: vi.fn(async () => unexpected()),
    cleanup: vi.fn(async () => {
      if (state.cleanupError) throw state.cleanupError;
    }),
  };
  const storage: StoragePort = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => {
      throw Error('No artifact read needed');
    }),
    exists: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
  };
  const created = {
    context: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      policySnapshot: { subjectId: owner },
      worker: { id: randomUUID() },
    },
    snapshot: { binding },
    ledger,
    payload,
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
  };
  const run = () =>
    runCloudCommandOperation(
      created as unknown as Parameters<typeof runCloudCommandOperation>[0],
      {
        database: database as unknown as NonNullable<
          Parameters<typeof runCloudCommandOperation>[1]['database']
        >,
        backend: backend as unknown as NonNullable<
          Parameters<typeof runCloudCommandOperation>[1]['backend']
        >,
        storage,
      },
    );
  const recover = () => {
    ports.recoveryLedger = ledger;
    backend.inspect.mockImplementation(
      async () => ({ State: { Running: false } }) as never,
    );
    return recoverCloudCommandOperations({
      database: database as never,
      backend: backend as never,
    });
  };
  const reject = () =>
    ports.publish.mockRejectedValue(
      new ProjectWorkspaceError('output_parent_stale'),
    );
  const unchanged = structuredClone(outcome);
  return {
    run,
    recover,
    reject,
    journal,
    outcome,
    unchanged,
    payload,
    binding,
    receipts,
    meter,
    state,
    ledger,
    backend,
    storage,
    queries,
    unexpected,
  };
}

beforeEach(() => {
  ports.publish.mockReset();
  ports.recoveryLedger = undefined;
  ports.snapshotParse.mockClear();
  ports.payloadParse.mockClear();
});
describe('confirmed pre-storage stale-parent publication rejection — dependency ports only', () => {
  it.each([false, true])(
    'closes %s project physical success as publication failure and preserves original bytes',
    async (project) => {
      const f = fixture({ project });
      f.reject();
      const result = await f.run();
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'failed',
        exitCode: 0,
        stopped: true,
        cleanupConfirmed: true,
        errorCode: 'project_output_parent_stale',
        artifacts: [],
      });
      expect(f.journal.outcome).toEqual(f.unchanged);
      expect(f.journal.cleanup_confirmed_at).toBeInstanceOf(Date);
      expect(f.unexpected).not.toHaveBeenCalled();
      expect(f.receipts).toHaveLength(1);
      const { signal, evidence } = f.receipts[0]!.payload;
      expect(signal.result).toMatchObject({
        status: 'failed',
        effects: 'none',
      });
      expect(evidence.reason).toBe('completed');
      expect(evidence.output).toBe(f.unchanged.output);
      expect(evidence.publicationRejection).toMatchObject({
        code: 'project_output_parent_stale',
        storageWrites: 0,
        publishedArtifacts: 0,
      });
      expect(evidence.errorCode).toBe('project_output_parent_stale');
      expect(evidence.publicationRejection!.absentStorageObjectsDigest).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
      expect(f.storage.exists).toHaveBeenCalledTimes(2);
      for (const [object] of (f.storage.exists as ReturnType<typeof vi.fn>).mock
        .calls) {
        expect(object).toMatchObject({
          organizationId: f.binding.task.scope.organizationId,
          workspaceId: f.binding.task.scope.workspaceId,
          ownerId: f.binding.requestedBy.id,
          immutable: true,
          mediaType: 'application/json',
        });
        expect(object.key).toBe(
          `organizations/${object.organizationId}/workspaces/${object.workspaceId}/owners/${object.ownerId}/exports/${object.id}`,
        );
      }
      expect(f.ledger.settleUsage).toHaveBeenCalledTimes(1);
      expect(f.meter.observation).toMatchObject({
        metric: 'tool_calls',
        amount: 1,
        state: 'settled',
        quality: 'measured',
      });
      expect(f.backend.cleanup).toHaveBeenCalledTimes(1);
      if (project)
        expect(evidence).toMatchObject({
          imageDigest: f.outcome.imageDigest,
          stopped: true,
          exitCode: 0,
        });
    },
  );
  it('re-enters after cleanup without publishing, computing, recording or settling twice', async () => {
    const f = fixture();
    f.reject();
    await f.run();
    const receipt = structuredClone(f.receipts[0]);
    ports.publish.mockImplementation(() => {
      throw Error('Failed publication cannot be retried after sealed receipt');
    });
    const result = await f.run();
    expect(result.status).toBe('failed');
    expect(f.receipts[0]).toEqual(receipt);
    expect(f.ledger.recordReceipt).toHaveBeenCalledTimes(1);
    expect(f.ledger.settleUsage).toHaveBeenCalledTimes(1);
    expect(f.backend.cleanup).toHaveBeenCalledTimes(1);
    expect(f.unexpected).not.toHaveBeenCalled();
  });
  it.each([
    'record-before',
    'record-after',
    'settle-before',
    'settle-after',
    'cleanup',
    'cleanup-confirmation',
  ] as const)(
    'recovers after %s without replaying physical work',
    async (stage) => {
      const f = fixture();
      f.reject();
      const error = Error('Unknown injected ' + stage);
      if (stage.startsWith('record')) {
        f.state.recordError = error;
        f.state.recordErrorAfterCommit = stage.endsWith('after');
      }
      if (stage.startsWith('settle')) {
        f.state.settleError = error;
        f.state.settleErrorAfterCommit = stage.endsWith('after');
      }
      if (stage === 'cleanup') f.state.cleanupError = error;
      if (stage === 'cleanup-confirmation') f.state.confirmError = error;
      await expect(f.run()).rejects.toBe(error);
      expect(f.journal.outcome).toEqual(f.unchanged);
      if (stage.startsWith('record') || stage.startsWith('settle'))
        expect(f.backend.cleanup).not.toHaveBeenCalled();
      f.state.recordError = null;
      f.state.settleError = null;
      f.state.cleanupError = null;
      f.state.confirmError = null;
      const result = await f.run();
      expect(result.status).toBe('failed');
      expect(result).toHaveProperty('cleanupConfirmed', true);
      expect(f.unexpected).not.toHaveBeenCalled();
      expect(f.receipts).toHaveLength(1);
      expect(ports.publish).toHaveBeenCalledTimes(
        stage === 'record-before' ? 2 : 1,
      );
      expect(f.journal.outcome).toEqual(f.unchanged);
    },
  );
  it.each(['plain-stale', 'unavailable', 'sql', 'storage'] as const)(
    'does not reinterpret unknown or non-stale %s errors',
    async (kind) => {
      const f = fixture(),
        error =
          kind === 'unavailable'
            ? new ProjectWorkspaceError('output_parent_unavailable')
            : Object.assign(
                Error(
                  kind === 'plain-stale' ? 'project_output_parent_stale' : kind,
                ),
                { code: kind === 'sql' ? '40001' : undefined },
              );
      ports.publish.mockRejectedValue(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.receipts).toHaveLength(0);
      expect(f.ledger.settleUsage).not.toHaveBeenCalled();
      expect(f.backend.cleanup).not.toHaveBeenCalled();
      expect(f.journal.outcome).toEqual(f.unchanged);
    },
  );
  it('preserves evidence after a prior output storage write instead of claiming effects none', async () => {
    const f = fixture(),
      error = new ProjectWorkspaceError('output_parent_stale');
    ports.publish.mockImplementation(async (_input, storage: StoragePort) => {
      await storage.put(
        {} as never,
        new Blob(['durable private prefix']).stream(),
      );
      throw error;
    });
    await expect(f.run()).rejects.toBe(error);
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.receipts).toHaveLength(0);
    expect(f.ledger.settleUsage).not.toHaveBeenCalled();
    expect(f.backend.cleanup).not.toHaveBeenCalled();
    expect(f.journal.outcome.artifacts).toHaveLength(2);
  });
  it.each([0, 1])(
    'keeps earlier orphan bytes at output %s unknown despite zero current writes and empty projections',
    async (index) => {
      const f = fixture();
      f.reject();
      (f.storage.exists as ReturnType<typeof vi.fn>).mockImplementation(
        async (object) =>
          object.id ===
          cloudStableIdForTest(
            `${f.binding.attempt.operationId}:artifact:${f.payload.arguments.outputs[index]!.path}`,
          ),
      );
      await expect(f.run()).rejects.toThrow(
        'cloud_publication_rejection_unconfirmed',
      );
      expect(f.storage.put).not.toHaveBeenCalled();
      expect(f.storage.delete).not.toHaveBeenCalled();
      expect(f.receipts).toHaveLength(0);
      expect(f.ledger.settleUsage).not.toHaveBeenCalled();
      expect(f.backend.cleanup).not.toHaveBeenCalled();
      expect(f.journal.outcome).toEqual(f.unchanged);
    },
  );
  it('keeps a lost storage-absence read unknown and never cleans recovery data', async () => {
    const f = fixture(),
      error = Error('storage existence read unavailable');
    f.reject();
    (f.storage.exists as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.receipts).toHaveLength(0);
    expect(f.ledger.settleUsage).not.toHaveBeenCalled();
    expect(f.backend.cleanup).not.toHaveBeenCalled();
  });
  it.each(['journal-artifacts', 'projection'] as const)(
    'retains recovery data if %s proves any publication',
    async (which) => {
      const f = fixture();
      f.reject();
      if (which === 'projection') f.journal.published = 1;
      else f.journal.artifacts = [{ versionId: randomUUID() }];
      await expect(f.run()).rejects.toThrow(
        'cloud_publication_rejection_unconfirmed',
      );
      expect(f.receipts).toHaveLength(0);
      expect(f.backend.cleanup).not.toHaveBeenCalled();
      expect(f.ledger.settleUsage).not.toHaveBeenCalled();
    },
  );
  it('does not turn a failed proof read into failure closure', async () => {
    const f = fixture(),
      error = Error('Database result unknown');
    f.reject();
    f.state.proofError = error;
    await expect(f.run()).rejects.toBe(error);
    expect(f.receipts).toHaveLength(0);
    expect(f.backend.cleanup).not.toHaveBeenCalled();
    expect(f.ledger.settleUsage).not.toHaveBeenCalled();
  });
  it.each([
    'network',
    'parentless',
    'not-stopped',
    'nonzero-exit',
    'service',
  ] as const)(
    'keeps %s outside the provable no-effects boundary',
    async (which) => {
      const f = fixture({ project: which === 'service' }),
        error = new ProjectWorkspaceError('output_parent_stale');
      ports.publish.mockRejectedValue(error);
      if (which === 'network') f.payload.network = 'public';
      if (which === 'parentless')
        for (const output of f.payload.arguments.outputs)
          delete (output as { parentObjectId?: string }).parentObjectId;
      if (which === 'not-stopped') f.journal.outcome.stopped = false;
      if (which === 'nonzero-exit') f.journal.outcome.exitCode = 1;
      if (which === 'service')
        Object.assign(f.payload.arguments, {
          background: { projectService: {} },
        });
      await expect(f.run()).rejects.toBe(error);
      expect(f.receipts).toHaveLength(0);
      expect(f.backend.cleanup).not.toHaveBeenCalled();
    },
  );
  it.each(['stale', 'conflict'] as const)(
    'does not cleanup after a %s receipt disposition',
    async (disposition) => {
      const f = fixture();
      f.reject();
      f.state.recordDisposition = disposition;
      await expect(f.run()).rejects.toThrow(
        'cloud_publication_rejection_unconfirmed',
      );
      expect(f.backend.cleanup).not.toHaveBeenCalled();
      expect(f.ledger.settleUsage).not.toHaveBeenCalled();
    },
  );
  it('accepts only a verified matching concurrent applied receipt after receipt_conflict', async () => {
    const f = fixture();
    f.reject();
    f.state.recordError = new RuntimeLedgerError('receipt_conflict');
    f.state.recordErrorAfterCommit = true;
    expect((await f.run()).status).toBe('failed');
    expect(f.receipts).toHaveLength(1);
    expect(f.backend.cleanup).toHaveBeenCalledTimes(1);
    expect(f.ledger.settleUsage).toHaveBeenCalledTimes(1);
  });
  it.each(['digest', 'disposition', 'physical-outcome'] as const)(
    'refuses tampered cached rejection %s instead of republishing',
    async (which) => {
      const f = fixture();
      f.reject();
      f.state.cleanupError = Error('leave cleanup pending');
      await expect(f.run()).rejects.toThrow('leave cleanup pending');
      f.state.cleanupError = null;
      f.backend.cleanup.mockClear();
      ports.publish.mockClear();
      if (which === 'digest')
        f.receipts[0]!.payload.evidence.publicationRejection!.payloadDigest =
          'sha256:' + '0'.repeat(64);
      if (which === 'disposition') f.receipts[0]!.disposition = 'conflict';
      if (which === 'physical-outcome')
        f.journal.outcome.output = 'changed physical evidence';
      await expect(f.run()).rejects.toThrow(
        'cloud_publication_rejection_unconfirmed',
      );
      expect(ports.publish).not.toHaveBeenCalled();
      expect(f.backend.cleanup).not.toHaveBeenCalled();
    },
  );
  it('leaves ordinary successful parentless publication behavior intact', async () => {
    const f = fixture();
    for (const o of f.payload.arguments.outputs)
      delete (o as { parentObjectId?: string }).parentObjectId;
    ports.publish.mockResolvedValue([
      {
        object: { id: randomUUID(), checksum: 'sha256:' + 'c'.repeat(64) },
        versionId: randomUUID(),
        fileName: 'out.json',
      },
    ]);
    const result = await f.run();
    expect(result.status).toBe('succeeded');
    expect(result).toHaveProperty('reason', 'completed');
    expect(f.receipts[0]!.payload.signal.result.effects).toBe('applied');
    expect(
      f.receipts[0]!.payload.evidence.publicationRejection,
    ).toBeUndefined();
  });
});

describe('cold recovery of sealed publication rejection', () => {
  it.each([false, true])(
    'settles a terminal %s project rejection before physical cleanup',
    async (project) => {
      const f = fixture({ project });
      f.reject();
      f.state.settleError = Error('crash before usage');
      await expect(f.run()).rejects.toThrow('crash before usage');
      expect(f.state.status).toBe('failed');
      expect(f.meter.observation).toBeNull();
      expect(f.backend.cleanup).not.toHaveBeenCalled();
      f.state.settleError = null;
      expect(await f.recover()).toEqual({ recovered: 1, failed: 0 });
      expect(f.meter.observation).toMatchObject({
        metric: 'tool_calls',
        amount: 1,
        state: 'settled',
      });
      expect(f.journal.cleanup_confirmed_at).toBeInstanceOf(Date);
      expect(f.backend.execute).not.toHaveBeenCalled();
      expect(f.backend.collect).not.toHaveBeenCalled();
      expect(ports.publish).toHaveBeenCalledTimes(1);
      expect(f.journal.outcome).toEqual(f.unchanged);
      expect(await f.recover()).toEqual({ recovered: 0, failed: 0 });
      expect(f.backend.cleanup).toHaveBeenCalledTimes(1);
      expect(f.receipts).toHaveLength(1);
    },
  );
  it('does not settle twice after a lost authoritative usage acknowledgement', async () => {
    const f = fixture();
    f.reject();
    f.state.settleError = Error('usage ACK unknown');
    f.state.settleErrorAfterCommit = true;
    await expect(f.run()).rejects.toThrow('usage ACK unknown');
    f.state.settleError = null;
    expect(await f.recover()).toEqual({ recovered: 1, failed: 0 });
    expect(f.ledger.settleUsage).toHaveBeenCalledTimes(1);
    expect(f.backend.cleanup).toHaveBeenCalledTimes(1);
  });
  it('keeps recovery selectable after unknown settlement, then closes without replay', async () => {
    const f = fixture();
    f.reject();
    f.state.settleError = Error('usage unavailable');
    await expect(f.run()).rejects.toThrow('usage unavailable');
    expect(await f.recover()).toEqual({ recovered: 0, failed: 1 });
    expect(f.backend.cleanup).not.toHaveBeenCalled();
    expect(f.journal.cleanup_confirmed_at).toBeNull();
    f.state.settleError = null;
    expect(await f.recover()).toEqual({ recovered: 1, failed: 0 });
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.receipts).toHaveLength(1);
  });
  it('does not cleanup or invent usage from a tampered rejection receipt', async () => {
    const f = fixture();
    f.reject();
    f.state.settleError = Error('before usage');
    await expect(f.run()).rejects.toThrow('before usage');
    f.state.settleError = null;
    f.receipts[0]!.payload.evidence.publicationRejection!.physicalOutcomeDigest =
      'sha256:' + '0'.repeat(64);
    expect(await f.recover()).toEqual({ recovered: 0, failed: 1 });
    expect(f.backend.cleanup).not.toHaveBeenCalled();
    expect(f.meter.observation).toBeNull();
  });
  it('keeps legacy terminal-failure recovery behavior outside the tagged seam', async () => {
    const f = fixture();
    f.state.status = 'failed';
    f.journal.outcome.reason = 'failed';
    expect(await f.recover()).toEqual({ recovered: 1, failed: 0 });
    expect(f.ledger.settleUsage).not.toHaveBeenCalled();
    expect(f.backend.execute).not.toHaveBeenCalled();
  });
});
