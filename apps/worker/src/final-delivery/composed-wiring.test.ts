/** Composition regression only. Actual job runner and private carrier;
 * execution/storage/DB ports are inert. Real DB branding is tested separately. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { runClaimedJob as RunClaimedJob } from '../job-runner.js';
import {
  bindCheckedFinalDeliveryCommitGuard,
  attachCheckedFinalDelivery,
  requireCheckedFinalDelivery,
  transferCheckedFinalDeliveryForExecution,
} from './checked-delivery.js';
import type { FinalDeliveryProof } from './guard.js';

const ports = vi.hoisted(() => ({
  start: vi.fn(),
  heartbeat: vi.fn(),
  append: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  finish: vi.fn(),
  isolation: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  QuestionObservationWriteError: class extends Error {},
  QueueError: class extends Error {},
  startClaimedJob: ports.start,
  heartbeatJob: ports.heartbeat,
  appendJobEvent: ports.append,
  completeJob: ports.complete,
  failJob: ports.fail,
  finishJobDrain: ports.finish,
}));
vi.mock('../isolation.js', () => ({
  prepareExecutionIsolation: ports.isolation,
}));
vi.mock('../workflow-engine.js', () => ({
  WorkflowPaused: class extends Error {},
}));
import { runClaimedJob } from '../job-runner.js';

const body = '原文与 UTF-8 ☃️\n';
const hash = (text: string) =>
  'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
const proof = (): FinalDeliveryProof => ({
  nativeSessionId: 'synthetic-native',
  publicMessageId: 'synthetic-message',
  durableSeq: 9,
  nativeBindingId: 'PRIVATE_NOT_IN_RESULT',
  nativeCandidateDigest: hash(body),
  candidateDigest: hash(body),
  factSetDigest: hash('synthetic facts'),
  attempt: 1,
  generation: 1,
});
const input = (): Parameters<typeof RunClaimedJob>[0] => ({
  workerId: 'worker',
  jobId: 'job',
  leaseToken: 'lease',
  leaseMs: 30000,
  heartbeatMs: 60000,
  executionRoot: '/synthetic-not-opened',
  stopping: () => false,
  onAbortReady: () => {},
});
const failure = {
  code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
  retryable: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ports.start.mockResolvedValue({
    context: { organizationId: 'org', workspaceId: 'workspace', runId: 'run' },
    job: { id: 'job', ownerId: 'owner', attempt: 1 },
    payload: { type: 'synthetic' },
  });
  ports.isolation.mockResolvedValue({ cleanup: ports.cleanup });
  for (const fn of [
    ports.append,
    ports.complete,
    ports.fail,
    ports.finish,
    ports.cleanup,
  ])
    fn.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('composed checked mode keeps private DB guard and legacy omission', () => {
  it.each(['no-proof', 'proof-without-guard', 'JSON-spread-lost'])(
    'covered mode cannot degrade to legacy: %s',
    async (kind) => {
      await runClaimedJob(input(), async ({ workflowLease }) => {
        requireCheckedFinalDelivery(workflowLease);
        const result = { answer: body };
        if (kind === 'no-proof') return result;
        const p = proof();
        if (kind !== 'proof-without-guard')
          bindCheckedFinalDeliveryCommitGuard(
            p,
            Object.freeze({
              assertCurrent: vi.fn(async () => ({
                assertCommitted: async () => {},
              })),
            }),
          );
        attachCheckedFinalDelivery(result, p);
        const output = { ...result };
        if (kind === 'JSON-spread-lost')
          return JSON.parse(JSON.stringify(output));
        transferCheckedFinalDeliveryForExecution(workflowLease, result, output);
        return output;
      });
      expect(ports.complete).not.toHaveBeenCalled();
      expect(ports.fail).toHaveBeenCalledWith(expect.objectContaining(failure));
      expect(
        ports.append.mock.calls.some(
          ([event]) => event.type === 'step.completed',
        ),
      ).toBe(false);
      expect(ports.cleanup).toHaveBeenCalledOnce();
    },
  );
  it('passes the original private guard as fifth key and preserves exact answer', async () => {
    const guard = Object.freeze({
      assertCurrent: vi.fn(async () => ({ assertCommitted: async () => {} })),
    });
    let expected: object | undefined;
    await runClaimedJob(input(), async ({ workflowLease }) => {
      requireCheckedFinalDelivery(workflowLease);
      const result = { answer: body },
        p = proof();
      bindCheckedFinalDeliveryCommitGuard(p, guard);
      attachCheckedFinalDelivery(result, p);
      const output = { ...result, citations: [] };
      transferCheckedFinalDeliveryForExecution(workflowLease, result, output);
      expected = output;
      return output;
    });
    expect(ports.fail).not.toHaveBeenCalled();
    expect(ports.complete).toHaveBeenCalledOnce();
    const completion = ports.complete.mock.calls[0]![0];
    expect(Reflect.ownKeys(completion)).toEqual([
      'workerId',
      'jobId',
      'leaseToken',
      'result',
      'checkedDelivery',
    ]);
    expect(completion.checkedDelivery).toBe(guard);
    expect(completion.result).toBe(expected);
    expect(completion.result.answer).toBe(body);
    expect(Reflect.ownKeys(completion.result)).toEqual(['answer', 'citations']);
    expect(
      JSON.stringify([completion.result, ports.append.mock.calls]),
    ).not.toContain(proof().nativeBindingId);
    expect(guard.assertCurrent).not.toHaveBeenCalled();
  });
  it('keeps ordinary uncovered mode at the original four keys with no checkedDelivery property', async () => {
    const result = { answer: '既有服务器摘要' };
    await runClaimedJob(input(), async ({ workflowLease }) => {
      const output = { ...result };
      transferCheckedFinalDeliveryForExecution(workflowLease, result, output);
      return output;
    });
    expect(ports.fail).not.toHaveBeenCalled();
    expect(ports.complete).toHaveBeenCalledOnce();
    expect(Reflect.ownKeys(ports.complete.mock.calls[0]![0])).toEqual([
      'workerId',
      'jobId',
      'leaseToken',
      'result',
    ]);
  });
});
