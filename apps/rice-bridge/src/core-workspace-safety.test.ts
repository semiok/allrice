import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorkspaceExcludesBridgeState } from './core.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

it('rejects workspace exposure of pairing and journals through a symlinked config parent', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p13-path-')),
  );
  roots.push(root);
  const privateState = join(root, 'state');
  const publicWorkspace = join(root, 'work');
  await mkdir(privateState, { mode: 0o700 });
  await mkdir(publicWorkspace, { mode: 0o700 });
  await symlink(privateState, join(root, 'state-link'));
  vi.stubEnv(
    'ALLRICE_BRIDGE_CONFIG_PATH',
    join(root, 'state-link', 'config.json'),
  );
  await expect(assertWorkspaceExcludesBridgeState(root)).rejects.toThrow(
    'BRIDGE_WORKSPACE_CONTAINS_STATE',
  );
  await expect(
    assertWorkspaceExcludesBridgeState(privateState),
  ).rejects.toThrow('BRIDGE_WORKSPACE_CONTAINS_STATE');
  await expect(
    assertWorkspaceExcludesBridgeState(
      join(privateState, 'config.json.operation-journal'),
    ),
  ).rejects.toThrow('BRIDGE_WORKSPACE_CONTAINS_STATE');
  await expect(
    assertWorkspaceExcludesBridgeState(publicWorkspace),
  ).resolves.toBeUndefined();
});
