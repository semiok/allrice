import { describe, expect, it, vi } from 'vitest';
import {
  DshRuntimeCloseError,
  type DshRuntimeCloseEvidence,
  type DshRuntimeProcessState,
} from '../../src/harness/dsh-protocol-client.js';
import { closeLegacyFixtureClient } from './legacy-client-close.js';

function legacy() {
  const evidence: DshRuntimeCloseEvidence = {
    process: { state: 'exited', stdioClosed: true, exitCode: 0, signal: null },
    shutdownAcknowledged: true,
    wrapperCleanupConfirmed: false,
    terminationAttempted: null,
  };
  const error = new DshRuntimeCloseError(evidence);
  const client = {
    close: vi.fn<() => Promise<void>>(async () => {
      throw error;
    }),
    processState: () => ({ ...evidence.process }),
    closureEvidence: () => ({ ...evidence, process: { ...evidence.process } }),
  };
  return { client, evidence, error };
}

describe('immutable retained reader test close boundary (no SDK)', () => {
  it('accepts only witnessed physical release while preserving false wrapper confirmation', async () => {
    const f = legacy();
    await expect(
      closeLegacyFixtureClient(f.client, 'retained'),
    ).resolves.toMatchObject({
      process: { state: 'exited', stdioClosed: true, exitCode: 0 },
      shutdownAcknowledged: true,
      wrapperCleanupConfirmed: false,
    });
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.error.evidence.wrapperCleanupConfirmed).toBe(false);
  });
  it.each([
    { shutdownAcknowledged: false },
    { wrapperCleanupConfirmed: true },
    { terminationAttempted: 'SIGTERM' as const },
    {
      process: {
        state: 'running',
        stdioClosed: false,
        exitCode: null,
        signal: null,
      } as DshRuntimeProcessState,
    },
    {
      process: {
        state: 'exited',
        stdioClosed: false,
        exitCode: 0,
        signal: null,
      } as DshRuntimeProcessState,
    },
    {
      process: {
        state: 'exited',
        stdioClosed: true,
        exitCode: 2,
        signal: null,
      } as DshRuntimeProcessState,
    },
    {
      process: {
        state: 'exited',
        stdioClosed: true,
        exitCode: null,
        signal: 'SIGKILL',
      } as DshRuntimeProcessState,
    },
  ])(
    'rejects missing or contradictory physical/semantic evidence %j',
    async (change) => {
      const f = legacy();
      Object.assign(f.evidence, change);
      await expect(closeLegacyFixtureClient(f.client, 'retained')).rejects.toBe(
        f.error,
      );
    },
  );
  it('does not let stale error evidence hide the actual still-live child', async () => {
    const f = legacy();
    f.client.processState = () => ({
      state: 'running',
      stdioClosed: false,
      exitCode: null,
      signal: null,
    });
    await expect(closeLegacyFixtureClient(f.client, 'retained')).rejects.toBe(
      f.error,
    );
  });
  it('refuses a contradictory retained closure observation', async () => {
    const f = legacy();
    f.client.closureEvidence = () => ({
      ...f.evidence,
      process: {
        state: 'unknown',
        stdioClosed: false,
        exitCode: null,
        signal: null,
      },
    });
    await expect(closeLegacyFixtureClient(f.client, 'retained')).rejects.toBe(
      f.error,
    );
  });
  it('does not suppress a close-observation persistence failure', async () => {
    const f = legacy();
    const failure = new AggregateError(
      [f.error, Error('observation failed')],
      'unconfirmed',
    );
    f.client.close.mockRejectedValue(failure);
    await expect(closeLegacyFixtureClient(f.client, 'retained')).rejects.toBe(
      failure,
    );
  });
  it('never applies the retained-fixture exception to a candidate', async () => {
    const f = legacy();
    await expect(closeLegacyFixtureClient(f.client, 'candidate')).rejects.toBe(
      f.error,
    );
  });
  it('rejects unexpected success instead of forging legacy evidence', async () => {
    const f = legacy();
    f.client.close = vi.fn(async () => {});
    await expect(
      closeLegacyFixtureClient(f.client, 'retained'),
    ).rejects.toThrow('unexpectedly supplied');
  });
});
