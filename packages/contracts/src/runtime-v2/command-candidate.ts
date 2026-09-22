import { z } from 'zod';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { ChangesetDocumentSchema } from './artifact-review.ts';

/** Models supply only an immutable reference. Bytes are resolved by the server. */
export const CommandCandidateRefSchema = z
  .object({
    artifactId: UuidSchema,
    checksum: ChecksumSchema,
  })
  .strict();
export const CommandCandidateSchema = CommandCandidateRefSchema.extend({
  content: z.string().max(512_000),
});
export const CommandCandidateEvidenceSchema = CommandCandidateRefSchema.extend({
  inputDigest: ChecksumSchema,
});

/** Exact projected manifest, not proof that a command ran. SHA verification of
 * content and file text belongs to the trusted server/Bridge implementations. */
export function commandCandidateManifest(
  base: { path: string; sha256: string }[],
  content: string,
): [string, string][] {
  const document = ChangesetDocumentSchema.parse(JSON.parse(content));
  const result = new Map(base.map((f) => [f.path, f.sha256]));
  for (const file of document.files) {
    if ((result.get(file.path) ?? null) !== (file.before?.checksum ?? null))
      throw Error('candidate_baseline_mismatch');
    if (file.after) result.set(file.path, file.after.checksum);
    else result.delete(file.path);
  }
  // Keep deleted inputs in the collision check: case/NFC aliases must not be
  // turned into a disguised replacement on a case-insensitive host.
  const paths = [
    ...new Set([
      ...base.map((f) => f.path),
      ...document.files.map((f) => f.path),
    ]),
  ];
  const keys = paths.map((p) => p.normalize('NFC').toLowerCase());
  if (
    new Set(base.map((f) => f.path)).size !== base.length ||
    keys.some((p, i) =>
      keys.some((q, j) => i !== j && (p === q || p.startsWith(`${q}/`))),
    )
  )
    throw Error('candidate_path_conflict');
  if (result.size > 64) throw Error('candidate_file_limit');
  return [...result].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
