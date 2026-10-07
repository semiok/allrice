import { expect, it } from 'vitest';
import { projectFixture } from '../../../apps/rice-bridge/test/project-fixture.js';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandToolInputSchema,
  ProjectExecuteInputSchema,
  projectRuntimeCacheIdentity,
} from '@allrice/contracts';
it('requires an explicit Node web profile for higher execution limits, keeping standard and Python limits', () => {
  const f = projectFixture('pnpm');
  const c = structuredClone(f.command);
  c.arguments.limits.memoryMiB = 1536;
  c.arguments.limits.timeoutMs = 300000;
  c.arguments.limits.pids = 128;
  expect(RuntimeLocalCommandSchema.safeParse(c).success).toBe(false);
  const {
    imageDigest: _image,
    isolation: _isolation,
    network: _network,
    ...tool
  } = c.arguments;
  void [_image, _isolation, _network];
  expect(RuntimeLocalCommandToolInputSchema.safeParse(tool).success).toBe(
    false,
  );
  Object.assign(c.arguments.projectPreparation!, {
    resourceProfile: 'web-development',
  });
  expect(RuntimeLocalCommandSchema.safeParse(c).success).toBe(true);
  expect(RuntimeLocalCommandToolInputSchema.safeParse(tool).success).toBe(true);
  const a = c.arguments;
  const project = {
    projectId: a.projectPreparation!.projectId,
    snapshot: {
      kind: 'artifact',
      id: '713d721f-f0bf-40dd-aa0b-65f6aa79e49b',
      checksum: 'sha256:' + 'a'.repeat(64),
    },
  };
  expect(
    ProjectExecuteInputSchema.safeParse({
      action: 'execute',
      project,
      executable: a.executable,
      args: a.args,
      path: '.',
      limits: a.limits,
      projectPreparation: a.projectPreparation,
    }).success,
  ).toBe(true);
  const python = projectFixture('uv').command;
  python.arguments.limits.memoryMiB = 1536;
  expect(RuntimeLocalCommandSchema.safeParse(python).success).toBe(false);
  c.arguments.limits.memoryMiB = 1537;
  expect(RuntimeLocalCommandSchema.safeParse(c).success).toBe(false);
});
it('separates the declared cache profile from an old standard reservation', () => {
  const f = projectFixture('pnpm'),
    s = f.command.arguments.projectPreparation!;
  const base = {
    spec: s,
    scope: {
      organizationId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49b',
      workspaceId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49c',
      ownerId: '713d721f-f0bf-40dd-aa0b-65f6aa79e49d',
    },
    image: f.command.arguments.imageDigest,
    architecture: 'amd64',
  };
  const original = projectRuntimeCacheIdentity(base);
  expect(
    projectRuntimeCacheIdentity({
      ...base,
      spec: { ...s, resourceProfile: 'standard' } as typeof s,
    }),
  ).toEqual(original);
  expect(
    projectRuntimeCacheIdentity({
      ...base,
      spec: { ...s, resourceProfile: 'web-development' } as typeof s,
    }),
  ).not.toEqual(original);
});

it('rejects a larger thread budget without the explicit web profile', () => {
  const c = structuredClone(projectFixture('pnpm').command);
  expect(RuntimeLocalCommandSchema.safeParse(c).success).toBe(true);
  c.arguments.limits.pids = 128;
  if (c.arguments.projectPreparation?.manager !== 'pnpm')
    throw new Error('PNPM_FIXTURE_REQUIRED');
  delete c.arguments.projectPreparation.resourceProfile;
  c.arguments.limits.memoryMiB = 512;
  c.arguments.limits.timeoutMs = 60000;
  expect(RuntimeLocalCommandSchema.safeParse(c).success).toBe(false);
});
