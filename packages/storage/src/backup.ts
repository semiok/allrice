import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    schemaVersion: z.string().min(1),
    databaseArtifact: z.string().min(1),
    storageArtifact: z.string().min(1),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface BackupPort {
  create(): Promise<BackupManifest>;
  restore(manifest: BackupManifest): Promise<void>;
}

export async function writeBackupManifest(path: string, input: BackupManifest) {
  const manifest = BackupManifestSchema.parse(input);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

export async function readBackupManifest(path: string) {
  return BackupManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
