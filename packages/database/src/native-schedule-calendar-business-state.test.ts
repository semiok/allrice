import { describe, expect, it } from 'vitest';
import {
  NativeCalendarDecisionSchema,
  NativeCalendarPlanSchema,
  calendarDecisionDigest,
} from './native-schedule-calendar-business-state.ts';
import { calendarOccurrenceIdentity } from './native-schedule-calendar-state.ts';
import { nativeOnceDigest } from './native-schedule-once-state.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = '2027-01-31T03:00:00.000Z';
const queued = {
  decisionId: id(1),
  periodId: id(2),
  kind: 'receipt',
  outcome: 'queued',
  revision: 1,
  decidedAt: P,
  receiptOccurrenceId: id(3),
  automationRunId: id(4),
  successorPeriodId: id(5),
  lease: { ownerId: id(6), epoch: 1, tokenDigest: nativeOnceDigest('lease') },
  budget: null,
};
describe('calendar immutable business decisions', () => {
  it('keeps canceled old and resumed new receipt identities apart at the same P', () => {
    const old = calendarOccurrenceIdentity(id(10), id(11), P);
    const resumed = calendarOccurrenceIdentity(id(10), id(12), P);
    expect(old.id).not.toBe(resumed.id);
    expect(old.key).not.toBe(resumed.key);
    expect(calendarOccurrenceIdentity(id(10), id(11), P)).toEqual(old);
  });
  it('retains the exact accepted decision digest on acknowledgement readback', () => {
    const d = NativeCalendarDecisionSchema.parse(queued);
    expect(calendarDecisionDigest(structuredClone(d))).toBe(
      calendarDecisionDigest(d),
    );
    expect(() =>
      NativeCalendarDecisionSchema.parse({
        ...queued,
        nativePhase: 'completed',
      }),
    ).toThrow();
  });
  it.each([
    { successorPeriodId: null },
    { automationRunId: null },
    { lease: null },
    { successorPeriodId: id(2) },
    { outcome: 'budget' },
    { kind: 'policy' },
  ])('rejects a missing/contradictory proof %j', (patch) => {
    expect(() =>
      NativeCalendarDecisionSchema.parse({ ...queued, ...patch }),
    ).toThrow();
  });
  it('allows policy cancellation without forging a native writer or receipt', () => {
    expect(
      NativeCalendarDecisionSchema.parse({
        ...queued,
        kind: 'policy',
        outcome: 'canceled',
        revision: 2,
        receiptOccurrenceId: null,
        lease: null,
        automationRunId: null,
        successorPeriodId: null,
      }).outcome,
    ).toBe('canceled');
  });
  it('persists the exact new P and original calendar revision in an intent', () => {
    const plan = NativeCalendarPlanSchema.parse({
      periodId: id(2),
      controlId: id(20),
      automationId: id(10),
      revision: 2,
      businessScheduledFor: P,
      initialArmId: id(21),
      revisionDigest: nativeOnceDigest('revision'),
      createdAt: '2027-01-01T00:00:00.000Z',
      cause: { kind: 'policy', policyRevision: 3 },
    });
    expect(plan.businessScheduledFor).toBe(P);
    expect(() =>
      NativeCalendarPlanSchema.parse({ ...plan, writerToken: 'forbidden' }),
    ).toThrow();
  });
});
