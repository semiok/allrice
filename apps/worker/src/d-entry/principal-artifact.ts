import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.object({ path: z.string().min(1), sha256 }).strict();
const manifestSchema = z
  .object({
    schema: z.literal(1),
    package: z.literal('@allrice/d-entry-principal'),
    version: z.literal('0.1.0'),
    dshVersion: z.literal('0.2.1-rc.2'),
    files: z.array(fileSchema),
    modules: z.array(
      z
        .object({
          specifier: z.string().min(1),
          version: z.string().min(1),
          sha256,
        })
        .strict(),
    ),
  })
  .strict();
const required = [
  'host.js',
  'types.js',
  'policy.js',
  'artifacts.js',
  'typert.host.js',
  'typert.host.d.ts',
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
  'types/host.d.ts',
  'types/types.d.ts',
  'types/policy.d.ts',
];

/** Read only the installed package's closed build receipt. Never generate,
 * install in the guest, or recover output from another checkout. */
export async function readDEntryPrincipalHostArtifact(): Promise<string> {
  const require = createRequire(import.meta.url);
  const receiptPath = require.resolve('@allrice/d-entry-principal/artifact');
  const base = dirname(receiptPath);
  const receipt = await readFile(receiptPath, 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(receipt));
  if (
    manifest.files.length !== required.length ||
    new Set(manifest.files.map((file) => file.path)).size !== required.length ||
    manifest.files.some((file) => !required.includes(file.path))
  )
    throw Error('PRINCIPAL_ARTIFACT_CLOSURE_INVALID');
  let host: string | undefined;
  for (const file of manifest.files) {
    const contents = await readFile(resolve(base, file.path), 'utf8');
    if (createHash('sha256').update(contents).digest('hex') !== file.sha256)
      throw Error('PRINCIPAL_ARTIFACT_HASH_INVALID');
    // Only the sealed single file is executed in the guest. Other bytes stay
    // checked here to bind the Node Remote face and metadata to this release.
    if (file.path === 'host.js') host = contents;
  }
  if (host === undefined) throw Error('PRINCIPAL_ARTIFACT_CLOSURE_INVALID');
  return host;
}
