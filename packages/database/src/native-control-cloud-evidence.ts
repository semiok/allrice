import { runtimePolicyDigest } from './runtime-policy.ts';

export class NativeControlCloudEvidenceError extends Error {
  constructor(readonly code: string) {
    super(`native_control_cloud_evidence_${code}`);
  }
}
function reject(code: string): never {
  throw new NativeControlCloudEvidenceError(code);
}

/** Complete cloud observations and their credential envelope may exceed the
 * control plan's 64 KiB bound. Keep the same canonical digest, with a separate
 * 1 MiB ceiling; SQL also enforces its unchanged credential::text size check.
 * This is a document digest, not approval or a replacement for evidence guards. */
export function nativeControlCloudEvidenceDigest(value: unknown): string {
  let nodes = 0;
  const visiting = new Set<object>();
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 32) reject('json_limit');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) reject('invalid_json');
      return;
    }
    if (!v || typeof v !== 'object' || visiting.has(v)) reject('invalid_json');
    const array = Array.isArray(v);
    if (
      Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)
    )
      reject('invalid_json');
    visiting.add(v);
    const keys = Reflect.ownKeys(v);
    if (array && keys.length !== v.length + 1) reject('invalid_json');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') reject('invalid_json');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
        reject('invalid_json');
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable)
        reject('invalid_json');
      visit(descriptor.value, depth + 1);
    }
    visiting.delete(v);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1_048_576)
    reject('json_limit');
  return runtimePolicyDigest(value);
}
