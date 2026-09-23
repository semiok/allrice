import { URL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  DSH_WEBUI_PRIVATE_ENTRYPOINT,
  createDshWebUiInvocation,
  resolveDshWebUiEntrypoint,
  spawnDshWebUi,
} from './dsh-webui-compatibility.mjs';

const options = {
  commandOverride: '/approved/dsh-entry.mjs',
  platformPatch: '/config/platform.patch.yml',
  runtimePatch: '/config/runtime.patch.yml',
  upstreamPort: 3080,
  trustedHosts: ['dsh.example.test', 'localhost'],
  adminHome: '/state/dsh-admin',
  credentialsPath: '/secrets/credentials.json',
  inheritedEnvironment: { NODE_ENV: 'test' },
  nodeExecutable: '/usr/bin/node',
};

describe('DSH WebUI compatibility adapter', () => {
  it('isolates the approved private DSH entrypoint behind one adapter', () => {
    expect(DSH_WEBUI_PRIVATE_ENTRYPOINT).toBe('@deepseek-ai/dsh/lib/bin.js');
    expect(
      resolveDshWebUiEntrypoint({
        moduleUrl: new URL('file:///srv/apps/dsh-admin/compatibility.mjs'),
      }),
    ).toBe('/srv/apps/dsh-admin/node_modules/@deepseek-ai/dsh/lib/bin.js');
    expect(
      resolveDshWebUiEntrypoint({ commandOverride: ' /opt/dsh/bin.mjs ' }),
    ).toBe('/opt/dsh/bin.mjs');
  });

  it('preserves the governed WebUI launch contract', () => {
    expect(createDshWebUiInvocation(options)).toEqual({
      executable: '/usr/bin/node',
      args: [
        '--expose-internals',
        '/approved/dsh-entry.mjs',
        '--profile',
        'web',
        '--patch',
        '/config/platform.patch.yml',
        '--patch',
        '/config/runtime.patch.yml',
        '--no-open',
        '--port',
        '3080',
        '--trusted-host',
        'dsh.example.test',
        'localhost',
      ],
      options: {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: {
          NODE_ENV: 'test',
          DSH_HOME: '/state/dsh-admin',
          DSH_CREDENTIALS_PATH: '/secrets/credentials.json',
        },
      },
    });
  });

  it('starts DSH only through the compatibility invocation', () => {
    const child = { on: vi.fn() };
    const spawn = vi.fn(() => child);

    expect(spawnDshWebUi(options, spawn)).toBe(child);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      expect.arrayContaining([
        '--expose-internals',
        '/approved/dsh-entry.mjs',
        '--profile',
        'web',
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ DSH_HOME: '/state/dsh-admin' }),
      }),
    );
  });
});
