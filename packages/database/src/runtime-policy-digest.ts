import { createHash } from 'node:crypto';

export class RuntimePolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Canonical JSON only; callers must schema-parse before hashing. No secret values logged. */
export function runtimePolicyDigest(input: unknown): string {
  function canonical(value: unknown): string {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
      return JSON.stringify(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++)
        if (!Object.hasOwn(value, i))
          throw new RuntimePolicyError('non_json_binding');
      return `[${value.map(canonical).join(',')}]`;
    }
    if (
      value &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype
    )
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    throw new RuntimePolicyError('non_json_binding');
  }
  return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;
}
