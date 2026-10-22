import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createNativeCalendarGeneration,
  type NativeCalendarWorkerPorts,
} from './native-schedule-calendar.ts';
import type { NativeScheduleControlHost } from './native-schedule-once.ts';
import type {
  NativeCalendarArm,
  NativeCalendarControl,
  NativeCalendarPeriod,
} from '@allrice/database';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (v: unknown): string =>
  'sha256:' + createHash('sha256').update(JSON.stringify(v)).digest('hex');
const reference = {
  artifactId: hash('artifact'),
  profileId: 'allrice-recurring-control-v1' as const,
  storageId: 'unit',
  stateRoot: '/isolated/unit',
};
function fixture() {
  const c: NativeCalendarControl = {
    kind: 'calendar',
    binding: 'rotating-at-v1',
    partitionId: 'allrice-recurring-v1',
    controlId: id(1),
    organizationId: id(2),
    workspaceId: id(3),
    ownerId: id(4),
    automationId: id(5),
    revision: 1,
    controlSessionId: 'stable-calendar-session',
    reference,
    sessionState: 'ready',
    nativeTaskId: null,
    dispatch: {
      consumer: 'experience-consolidation-v1',
      employeeAssignmentId: id(6),
      employeeInstanceId: id(7),
    },
  };
  const at = new Date(Date.now() + 60_000).toISOString();
  function binding(n: number) {
    const target = new Date(Date.parse(at) + (n - 20) * 60_000).toISOString();
    const period: NativeCalendarPeriod = {
      periodId: id(n),
      partitionId: 'allrice-recurring-v1',
      controlId: c.controlId,
      automationId: c.automationId,
      revision: 1,
      businessScheduledFor: target,
      currentArmId: id(n + 1),
      state: 'prepared',
      version: 0,
    };
    const arm: NativeCalendarArm = {
      armId: id(n + 1),
      periodId: period.periodId,
      attempt: 1,
      nativeAt: target,
      reason: 'business_target',
      requestDigest: hash(n),
      status: 'prepared',
      nativeTaskId: null,
      taskSnapshot: null,
      bindWriteId: null,
      lastWriteId: null,
      createWriter: null,
      absenceProof: null,
      snapshotVersion: 0,
    };
    return {
      period,
      arm,
      closed: false,
      retirement: null as null | { retirementId: string; recordDigest: string },
    };
  }
  const first = binding(20),
    bindings = [first],
    retired = new Set<string>(),
    archive = new Map<string, unknown>();
  const trace: string[] = [],
    records: Record<string, unknown> = {};
  const writer = {
    partitionId: 'allrice-recurring-v1',
    ownerId: 'unit-writer',
    epoch: 1,
    token: 'unit-token',
  };
  let loseBegin = false,
    loseCreate = false,
    loseDelete = false,
    activeOnlyCatalog = false;
  const find = (armId: string) => bindings.find((b) => b.arm.armId === armId)!;
  const ports = {
    materialize: vi.fn(async () => false),
    loadCalendarState: vi.fn(async () =>
      structuredClone({
        controls: [{ control: c, version: 2 }],
        bindings: bindings.filter((b) => !retired.has(b.arm.armId)),
      }),
    ),
    beginCalendarArmCreate: vi.fn(async (_w, input) => {
      const b = find(input.armId);
      trace.push('begin:' + b.period.periodId);
      b.arm.status = 'creating';
      b.arm.snapshotVersion++;
      b.arm.createWriter = {
        partitionId: writer.partitionId,
        ownerId: writer.ownerId,
        epoch: writer.epoch,
        tokenDigest: hash(writer.token),
      };
      if (loseBegin) {
        loseBegin = false;
        throw Error('begin ACK lost');
      }
      return structuredClone({
        outcome: 'create_authorized' as const,
        period: b.period,
        arm: b.arm,
      });
    }),
    confirmCalendarArmAbsent: vi.fn(async (_w, input) => {
      const b = find(input.armId);
      trace.push('absent:' + b.period.periodId);
      if (
        b.arm.status === 'creating' &&
        writer.epoch <= b.arm.createWriter!.epoch
      )
        throw Error('generation not fenced');
      b.arm.status = 'absent';
      b.arm.snapshotVersion++;
      b.arm.absenceProof = {
        kind: 'never_started',
        taskSetDigest: hash(records),
      };
      b.period.state = 'recovery_required';
      b.period.version++;
      return structuredClone({ period: b.period, arm: b.arm });
    }),
    prepareCalendarArm: vi.fn(async (_w, input) => {
      const b = find(input.previousArmId);
      trace.push('recover:' + b.period.periodId);
      b.arm = {
        ...b.arm,
        armId: input.armId,
        nativeAt: input.nativeAt,
        status: 'prepared',
        attempt: b.arm.attempt + 1,
        reason: 'future_recovery',
        absenceProof: null,
        createWriter: null,
        snapshotVersion: 0,
      };
      b.period = {
        ...b.period,
        currentArmId: b.arm.armId,
        state: 'prepared',
        version: b.period.version + 1,
      };
      return structuredClone({ period: b.period, arm: b.arm });
    }),
    readExactCalendarArm: vi.fn(async (armId) => {
      const b = find(armId);
      return structuredClone(
        b.arm.nativeTaskId
          ? {
              state: 'bound',
              period: b.period,
              arm: b.arm,
              fullTask: b.arm.taskSnapshot,
            }
          : {
              state: 'absent',
              period: b.period,
              arm: b.arm,
              generationFence: {
                canCreate: false,
                currentEpoch: writer.epoch,
                closed: false,
                createWriter: b.arm.createWriter,
                absenceProved: !!b.arm.absenceProof,
              },
            },
      );
    }),
    readExactCalendarRetirement: vi.fn(async (retirementId) =>
      bindings.some(
        (b) =>
          b.retirement?.retirementId === retirementId &&
          retired.has(b.arm.armId),
      )
        ? 'committed'
        : 'absent',
    ),
  } as unknown as NativeCalendarWorkerPorts;
  let driver: ReturnType<typeof createNativeCalendarGeneration>;
  const host = {
    decodeTask: (v: unknown) => structuredClone(v),
    catalog: vi.fn(async () =>
      Object.values(records)
        .map((raw) => {
          const t = raw as {
            record: Record<string, unknown>;
            sessionId: string;
            status: string;
            lastDelivery?: unknown;
          };
          return {
            ...t.record,
            sessionId: t.sessionId,
            status: t.status,
            ...(t.lastDelivery ? { lastDelivery: t.lastDelivery } : {}),
          };
        })
        .filter((row) => !activeOnlyCatalog || row.status === 'active'),
    ),
    createOnce: vi.fn(async (sessionId: string, nativeAt: string) => {
      trace.push('create');
      const record = {
        id: 'native-' + host.createOnce.mock.calls.length,
        kind: 'at',
        title: 'AllRice once control',
        prompt: 'Synthetic schedule control only. Never execute business work.',
        scheduledAt: nativeAt,
      };
      const value = { sessionId, status: 'active', record };
      const prepared = driver.putMutation(record.id, value as never),
        b = find(prepared.binding.arm.armId);
      b.arm.status = 'bound';
      b.arm.nativeTaskId = record.id;
      b.arm.taskSnapshot = value;
      b.arm.snapshotVersion++;
      b.arm.bindWriteId = 'bind-' + record.id;
      b.arm.lastWriteId = b.arm.bindWriteId;
      b.period.state = 'bound';
      b.period.version++;
      records[record.id] = structuredClone(value);
      driver.acceptedPut(prepared.binding, value as never);
      if (loseCreate) {
        loseCreate = false;
        throw Error('create ACK lost');
      }
      return record;
    }),
    deleteOnce: vi.fn(async (_session: string, taskId: string) => {
      trace.push('delete');
      const prepared = driver.retireMutation(taskId),
        b = find(prepared.binding.arm.armId);
      archive.set(taskId, structuredClone(b.arm.taskSnapshot));
      retired.add(b.arm.armId);
      delete records[taskId];
      driver.acceptedRetirement(prepared.binding);
      if (loseDelete) {
        loseDelete = false;
        throw Error('delete ACK lost');
      }
    }),
  };
  const make = () =>
    (driver = createNativeCalendarGeneration({
      ports,
      writer,
      host: () => host as unknown as NativeScheduleControlHost,
      fence: async () => {},
      track: async (p) => p,
      mutate: async () => {},
      loadTaskRecords: async () => structuredClone(records),
      digest: hash,
    }));
  make();
  return {
    c,
    first,
    bindings,
    binding,
    ports,
    host,
    writer,
    records,
    archive,
    trace,
    driver: () => driver,
    make,
    loseBegin: () => {
      loseBegin = true;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    loseDelete: () => {
      loseDelete = true;
    },
    activeOnlyCatalog: () => {
      activeOnlyCatalog = true;
    },
    closeFirst: () => {
      first.closed = true;
      first.retirement = {
        retirementId: id(90),
        recordDigest: hash(
          (first.arm.taskSnapshot as { record: unknown }).record,
        ),
      };
    },
  };
}
describe('calendar generation driver with scripted SQL ports; no actual Host or SQL', () => {
  it('calls public create once and adopts the exact persisted native identity', async () => {
    const f = fixture();
    await f.driver().tick();
    await f.driver().tick();
    expect(f.host.createOnce).toHaveBeenCalledTimes(1);
    expect(f.first.arm.nativeTaskId).toBe('native-1');
    expect(f.host.createOnce.mock.calls[0]![0]).toBe(f.c.controlSessionId);
  });
  it('retires a completed Task through the public facade, retaining history before creating N', async () => {
    const f = fixture();
    await f.driver().tick();
    f.closeFirst();
    const next = f.binding(30);
    f.bindings.push(next);
    await f.driver().tick();
    expect(f.host.deleteOnce).toHaveBeenCalledTimes(1);
    expect(f.host.createOnce).toHaveBeenCalledTimes(2);
    expect(f.archive.has('native-1')).toBe(true);
    expect(Object.keys(f.records)).toEqual(['native-2']);
    expect(f.host.createOnce.mock.calls.map((v) => v[0])).toEqual([
      f.c.controlSessionId,
      f.c.controlSessionId,
    ]);
  });
  it('never reissues create after the public call loses its ACK but put persisted', async () => {
    const f = fixture();
    f.loseCreate();
    await expect(f.driver().tick()).rejects.toThrow('ACK lost');
    f.writer.epoch++;
    f.make();
    await f.driver().tick();
    expect(f.host.createOnce).toHaveBeenCalledTimes(1);
  });
  it('a lost begin ACK grants no public create authorization', async () => {
    const f = fixture();
    f.loseBegin();
    await expect(f.driver().tick()).rejects.toThrow('begin ACK lost');
    expect(f.host.createOnce).not.toHaveBeenCalled();
    await expect(f.driver().tick()).rejects.toThrow(
      'calendar_create_ack_unknown',
    );
    expect(f.ports.confirmCalendarArmAbsent).not.toHaveBeenCalled();
    f.writer.epoch++;
    f.make();
    await f.driver().tick();
    expect(f.host.createOnce).toHaveBeenCalledTimes(1);
    expect(f.first.period.businessScheduledFor).toBe(
      f.host.createOnce.mock.calls[0]![1],
    );
  });
  it('clears a fenced canceled old create slot before beginning the new period', async () => {
    const f = fixture();
    f.first.closed = true;
    f.first.arm.status = 'creating';
    f.first.arm.createWriter = {
      partitionId: f.writer.partitionId,
      ownerId: f.writer.ownerId,
      epoch: 1,
      tokenDigest: hash(f.writer.token),
    };
    f.writer.epoch = 2;
    f.bindings.push(f.binding(30));
    await f.driver().tick();
    expect(f.trace[0]).toBe('absent:' + f.first.period.periodId);
    expect(f.host.createOnce).toHaveBeenCalledTimes(1);
    expect(f.ports.prepareCalendarArm).not.toHaveBeenCalled();
  });
  it('repairs only an exact retirement ACK and never recreates the old Task', async () => {
    const f = fixture();
    await f.driver().tick();
    f.closeFirst();
    f.loseDelete();
    await f.driver().tick();
    expect(f.host.deleteOnce).toHaveBeenCalledTimes(1);
    expect(f.host.createOnce).toHaveBeenCalledTimes(1);
    expect(f.archive.has('native-1')).toBe(true);
  });
  it('will not use an active-only catalog to prove absence', async () => {
    const f = fixture();
    f.first.arm.nativeAt = '2020-01-01T00:00:00.000Z';
    f.first.period.businessScheduledFor = f.first.arm.nativeAt;
    f.records['inactive-other'] = {
      sessionId: 'other',
      status: 'inactive',
      record: {
        id: 'inactive-other',
        kind: 'at',
        scheduledAt: '2020-01-01T00:00:00.000Z',
        title: 'AllRice once control',
        prompt: 'Synthetic schedule control only. Never execute business work.',
      },
      lastDelivery: {
        scheduledAt: '2020-01-01T00:00:00.000Z',
        deliveredAt: '2020-01-01T00:00:01.000Z',
        messageId: 'old',
      },
    };
    f.activeOnlyCatalog();
    await expect(f.driver().tick()).rejects.toThrow('calendar_binding_invalid');
    expect(f.ports.confirmCalendarArmAbsent).not.toHaveBeenCalled();
    expect(f.host.createOnce).not.toHaveBeenCalled();
  });
});
