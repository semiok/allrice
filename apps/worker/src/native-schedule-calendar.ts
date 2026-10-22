import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  NativeCalendarControl,
  NativeCalendarMutation,
  createNativeRecurringSqlStore,
} from '@allrice/database';
import type {
  NativeScheduleControlHost,
  NativeScheduleWriter,
} from './native-schedule-once.ts';
type ScheduleTask = ReturnType<NativeScheduleControlHost['decodeTask']>;

type SqlCalendar = NonNullable<
  ReturnType<typeof createNativeRecurringSqlStore>['calendar']
>;
export type NativeCalendarWorkerPorts = Pick<
  SqlCalendar,
  | 'loadCalendarState'
  | 'beginCalendarArmCreate'
  | 'confirmCalendarArmAbsent'
  | 'prepareCalendarArm'
  | 'readExactCalendarArm'
  | 'readExactCalendarRetirement'
> & {
  materialize(
    writer: NativeScheduleWriter,
    allowHandoff?: boolean,
  ): Promise<boolean>;
};
type CalendarState = Awaited<ReturnType<SqlCalendar['loadCalendarState']>>;
type Binding = CalendarState['bindings'][number];
export type { NativeCalendarControl };

/** No independent Host, writer, timer, queue or factory. All work is invoked
 * from the existing serialized recurring generation and its tracked SQL writes. */
