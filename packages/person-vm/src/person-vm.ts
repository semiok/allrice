import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  RequestContextSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import {
  PersonVmError,
  PERSON_VM_COLD_MS,
  PERSON_VM_IDLE_MS,
  type PersonVmAction,
  type PersonVmActivity,
  type PersonVmAuthority,
  type PersonVmBinding,
  type PersonVmEgressPort,
  type PersonVmEgressReceipt,
  type PersonVmHostPort,
  type PersonVmRuntimePort,
  type PersonVmView,
} from './contract.ts';
import type { PersonVmDiskPort } from './encrypted-disk.ts';
import type { PersonVmNativePort } from './microsandbox.ts';
import {
  bindingOf,
  type PersonVmStore,
  type VmHold,
  type VmLease,
  type VmRecord,
} from './store.ts';

export function sameVmBinding(left: PersonVmBinding, right: PersonVmBinding) {
  return (
    Boolean(left && right) &&
    left.vmId === right.vmId &&
    left.personId === right.personId &&
    left.organizationId === right.organizationId &&
    left.instanceId === right.instanceId &&
    left.leaseEpoch === right.leaseEpoch
  );
}
function view(row: VmRecord, ready = false): PersonVmView {
  return {
    vmId: row.vmId,
    personId: row.personId,
    organizationId: row.organizationId,
    phase: row.phase,
    ready,
    diskRetained: row.diskRetained,
    lastActivityAt: row.lastActivityAt,
  };
}
function safeError(error: unknown) {
  return error instanceof PersonVmError
    ? error
    : new PersonVmError('PROVIDER_FAILED', { cause: error });
}

