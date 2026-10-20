import { describe, expect, it } from 'vitest';
import {
  ScheduleId,
  createDailyScheduleRecord,
  createEveryScheduleRecord,
  decodeScheduleRecord,
  resolveDailyOccurrence,
  resolveEveryOccurrence,
} from '@deepseek-ai/dsh-schedule';

const TITLE = 'AllRice once control';
const PROMPT = 'Synthetic schedule control only. Never execute business work.';

function daily(time: string, timeZone: string, now: string) {
  return createDailyScheduleRecord(
    ScheduleId('schedule-daily'),
    PROMPT,
    { time, time_zone: timeZone },
    Date.parse(now),
    TITLE,
  );
}

describe('native recurring time semantics from the installed public DSH API', () => {
  it('commits Shanghai wall time as UTC and requires a strictly future first target', () => {
    const record = daily(
      '09:30:00',
      'Asia/Shanghai',
      '2026-01-01T00:00:00.000Z',
    );
    expect(record).toMatchObject({
      kind: 'daily',
      time: '09:30:00.000',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-01-01T01:30:00.000Z',
    });
    expect(decodeScheduleRecord(record)).toEqual(record);
    expect(
      resolveDailyOccurrence(record, Date.parse('2026-01-01T01:30:00.000Z')),
    ).toEqual({
      occurrenceAt: '2026-01-01T01:30:00.000Z',
      nextScheduledAt: '2026-01-02T01:30:00.000Z',
    });
    expect(
      daily('09:30:00', 'Asia/Shanghai', '2026-01-01T01:30:00.000Z')
        .scheduledAt,
    ).toBe('2026-01-02T01:30:00.000Z');
  });

  it('skips New York spring 02:30 when that local time does not exist, without shifting or manufacturing a delivery', () => {
    expect(
      daily('02:30:00', 'America/New_York', '2026-03-08T00:00:00.000Z')
        .scheduledAt,
    ).toBe('2026-03-09T06:30:00.000Z');
    const existing = daily(
      '02:30:00',
      'America/New_York',
      '2026-03-07T00:00:00.000Z',
    );
    expect(existing.scheduledAt).toBe('2026-03-07T07:30:00.000Z');
    expect(
      resolveDailyOccurrence(existing, Date.parse('2026-03-08T12:00:00.000Z')),
    ).toEqual({
      occurrenceAt: '2026-03-07T07:30:00.000Z',
      nextScheduledAt: '2026-03-09T06:30:00.000Z',
    });
  });

  it('chooses only the earlier New York autumn 01:30 and never schedules its repeated later instant', () => {
    const record = daily(
      '01:30:00',
      'America/New_York',
      '2026-11-01T00:00:00.000Z',
    );
    expect(record.scheduledAt).toBe('2026-11-01T05:30:00.000Z');
    const expected = {
      occurrenceAt: '2026-11-01T05:30:00.000Z',
      nextScheduledAt: '2026-11-02T06:30:00.000Z',
    };
    expect(
      resolveDailyOccurrence(record, Date.parse('2026-11-01T05:30:00.000Z')),
    ).toEqual(expected);
    expect(
      resolveDailyOccurrence(record, Date.parse('2026-11-01T06:30:00.000Z')),
    ).toEqual(expected);
    // Creation between the two 01:30 readings does not select the second one.
    expect(
      daily('01:30:00', 'America/New_York', '2026-11-01T05:45:00.000Z')
        .scheduledAt,
    ).toBe('2026-11-02T06:30:00.000Z');
  });

  it('resolves a delayed daily decision to the latest actual due date without enumerating a backlog', () => {
    const record = daily(
      '09:30:00',
      'Asia/Shanghai',
      '2026-01-01T00:00:00.000Z',
    );
    expect(
      resolveDailyOccurrence(record, Date.parse('2026-01-05T12:00:00.000Z')),
    ).toEqual({
      occurrenceAt: '2026-01-05T01:30:00.000Z',
      nextScheduledAt: '2026-01-06T01:30:00.000Z',
    });
  });

  it('keeps fixed hourly intervals anchored to elapsed UTC time through both DST transitions', () => {
    const spring = createEveryScheduleRecord(
      ScheduleId('schedule-spring'),
      PROMPT,
      3_600,
      Date.parse('2026-03-08T06:30:00.000Z'),
      TITLE,
    );
    expect(spring.scheduledAt).toBe('2026-03-08T07:30:00.000Z');
    expect(
      resolveEveryOccurrence(spring, Date.parse('2026-03-08T09:45:00.000Z')),
    ).toEqual({
      occurrenceAt: '2026-03-08T09:30:00.000Z',
      nextScheduledAt: '2026-03-08T10:30:00.000Z',
    });
    const autumn = createEveryScheduleRecord(
      ScheduleId('schedule-autumn'),
      PROMPT,
      3_600,
      Date.parse('2026-11-01T04:30:00.000Z'),
      TITLE,
    );
    expect(autumn.scheduledAt).toBe('2026-11-01T05:30:00.000Z');
    expect(
      resolveEveryOccurrence(autumn, Date.parse('2026-11-01T06:30:00.000Z')),
    ).toEqual({
      occurrenceAt: '2026-11-01T06:30:00.000Z',
      nextScheduledAt: '2026-11-01T07:30:00.000Z',
    });
  });
});
