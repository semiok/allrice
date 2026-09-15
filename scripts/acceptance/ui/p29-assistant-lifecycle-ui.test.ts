/** No provider/model/Chrome: scope and error hygiene before resource startup. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  assertLifecycleUiScope,
  lifecycleFixtureCleanupAllowed,
  verifyAssistantLifecycleInChrome,
  type LifecycleUiInput,
} from './p29-assistant-lifecycle-ui.ts';

function input(): LifecycleUiInput {
  const task = () => ({
    org: randomUUID(),
    workspace: randomUUID(),
    user: randomUUID(),
    session: randomUUID(),
    rootRunId: randomUUID(),
  });
  return {
    db: vi
      .fn()
      .mockRejectedValue(
        Error('PRIVATE_DB_DETAILS'),
      ) as unknown as LifecycleUiInput['db'],
    databaseUrl: `postgres://a123@127.0.0.1:5432/allrice_b2?options=${encodeURIComponent(`-csearch_path=p25_${'a'.repeat(32)},public`)}`,
    storageRoot: '/not-used',
    evidenceDirectory: '/not-used',
    partial: task(),
    cancellation: task(),
    partialOtherSessionId: randomUUID(),
    otherSessionId: randomUUID(),
    drainCancellation: vi.fn(),
    createSameSessionPeer: vi.fn(),
  };
}
describe('MET140 UI scope guards', () => {
  it('accepts only the identity projection from an extended runtime fixture', () => {
    const options = input();
    Object.assign(options.partial, {
      runtime: {},
      credentialReference: 'synthetic-never-resolved',
    });
    expect(assertLifecycleUiScope(options)).toBe(`p25_${'a'.repeat(32)}`);
    expect(options.db).not.toHaveBeenCalled();
  });
  it('retains the fixture when UI cleanup is missing or any owner remains unconfirmed', () => {
    expect(lifecycleFixtureCleanupAllowed(false)).toBe(true);
    expect(lifecycleFixtureCleanupAllowed(true)).toBe(false);
    const cleanup = {
      chromeClosed: true,
      nextStopped: true,
      authRemoved: true,
    };
    expect(lifecycleFixtureCleanupAllowed(true, cleanup)).toBe(true);
    for (const key of Object.keys(cleanup))
      expect(
        lifecycleFixtureCleanupAllowed(true, { ...cleanup, [key]: false }),
      ).toBe(false);
  });
  it.each([
    'postgres://a123@192.0.2.1:5432/allrice_b2',
    'postgres://a123@127.0.0.1:5432/production',
    'postgres://a123:must-not-leak@127.0.0.1:5432/allrice_b2',
    `postgres://a123@127.0.0.1:5432/allrice_b2?options=${encodeURIComponent('-csearch_path=public')}`,
  ])('rejects non-fixture database before I/O (%#)', async (databaseUrl) => {
    const options = { ...input(), databaseUrl };
    const report = await verifyAssistantLifecycleInChrome(options);
    expect(report.passed).toBe(false);
    expect(report.failure).toEqual({
      code: 'MET140_UI_FAILED',
      phase: 'scope',
    });
    expect(options.db).not.toHaveBeenCalled();
    expect(options.drainCancellation).not.toHaveBeenCalled();
    expect(Object.values(report.cleanup).every(Boolean)).toBe(true);
    expect(report.screenshots).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('must-not-leak');
  });
  it('rejects repeated roots and other-session alias before I/O', () => {
    const options = input();
    options.cancellation.rootRunId = options.partial.rootRunId;
    expect(() => assertLifecycleUiScope(options)).toThrow();
    options.cancellation.rootRunId = randomUUID();
    options.otherSessionId = options.cancellation.session;
    expect(() => assertLifecycleUiScope(options)).toThrow();
    expect(options.db).not.toHaveBeenCalled();
  });
  it('does not expose private diagnostics or run native drain on DB failure', async () => {
    const options = input();
    const report = await verifyAssistantLifecycleInChrome(options);
    expect(report.failure).toEqual({
      code: 'MET140_UI_FAILED',
      phase: 'scope',
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_DB_DETAILS');
    expect(options.drainCancellation).not.toHaveBeenCalled();
  });
});
