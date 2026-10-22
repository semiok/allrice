import { describe, expect, it } from 'vitest';
import {
  DshRunTiming,
  type DshRunTimingReport,
  type DshRunTimingOutcome,
} from './run-timing.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(
  options: Partial<ConstructorParameters<typeof DshRunTiming>[0]> = {},
) {
  let now = 1_000;
  const reports: DshRunTimingReport[] = [];
  const timing = new DshRunTiming({
    runId: 'run-fixture',
    sessionId: 'session-fixture',
    attempt: 1,
    generation: 2,
    onDiagnostic: (report) => reports.push(report),
    clock: () => now,
    ...options,
  });
  return { timing, reports, at: (elapsed: number) => (now = 1_000 + elapsed) };
}

describe('Worker-only DSH Run timing', () => {
  it('uses one monotonic origin and distinguishes native chunks from visible text', () => {
    const { timing, reports, at } = fixture();
    at(12);
    timing.mark('preparationCompleted');
    at(25);
    timing.mark('firstNativeChunk');
    at(35);
    timing.mark('firstNativeChunk');
    at(90);
    timing.mark('firstVisibleText');
    at(100);
    timing.mark('nativeTurnEnded');
    at(110);
    timing.mark('beforePublication');
    at(125);
    timing.mark('publicationCompleted');
    at(130);
    timing.finish('completed');

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      schemaVersion: 1,
      event: 'allrice.dsh_run_timing',
      scope: 'harness-execute',
      runId: 'run-fixture',
      sessionId: 'session-fixture',
      attempt: 1,
      generation: 2,
      outcome: 'completed',
      elapsedMs: 130,
      points: {
        preparationCompleted: 12,
        firstNativeChunk: 25,
        firstVisibleText: 90,
        nativeTurnEnded: 100,
        beforePublication: 110,
        publicationCompleted: 125,
      },
    });
    expect(Object.values(reports[0]!.capabilities)).toEqual(
      Array(5).fill(false),
    );
    expect(Object.values(reports[0]!.wire)).toEqual(Array(4).fill(null));
  });

  it('updates the final native turn end while retaining first observations', () => {
    const { timing, reports, at } = fixture();
    at(10);
    timing.mark('firstNativeChunk');
    at(20);
    timing.mark('firstVisibleText');
    at(30);
    timing.mark('nativeTurnEnded');
    at(40);
    timing.mark('firstNativeChunk');
    timing.mark('firstVisibleText');
    at(60);
    timing.mark('nativeTurnEnded');
    at(70);
    timing.finish('completed');

    expect(reports[0]!.points).toMatchObject({
      firstNativeChunk: 10,
      firstVisibleText: 20,
      nativeTurnEnded: 60,
    });
  });

  it('counts overlapping guard spans separately while their union counts once', async () => {
    const { timing, reports, at } = fixture();
    const a = deferred();
    const b = deferred();
    at(10);
    const first = timing.checkContent('nativeDispatch', () => a.promise);
    at(20);
    const second = timing.checkContent('modelAdmission', () => b.promise);
    at(40);
    a.resolve();
    await first;
    at(55);
    b.resolve();
    await second;
    at(70);
    await timing.checkContent('nativeDispatch', async () => {
      at(80);
    });
    at(85);
    timing.finish('completed');

    expect(reports[0]!.contentChecks).toMatchObject({
      calls: 3,
      failed: 0,
      pending: 0,
      sumMs: 75,
      unionMs: 55,
      phases: {
        nativeDispatch: { calls: 2, failed: 0, pending: 0, durationMs: 40 },
        modelAdmission: { calls: 1, failed: 0, pending: 0, durationMs: 35 },
      },
    });
  });

  it('keeps fractional timestamps so short spans are not rounded at each endpoint', async () => {
    const { timing, reports, at } = fixture();
    at(10.49);
    timing.mark('preparationCompleted');
    timing.modelStarted('short-call');
    await timing.checkContent('nativeDispatch', async () => {
      at(10.51);
    });
    timing.modelFinished('short-call');
    timing.finish('completed');

    const report = reports[0]!;
    expect(report.elapsedMs).toBeCloseTo(10.51, 8);
    expect(report.points.preparationCompleted).toBeCloseTo(10.49, 8);
    expect(report.contentChecks.sumMs).toBeCloseTo(0.02, 8);
    expect(report.contentChecks.unionMs).toBeCloseTo(0.02, 8);
    expect(report.modelChain.durationMs).toBeCloseTo(0.02, 8);
  });

  it('preserves the exact guard exception without logging its secret text', async () => {
    const { timing, reports, at } = fixture();
    const secret = new Error('SECRET_TOKEN_AND_PRIVATE_PROMPT');
    await expect(
      timing.checkContent('toolDispatch', async () => {
        at(15);
        throw secret;
      }),
    ).rejects.toBe(secret);
    await timing.checkContent('sceneLoad', async () => {
      at(19);
    });
    timing.finish('failed');

    expect(reports[0]!.contentChecks).toMatchObject({
      calls: 2,
      failed: 1,
      sumMs: 19,
      unionMs: 19,
      phases: {
        toolDispatch: { calls: 1, failed: 1, durationMs: 15 },
        sceneLoad: { calls: 1, failed: 0, durationMs: 4 },
      },
    });
    expect(JSON.stringify(reports)).not.toMatch(/SECRET|PRIVATE_PROMPT/);
  });

  it('snapshots pending guards and never blocks or emits again when they finish', async () => {
    const { timing, reports, at } = fixture();
    const gate = deferred();
    at(10);
    const checking = timing.checkContent('inputGate', () => gate.promise);
    at(50);
    timing.finish('waiting');
    expect(reports[0]!.contentChecks).toMatchObject({
      calls: 1,
      pending: 1,
      sumMs: 40,
      unionMs: 40,
      phases: { inputGate: { pending: 1, durationMs: 40 } },
    });
    const snapshot = JSON.stringify(reports);
    at(90);
    gate.resolve();
    await checking;
    timing.finish('completed');
    expect(JSON.stringify(reports)).toBe(snapshot);
    let invoked = false;
    await timing.checkContent('other', async () => {
      invoked = true;
    });
    expect(invoked).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it('counts unfinished overlapping guards in one phase without changing a late rejection', async () => {
    const { timing, reports, at } = fixture();
    const a = deferred();
    const b = deferred();
    const c = deferred();
    at(10);
    const first = timing.checkContent('inputGate', () => a.promise);
    at(20);
    const second = timing.checkContent('inputGate', () => b.promise);
    at(30);
    const third = timing.checkContent('inputGate', () => c.promise);
    at(40);
    a.resolve();
    await first;
    at(50);
    timing.finish('aborted');

    expect(reports[0]!.contentChecks).toMatchObject({
      calls: 3,
      failed: 0,
      pending: 2,
      sumMs: 80,
      unionMs: 40,
      phases: {
        inputGate: { calls: 3, failed: 0, pending: 2, durationMs: 80 },
      },
    });
    const snapshot = JSON.stringify(reports);
    const failure = { message: 'PRIVATE_LATE_FAILURE' };
    const rejected = expect(second).rejects.toBe(failure);
    at(100);
    b.reject(failure);
    c.resolve();
    await Promise.all([rejected, third]);
    expect(JSON.stringify(reports)).toBe(snapshot);
  });

  it('preserves a synchronous guard throw even when the clock fails', async () => {
    let reads = 0;
    const { timing, reports } = fixture({
      clock: () => {
        if (reads++ === 0) return 1_000;
        throw Error('PRIVATE_CLOCK_FAILURE');
      },
    });
    const failure = { message: 'PRIVATE_SYNC_FAILURE' };
    await expect(
      timing.checkContent('toolDispatch', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    timing.finish('failed');

    expect(reports[0]!.contentChecks).toMatchObject({
      calls: 1,
      failed: 1,
      pending: 0,
      sumMs: 0,
      unionMs: 0,
    });
    expect(JSON.stringify(reports)).not.toContain('PRIVATE');
  });

  it('keeps concurrent Runs isolated, including a rejecting guard', async () => {
    const a = fixture({ runId: 'run-a' });
    const b = fixture({ runId: 'run-b' });
    const first = deferred();
    const second = deferred();
    a.at(5);
    b.at(20);
    const operationA = a.timing.checkContent(
      'personalSkill',
      () => first.promise,
    );
    const error = new Error('PRIVATE_REJECTED_CONTENT');
    const operationB = b.timing.checkContent(
      'deliveryRepair',
      () => second.promise,
    );
    const rejected = expect(operationB).rejects.toBe(error);
    a.at(15);
    b.at(70);
    first.resolve();
    second.reject(error);
    await Promise.all([operationA, rejected]);
    a.timing.finish('completed');
    b.timing.finish('failed');

    expect(a.reports[0]).toMatchObject({
      runId: 'run-a',
      contentChecks: { calls: 1, failed: 0, sumMs: 10, unionMs: 10 },
    });
    expect(b.reports[0]).toMatchObject({
      runId: 'run-b',
      contentChecks: { calls: 1, failed: 1, sumMs: 50, unionMs: 50 },
    });
  });

  it('pairs model calls, ignores duplicate reports and retains unclosed spans', () => {
    const { timing, reports, at } = fixture();
    at(10);
    timing.modelStarted('call-a');
    at(20);
    timing.modelStarted('call-a');
    timing.modelStarted('call-b');
    at(40);
    timing.modelFinished('call-a');
    at(50);
    timing.modelFinished('call-a');
    timing.modelFinished('unknown-call');
    timing.modelStarted('call-a');
    at(70);
    timing.finish('aborted');

    expect(reports[0]!.modelChain).toEqual({
      calls: 2,
      completed: 1,
      durationMs: 30,
      unclosed: 1,
      unclosedDurationMs: 50,
      truncated: false,
    });
    expect(JSON.stringify(reports)).not.toContain('call-a');
    expect(JSON.stringify(reports)).not.toContain('call-b');
  });

  it('bounds tracked model identities without printing dynamic IDs', () => {
    const { timing, reports, at } = fixture();
    for (let index = 0; index < 300; index++)
      timing.modelStarted(`PRIVATE_CALL_${index}`);
    at(15);
    timing.finish('aborted');
    expect(reports[0]!.modelChain).toMatchObject({
      calls: 256,
      completed: 0,
      unclosed: 256,
      unclosedDurationMs: 3_840,
      truncated: true,
    });
    expect(JSON.stringify(reports)).not.toContain('PRIVATE_CALL');
  });

  it('does not let synchronous or asynchronous logging failure alter execution', async () => {
    for (const onDiagnostic of [
      () => {
        throw Error('LOGGER_FAILURE');
      },
      async () => {
        throw Error('ASYNC_LOGGER_FAILURE');
      },
    ]) {
      const { timing } = fixture({ onDiagnostic });
      let calls = 0;
      await timing.checkContent('afterNativeResult', async () => {
        calls++;
      });
      expect(() => timing.finish('completed')).not.toThrow();
      expect(() => timing.finish('failed')).not.toThrow();
      const businessFailure = Error('BUSINESS_FAILURE');
      await expect(
        timing.checkContent('other', async () => {
          throw businessFailure;
        }),
      ).rejects.toBe(businessFailure);
      expect(calls).toBe(1);
      await Promise.resolve();
    }
  });

  it('admits only fixed fields and bounded identities, never extra input data', async () => {
    const { timing, reports } = fixture({
      runId: 'SECRET_TOKEN\nPRIVATE_PROMPT',
      sessionId: 'x'.repeat(201),
      attempt: NaN,
      generation: Infinity,
      ...({ rawPayload: { secret: 'PRIVATE_RAW_PAYLOAD' } } as object),
    });
    timing.mark('PRIVATE_MARK' as never);
    timing.modelStarted('PRIVATE CALL WITH SPACES');
    await timing.checkContent('PRIVATE_PHASE' as never, async () => {});
    timing.finish('PRIVATE_OUTCOME' as DshRunTimingOutcome);
    const report = reports[0]!;
    expect(report).toMatchObject({
      runId: null,
      sessionId: null,
      attempt: null,
      generation: null,
      outcome: 'failed',
      contentChecks: { phases: { other: { calls: 1 } } },
      modelChain: { calls: 0 },
    });
    expect(Object.values(report.points)).toEqual(Array(6).fill(null));
    expect(JSON.stringify(report)).not.toMatch(/SECRET|PRIVATE|rawPayload/);
  });

  it('keeps timing nonnegative and monotonic if a diagnostic clock fails', () => {
    let now = 100;
    const { timing, reports } = fixture({
      clock: () => {
        if (now === 999) throw Error('CLOCK_FAILURE');
        return now;
      },
    });
    now = 110;
    timing.mark('preparationCompleted');
    now = 105;
    timing.mark('firstNativeChunk');
    now = NaN;
    timing.mark('firstVisibleText');
    now = 999;
    timing.mark('nativeTurnEnded');
    now = 120;
    timing.finish('completed');
    expect(reports[0]).toMatchObject({
      elapsedMs: 20,
      points: {
        preparationCompleted: 10,
        firstNativeChunk: 10,
        firstVisibleText: 10,
        nativeTurnEnded: 10,
      },
    });
  });

  it('establishes a missing origin from the first valid clock sample', () => {
    let now: number | null = null;
    const { timing, reports } = fixture({
      clock: () => {
        if (now === null) throw Error('CLOCK_ORIGIN_FAILURE');
        return now;
      },
    });
    timing.mark('preparationCompleted');
    now = 5_000_000;
    timing.mark('firstNativeChunk');
    now += 25;
    timing.finish('completed');

    expect(reports[0]).toMatchObject({
      elapsedMs: 25,
      points: { preparationCompleted: 0, firstNativeChunk: 0 },
    });
  });
});