export function createNativeCalendarGeneration(options: {
  ports: NativeCalendarWorkerPorts;
  writer: NativeScheduleWriter;
  host(): NativeScheduleControlHost;
  fence(): Promise<void>;
  mutate(mutation: NativeCalendarMutation): Promise<void>;
  track<T>(work: Promise<T>): Promise<T>;
  loadTaskRecords(): Promise<Record<string, unknown>>;
  digest(value: unknown): string;
}) {
  let state: CalendarState = { controls: [], bindings: [] };
  const fail = (): never => {
    throw Error('calendar_binding_invalid');
  };
  const task = (raw: unknown) => options.host().decodeTask(raw);
  async function reload() {
    state = await options.track(
      options.ports.loadCalendarState(options.writer),
    );
    return state;
  }
  function parent(c: NativeCalendarControl) {
    const row = state.controls.find((r) => r.control.controlId === c.controlId);
    if (
      !row ||
      row.control.controlSessionId !== c.controlSessionId ||
      row.control.nativeTaskId !== null
    )
      return fail();
    return row;
  }
  function bindingFor(
    id: string,
    value: ScheduleTask,
    loading: boolean,
  ): Binding {
    const c = state.controls.find(
      (r) => r.control.controlSessionId === value.sessionId,
    )?.control;
    if (
      !c ||
      value.record.id !== id ||
      value.record.kind !== 'at' ||
      value.record.title !== 'AllRice once control' ||
      value.record.prompt !==
        'Synthetic schedule control only. Never execute business work.' ||
      value.status !== (value.lastDelivery ? 'inactive' : 'active') ||
      (value.deliveryHistory &&
        (value.deliveryHistory.earlierRecordsUnavailable ||
          value.deliveryHistory.earlierRecordsPruned ||
          value.deliveryHistory.records.length !==
            (value.lastDelivery ? 1 : 0)))
    )
      return fail();
    let b = state.bindings.find((row) => row.arm.nativeTaskId === id);
    if (!b && !loading) {
      const pending = state.bindings.filter(
        (row) =>
          row.period.controlId === c.controlId &&
          row.arm.status === 'creating' &&
          row.arm.nativeTaskId === null &&
          row.arm.nativeAt === value.record.scheduledAt,
      );
      if (
        pending.length !== 1 ||
        value.lastDelivery ||
        value.status !== 'active'
      )
        return fail();
      b = pending[0];
    }
    if (
      !b ||
      b.period.controlId !== c.controlId ||
      b.arm.nativeAt !== value.record.scheduledAt ||
      (value.lastDelivery && value.lastDelivery.scheduledAt !== b.arm.nativeAt)
    )
      return fail();
    if (b.arm.taskSnapshot !== null) {
      const before = task(b.arm.taskSnapshot);
      if (
        !isDeepStrictEqual(before.record, value.record) ||
        (before.lastDelivery && !isDeepStrictEqual(before, value))
      )
        return fail();
    }
    return b;
  }
  function putMutation(id: string, value: ScheduleTask) {
    const b = bindingFor(id, value, false);
    return {
      binding: b,
      mutation: {
        kind: 'calendar' as const,
        action: 'put_task' as const,
        controlId: b.period.controlId,
        periodId: b.period.periodId,
        armId: b.arm.armId,
        requestDigest: b.arm.requestDigest,
        expectedPeriodVersion: b.period.version,
        expectedArmVersion: b.arm.snapshotVersion,
        task: value,
      },
    };
  }
  function acceptedPut(b: Binding, value: ScheduleTask) {
    b.period.version++;
    b.period.state = value.lastDelivery ? 'received' : 'bound';
    b.arm.snapshotVersion++;
    b.arm.nativeTaskId = value.record.id;
    b.arm.taskSnapshot = structuredClone(value);
    b.arm.status = value.lastDelivery ? 'received' : 'bound';
  }
  function retireMutation(id: string) {
    const b = state.bindings.find((r) => r.arm.nativeTaskId === id);
    if (
      !b ||
      !b.closed ||
      !b.retirement ||
      b.arm.taskSnapshot === null ||
      options.digest(task(b.arm.taskSnapshot).record) !==
        b.retirement.recordDigest
    )
      return fail();
    return {
      binding: b,
      mutation: {
        kind: 'calendar' as const,
        action: 'retire_task' as const,
        controlId: b.period.controlId,
        periodId: b.period.periodId,
        armId: b.arm.armId,
        retirementId: b.retirement.retirementId,
        nativeTaskId: id,
        taskDigest: options.digest(b.arm.taskSnapshot),
        expectedArmVersion: b.arm.snapshotVersion,
      },
    };
  }
  async function sessionMutation(
    c: NativeCalendarControl,
    action: 'session_initializing' | 'session_ready',
  ) {
    const row = parent(c);
    await options.mutate({
      kind: 'calendar',
      action,
      controlId: c.controlId,
      expectedControlVersion: row.version,
    });
    row.version++;
    row.control.sessionState =
      action === 'session_ready' ? 'ready' : 'initializing';
  }
  async function fullTaskSet() {
    await options.fence();
    const records = Object.fromEntries(
        Object.entries(await options.loadTaskRecords()),
      ),
      catalog = await options.host().catalog();
    if (
      !Array.isArray(catalog) ||
      catalog.length !== Object.keys(records).length
    )
      return fail();
    const seen = new Set<string>();
    for (const entry of catalog) {
      const raw = records[entry.id];
      if (!raw || seen.has(entry.id)) return fail();
      seen.add(entry.id);
      const stored = task(raw);
      if (
        stored.sessionId !== entry.sessionId ||
        stored.status !== entry.status ||
        !isDeepStrictEqual(
          stored.record,
          Object.fromEntries(
            Object.entries(entry).filter(
              ([key]) => !['sessionId', 'status', 'lastDelivery'].includes(key),
            ),
          ),
        )
      ) {
        // Catalog may add public summary fields. All immutable record fields
        // and real lastDelivery still have to agree; SQL holds the FULL value.
        for (const [key, value] of Object.entries(stored.record))
          if (
            !isDeepStrictEqual(
              (entry as unknown as Record<string, unknown>)[key],
              value,
            )
          )
            return fail();
        if (
          stored.sessionId !== entry.sessionId ||
          stored.status !== entry.status
        )
          return fail();
      }
      if (!isDeepStrictEqual(stored.lastDelivery, entry.lastDelivery))
        return fail();
    }
    await options.fence();
    return records;
  }
  async function absent(b: Binding) {
    const result = await options.track(
      options.ports.confirmCalendarArmAbsent(options.writer, {
        periodId: b.period.periodId,
        armId: b.arm.armId,
        requestDigest: b.arm.requestDigest,
        expectedPeriodVersion: b.period.version,
        expectedArmVersion: b.arm.snapshotVersion,
        taskRecords: await fullTaskSet(),
      }),
    );
    b.period = result.period;
    b.arm = result.arm;
  }
  async function recover(b: Binding) {
    if (b.closed) return;
    const next = await options.track(
      options.ports.prepareCalendarArm(options.writer, {
        periodId: b.period.periodId,
        previousArmId: b.arm.armId,
        expectedPeriodVersion: b.period.version,
        expectedArmVersion: b.arm.snapshotVersion,
        armId: randomUUID(),
        nativeAt: new Date(
          Math.max(
            Date.now() + 5_000,
            Date.parse(b.period.businessScheduledFor),
            Date.parse(b.arm.nativeAt),
          ),
        ).toISOString(),
      }),
    );
    b.period = next.period;
    b.arm = next.arm;
  }
  async function tick() {
    await reload();
    // Resolve old create slots before any new-period create. A lost begin or
    // create ACK always closes/drains this generation; it never issues create.
    for (const b of state.bindings.filter((r) => r.arm.status === 'creating')) {
      const exact = await options.track(
        options.ports.readExactCalendarArm(b.arm.armId, b.arm.requestDigest),
      );
      if (exact.state === 'unknown') return fail();
      if (exact.state === 'bound') {
        await reload();
        continue;
      }
      if (
        !b.arm.createWriter ||
        options.writer.epoch <= b.arm.createWriter.epoch
      )
        throw Error('calendar_create_ack_unknown');
      await absent(b);
      await recover(b);
    }
    for (const b of [...state.bindings].sort(
      (a, b) => Number(b.closed) - Number(a.closed),
    )) {
      await options.fence();
      if (b.closed) {
        if (b.arm.nativeTaskId && b.retirement) {
          try {
            await options
              .host()
              .deleteOnce(parentFor(b).controlSessionId, b.arm.nativeTaskId);
          } catch (error) {
            const exact = await options.track(
              options.ports.readExactCalendarRetirement(
                b.retirement.retirementId,
              ),
            );
            if (exact !== 'committed') throw error;
          }
          if (
            (await options.track(
              options.ports.readExactCalendarRetirement(
                b.retirement.retirementId,
              ),
            )) !== 'committed'
          )
            return fail();
        }
        continue;
      }
      if (
        b.arm.status === 'prepared' &&
        Date.parse(b.arm.nativeAt) <= Date.now()
      )
        await absent(b);
      if (b.arm.status === 'absent') await recover(b);
      if (b.arm.status !== 'prepared') continue;
      const authorized = await options.track(
        options.ports.beginCalendarArmCreate(options.writer, {
          periodId: b.period.periodId,
          armId: b.arm.armId,
          requestDigest: b.arm.requestDigest,
          expectedPeriodVersion: b.period.version,
          expectedArmVersion: b.arm.snapshotVersion,
        }),
      );
      b.period = authorized.period;
      b.arm = authorized.arm;
      await options.fence();
      // Exactly this successful COMMIT ACK authorizes this one call.
      const created = await options
        .host()
        .createOnce(parentFor(b).controlSessionId, b.arm.nativeAt);
      const exact = await options.track(
        options.ports.readExactCalendarArm(b.arm.armId, b.arm.requestDigest),
      );
      if (exact.state !== 'bound' || exact.arm.nativeTaskId !== created.id)
        return fail();
      b.period = exact.period;
      b.arm = exact.arm;
    }
  }
  function parentFor(b: Binding) {
    const c = state.controls.find(
      (r) => r.control.controlId === b.period.controlId,
    )?.control;
    return c ?? fail();
  }
  return {
    reload,
    tick,
    sessionMutation,
    bindingFor,
    putMutation,
    acceptedPut,
    retireMutation,
    hasTask: (id: string) =>
      state.bindings.some((b) => b.arm.nativeTaskId === id),
    acceptedRetirement: (b: Binding) => {
      state.bindings = state.bindings.filter((row) => row !== b);
    },
  };
}
export type NativeCalendarGeneration = ReturnType<
  typeof createNativeCalendarGeneration
>;
