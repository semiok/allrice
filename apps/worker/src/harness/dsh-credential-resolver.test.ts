import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DeploymentDshCredentialResolver } from './dsh-credential-resolver.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.ALLRICE_DSH_CREDENTIALS_JSON;
  delete process.env.ALLRICE_DSH_CREDENTIALS_FILE;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('DeploymentDshCredentialResolver', () => {
  it('resolves only a binding matching the frozen tenant context', async () => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    process.env.ALLRICE_DSH_CREDENTIALS_JSON = JSON.stringify({
      'tenant:deepseek': {
        organizationId,
        workspaceId,
        ownerId,
        apiKey: 'tenant-secret',
      },
    });
    const resolver = new DeploymentDshCredentialResolver();
    await expect(
      resolver.resolve({
        reference: 'tenant:deepseek',
        organizationId,
        workspaceId,
        ownerId,
        route: 'deepseek-official',
      }),
    ).resolves.toEqual({ apiKey: 'tenant-secret' });
    await expect(
      resolver.resolve({
        reference: 'tenant:deepseek',
        organizationId,
        workspaceId: randomUUID(),
        ownerId,
        route: 'deepseek-official',
      }),
    ).rejects.toThrow('unavailable');
  });

  it('supports an explicitly deployment-scoped binding', async () => {
    process.env.ALLRICE_DSH_CREDENTIALS_JSON = JSON.stringify({
      'deployment:deepseek-default': {
        scope: 'deployment',
        apiKey: 'deployment-secret',
      },
    });
    await expect(
      new DeploymentDshCredentialResolver().resolve({
        reference: 'deployment:deepseek-default',
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        ownerId: randomUUID(),
        route: 'deepseek-official',
      }),
    ).resolves.toEqual({ apiKey: 'deployment-secret' });
  });

  it('loads deployment credentials from a private file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-dsh-secret-'));
    temporaryDirectories.push(directory);
    const credentialFile = join(directory, 'credentials.json');
    await writeFile(
      credentialFile,
      JSON.stringify({
        'deployment:minimax-default': {
          scope: 'deployment',
          apiKey: 'minimax-secret',
        },
      }),
      { mode: 0o600 },
    );
    process.env.ALLRICE_DSH_CREDENTIALS_FILE = credentialFile;

    await expect(
      new DeploymentDshCredentialResolver().resolve({
        reference: 'deployment:minimax-default',
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        ownerId: randomUUID(),
        route: 'openai-compatible',
      }),
    ).resolves.toEqual({ apiKey: 'minimax-secret' });
  });
});
