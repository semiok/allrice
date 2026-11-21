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
      },
    );
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
    controller.abort(new Error('client canceled while transport closing'));
    expect(actualSignal?.aborted).toBe(true);
    expect(admission.finished).toHaveLength(0);
    expect(admission.records.size).toBe(1);
    childSettled.resolve();
    await request;
    expect(admission.records.size).toBe(0);
    expect(admission.finished).toHaveLength(1);
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
    await expect(
      runGatewayAdmission(
        admission.injection,
        binding,
        'unknown-1',
        new AbortController().signal,
        async (_signal, activate) => {
          await activate();
          throw new ModelGatewayError('LEDGER_UNAVAILABLE');
        },
      ),
    ).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    expect(admission.observe(binding.vm)).toMatchObject({
      active: 1,
      queued: 0,
    });
    expect(admission.finished).toHaveLength(0);
    expect([...admission.records.values()][0]!.pending.size).toBe(0);
  });

  it('a failed finish write retains a known-joined permit and rejects the request', async () => {
    const admission = new FixtureAdmission();
    const binding = modelBinding();
    admission.failFinish = true;
    await expect(
      runGatewayAdmission(
        admission.injection,
        binding,
        'finish-write-failed',
        new AbortController().signal,
        async (_signal, activate) => {
          await activate();
        },
      ),
    ).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' });
    expect(admission.records.size).toBe(1);
    expect([...admission.records.values()][0]!.pending.size).toBe(0);
  });
});