export class PersonVmService implements PersonVmHostPort {
  private readonly now: () => Date;
  private readonly currentLease = new AsyncLocalStorage<{
    active: boolean;
    requestId: string;
    personId: string;
    lease: VmLease;
  }>();
  constructor(
    private readonly options: {
      store: PersonVmStore;
      authority: PersonVmAuthority;
      disk: PersonVmDiskPort;
      native: PersonVmNativePort;
      egress?: PersonVmEgressPort;
      runtime?: PersonVmRuntimePort;
      leaseTtlMs: number;
      activityMaxAgeMs: number;
      cleanupTimeoutMs: number;
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    if (
      ![
        options.leaseTtlMs,
        options.activityMaxAgeMs,
        options.cleanupTimeoutMs,
      ].every((value) => Number.isFinite(value) && value > 0)
    )
      throw new PersonVmError('PROVIDER_FAILED');
  }
  private async identity(
    context: RequestContext,
    action: PersonVmAction,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    RequestContextSchema.parse(context); // Shape only; authority below supplies current trust.
    const identity = await this.options.authority.authorize(
      context,
      action,
      signal,
    );
    if (
      !UuidSchema.safeParse(identity.personId).success ||
      identity.organizationId !== context.organizationId ||
      (context.actor.type === 'user' && identity.personId !== context.actor.id)
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    return identity;
  }
  private checkOrganization(row: VmRecord, organizationId: string) {
    if (row.organizationId !== organizationId)
      throw new PersonVmError('ORGANIZATION_CONFLICT');
  }
  private async leased<T>(
    context: RequestContext,
    action: PersonVmAction,
    signal: AbortSignal,
    work: (
      lease: VmLease,
      identity: { personId: string; organizationId: string },
    ) => Promise<T>,
  ) {
    const identity = await this.identity(context, action, signal);
    return this.options.store.withLease(
      identity.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs },
      async (lease) => {
        if (lease.row)
          this.checkOrganization(lease.row, identity.organizationId);
        const frame = {
          active: true,
          requestId: context.requestId,
          personId: identity.personId,
          lease,
        };
        return this.currentLease.run(frame, async () => {
          try {
            return await work(lease, identity);
          } finally {
            frame.active = false;
          }
        });
      },
    );
  }
  private required(row: VmRecord | null) {
    if (!row || row.phase === 'deleted' || !row.diskRetained)
      throw new PersonVmError('NOT_FOUND');
    return row;
  }
  async read(context: RequestContext, signal: AbortSignal) {
    const identity = await this.identity(context, 'read', signal);
    const row = await this.options.store.read(identity.personId);
    if (!row) return null;
    this.checkOrganization(row, identity.organizationId);
    return view(row); // A persisted running flag is not a readiness assertion.
  }
  async create(context: RequestContext, signal: AbortSignal) {
    return this.leased(context, 'create', signal, async (lease, identity) => {
      if (lease.row && lease.row.phase !== 'deleted') return view(lease.row);
      if (lease.row?.diskRetained) {
        lease.row.phase = lease.row.diskTier === 'cold' ? 'cold' : 'stopped';
        await lease.save(lease.row);
        await lease.audit(lease.row, {
          requestId: context.requestId,
          action: 'create-retained',
          result: 'succeeded',
        });
        return view(lease.row);
      }
      const row: VmRecord = {
        vmId: randomUUID(),
        ...identity,
        phase: 'starting',
        diskTier: 'warm',
        diskRetained: true,
        nativeCreated: false,
        instanceId: null,
        leaseEpoch: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        egressReceipt: null,
        gatewayPorts: [],
        holds: [],
        lastActivityAt: this.now().toISOString(),
        stoppedAt: null,
        idleSince: null,
        activityObservedAt: null,
      };
      await lease.save(row); // Persist ownership before creating disk/key side effects.
      await lease.audit(row, {
        requestId: context.requestId,
        action: 'create',
        result: 'started',
      });
      try {
        signal.throwIfAborted();
        await lease.guard();
        await this.options.disk.create(
          { vmId: row.vmId, tier: row.diskTier },
          signal,
        );
        row.phase = 'stopped';
        row.stoppedAt = this.now().toISOString();
        await lease.save(row);
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'create',
          result: 'succeeded',
        });
        return view(row);
      } catch (error) {
        row.phase = 'failed';
        await lease.save(row);
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'create',
          result: 'failed',
          errorCode: safeError(error).code,
        });
        throw safeError(error); // Retain possible partial storage; never erase by default.
      }
    });
  }
  private validateReceipt(
    binding: PersonVmBinding,
    receipt: PersonVmEgressReceipt,
  ) {
    if (
      !receipt ||
      !receipt.binding ||
      !sameVmBinding(binding, receipt.binding) ||
      typeof receipt.bindingId !== 'string' ||
      !receipt.bindingId ||
      !Array.isArray(receipt.gatewayPorts) ||
      receipt.gatewayPorts.length === 0 ||
      receipt.gatewayPorts.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      ) ||
      new Set(receipt.gatewayPorts).size !== receipt.gatewayPorts.length
    )
      throw new PersonVmError('EGRESS_BINDING_INVALID');
  }
  private receipt(
    binding: PersonVmBinding,
    value: PersonVmEgressReceipt,
  ): PersonVmEgressReceipt {
    this.validateReceipt(binding, value);
    return Object.freeze({
      binding: Object.freeze({ ...binding }),
      bindingId: value.bindingId,
      gatewayPorts: Object.freeze([...value.gatewayPorts]),
    });
  }
  private async mounted(row: VmRecord, signal: AbortSignal) {
    const mount = await this.options.disk.attach(
      { vmId: row.vmId, tier: row.diskTier },
      signal,
    );
    await this.options.native.prepare(bindingOf(row), mount, signal);
  }
  private async ready(row: VmRecord, signal: AbortSignal) {
    if (!this.options.runtime || !this.options.egress || !row.egressReceipt)
      throw new PersonVmError('RUNTIME_NOT_READY');
    const binding = bindingOf(row);
    row.egressReceipt = this.receipt(binding, row.egressReceipt);
    await this.options.egress.assertActive(row.egressReceipt, signal);
    await this.options.native.ping(binding, signal);
    const result = await this.options.runtime.readiness(binding, signal);
    if (
      !result ||
      !sameVmBinding(result.binding, binding) ||
      result.authenticated !== true ||
      result.editorReady !== true ||
      result.canSend !== true
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
  }
  async start(context: RequestContext, signal: AbortSignal) {
    return this.leased(context, 'start', signal, async (lease) => {
      const row = this.required(lease.row);
      if (!this.options.egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
      if (!this.options.runtime) throw new PersonVmError('RUNTIME_NOT_READY');
      if (row.phase === 'running') {
        await this.mounted(row, signal);
        await this.ready(row, signal);
        return view(row, true);
      }
      if (
        row.phase === 'failed' ||
        row.phase === 'starting' ||
        row.egressReceipt
      )
        await this.cleanup(row, lease, 'takeover');
      row.leaseEpoch += 1;
      row.instanceId = randomUUID();
      row.phase = 'starting';
      row.stoppedAt = null;
      row.idleSince = null;
      row.activityObservedAt = null;
      row.lastActivityAt = this.now().toISOString();
      await lease.save(row);
      await lease.audit(row, {
        requestId: context.requestId,
        action: 'start',
        result: 'started',
      });
      try {
        signal.throwIfAborted();
        await lease.guard();
        const binding = bindingOf(row);
        const receipt = this.receipt(
          binding,
          await this.options.egress.prepare(binding, signal),
        );
        row.egressReceipt = receipt;
        await lease.save(row);
        if (
          row.nativeCreated &&
          JSON.stringify([...receipt.gatewayPorts].sort((a, b) => a - b)) !==
            JSON.stringify([...row.gatewayPorts].sort((a, b) => a - b))
        )
          throw new PersonVmError('EGRESS_BINDING_INVALID');
        if (!row.nativeCreated) row.gatewayPorts = [...receipt.gatewayPorts];
        await lease.save(row);
        if (row.diskTier === 'cold') {
          await this.options.disk.move(
            { vmId: row.vmId, tier: 'cold' },
            'warm',
            signal,
          );
          row.diskTier = 'warm';
          await lease.save(row);
        }
        await this.mounted(row, signal);
        await lease.guard();
        await this.options.egress.assertActive(receipt, signal);
        const state = await this.options.native.status(binding, signal);
        if (state === 'absent' && !row.nativeCreated) {
          await this.options.native.create(binding, receipt, signal);
          row.nativeCreated = true;
          await lease.save(row);
        } else if (state === 'stopped' && row.nativeCreated)
          await this.options.native.start(binding, signal);
        else throw new PersonVmError('PROVIDER_FAILED');
        await lease.guard();
        await this.options.runtime.start(binding, signal);
        await this.ready(row, signal);
        row.phase = 'running';
        await lease.save(row);
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'start',
          result: 'succeeded',
        });
        return view(row, true);
      } catch (error) {
        const failure = safeError(error);
        try {
          await lease.audit(row, {
            requestId: context.requestId,
            action: 'start',
            result: 'failed',
            errorCode: failure.code,
          });
        } catch {
          /* Failure audit cannot prevent physical cleanup after a lost DB connection. */
        }
        try {
          await this.cleanup(row, lease, 'failure');
        } catch {
          throw new PersonVmError('CLEANUP_INCOMPLETE', { cause: failure });
        }
        throw failure;
      }
    });
  }
  async prewarm(
    context: RequestContext,
    input: { trigger: 'page' | 'input' },
    signal: AbortSignal,
  ) {
    if (input.trigger !== 'page' && input.trigger !== 'input')
      throw new PersonVmError('AUTHORIZATION_DENIED');
    await this.create(context, signal);
    return this.start(context, signal);
  }
  private async inactive(
    row: VmRecord,
    signal: AbortSignal,
  ): Promise<PersonVmActivity> {
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    if (!this.options.runtime) throw new PersonVmError('ACTIVITY_UNKNOWN');
    let snapshot: PersonVmActivity;
    try {
      snapshot = await this.options.runtime.activity(bindingOf(row), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PersonVmError('ACTIVITY_UNKNOWN', { cause: error });
    }
    if (!snapshot) throw new PersonVmError('ACTIVITY_UNKNOWN');
    const age = this.now().getTime() - Date.parse(snapshot.observedAt);
    if (
      !sameVmBinding(snapshot.binding, bindingOf(row)) ||
      snapshot.state !== 'known' ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > this.options.activityMaxAgeMs
    )
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    const counts = [
      snapshot.activeTurns,
      snapshot.activeJobs,
      snapshot.activeSubtasks,
      snapshot.pendingApprovals,
    ];
    if (!counts.every((value) => Number.isInteger(value) && value >= 0))
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    if (counts.some((value) => value > 0)) throw new PersonVmError('VM_ACTIVE');
    return snapshot;
  }
  private async cleanup(
    row: VmRecord,
    lease: VmLease,
    reason: 'stop' | 'failure' | 'takeover' | 'delete',
  ) {
    let failed = false;
    if (row.egressReceipt) {
      try {
        if (!this.options.egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
        await this.options.egress.revoke(
          this.receipt(bindingOf(row), row.egressReceipt),
          reason,
          AbortSignal.timeout(this.options.cleanupTimeoutMs),
        );
        row.egressReceipt = null;
      } catch {
        failed = true;
      }
    }
    let stopped = false;
    // Revocation exhausting its budget must not pre-abort the physical stop attempt.
    const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs);
    try {
      if (row.instanceId) {
        await this.mounted(row, signal);
        const binding = bindingOf(row);
        await this.options.native.stop(binding, signal);
        const state = await this.options.native.status(binding, signal);
        stopped = state === 'stopped' || state === 'absent';
        if (state === 'stopped') row.nativeCreated = true; // Native create may have committed before a failed host save/ack.
      } else stopped = !row.nativeCreated;
    } catch {
      failed = true;
    }
    if (stopped) {
      row.stoppedAt ??= this.now().toISOString();
      try {
        await this.options.disk.detach(
          { vmId: row.vmId, tier: row.diskTier },
          AbortSignal.timeout(this.options.cleanupTimeoutMs),
        );
      } catch {
        failed = true;
      }
    } else failed = true;
    row.phase = failed ? 'failed' : 'stopped';
    await lease.save(row);
    if (failed) throw new PersonVmError('CLEANUP_INCOMPLETE');
  }
  async stop(context: RequestContext, signal: AbortSignal) {
    return this.leased(context, 'stop', signal, async (lease) => {
      const row = this.required(lease.row);
      if (row.phase === 'running') await this.inactive(row, signal);
      if (row.phase === 'starting') throw new PersonVmError('ACTIVITY_UNKNOWN');
      await lease.audit(row, {
        requestId: context.requestId,
        action: 'stop',
        result: 'started',
      });
      try {
        if (row.instanceId) await this.cleanup(row, lease, 'stop');
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'stop',
          result: 'succeeded',
        });
        return view(row);
      } catch (error) {
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'stop',
          result: 'failed',
          errorCode: safeError(error).code,
        });
        throw error;
      }
    });
  }
  async delete(
    context: RequestContext,
    input: { deleteDisk?: boolean },
    signal: AbortSignal,
  ) {
    if (input.deleteDisk !== undefined && typeof input.deleteDisk !== 'boolean')
      throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED');
    return this.leased(context, 'delete', signal, async (lease) => {
      const row = lease.row;
      if (!row) throw new PersonVmError('NOT_FOUND');
      if (input.deleteDisk) {
        try {
          const allowed = await this.identity(context, 'delete-disk', signal);
          this.checkOrganization(row, allowed.organizationId);
        } catch (error) {
          await lease.audit(row, {
            requestId: context.requestId,
            action: 'delete-disk',
            result: 'denied',
            errorCode: 'DISK_DELETE_NOT_AUTHORIZED',
          });
          throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED', {
            cause: error,
          });
        }
      }
      if (row.phase === 'running') await this.inactive(row, signal);
      if (row.holds.length > 0 || row.phase === 'starting')
        throw new PersonVmError('VM_ACTIVE');
      const action = input.deleteDisk ? 'delete-disk' : 'delete';
      await lease.audit(row, {
        requestId: context.requestId,
        action,
        result: 'started',
      });
      try {
        if (row.instanceId && row.diskRetained)
          await this.cleanup(row, lease, 'delete');
        if (input.deleteDisk && row.diskRetained) {
          await lease.guard();
          await this.options.disk.delete(
            { vmId: row.vmId, tier: row.diskTier },
            signal,
          );
          row.diskRetained = false;
        }
        row.phase = 'deleted';
        await lease.save(row);
        await lease.audit(row, {
          requestId: context.requestId,
          action,
          result: 'succeeded',
        });
        return view(row);
      } catch (error) {
        row.phase = 'failed';
        await lease.save(row);
        await lease.audit(row, {
          requestId: context.requestId,
          action,
          result: 'failed',
          errorCode: safeError(error).code,
        });
        throw safeError(error);
      }
    });
  }
  /** Scheduler calls with a current trusted identity. No Agent/task scheduler is added. */
  async reconcileIdle(context: RequestContext, signal: AbortSignal) {
    return this.leased(context, 'stop', signal, async (lease) => {
      const row = this.required(lease.row);
      const elapsed = this.now().getTime() - Date.parse(row.lastActivityAt);
      if (row.phase === 'starting' || row.phase === 'failed') return view(row);
      if (row.phase === 'running') {
        let snapshot: PersonVmActivity;
        try {
          snapshot = await this.inactive(row, signal);
        } catch (error) {
          if (
            error instanceof PersonVmError &&
            (error.code === 'VM_ACTIVE' || error.code === 'ACTIVITY_UNKNOWN')
          ) {
            row.lastActivityAt = this.now().toISOString();
            row.idleSince = null;
            row.activityObservedAt = null;
            await lease.save(row);
            return view(row);
          }
          throw error;
        }
        const observed = Date.parse(snapshot.observedAt);
        const previous = row.activityObservedAt
          ? Date.parse(row.activityObservedAt)
          : NaN;
        if (
          !row.idleSince ||
          !Number.isFinite(previous) ||
          observed < previous ||
          observed - previous > this.options.activityMaxAgeMs
        ) {
          row.idleSince = this.now().toISOString();
        }
        row.activityObservedAt = snapshot.observedAt;
        const continuouslyIdleFor =
          this.now().getTime() -
          Math.max(Date.parse(row.idleSince), Date.parse(row.lastActivityAt));
        if (
          continuouslyIdleFor < PERSON_VM_IDLE_MS ||
          elapsed < PERSON_VM_IDLE_MS
        ) {
          await lease.save(row);
          return view(row);
        }
        await this.cleanup(row, lease, 'stop');
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'idle-stop',
          result: 'succeeded',
        });
      }
      const stoppedFor = row.stoppedAt
        ? this.now().getTime() - Date.parse(row.stoppedAt)
        : 0;
      if (row.phase === 'stopped' && stoppedFor >= PERSON_VM_COLD_MS) {
        await this.options.disk.move(
          { vmId: row.vmId, tier: row.diskTier },
          'cold',
          signal,
        );
        row.diskTier = 'cold';
        row.phase = 'cold';
        await lease.save(row);
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'cold',
          result: 'succeeded',
        });
      }
      return view(row);
    });
  }
  async resolve(context: RequestContext, signal: AbortSignal) {
    const identity = await this.identity(context, 'read', signal);
    const active = this.currentLease.getStore();
    const ownLease =
      active?.active === true &&
      active.requestId === context.requestId &&
      active.personId === identity.personId
        ? active.lease
        : null;
    if (ownLease) await ownLease.guard();
    const row = this.required(
      ownLease
        ? ownLease.row
        : await this.options.store.read(identity.personId),
    );
    this.checkOrganization(row, identity.organizationId);
    if (
      (!ownLease && row.leaseOwner) ||
      row.phase !== 'running' ||
      !row.egressReceipt ||
      !this.options.egress
    )
      throw new PersonVmError(
        ownLease ? 'RUNTIME_NOT_READY' : 'LEASE_CONFLICT',
      );
    const receipt = this.receipt(bindingOf(row), row.egressReceipt);
    await this.options.egress.assertActive(receipt, signal);
    return bindingOf(row);
  }
  async assertCurrentBinding(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    if (!sameVmBinding(await this.resolve(context, signal), binding))
      throw new PersonVmError('LEASE_LOST');
  }
  async recoverExpired(context: RequestContext, signal: AbortSignal) {
    const identity = await this.identity(context, 'stop', signal);
    const before = this.required(
      await this.options.store.read(identity.personId),
    );
    this.checkOrganization(before, identity.organizationId);
    return this.options.store.recover(
      identity.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs, signal },
      async (lease) => {
        const row = this.required(lease.row);
        this.checkOrganization(row, identity.organizationId);
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'recover',
          result: 'started',
        });
        try {
          await this.cleanup(row, lease, 'takeover');
          await lease.audit(row, {
            requestId: context.requestId,
            action: 'recover',
            result: 'succeeded',
          });
          return view(row);
        } catch (error) {
          await lease.audit(row, {
            requestId: context.requestId,
            action: 'recover',
            result: 'failed',
            errorCode: safeError(error).code,
          });
          throw error;
        }
      },
    );
  }
  async acquireHold(
    context: RequestContext,
    binding: PersonVmBinding,
    input: Pick<VmHold, 'kind' | 'operationId'>,
    signal: AbortSignal,
  ) {
    return this.leased(context, 'start', signal, async (lease) => {
      const row = this.required(lease.row);
      if (row.phase !== 'running' || !sameVmBinding(bindingOf(row), binding))
        throw new PersonVmError('LEASE_LOST');
      if (
        !input.operationId ||
        !['turn', 'job', 'subtask', 'approval', 'host-operation'].includes(
          input.kind,
        )
      )
        throw new PersonVmError('AUTHORIZATION_DENIED');
      const old = row.holds.find(
        (hold) =>
          hold.kind === input.kind && hold.operationId === input.operationId,
      );
      if (old) return old.id;
      const hold = { id: randomUUID(), ...input };
      row.holds.push(hold);
      row.idleSince = null;
      row.activityObservedAt = null;
      row.lastActivityAt = this.now().toISOString();
      await lease.save(row);
      return hold.id;
    });
  }
  async releaseHold(
    context: RequestContext,
    binding: PersonVmBinding,
    holdId: string,
    signal: AbortSignal,
  ) {
    await this.leased(context, 'start', signal, async (lease) => {
      const row = this.required(lease.row);
      if (!sameVmBinding(bindingOf(row), binding))
        throw new PersonVmError('LEASE_LOST');
      row.holds = row.holds.filter((hold) => hold.id !== holdId);
      row.idleSince = null;
      row.activityObservedAt = null;
      row.lastActivityAt = this.now().toISOString();
      await lease.save(row);
    });
  }
}
