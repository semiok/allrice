import { createHash } from 'node:crypto';
// Stable canonical identity. Moving this helper must not change old digests.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const nativeRootDigest = (value: unknown) =>
  'sha256:' +
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
