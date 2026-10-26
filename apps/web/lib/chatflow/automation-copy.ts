const zoneNames: Record<string, string> = {
  'Asia/Shanghai': '北京时间',
  'Asia/Hong_Kong': '香港时间',
  'Asia/Taipei': '台北时间',
  'Asia/Tokyo': '东京时间',
  'Asia/Singapore': '新加坡时间',
  UTC: '世界标准时间',
};

/** Common zones in everyday words; any other IANA name stays as written. */
export function timeZoneLabel(zone: string) {
  return zoneNames[zone] ?? zone;
}

/** "11 月 1 日 09:00" in the given zone (the viewer's when omitted); the year only when it differs. */
export function automationTime(
  value: string,
  timeZone?: string,
  now = new Date(),
) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(timeZone ? { timeZone } : {}),
      })
        .formatToParts(new Date(value))
        .map((part) => [part.type, part.value]),
    );
    const day = `${parts.month} 月 ${parts.day} 日 ${parts.hour}:${parts.minute}`;
    return parts.year === String(now.getFullYear())
      ? day
      : `${parts.year} 年 ${day}`;
  } catch {
    return value;
  }
}

/** The browser could not keep the request record, so nothing was sent. */
export const requestNotSent =
  '浏览器没能记下这次请求，所以没有发出。请刷新页面后再试。';
