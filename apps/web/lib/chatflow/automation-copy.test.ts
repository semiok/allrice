import { describe, expect, it } from 'vitest';
import { automationTime, timeZoneLabel } from './automation-copy';

describe('automation wording', () => {
  it('names common zones in words and keeps any other zone as written', () => {
    expect(timeZoneLabel('Asia/Shanghai')).toBe('北京时间');
    expect(timeZoneLabel('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('writes dates as "11 月 1 日 09:00" in the task zone, with the year only when it differs', () => {
    const now = new Date('2026-10-26T00:00:00Z');
    expect(automationTime('2026-11-01T01:00:00Z', 'Asia/Shanghai', now)).toBe(
      '11 月 1 日 09:00',
    );
    expect(automationTime('2027-01-02T01:05:00Z', 'Asia/Shanghai', now)).toBe(
      '2027 年 1 月 2 日 09:05',
    );
    expect(automationTime('not a date', 'Asia/Shanghai', now)).toBe(
      'not a date',
    );
  });
});
