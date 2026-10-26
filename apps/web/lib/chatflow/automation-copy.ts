const zoneNames: Record<string, string> = {
  'Asia/Shanghai': '北京时间',
  'Asia/Hong_Kong': '香港时间',
  'Asia/Taipei': '台北时间',
  'Asia/Tokyo': '东京时间',
  'Asia/Singapore': '新加坡时间',
  'Europe/London': '伦敦时间',
  'America/New_York': '纽约时间',
  'America/Los_Angeles': '洛杉矶时间',
  UTC: '世界标准时间',
};

/** Common zones, offered by name; the value stays the IANA zone. */
export const commonTimeZones = Object.keys(zoneNames);

/** Common zones in everyday words; any other IANA name stays as written. */
export function timeZoneLabel(zone: string) {
  return zoneNames[zone] ?? zone;
}

/**
 * Zones to offer in a picker: the common ones first, then every other zone
 * this browser knows. `keep` (the task's saved zone and the current choice)
 * is always offered, so an unusual zone can be chosen again after a change.
 */
export function timeZoneOptions(keep: string[]) {
  let known: string[] = [];
  try {
    known = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older engines: the common zones and the kept ones are still offered.
  }
  const others = [...new Set([...keep, ...known])]
    .filter((zone) => zone && !Object.hasOwn(zoneNames, zone))
    .sort();
  return { common: commonTimeZones, others };
}

/** The browser could not keep the request record, so nothing was sent. */
export const requestNotSent =
  '浏览器没能记下这次请求，所以没有发出。请刷新页面后再试。';
