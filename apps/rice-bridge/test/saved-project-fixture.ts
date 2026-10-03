import { createHash, randomUUID } from 'node:crypto';
import {
  RuntimeLocalCommandSchema,
  ProjectSnapshotSchema,
} from '@allrice/contracts';
import { projectFixture } from './project-fixture.js';
import { projectCacheKey } from '../src/project-preparation.js';

const hash = (s: string) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;
export function savedProjectFixture(
  manager: 'pnpm' | 'uv' = 'pnpm',
  architecture: 'amd64' | 'arm64' = 'amd64',
) {
  const f = projectFixture(manager, architecture),
    a = f.command.arguments;
  const snapshot = ProjectSnapshotSchema.parse({
    version: 1,
    projectId: a.projectPreparation!.projectId,
    sourceDigest: a.projectPreparation!.sourceDigest,
    files: Object.entries(f.files)
      .sort(([p], [q]) => p.localeCompare(q))
      .map(([path, b]) => ({
        path,
        sha256: a.files.find((v) => v.path === path)!.sha256,
        sizeBytes: b.length,
        contentBase64: b.toString('base64'),
      })),
  });
  const scope = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const command = RuntimeLocalCommandSchema.parse({
    ...f.command,
    arguments: {
      ...a,
      files: snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })),
      projectSource: {
        version: 1,
        project: {
          projectId: snapshot.projectId,
          snapshot: {
            kind: 'artifact',
            id: randomUUID(),
            checksum: hash(JSON.stringify(snapshot)),
          },
        },
        snapshot,
        architecture,
        cacheKey: projectCacheKey({
          spec: a.projectPreparation!,
          scope,
          image: a.imageDigest,
          architecture,
        }),
        origin: {
          jobId: randomUUID(),
          workerId: randomUUID(),
          attempt: 1,
          leaseTokenDigest: 'a'.repeat(64),
        },
      },
    },
  });
  return { ...f, command, scope };
}
