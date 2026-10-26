const parts = (date: Date, timeZone?: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

function format(date: Date, now: Date, timeZone?: string) {
  const at = parts(date, timeZone);
  const day = `${at.month} 月 ${at.day} 日 ${at.hour}:${at.minute}`;
  // Both years are read in the same zone, so New Year's Eve does not drift.
  return at.year === parts(now, timeZone).year ? day : `${at.year} 年 ${day}`;
}

/**
 * "11 月 1 日 09:00", with the year only when it is not this year. Read in
 * `timeZone` when given (an unknown zone falls back to the viewer's), else in
 * the viewer's own. Empty for an invalid date.
 */
export function shortDateTime(
  iso: string,
  { timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {},
) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return format(date, now, timeZone);
  } catch {
    return format(date, now);
  }
}
