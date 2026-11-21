import { describe, expect, it } from 'vitest';
import type { PersonVmAdmissionLease } from '@allrice/person-vm';
import { runGatewayAdmission } from './admission.ts';
import { ModelGatewayError } from './contract.ts';
import { deferred, FixtureAdmission, modelBinding } from './gateway.fixture.ts';

const leaseFor = (binding = modelBinding()): PersonVmAdmissionLease => ({
  binding: binding.vm,
  freezeId: 'host-issued-freeze',
  version: 'host-issued-version',
});

describe('gateway admission request ownership (synthetic host protocol)', () => {
  it('freeze preserves an admitted waiter; cancel still joins its real child before finish', async () => {
    const admission = new FixtureAdmission();
    const binding = modelBinding();
    const controller = new AbortController();
    const queued = deferred();
    const allowDispatch = deferred();
    const active = deferred();
    const childSettled = deferred();
    const canceled = new Error('client canceled while transport closing');
    let actualSignal: AbortSignal | undefined;
    const request = runGatewayAdmission(
      admission.injection,
      binding,
      'host-request-1',
      controller.signal,
      async (signal, activate) => {
        actualSignal = signal;
        queued.resolve();
        await allowDispatch.promise;
        await activate();
        active.resolve();
        await childSettled.promise;
        return { ok: false, error: signal.reason };
      },
    );
    const rejected = expect(request).rejects.toBe(canceled);
    await queued.promise;
    await admission.participant.freeze(leaseFor(binding), controller.signal);
    expect(admission.observe(binding.vm)).toMatchObject({
      queued: 1,
      active: 0,
      deferred: 0,
    });
    allowDispatch.resolve();
    await active.promise;
    expect(admission.observe(binding.vm)).toMatchObject({
      queued: 0,
      active: 1,
      deferred: 0,
    });
    controller.abort(canceled);
    expect(actualSignal?.aborted).toBe(true);
    expect(admission.finished).toHaveLength(0);
    expect(admission.records.size).toBe(1);
    childSettled.resolve();
    await rejected;
    expect(admission.records.size).toBe(0);
    expect(admission.finished).toHaveLength(1);
    expect(admission.finishCalls).toHaveLength(1);
  });

  it('one exact release cannot wake or dispatch; true ready cancels the old execution without relabeling', async () => {
    const admission = new FixtureAdmission();
    const binding = modelBinding();
    const original = structuredClone(binding);
    const signal = new AbortController().signal;
    const lease = leaseFor(binding);
    await admission.participant.freeze(lease, signal);
    let dispatches = 0;
    const request = runGatewayAdmission(
      admission.injection,
      binding,
      'deferred-1',
      signal,
      async () => {
        dispatches++;
        return { ok: true, value: undefined };
      },
    );
    const rejected = expect(request).rejects.toMatchObject({
      code: 'EXECUTION_REBIND_REQUIRED',
    });
    await admission.waiting.promise;
    expect(
      await admission.participant.thaw(
        { ...lease, version: 'superseded' },
        signal,
      ),
    ).toBe('superseded');
    expect(admission.wakeCount).toBe(0);
    expect(await admission.participant.thaw(lease, signal)).toBe('released');
    expect(admission.wakeCount).toBe(0);
    expect(dispatches).toBe(0);
    expect(admission.finished).toHaveLength(0);
    // Simulate the model host returning a newer true-ready VM. It is never
    // permission to rewrite native/employee/Run fields of the old envelope.
    admission.entryReleased = true;
    admission.ready.resolve({ ...binding.vm, leaseEpoch: 2 });
    await rejected;
    expect(binding).toEqual(original);
    expect(dispatches).toBe(0);
    expect(admission.finished).toHaveLength(1);
  });

  it('canceled deferred demand stays canceled after both late release ACKs', async () => {
    const admission = new FixtureAdmission();
    const binding = modelBinding();
    const controller = new AbortController();
    const lease = leaseFor(binding);
    await admission.participant.freeze(lease, controller.signal);
    let dispatches = 0;
    const request = runGatewayAdmission(
      admission.injection,
      binding,
      'deferred-cancel',
      controller.signal,
      async () => {
        dispatches++;
        return { ok: true, value: undefined };
      },
    );
    const rejection = expect(request).rejects.toThrow('caller stopped');
    await admission.waiting.promise;
    controller.abort(new Error('caller stopped'));
    await rejection;
    const signal = new AbortController().signal;
    await admission.participant.thaw(lease, signal);
    admission.entryReleased = true;
    admission.release();
    expect(admission.wakeCount).toBe(0);
    expect(dispatches).toBe(0);
    expect(admission.records.size).toBe(0);
  });

  it('unconfirmed actual drain settles callbacks but retains its durable permit instead of fake idle', async () => {
    const admission = new FixtureAdmission();
    const binding = modelBinding();
    const unknown = new ModelGatewayError('LEDGER_UNAVAILABLE');
    const failure = (await runGatewayAdmission(
      admission.injection,
      binding,
      'unknown-1',
      new AbortController().signal,
      async (_signal, activate) => {
        await activate();
        throw unknown;
      },
    ).catch((error: unknown) => error)) as ModelGatewayError;
    expect(failure.code).toBe('LEDGER_UNAVAILABLE');
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors[0]).toBe(unknown);
    expect((failure.cause as AggregateError).errors[1]).toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(admission.observe(binding.vm)).toMatchObject({
      active: 1,
      queued: 0,
    });
    expect(admission.finished).toHaveLength(0);
    expect(admission.finishCalls).toHaveLength(1);
    expect([...admission.records.values()][0]!.pending.size).toBe(0);
    expect([...admission.records.values()][0]!.unsafe).toBe(true);
  });

  it.each(['queued', 'active'] as const)(
    'confirmed-join %s business failure finishes before throwing the original error',
    async (phase) => {
      const admission = new FixtureAdmission();
      const original = new Error(
        'provider business failure after confirmed join',
      );
      const completed = deferred();
      const entered = deferred();
      const request = runGatewayAdmission(
        admission.injection,
        modelBinding(),
        `business-${phase}`,
        new AbortController().signal,
        async (_signal, activate) => {
          if (phase === 'active') await activate();
          entered.resolve();
          await completed.promise;
          return { ok: false, error: original };
        },
      );
      const rejected = expect(request).rejects.toBe(original);
      await entered.promise;
      expect(admission.finishCalls).toHaveLength(0);
      completed.resolve();
      await rejected;
      expect(admission.finishCalls).toHaveLength(1);
      expect(admission.finished).toHaveLength(1);
      expect(admission.records.size).toBe(0);
    },
  );

  it.each(['success', 'business-error'] as const)(
    'failed finish retains a known-joined %s permit and preserves first evidence',
    async (kind) => {
      const admission = new FixtureAdmission();
      const binding = modelBinding();
      admission.failFinish = true;
      const original = new Error('original joined business failure');
      const failure = (await runGatewayAdmission(
        admission.injection,
        binding,
        'finish-write-failed',
        new AbortController().signal,
        async (_signal, activate) => {
          await activate();
          return kind === 'success'
            ? { ok: true, value: undefined }
            : { ok: false, error: original };
        },
      ).catch((error: unknown) => error)) as ModelGatewayError;
      expect(failure.code).toBe('LEDGER_UNAVAILABLE');
      if (kind === 'business-error')
        expect((failure.cause as AggregateError).errors[0]).toBe(original);
      expect(admission.records.size).toBe(1);
      expect(admission.finishCalls).toHaveLength(1);
      expect([...admission.records.values()][0]!.pending.size).toBe(0);
      expect([...admission.records.values()][0]!.unsafe).toBe(false);
    },
  );

  it('a late active callback cleanup failure retains the earlier joined business error', async () => {
    const admission = new FixtureAdmission();
    const original = new Error('first joined business error');
    const listenerFailure = new Error('active listener cleanup failed');
    const activate = admission.activate.bind(admission);
    admission.activate = async (permit, operation, signal) => {
      await activate(permit, operation, signal);
      admission.records.get(permit)!.unsafe = true;
      throw listenerFailure;
    };
    const failure = (await runGatewayAdmission(
      admission.injection,
      modelBinding(),
      'late-listener-cleanup',
      new AbortController().signal,
      async (_signal, enter) => {
        await enter();
        return { ok: false, error: original };
      },
    ).catch((error: unknown) => error)) as ModelGatewayError;
    expect(failure.code).toBe('LEDGER_UNAVAILABLE');
    expect((failure.cause as AggregateError).errors).toEqual([
      original,
      listenerFailure,
      expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' }),
    ]);
    expect(admission.finishCalls).toHaveLength(1);
    expect(admission.finished).toHaveLength(0);
    expect(admission.records.size).toBe(1);
    expect([...admission.records.values()][0]!.pending.size).toBe(0);
  });

  it.each(['queued-only', 'queued-and-active'] as const)(
    '%s listener cleanup failures retain every error after the real work fulfilled',
    async (phase) => {
      const admission = new FixtureAdmission();
      const original = new Error('first joined business error');
      const queuedFailure = new Error('queued listener cleanup failed');
      const activeFailure = new Error('active listener cleanup failed');
      const queued = admission.queued.bind(admission);
      admission.queued = async (permit, operation, signal) => {
        await queued(permit, operation, signal);
        admission.records.get(permit)!.unsafe = true;
        throw queuedFailure;
      };
      if (phase === 'queued-and-active') {
        const activate = admission.activate.bind(admission);
        admission.activate = async (permit, operation, signal) => {
          await activate(permit, operation, signal);
          admission.records.get(permit)!.unsafe = true;
          throw activeFailure;
        };
      }
      const failure = (await runGatewayAdmission(
        admission.injection,
        modelBinding(),
        phase,
        new AbortController().signal,
        async (_signal, enter) => {
          await enter();
          return { ok: false, error: original };
        },
      ).catch((error: unknown) => error)) as ModelGatewayError;
      expect(failure.code).toBe('LEDGER_UNAVAILABLE');
      expect((failure.cause as AggregateError).errors).toEqual([
        original,
        ...(phase === 'queued-and-active' ? [activeFailure] : []),
        queuedFailure,
        expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' }),
      ]);
      expect(admission.finishCalls).toHaveLength(1);
      expect(admission.finished).toHaveLength(0);
      expect(admission.records.size).toBe(1);
      expect([...admission.records.values()][0]!).toMatchObject({
        unsafe: true,
      });
      expect([...admission.records.values()][0]!.pending.size).toBe(0);
    },
  );

  it('cancel after entering deferred wait and one thaw joins demand without marking business work unsafe', async () => {
    const admission = new FixtureAdmission();
    const binding = modelBinding();
    const controller = new AbortController();
    const lease = leaseFor(binding);
    const signal = new AbortController().signal;
    await admission.participant.freeze(lease, signal);
    const canceled = new Error('caller canceled an entered deferred wait');
    let dispatches = 0;
    const request = runGatewayAdmission(
      admission.injection,
      binding,
      'entered-deferred-cancel',
      controller.signal,
      async () => {
        dispatches++;
        return { ok: true, value: undefined };
      },
    );
    const rejected = expect(request).rejects.toBe(canceled);
    await admission.waiting.promise;
    await admission.participant.thaw(lease, signal);
    expect([...admission.records.values()][0]!.pending.size).toBe(1);
    controller.abort(canceled);
    await rejected;
    expect(admission.finishCalls).toHaveLength(1);
    expect(admission.finished).toHaveLength(1);
    expect(admission.records.size).toBe(0);
    admission.entryReleased = true;
    admission.release();
    expect(admission.wakeCount).toBe(0);
    expect(dispatches).toBe(0);
  });
});
