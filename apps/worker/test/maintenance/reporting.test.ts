import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DevProducerLifecycle } from '../../../../packages/database/src/dev-producer-lifecycle.ts';
import type { ServiceBuildIdentity } from '../../../../packages/database/src/service-build-identity.ts';
const db = vi.hoisted(() => ({
  collectMaintenanceSourceReports: vi.fn(),
  claimMaintenanceSourceReport: vi.fn(),
  settleMaintenanceSourceReport: vi.fn(),
}));
vi.mock('@allrice/database', () => db);
import { runMaintenanceReportingProducer } from '../../src/maintenance-reporting.ts';
const deploymentId = randomUUID();
const state = {
  deploymentId,
  credentialRevision: 1,
  policyRevision: 1,
  paused: false,
  checkIntervalMinutes: 15,
  mode: 'report_only',
  automaticMerge: false,
  automaticDeployment: false,
};
const payload = {
  version: 1,
  sourceReportId: randomUUID(),
  sourceKind: 'deployment_health',
  sampledAt: new Date().toISOString(),
  observedReleaseSha: 'a'.repeat(40),
  producerVersion: 'allrice-maintenance.v1',
  facts: { findings: [], quality: null, probe: null },
};
const pending = {
  id: randomUUID(),
  attempt: 1,
  deploymentId,
  payload,
  payloadDigest: 'sha256:' + 'b'.repeat(64),
};
const identity: ServiceBuildIdentity = {
  version: 1,
  environment: 'dev',
  service: 'worker',
  mode: 'production',
  sourceSha: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  manifestDigest: 'sha256:' + 'c'.repeat(64),
  artifactDigest: 'sha256:' + 'd'.repeat(64),
  runtimeGraphDigest: 'sha256:' + 'e'.repeat(64),
  webBuildId: 'fixture',
  bootId: randomUUID(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  nodeVersion: process.version,
  protocols: { identity: 1, ordinaryConsumer: 1, releaseAdmission: 'disabled' },
};
describe('report-only producer transport and lifetime boundaries', () => {
  let directory: string, connectionFile: string;
  let now = Date.now();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maintenance-transport-'));
    connectionFile = join(directory, 'connection.json');
  });
  afterAll(async () => {
    await rm(directory, { recursive: true });
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    now += 60001;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(
      connectionFile,
      JSON.stringify({
        version: 1,
        centralUrl: 'https://central.example.test',
        deploymentId,
        installationKey: 'k'.repeat(43),
      }),
      { mode: 0o600 },
    );
    db.claimMaintenanceSourceReport.mockResolvedValue(null);
  });
  function lifecycle() {
    const finishes: string[] = [];
    const controller = new DevProducerLifecycle(true, 'worker', identity, {
      start: async (input) => ({
        id: input.id!,
        instanceBootId: input.instanceBootId,
        epoch: 0,
      }),
      finish: async (input) => {
        finishes.push(input.id);
      },
    });
    return { controller, finishes };
  }
  function run(transport: typeof fetch, signal?: AbortSignal) {
    return runMaintenanceReportingProducer({
      connectionFile,
      releaseSha: 'a'.repeat(40),
      transport,
      signal,
    });
  }
  it.each(['timeout', 'unauthorized', 'abort', 'bad-config'])(
    'finishes the real lifecycle permit for known %s failure',
    async (kind) => {
      const f = lifecycle();
      if (kind === 'bad-config') await writeFile(connectionFile, '{}');
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (kind === 'unauthorized') return new Response('{}', { status: 401 });
        throw new DOMException(
          kind,
          kind === 'abort' ? 'AbortError' : 'TimeoutError',
        );
      });
      await f.controller.run('automation', () => run(transport));
      expect(f.finishes).toHaveLength(1);
      expect(f.controller.snapshot()?.activeRoots).toBe(0);
      expect(db.collectMaintenanceSourceReports).not.toHaveBeenCalled();
    },
  );
  it('reuses the outbox partition across credential rotation', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(state));
    await run(transport);
    const first = db.collectMaintenanceSourceReports.mock.calls[0]![0];
    now += 60001;
    await writeFile(
      connectionFile,
      JSON.stringify({
        version: 1,
        centralUrl: 'https://central.example.test',
        deploymentId,
        installationKey: 'n'.repeat(43),
      }),
    );
    await run(transport);
    expect(
      db.collectMaintenanceSourceReports.mock.calls[1]![0].connectionDigest,
    ).toBe(first.connectionDigest);
    expect(
      new Headers(transport.mock.calls[1]![1]!.headers).get('authorization'),
    ).toBe('Bearer ' + 'n'.repeat(43));
  });
  it('retains the immutable outbox after an unknown POST and finishes only its transport permit', async () => {
    const f = lifecycle();
    db.claimMaintenanceSourceReport.mockResolvedValueOnce(pending);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(state))
      .mockRejectedValueOnce(Error('receipt lost'));
    await f.controller.run('automation', () => run(transport));
    expect(JSON.parse(String(transport.mock.calls[1]![1]!.body))).toEqual(
      payload,
    );
    expect(db.settleMaintenanceSourceReport).toHaveBeenCalledWith({
      id: pending.id,
      attempt: 1,
      failed: true,
    });
    expect(f.finishes).toHaveLength(1);
  });
  it('keeps a truly unknown database acknowledgement unresolved without replaying or downgrading it', async () => {
    const f = lifecycle();
    db.claimMaintenanceSourceReport.mockResolvedValueOnce(pending);
    const receipt = {
      reportId: randomUUID(),
      deploymentId,
      sourceReportId: payload.sourceReportId,
      payloadDigest: pending.payloadDigest,
      receivedAt: new Date().toISOString(),
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json(receipt));
    db.settleMaintenanceSourceReport.mockRejectedValueOnce(
      Error('database commit response lost'),
    );
    await expect(
      f.controller.run('automation', () => run(transport)),
    ).rejects.toThrow('database commit response lost');
    expect(f.finishes).toEqual([]);
    expect(db.settleMaintenanceSourceReport).toHaveBeenCalledTimes(1);
  });
});
