/** Synthetic coordinator races; physical browser/preview proof belongs to Dev. */
import { afterEach, expect, it, vi } from 'vitest';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import type * as Database from '@allrice/database';
import { executePlatformQualityCheck } from './platform-quality.js';

const test = vi.hoisted(() => ({
  probe: new AbortController(),
  window: '',
  reason: '',
  calls: [] as string[],
  reports: [] as { verdict: string }[],
  id: '00000000-0000-4000-8000-000000000001',
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getDatabase: () => async () => [],
  getPlatformQualityExecution: async () => ({
    id: test.id,
    runId: test.id,
    sessionId: test.id,
    ownerId: test.id,
    organizationId: test.id,
    workspaceId: test.id,
    frozen: {
      caseId: 'project.live.v1',
      releaseSha: 'test-release',
      fingerprint: 'test',
    },
  }),
  acquireConversationRuntime: async () => undefined,
  releaseConversationRuntime: async () => undefined,
  recordPlatformQualityReport: async (
    _lease: unknown,
    report: { verdict: string },
  ) => {
    test.reports.push(report);
  },
  appendJobEvent: async (event: {
    type: string;
    payload: { toolCallId: string };
  }) => {
    if (
      event.type === 'tool.started' &&
      event.payload.toolCallId.endsWith(':' + test.window)
    ) {
      // Let the async write finish after cancellation, exercising the admission
      // window before Broker entry rather than canceling at step construction.
      await Promise.resolve();
      test.probe.abort(Error(test.reason));
    }
  },
}));
vi.mock('../tool-broker.js', () => ({
  executeRiceTool: async (input: {
    call: { arguments: { action?: string; command?: string } };
    qualityLiveProbe?: { syncOnce: (signal: AbortSignal) => Promise<unknown> };
  }) => {
    const action = input.call.arguments.action ?? input.call.arguments.command!;
    test.calls.push(action);
    if (action === 'verify_live')
      await input.qualityLiveProbe!.syncOnce(test.probe.signal);
    if (action === 'apply' && test.window === 'after-apply')
      test.probe.abort(Error(test.reason));
    return {
      modelContent: JSON.stringify({
        project: {
          projectId: test.id,
          snapshot: {
            kind: 'artifact',
            id: test.id,
            checksum: 'sha256:' + 'a'.repeat(64),
          },
        },
        sourceDigest: 'sha256:' + 'a'.repeat(64),
        service: { id: test.id },
      }),
      summary: 'Synthetic coordinator race',
    };
  },
}));
afterEach(() => vi.unstubAllEnvs());
it.each([
  ['apply', 'BROWSER_TASK_CANCELED'],
  ['after-apply', 'BROWSER_TASK_CANCELED'],
  ['service-sync', 'BROWSER_TASK_CANCELED'],
  ['apply', 'QUALITY_PROBE_TIMEOUT'],
  ['after-apply', 'QUALITY_PROBE_TIMEOUT'],
  ['service-sync', 'QUALITY_PROBE_TIMEOUT'],
])(
  'does not begin a new mutation after %s loses the browser phase (%s)',
  async (window, reason) => {
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'test-release');
    test.probe = new AbortController();
    test.window = window;
    test.reason = reason;
    test.calls = [];
    test.reports = [];
    const handler = {
      signal: new AbortController().signal,
      workflowLease: { workerId: test.id, jobId: test.id, leaseToken: test.id },
      execution: { job: { attempt: 1 }, context: { worker: { id: test.id } } },
    } as unknown as ClaimedJobHandlerInput;
    const resolved = {
      grantedCapabilities: [],
      nativeSkills: [],
      promptSnapshot: { userRequest: '' },
    } as unknown as Awaited<
      ReturnType<typeof Database.resolveEmployeeExecution>
    >;
    await expect(
      executePlatformQualityCheck(handler, resolved),
    ).rejects.toThrow();
    expect(test.calls).not.toContain('service_sync');
    if (window === 'apply') expect(test.calls).not.toContain('apply');
    else expect(test.calls).toContain('apply');
    expect(test.reports).toHaveLength(1);
    expect(test.reports[0]!.verdict).toBe('execution_failed');
  },
);
