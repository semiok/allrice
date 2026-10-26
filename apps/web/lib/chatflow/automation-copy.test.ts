import { describe, expect, it } from 'vitest';
import {
  commonTimeZones,
  timeZoneLabel,
  timeZoneOptions,
} from './automation-copy';
import { shortDateTime } from './short-date-time';

describe('automation wording', () => {
  it('names common zones in words and keeps any other zone as written', () => {
    expect(timeZoneLabel('Asia/Shanghai')).toBe('北京时间');
    expect(timeZoneLabel('Europe/Berlin')).toBe('Europe/Berlin');
    for (const zone of commonTimeZones)
      expect(timeZoneLabel(zone)).not.toContain('/');
  });

  it('offers every known zone after the common ones and keeps unusual saved zones', () => {
    const { common, others } = timeZoneOptions(['Europe/Berlin', 'Etc/GMT-14']);
    expect(common).toEqual(commonTimeZones);
    expect(others).toContain('Europe/Berlin');
    expect(others).toContain('Pacific/Auckland');
    // Kept even if the browser's own list does not name it.
    expect(others).toContain('Etc/GMT-14');
    for (const zone of common) expect(others).not.toContain(zone);
    expect(new Set(others).size).toBe(others.length);
    expect(timeZoneOptions(['']).others).not.toContain('');
  });

  it('reads a task time in the task zone, whatever the viewer zone is', () => {
    const now = new Date('2026-10-26T00:00:00Z');
    // 01:00Z is 09:00 in Beijing and 21:00 the day before in New York.
    expect(
      shortDateTime('2026-11-01T01:00:00Z', { timeZone: 'Asia/Shanghai', now }),
    ).toBe('11 月 1 日 09:00');
    expect(
      shortDateTime('2026-11-01T01:00:00Z', {
        timeZone: 'America/New_York',
        now,
      }),
    ).toBe('10 月 31 日 21:00');
    expect(
      shortDateTime('2026-11-01T01:00:00Z', { timeZone: 'Not/AZone', now }),
    ).toBe(shortDateTime('2026-11-01T01:00:00Z', { now }));
    expect(shortDateTime('not a date', { now })).toBe('');
  });

  it('compares years in the same zone around New Year', () => {
    // 2027-01-01 01:00 in Beijing while it is still 2026 in UTC.
    const now = new Date('2026-12-31T17:00:00Z');
    expect(
      shortDateTime('2026-12-31T17:30:00Z', { timeZone: 'Asia/Shanghai', now }),
    ).toBe('1 月 1 日 01:30');
    expect(
      shortDateTime('2026-12-31T15:00:00Z', { timeZone: 'Asia/Shanghai', now }),
    ).toBe('2026 年 12 月 31 日 23:00');
  });
});
