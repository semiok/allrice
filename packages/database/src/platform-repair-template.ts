// A candidate can alter one regex and its literal replacement, never module
// code or the test driver. This is deliberately narrower than arbitrary code.
export const repairSlotStart = '      .replace(';
export const repairSlotClose = '      );';
export const repairSlotPattern =
  '^ {6}\\.replace\\(\\s*/((?:\\\\[^\\r\\n]|[^/\\\\\\r\\n]){1,4000})/([gi]{1,2})\\s*,\\s*([\x27\x22])([^\\r\\n]{1,200})\\3\\s*,?\\s*\\);$';
export const repairReplacementPattern =
  '^(?:\\$[1-9]|[A-Za-z0-9_ \\[\\]\\-])+$';
export function repairTemplateSlot(before: string, after: string) {
  const start = before.lastIndexOf(repairSlotStart),
    end = before.indexOf(repairSlotClose, start);
  if (start < 0 || end < start) throw Error('REPOSITORY_REPAIR_TEMPLATE');
  const prefix = before.slice(0, start),
    suffix = before.slice(end + repairSlotClose.length);
  if (!after.startsWith(prefix) || !after.endsWith(suffix))
    throw Error('REPOSITORY_REPAIR_TEMPLATE');
  const match = new RegExp(repairSlotPattern).exec(
    after.slice(prefix.length, after.length - suffix.length),
  );
  if (
    !match ||
    !match[2]!.includes('g') ||
    new Set(match[2]).size !== match[2]!.length ||
    !new RegExp(repairReplacementPattern).test(match[4]!) ||
    !match[4]!.includes('[REDACTED]')
  )
    throw Error('REPOSITORY_REPAIR_TEMPLATE');
  // Compile syntax only; no candidate module or regexp is executed here.
  new RegExp(match[1]!, match[2]!);
  return { pattern: match[1]!, flags: match[2]!, replacement: match[4]! };
}
