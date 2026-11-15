import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { formatFileListDate } from './file-list-date';

const local = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
) => new Date(year, month - 1, day, hour, minute);

describe('file list dates', () => {
  it('shows today with a zero-padded local time', () => {
    expect(
      formatFileListDate(
        local(2026, 11, 15, 10, 30).toISOString(),
        local(2026, 11, 15, 18),
      ),
    ).toBe('今日 10:30');
    expect(
      formatFileListDate(
        local(2026, 11, 15, 0, 7).toISOString(),
        local(2026, 11, 15, 18),
      ),
    ).toBe('今日 00:07');
  });
  it('shows only month/day for an earlier day', () => {
    expect(
      formatFileListDate(
        local(2026, 11, 14, 23, 59).toISOString(),
        local(2026, 11, 15),
      ),
    ).toBe('11/14');
  });
  it('does not treat the same month/day in another year as today', () => {
    expect(
      formatFileListDate(
        local(2025, 11, 15, 10, 30).toISOString(),
        local(2026, 11, 15),
      ),
    ).toBe('11/15');
    expect(
      formatFileListDate(
        local(2025, 12, 31, 22).toISOString(),
        local(2026, 1, 1),
      ),
    ).toBe('12/31');
  });
  it('changes days at local midnight even when UTC stays on the same day', () => {
    // A separate timezone process avoids mutating Vitest's shared clock/env.
    const source = new URL('./file-list-date.ts', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import { formatFileListDate } from ${JSON.stringify(source)};
       const now = new Date('2026-11-14T16:01:00Z');
       console.log(JSON.stringify({ day: now.getDate(), labels: [
         formatFileListDate('2026-11-14T15:59:00Z', now),
         formatFileListDate('2026-11-14T16:00:00Z', now)
       ] }));`,
      ],
      { env: { ...process.env, TZ: 'Asia/Shanghai' }, encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual({
      day: 15,
      labels: ['11/14', '今日 00:00'],
    });
  });
});
