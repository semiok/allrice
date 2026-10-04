/** Synthetic immutable source for actual runsc acceptance; no model or tenant authority is mocked as executed. */
import { randomUUID } from 'node:crypto';
import {
  CloudProjectCommandSchema,
  cloudToolchainImageV1,
  cloudPythonImageV1,
} from '@allrice/contracts';
import { projectCacheKey } from '@allrice/project-runtime';
import { savedProjectFixture } from '../../../rice-bridge/test/saved-project-fixture.js';
export function cloudProjectFixture(manager: 'pnpm' | 'uv' = 'pnpm') {
  const f = savedProjectFixture(manager),
    a = f.command.arguments,
    imageDigest = manager === 'uv' ? cloudPythonImageV1 : cloudToolchainImageV1;
  const projectSource = {
    ...a.projectSource!,
    executionOrigin: {
      toolName: 'workspace.project' as const,
      callId: randomUUID(),
      argumentsDigest: 'sha256:' + 'a'.repeat(64),
      selectionId: randomUUID(),
    },
    cacheKey: projectCacheKey({
      spec: a.projectPreparation!,
      scope: f.scope,
      image: imageDigest,
      architecture: 'amd64',
    }),
  };
  const command = CloudProjectCommandSchema.parse({
    kind: 'project',
    capability: 'cloud.process.execute',
    arguments: {
      executable: a.executable,
      args: a.args,
      path: a.path,
      files: a.files,
      limits: a.limits,
      projectPreparation: a.projectPreparation,
      projectSource,
      imageDigest,
    },
    imageDigest,
    backend: 'cloud-gvisor-v1',
    runtime: 'runsc',
    network: 'none',
  });
  return { command, scope: f.scope };
}
