import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmEgressReceipt,
  type PersonVmView,
  type PersonVmHoldKind,
} from './contract.ts';

export type VmHold = {
  id: string;
  kind: PersonVmHoldKind;
  operationId: string;
};
export type VmRecord = {
  vmId: string;
  personId: string;
  organizationId: string;
  phase: PersonVmView['phase'];
  diskTier: 'warm' | 'cold';
  diskRetained: boolean;
  nativeCreated: boolean;
  instanceId: string | null;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  egressReceipt: PersonVmEgressReceipt | null;
  gatewayPorts: number[];
  holds: VmHold[];
  lastActivityAt: string;
  stoppedAt: string | null;
  idleSince: string | null;
  activityObservedAt: string | null;
};
export type VmAudit = {
  requestId: string;
  action: string;
  result: 'started' | 'succeeded' | 'failed' | 'denied';
  errorCode?: string;
};
export interface VmLease {
  row: VmRecord | null;
  save(row: VmRecord): Promise<void>;
  guard(): Promise<void>;
  audit(row: VmRecord, event: VmAudit): Promise<void>;
}
export interface PersonVmStore {
  read(personId: string): Promise<VmRecord | null>;
  withLease<T>(
    personId: string,
    options: { now: () => Date; ttlMs: number },
    work: (lease: VmLease) => Promise<T>,
  ): Promise<T>;
  recover<T>(
    personId: string,
    options: { now: () => Date; ttlMs: number; signal: AbortSignal },
    work: (lease: VmLease) => Promise<T>,
  ): Promise<T>;
}

export type PersonVmLeaseOwner = Readonly<{
  personId: string;
  vmId: string;
  ownerToken: string;
  leaseEpoch: number;
}>;
/** MET-274 extension. Resolve only after old callbacks/commands cannot execute again. */
export interface PersonVmLeaseFencePort {
  confirmSettled(owner: PersonVmLeaseOwner, signal: AbortSignal): Promise<void>;
}

function isConnectionFailure(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code ?? '');
  return (
    code.startsWith('CONNECTION_') ||
    code.startsWith('08') ||
    ['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE'].includes(code) ||
    Boolean(
      error instanceof Error &&
      error.cause &&
      error.cause !== error &&
      isConnectionFailure(error.cause),
    )
  );
}

// A reserved postgres.js connection cannot be used/released after onclose.
// Use the public pool hook; this store requires its own lifecycle pool, not the Web pool.
const poolWatchers = new WeakMap<postgres.Sql, Set<() => void>>();
function watchConnection(sql: postgres.Sql, lost: () => void) {
  let watchers = poolWatchers.get(sql);
  if (!watchers) {
    watchers = new Set();
    poolWatchers.set(sql, watchers);
    const previous = sql.options.onclose;
    sql.options.onclose = (id) => {
      try {
        previous?.(id);
      } finally {
        for (const callback of watchers!) callback();
      }
    };
  }
  watchers.add(lost);
  return () => {
    watchers!.delete(lost);
  };
}
function lostConnection(): never {
  throw Object.assign(new Error('VM_STORE_CONNECTION_LOST'), {
    code: 'CONNECTION_CLOSED',
  });
}

function fromRow(row: Record<string, unknown>): VmRecord {
  const date = (value: unknown) => new Date(value as string).toISOString();
  return {
    vmId: String(row.vm_id),
    personId: String(row.person_id),
    organizationId: String(row.organization_id),
    phase: row.phase as VmRecord['phase'],
    diskTier: row.disk_tier as VmRecord['diskTier'],
    diskRetained: Boolean(row.disk_retained),
    nativeCreated: Boolean(row.native_created),
    instanceId: row.instance_id === null ? null : String(row.instance_id),
    leaseEpoch: Number(row.lease_epoch),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : date(row.lease_expires_at),
    egressReceipt: row.egress_receipt as VmRecord['egressReceipt'],
    gatewayPorts: row.gateway_ports as number[],
    holds: row.holds as VmHold[],
    lastActivityAt: date(row.last_activity_at),
    stoppedAt: row.stopped_at === null ? null : date(row.stopped_at),
    idleSince: row.idle_since === null ? null : date(row.idle_since),
    activityObservedAt:
      row.activity_observed_at === null ? null : date(row.activity_observed_at),
  };
}
export function bindingOf(row: VmRecord): PersonVmBinding {
  if (!row.instanceId) throw new PersonVmError('LEASE_LOST');
  return Object.freeze({
    vmId: row.vmId,
    personId: row.personId,
    organizationId: row.organizationId,
    instanceId: row.instanceId,
    leaseEpoch: row.leaseEpoch,
  });
}

