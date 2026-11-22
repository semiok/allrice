import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeScheduleRecord,
  scheduleDomain,
  type ScheduleCatalogEntry,
  type ScheduleService,
} from '@deepseek-ai/dsh-schedule';

export type NativeScheduleObservation = Readonly<
  Pick<ScheduleCatalogEntry, 'id' | 'sessionId' | 'status' | 'scheduledAt'> & {
    fingerprint: `sha256:${string}`;
  }
>;

/** Content observations only: neither a native revision nor current authority. */
export type NativeScheduleObservationBatch = Readonly<{
  items: readonly NativeScheduleObservation[];
  fingerprint: `sha256:${string}`;
}>;

function invalid(): never {
  throw new TypeError('Invalid native schedule catalog');
}

/** Reject values JSON would silently omit, invoke, or normalize before hashing. */
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (typeof value !== 'object' || value === null) return invalid();
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      if (!field?.enumerable || !('value' in field)) return invalid();
      items.push(canonical(field.value));
    }
    return '[' + items.join(',') + ']';
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const fields: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !field?.enumerable || !('value' in field))
      return invalid();
    fields.push([key, field.value]);
  }
  fields.sort(([left], [right]) => compare(left, right));
  return (
    '{' +
    fields
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fingerprint(serialized: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function observe(value: unknown): NativeScheduleObservation {
  // Validate the original, complete JSON shape before any native decoding.
  const serialized = canonical(value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const { sessionId, status, lastDelivery, ...rawRecord } = value as Record<
    string,
    unknown
  >;
  const record = decodeScheduleRecord(rawRecord);
  const task = scheduleDomain.tables.tasks.valueSchema.parse({
    sessionId,
    status,
    record,
    ...(lastDelivery === undefined ? {} : { lastDelivery }),
  });
  const entry = {
    ...task.record,
    sessionId: task.sessionId,
    status: task.status,
    ...(task.lastDelivery === undefined
      ? {}
      : { lastDelivery: task.lastDelivery }),
  };
  // Defaults, dropped unknown fields, and normalization cannot certify a row.
  if (!isDeepStrictEqual(entry, value)) return invalid();
  return Object.freeze({
    id: entry.id,
    sessionId: entry.sessionId,
    status: entry.status,
    scheduledAt: entry.scheduledAt,
    fingerprint: fingerprint(serialized),
  });
}

/**
 * Read the actual Host service without activating a Session or owning its life.
 * The caller supplies the trusted native service, never browser/guest JSON.
 * catalog() has no cancellation argument: an in-flight read is always joined.
 */
export async function readNativeScheduleObservations(
  schedule: Pick<ScheduleService, 'catalog'>,
  signal: AbortSignal,
): Promise<NativeScheduleObservationBatch> {
  signal.throwIfAborted();
  const catalog = await schedule.catalog();
  signal.throwIfAborted();
  if (!Array.isArray(catalog)) return invalid();
  canonical(catalog);
  const items = catalog.map(observe);
  items.sort((left, right) => compare(left.id, right.id));
  if (
    items.some((item, index) => index > 0 && items[index - 1]!.id === item.id)
  )
    return invalid();
  return Object.freeze({
    items: Object.freeze(items),
    fingerprint: fingerprint(canonical(items)),
  });
}
