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
  type PersonVmAction,
  type PersonVmAdmissionBindingPort,
  type PersonVmActivity,
  type PersonVmAuthority,
  type PersonVmBinding,
  type PersonVmEgressPort,
  type PersonVmEgressReceipt,
  type PersonVmHostPort,
  type PersonVmRuntimePort,
  type PersonVmView,
} from './contract.ts';
import { PersonVmAdmissionHost } from './admission-host.ts';
import {
  checkAdmissionBinding,
  PostgresPersonVmAdmissionStore,
} from './admission-store.ts';
import type { PersonVmNativeActivityPort } from './admission-contract.ts';
import type { PersonVmSqlFactory } from './store.ts';
import type { PersonVmDiskPort } from './encrypted-disk.ts';
import type { PersonVmNativePort } from './microsandbox.ts';
import { bootstrapPersonVm } from './guest-bootstrap.ts';
import {
  checkedWebRoster,
  type PersonVmWebRosterPort,
  type PersonVmWebStartup,
} from './web-endpoints.ts';
import {
  bindingOf,
  PostgresPersonVmStore,
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

export class PersonVmService
  implements PersonVmHostPort, PersonVmAdmissionBindingPort
{
  private admissionHost?: PersonVmAdmissionHost;
  private admissionShared?: PostgresPersonVmAdmissionStore;
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
      nativeWeb?: PersonVmWebRosterPort;
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
  /** Trusted production composition. Reuses this service's actual authority,
   * providers and physical store; the callbacks below never reacquire a lock. */
  createAdmissionHost(input: {
    openSql: PersonVmSqlFactory;
    nativeActivity?: PersonVmNativeActivityPort;
    monotonic?: () => number;
  }) {
    if (this.admissionHost) throw new PersonVmError('LEASE_CONFLICT');
    if (!(this.options.store instanceof PostgresPersonVmStore))
      throw new PersonVmError('PROVIDER_FAILED');
    this.options.store.assertAdmissionFactory(input.openSql);
    const shared = new PostgresPersonVmAdmissionStore(input.openSql);
    const host = new PersonVmAdmissionHost({
      ...input,
      shared,
      store: this.options.store,
      authority: this.options.authority,
      leaseTtlMs: this.options.leaseTtlMs,
      now: this.now,
      startOwned: async (context, lease, signal) => {
        await this.identity(context, 'start', signal);
        if (!lease.row) throw new PersonVmError('NOT_FOUND');
        this.checkOrganization(lease.row, context.organizationId);
        await this.inLeaseFrame(context, lease.row.personId, lease, () =>
          this.startOwned(context, lease, signal),
        );
        return bindingOf(lease.row);
      },
      assertStopSafe: async (lease, signal) => {
        const row = this.required(lease.row);
        if (row.holds.length) throw new PersonVmError('VM_ACTIVE');
        const status = await this.options.native.status(bindingOf(row), signal);
        // No public autonomous native-admission fence has been wired. Even
        // complete-looking fixture projections cannot permit a running stop.
        if (status !== 'stopped' && status !== 'absent')
          throw new PersonVmError('ACTIVITY_UNKNOWN');
      },
      stopOwned: async (context, lease, signal) => {
        await this.identity(context, 'stop', signal);
        return this.inLeaseFrame(context, context.actor.id, lease, () =>
          this.stopOwned(context, lease, signal, true),
        );
      },
    });
    // Publish together only after factory validation and host construction. This
    // is the SAME authority, never a replacement or another caller's factory.
    this.admissionShared = shared;
    return (this.admissionHost = host);
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
      signal: AbortSignal,
    ) => Promise<T>,
    allowClosed = false,
  ) {
    const identity = await this.identity(context, action, signal);
    return this.options.store.withLease(
      identity.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs },
      async (lease) => {
        if (!allowClosed) await lease.assertAdmissionOpen();
        const current = AbortSignal.any([signal, lease.signal]);
        current.throwIfAborted();
        if (lease.row)
          this.checkOrganization(lease.row, identity.organizationId);
        const operation = (ownedSignal: AbortSignal) =>
          this.inLeaseFrame(context, identity.personId, lease, () =>
            work(lease, identity, ownedSignal),
          );
        return this.admissionHost
          ? this.admissionHost.trackOwner(identity.personId, current, operation)
          : operation(current);
      },
    );
  }
  private inLeaseFrame<T>(
    context: RequestContext,
    personId: string,
    lease: VmLease,
    work: () => Promise<T>,
  ) {
    const frame = {
      active: true,
      requestId: context.requestId,
      personId,
      lease,
    };
    return this.currentLease.run(frame, async () => {
      try {
        return await work();
      } finally {
        frame.active = false;
      }
    });
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
    return this.leased(
      context,
      'create',
      signal,
      async (lease, identity, signal) => {
        const retry =
          lease.row &&
          !lease.row.instanceId &&
          !lease.row.nativeCreated &&
          lease.row.diskRetained &&
          (lease.row.phase === 'failed' || lease.row.phase === 'starting');
        if (lease.row && lease.row.phase !== 'deleted' && !retry)
          return view(lease.row);
        if (lease.row?.diskRetained && !retry) {
          lease.row.phase = lease.row.diskTier === 'cold' ? 'cold' : 'stopped';
          await lease.save(lease.row);
          await lease.audit(lease.row, {
            requestId: context.requestId,
            action: 'create-retained',
            result: 'succeeded',
          });
          return view(lease.row);
        }
        const row: VmRecord = retry
          ? lease.row!
          : {
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
        row.phase = 'starting';
        await lease.save(row); // Persist ownership before creating disk/key side effects.
        await lease.audit(row, {
          requestId: context.requestId,
          action: 'create',
          result: 'started',
        });
        try {
          signal.throwIfAborted();
          await lease.guard();
          let inspected = await this.options.disk.inspect(row.vmId, signal);
          if (inspected.state === 'unknown')
            throw new PersonVmError('PROVIDER_FAILED');
          if (inspected.state === 'absent') {
            await this.options.disk.create(
              { vmId: row.vmId, tier: row.diskTier },
              signal,
            );
            inspected = await this.options.disk.inspect(row.vmId, signal);
          }
          if (inspected.state !== 'ready')
            throw new PersonVmError('PROVIDER_FAILED');
          row.diskTier = inspected.disk.tier;
          row.phase = row.diskTier === 'cold' ? 'cold' : 'stopped';
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
      },
    );
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
  private async reconcileDisk(
    row: VmRecord,
    signal: AbortSignal,
    lease: VmLease,
  ) {
    const inspected = await this.options.disk.inspect(row.vmId, signal);
    if (inspected.state !== 'ready') {
      if (
        inspected.state !== 'absent' ||
        row.instanceId ||
        row.nativeCreated ||
        (row.phase !== 'starting' && row.phase !== 'failed')
      )
        throw new PersonVmError('PROVIDER_FAILED');
      return { state: 'absent' } as const;
    }
    if (row.diskTier !== inspected.disk.tier) {
      row.diskTier = inspected.disk.tier;
      if (row.phase === 'cold' || row.phase === 'stopped')
        row.phase = row.diskTier === 'cold' ? 'cold' : 'stopped';
      await lease.save(row);
    }
    return inspected;
  }
  private async mounted(row: VmRecord, signal: AbortSignal, lease: VmLease) {
    if ((await this.reconcileDisk(row, signal, lease)).state !== 'ready')
      throw new PersonVmError('PROVIDER_FAILED');
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
    return this.leased(context, 'start', signal, (lease, _identity, current) =>
      this.startOwned(context, lease, current),
    );
  }
  private async webRoster(context: RequestContext, signal: AbortSignal) {
    if (!this.options.nativeWeb) return undefined;
    try {
      signal.throwIfAborted();
      const roster = checkedWebRoster(
        await this.options.nativeWeb.prepare(context, signal),
      );
      signal.throwIfAborted();
      return roster;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        [
          'authentication_required',
          'authorization_denied',
          'tenant_context_invalid',
        ].includes(String(error.code))
      )
        throw new PersonVmError('AUTHORIZATION_DENIED', { cause: error });
      throw safeError(error);
    }
  }
  private async startOwned(
    context: RequestContext,
    lease: VmLease,
    signal: AbortSignal,
  ) {
    const row = this.required(lease.row);
    if (!this.options.egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
    if (!this.options.runtime) throw new PersonVmError('RUNTIME_NOT_READY');
    if (
      typeof this.options.runtime.memoryGuestPlan !== 'function' ||
      typeof this.options.native.bootstrap !== 'function'
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
    if (
      this.options.nativeWeb &&
      (!this.options.native.prepareWebEndpoints ||
        !this.options.native.assertWebEndpoints ||
        !this.options.runtime.retireAfterNativeStop)
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
    const roster = await this.webRoster(context, signal);
    if (
      roster &&
      (roster.personId !== row.personId ||
        roster.organizationId !== row.organizationId)
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    if (row.phase === 'running') {
      await this.mounted(row, signal, lease);
      if (roster) {
        await lease.guard();
        await this.options.native.prepareWebEndpoints!(
          bindingOf(row),
          roster,
          signal,
        );
        await lease.guard();
      }
      await this.ready(row, signal);
      if (
        roster &&
        (await this.webRoster(context, signal))?.digest !== roster.digest
      )
        throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
      return view(row, true);
    }
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    if (
      row.phase === 'failed' ||
      row.phase === 'starting' ||
      row.egressReceipt
    ) {
      if ((await this.takeoverSafe(row, signal, lease)).state !== 'ready')
        throw new PersonVmError('PROVIDER_FAILED');
      await this.cleanup(row, lease, 'takeover');
    }
    await lease.assertAdmissionOpen(true);
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
      await this.mounted(row, signal, lease);
      await lease.guard();
      await this.options.egress.assertActive(receipt, signal);
      let web: PersonVmWebStartup | undefined;
      if (roster) {
        const endpoints = await this.options.native.prepareWebEndpoints!(
          binding,
          roster,
          signal,
        );
        if (
          !sameVmBinding(endpoints.binding, binding) ||
          endpoints.rosterDigest !== roster.digest
        )
          throw new PersonVmError('LEASE_LOST');
        checkedWebRoster({
          ...roster,
          entries: endpoints.endpoints,
          digest: endpoints.rosterDigest,
        });
        for (const key of ['hostPort', 'guestPort'] as const) {
          if (
            new Set(endpoints.endpoints.map((entry) => entry[key])).size !==
              endpoints.endpoints.length ||
            endpoints.endpoints.some(
              (entry) =>
                !Number.isInteger(entry[key]) ||
                entry[key] < 1 ||
                entry[key] > 65535,
            )
          )
            throw new PersonVmError('PROVIDER_FAILED');
        }
        web = Object.freeze({ context, receipt: endpoints });
        await lease.guard();
      }
      const state = await this.options.native.status(binding, signal);
      if (state === 'absent' && !row.nativeCreated) {
        if (web)
          await this.options.native.create(
            binding,
            receipt,
            signal,
            web.receipt,
          );
        else await this.options.native.create(binding, receipt, signal);
        row.nativeCreated = true;
        await lease.save(row);
      } else if (state === 'stopped' && row.nativeCreated)
        await this.options.native.start(binding, signal);
      else throw new PersonVmError('PROVIDER_FAILED');
      if (web)
        await this.options.native.assertWebEndpoints!(web.receipt, signal);
      await lease.guard();
      const frame = this.currentLease.getStore();
      const assertStarting = async () => {
        if (!frame?.active || frame.lease !== lease)
          throw new PersonVmError('LEASE_LOST');
        await lease.guard();
        const identity = await this.identity(context, 'start', signal);
        if (
          identity.personId !== binding.personId ||
          identity.organizationId !== binding.organizationId
        )
          throw new PersonVmError('AUTHORIZATION_DENIED');
        if (row.phase !== 'starting' || !sameVmBinding(bindingOf(row), binding))
          throw new PersonVmError('LEASE_LOST');
        await lease.assertAdmissionOpen(true);
        await this.options.egress!.assertActive(receipt, signal);
        if (roster) {
          const current = (await this.webRoster(context, signal))!;
          if (
            current.personId !== binding.personId ||
            current.organizationId !== binding.organizationId ||
            current.digest !== roster.digest
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
        }
        await lease.guard();
      };
      await bootstrapPersonVm({
        binding,
        signal,
        native: this.options.native,
        runtime: this.options.runtime,
        assertCurrent: assertStarting,
        web,
      });
      await assertStarting();
      await this.ready(row, signal);
      await assertStarting();
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
  private async takeoverSafe(
    row: VmRecord,
    signal: AbortSignal,
    lease: VmLease,
  ) {
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    const inspected = await this.reconcileDisk(row, signal, lease);
    if (!row.instanceId) {
      if (row.nativeCreated) throw new PersonVmError('PROVIDER_FAILED');
      return inspected;
    }
    await this.mounted(row, signal, lease);
    const state = await this.options.native.status(bindingOf(row), signal);
    if (state === 'unknown') throw new PersonVmError('ACTIVITY_UNKNOWN');
    if (state === 'running') {
      await this.inactive(row, signal);
      // Instantaneous zero counts neither cover the intervening window nor
      // freeze native admission. No public VM-wide primitive is wired yet.
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }
    return inspected;
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
        await this.mounted(row, signal, lease);
        const binding = bindingOf(row);
        await this.options.native.stop(binding, signal);
        const state = await this.options.native.status(binding, signal);
        stopped = state === 'stopped' || state === 'absent';
        if (state === 'stopped') row.nativeCreated = true; // Native create may have committed before a failed host save/ack.
      } else {
        const inspected = await this.reconcileDisk(row, signal, lease);
        stopped = !row.nativeCreated && inspected.state === 'ready';
      }
    } catch {
      failed = true;
    }
    if (stopped) {
      row.stoppedAt ??= this.now().toISOString();
      try {
        if (row.instanceId) {
          if (
            this.options.nativeWeb &&
            !this.options.runtime?.retireAfterNativeStop
          )
            throw new PersonVmError('RUNTIME_NOT_READY');
          await this.options.runtime?.retireAfterNativeStop?.(
            bindingOf(row),
            AbortSignal.timeout(this.options.cleanupTimeoutMs),
          );
        }
        // A confirmed VM stop does not prove its host runtime I/O has joined.
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
    return this.leased(context, 'stop', signal, (lease, _identity, current) =>
      this.stopOwned(context, lease, current),
    );
  }
  private async stopOwned(
    context: RequestContext,
    lease: VmLease,
    signal: AbortSignal,
    admissionOwned = false,
  ) {
    if (!admissionOwned) await lease.assertAdmissionOpen(true);
    const row = this.required(lease.row);
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    if (row.phase === 'running' || row.phase === 'failed')
      await this.takeoverSafe(row, signal, lease);
    if (row.phase === 'starting') throw new PersonVmError('ACTIVITY_UNKNOWN');
    if ((row.phase === 'cold' || row.phase === 'stopped') && !row.egressReceipt)
      return view(row);
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
  }
  async delete(
    context: RequestContext,
    input: { deleteDisk?: boolean },
    signal: AbortSignal,
  ) {
    if (input.deleteDisk !== undefined && typeof input.deleteDisk !== 'boolean')
      throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED');
    return this.leased(
      context,
      'delete',
      signal,
      async (lease, _identity, signal) => {
        await lease.assertAdmissionOpen(true);
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
        if (row.phase === 'running')
          await this.takeoverSafe(row, signal, lease);
        if (row.holds.length > 0 || row.phase === 'starting')
          throw new PersonVmError('VM_ACTIVE');
        if (row.diskRetained) await this.reconcileDisk(row, signal, lease);
        const action = input.deleteDisk ? 'delete-disk' : 'delete';
        await lease.audit(row, {
          requestId: context.requestId,
          action,
          result: 'started',
        });
        try {
          if (row.instanceId && row.diskRetained) {
            if (row.phase !== 'running')
              await this.takeoverSafe(row, signal, lease);
            await this.cleanup(row, lease, 'delete');
          }
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
      },
    );
  }
  /** Scheduler calls with a current trusted identity. No Agent/task scheduler is added. */
  async reconcileIdle(context: RequestContext, signal: AbortSignal) {
    if (this.admissionHost) {
      const identity = await this.identity(context, 'stop', signal);
      const row = this.required(
        await this.options.store.read(identity.personId),
      );
      this.checkOrganization(row, identity.organizationId);
      if (row.phase === 'running') {
        await this.admissionHost.reconcileIdle(context, bindingOf(row), signal);
        return view(
          this.required(await this.options.store.read(identity.personId)),
        );
      }
    }
    return this.leased(
      context,
      'stop',
      signal,
      async (lease, _identity, signal) => {
        const row = this.required(lease.row);
        if (row.phase === 'starting' || row.phase === 'failed')
          return view(row);
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
          // Polling 0 cannot prove a continuous idle interval or freeze a job
          // beginning after this read. Automatic running-VM reclamation remains
          // disabled until a real native window/admission guarantee is available.
          row.idleSince = null;
          row.activityObservedAt = snapshot.observedAt;
          await lease.save(row);
          return view(row);
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
      },
    );
  }
  async assertAdmissionBinding(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const identity = await this.identity(context, 'read', signal);
    if (
      context.actor.type !== 'user' ||
      identity.personId !== binding.personId ||
      identity.organizationId !== binding.organizationId
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    const shared = this.admissionShared;
    if (!this.admissionHost || !shared)
      throw new PersonVmError('RUNTIME_NOT_READY');
    const egress = this.options.egress;
    if (!egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
    const receipt = await shared.transaction(
      identity.personId,
      signal,
      async (tx) => {
        checkAdmissionBinding(tx, binding);
        if (tx.row.disk_retained !== true) throw new PersonVmError('NOT_FOUND');
        if (!tx.row.egress_receipt)
          throw new PersonVmError('EGRESS_UNAVAILABLE');
        return this.receipt(
          binding,
          tx.row.egress_receipt as PersonVmEgressReceipt,
        );
      },
    );
    // No physical lease/running assertion: admit/activate/wake retain those
    // responsibilities. Do not hold a PG row lock while checking local egress.
    await egress.assertActive(receipt, signal);
    signal.throwIfAborted();
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
        const current = AbortSignal.any([signal, lease.signal]);
        await lease.assertAdmissionOpen(true);
        const row = this.required(lease.row);
        this.checkOrganization(row, identity.organizationId);
        return this.inLeaseFrame(
          context,
          identity.personId,
          lease,
          async () => {
            const inspected = await this.takeoverSafe(row, current, lease);
            await lease.audit(row, {
              requestId: context.requestId,
              action: 'recover',
              result: 'started',
            });
            if (inspected.state === 'absent') {
              // Ownership is recovered, but an initial creation without image
              // bytes is not a stopped/ready disk. Keep the retryable phase.
              row.phase = 'failed';
              row.stoppedAt = null;
              await lease.save(row);
              await lease.audit(row, {
                requestId: context.requestId,
                action: 'recover-create-retry',
                result: 'succeeded',
              });
              return view(row);
            }
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
    await this.leased(
      context,
      'start',
      signal,
      async (lease) => {
        const row = this.required(lease.row);
        if (!sameVmBinding(bindingOf(row), binding))
          throw new PersonVmError('LEASE_LOST');
        row.holds = row.holds.filter((hold) => hold.id !== holdId);
        row.idleSince = null;
        row.activityObservedAt = null;
        row.lastActivityAt = this.now().toISOString();
        await lease.save(row);
      },
      true,
    );
  }
}