export class PostgresPersonVmStore implements PersonVmStore {
  private readonly settledOrphans = new Map<string, string>();
  constructor(
    private readonly sql: postgres.Sql,
    private readonly fence?: PersonVmLeaseFencePort,
  ) {}
  async read(personId: string) {
    const [row] = await this
      .sql`select * from person_virtual_machines where person_id=${personId}`;
    return row ? fromRow(row) : null;
  }
  async withLease<T>(
    personId: string,
    options: { now: () => Date; ttlMs: number },
    work: (lease: VmLease) => Promise<T>,
  ) {
    const sql = await this.sql.reserve();
    let connectionLost = false;
    const unwatch = watchConnection(this.sql, () => {
      connectionLost = true;
    });
    const connected = () => {
      if (connectionLost) lostConnection();
    };
    const token = randomUUID();
    let locked = false;
    let failedConnection = false;
    let bodyError: unknown;
    let result!: T;
    const expires = () =>
      new Date(options.now().getTime() + options.ttlMs).toISOString();
    try {
      const [lock] =
        await sql`select pg_try_advisory_lock(hashtextextended(${'person-vm:' + personId},0)) as locked`;
      if (!lock?.locked) throw new PersonVmError('LEASE_CONFLICT');
      locked = true;
      const [stored] =
        await sql`select * from person_virtual_machines where person_id=${personId}`;
      const row = stored ? fromRow(stored) : null;
      // Expiry is NOT proof the previous owner/operation is fenced. Never steal on TTL alone.
      if (row?.leaseOwner) throw new PersonVmError('LEASE_CONFLICT');
      if (row)
        await sql`update person_virtual_machines set lease_owner=${token},lease_expires_at=${expires()} where person_id=${personId}`;
      const guard = async () => {
        connected();
        const [current] =
          await sql`update person_virtual_machines set lease_expires_at=${expires()}
          where person_id=${personId} and lease_owner=${token} returning vm_id`;
        if (!current) throw new PersonVmError('LEASE_LOST');
      };
      const lease: VmLease = {
        row,
        guard,
        save: async (record) => {
          connected();
          if (record.personId !== personId)
            throw new PersonVmError('LEASE_LOST');
          const values = {
            person_id: record.personId,
            vm_id: record.vmId,
            organization_id: record.organizationId,
            phase: record.phase,
            disk_tier: record.diskTier,
            disk_retained: record.diskRetained,
            native_created: record.nativeCreated,
            instance_id: record.instanceId,
            lease_epoch: record.leaseEpoch,
            lease_owner: token,
            lease_expires_at: expires(),
            egress_receipt: record.egressReceipt
              ? sql.json(record.egressReceipt as postgres.JSONValue)
              : null,
            gateway_ports: sql.json(record.gatewayPorts),
            holds: sql.json(record.holds),
            last_activity_at: record.lastActivityAt,
            stopped_at: record.stoppedAt,
            idle_since: record.idleSince,
            activity_observed_at: record.activityObservedAt,
          };
          const rows =
            await sql`insert into person_virtual_machines ${sql(values)}
            on conflict (person_id) do update set
              vm_id=excluded.vm_id,phase=excluded.phase,disk_tier=excluded.disk_tier,disk_retained=excluded.disk_retained,
              native_created=excluded.native_created,instance_id=excluded.instance_id,lease_epoch=excluded.lease_epoch,
              egress_receipt=excluded.egress_receipt,gateway_ports=excluded.gateway_ports,holds=excluded.holds,
              last_activity_at=excluded.last_activity_at,stopped_at=excluded.stopped_at,idle_since=excluded.idle_since,
              activity_observed_at=excluded.activity_observed_at,lease_expires_at=excluded.lease_expires_at,updated_at=now()
            where person_virtual_machines.lease_owner=${token} returning vm_id`;
          if (rows.length !== 1) throw new PersonVmError('LEASE_LOST');
        },
        audit: async (record, event) => {
          connected();
          await sql`insert into person_vm_audit(vm_id,person_id,organization_id,request_id,action,result,error_code,lease_epoch)
            values(${record.vmId},${record.personId},${record.organizationId},${event.requestId},${event.action},${event.result},${event.errorCode ?? null},${record.leaseEpoch})`;
        },
      };
      result = await work(lease);
    } catch (error) {
      bodyError = error;
      failedConnection = isConnectionFailure(error);
    } finally {
      if (locked) {
        try {
          // A broken connection leaves a durable orphan lease for explicit fenced recovery.
          if (!failedConnection && !connectionLost)
            await sql`update person_virtual_machines set lease_owner=null,lease_expires_at=null where person_id=${personId} and lease_owner=${token}`;
          if (!failedConnection && !connectionLost)
            await sql`select pg_advisory_unlock(hashtextextended(${'person-vm:' + personId},0))`;
        } catch (error) {
          failedConnection = true;
          bodyError ??= error;
        } finally {
          // work() has settled, including the provider's joined child promises.
          if (failedConnection || connectionLost)
            this.settledOrphans.set(personId, token);
          if (connectionLost && !bodyError)
            bodyError = Object.assign(new Error('VM_STORE_CONNECTION_LOST'), {
              code: 'CONNECTION_CLOSED',
            });
          unwatch();
          if (!failedConnection && !connectionLost) sql.release();
        }
      } else {
        unwatch();
        if (!failedConnection && !connectionLost) sql.release();
      }
    }
    if (bodyError) throw bodyError;
    return result;
  }
  async recover<T>(
    personId: string,
    options: { now: () => Date; ttlMs: number; signal: AbortSignal },
    work: (lease: VmLease) => Promise<T>,
  ) {
    options.signal.throwIfAborted();
    const sql = await this.sql.reserve();
    let connectionLost = false;
    const unwatch = watchConnection(this.sql, () => {
      connectionLost = true;
    });
    const connected = () => {
      if (connectionLost) lostConnection();
    };
    let locked = false;
    let broken = false;
    try {
      const [lock] =
        await sql`select pg_try_advisory_lock(hashtextextended(${'person-vm:' + personId},0)) as locked`;
      if (!lock?.locked) throw new PersonVmError('LEASE_CONFLICT');
      locked = true;
      const [stored] =
        await sql`select * from person_virtual_machines where person_id=${personId}`;
      if (!stored) throw new PersonVmError('NOT_FOUND');
      const row = fromRow(stored);
      const token = row.leaseOwner;
      if (
        !token ||
        !row.leaseExpiresAt ||
        Date.parse(row.leaseExpiresAt) > options.now().getTime()
      )
        throw new PersonVmError('LEASE_CONFLICT');
      if (this.settledOrphans.get(personId) !== token) {
        if (!this.fence) throw new PersonVmError('LEASE_CONFLICT');
        await this.fence.confirmSettled(
          {
            personId,
            vmId: row.vmId,
            ownerToken: token,
            leaseEpoch: row.leaseEpoch,
          },
          options.signal,
        );
      }
      const guard = async () => {
        connected();
        const [found] =
          await sql`update person_virtual_machines set lease_expires_at=${new Date(options.now().getTime() + options.ttlMs)} where person_id=${personId} and lease_owner=${token} returning vm_id`;
        if (!found) throw new PersonVmError('LEASE_LOST');
      };
      const result = await work({
        row,
        guard,
        save: async (value) => {
          connected();
          if (
            value.vmId !== row.vmId ||
            value.personId !== personId ||
            value.leaseEpoch !== row.leaseEpoch
          )
            throw new PersonVmError('LEASE_LOST');
          const [found] =
            await sql`update person_virtual_machines set phase=${value.phase},native_created=${value.nativeCreated},stopped_at=${value.stoppedAt},egress_receipt=${value.egressReceipt ? sql.json(value.egressReceipt as postgres.JSONValue) : null},updated_at=now()
            where person_id=${personId} and lease_owner=${token} and lease_epoch=${row.leaseEpoch} returning vm_id`;
          if (!found) throw new PersonVmError('LEASE_LOST');
        },
        audit: async (value, event) => {
          connected();
          await sql`insert into person_vm_audit(vm_id,person_id,organization_id,request_id,action,result,error_code,lease_epoch)
            values(${value.vmId},${value.personId},${value.organizationId},${event.requestId},${event.action},${event.result},${event.errorCode ?? null},${value.leaseEpoch})`;
        },
      });
      connected();
      const [released] =
        await sql`update person_virtual_machines set lease_owner=null,lease_expires_at=null where person_id=${personId} and lease_owner=${token} returning vm_id`;
      if (!released) throw new PersonVmError('LEASE_LOST');
      this.settledOrphans.delete(personId);
      return result;
    } catch (error) {
      broken = isConnectionFailure(error);
      throw error;
    } finally {
      try {
        if (locked && !connectionLost && !broken)
          await sql`select pg_advisory_unlock(hashtextextended(${'person-vm:' + personId},0))`;
      } finally {
        unwatch();
        if (!connectionLost && !broken) sql.release();
      }
    }
  }
}
