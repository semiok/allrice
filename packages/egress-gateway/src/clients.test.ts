import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { RequestContext } from '@allrice/contracts';
import { createEgressGateway } from './gateway.js';
import { createPackageMirrorRoutes } from './routes.js';
import type { GuestEgressAccess } from './contract.js';

const exec = promisify(execFile);

it('npm and pip install dependency graphs through authenticated mirror HTTP with no external upstream', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'egress-clients-')));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw Error('address');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const blobs = new Map<string, Buffer>();
  const metadata = new Map<string, unknown>();
  let capability: GuestEgressAccess | undefined;
  const binding = {
    vmId: 'fixture',
    personId: 'fixture',
    organizationId: 'fixture',
    instanceId: 'fixture',
    leaseEpoch: 1,
  };
  const requests: string[] = [];
  const gateway = createEgressGateway({
    policy: {
      routes: createPackageMirrorRoutes({
        npmOrigin: 'https://registry.npmjs.org',
        pypiOrigin: 'https://pypi.org',
        pythonFilesOrigin: 'https://files.pythonhosted.org',
        maxResponseBytes: 1000000,
        timeoutMs: 10000,
        maxArtifacts: 20,
      }),
    },
    provisioner: {
      endpoint: async () => ({ host: '127.0.0.1', port, guestOrigin: origin }),
      install: async (_b, access) => {
        capability = access;
      },
      remove: async () => {},
    },
    vm: { assertCurrentBinding: async () => {} },
    authority: {
      context: async () => ({}) as RequestContext,
      allow: async () => {},
    },
    revokeModel: async () => {},
    transport: {
      read: async (url) => {
        requests.push(url.href);
        const body = blobs.get(url.href);
        if (body)
          return { status: 200, body, contentType: 'application/octet-stream' };
        if (!metadata.has(url.href))
          throw Error('unregistered fixture upstream');
        return {
          status: 200,
          body: Buffer.from(JSON.stringify(metadata.get(url.href))),
          contentType: 'application/json',
        };
      },
    },
  });
  let receipt: Awaited<ReturnType<typeof gateway.prepare>> | undefined;
  try {
    for (const name of ['egress-child', 'egress-parent']) {
      const directory = join(root, name);
      await mkdir(join(directory, 'package'), { recursive: true });
      const manifest = {
        name,
        version: '1.0.0',
        ...(name === 'egress-parent'
          ? { dependencies: { 'egress-child': '1.0.0' } }
          : {}),
      };
      await writeFile(
        join(directory, 'package/package.json'),
        JSON.stringify(manifest),
      );
      await writeFile(
        join(directory, 'package/index.js'),
        'module.exports = 42;',
      );
      await exec('tar', [
        '-czf',
        join(directory, 'package.tgz'),
        '-C',
        directory,
        'package',
      ]);
      const bytes = await readFile(join(directory, 'package.tgz'));
      const target = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;
      blobs.set(target, bytes);
      metadata.set(`https://registry.npmjs.org/${name}`, {
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            ...manifest,
            dist: {
              tarball: target,
              integrity:
                'sha512-' + createHash('sha512').update(bytes).digest('base64'),
            },
          },
        },
      });
    }
    // Generate two valid wheels using only Python's standard library; no registry downloads.
    await exec('python3', [
      '-c',
      `import zipfile,sys,pathlib
root=pathlib.Path(sys.argv[1])
for name in ['egress_child','egress_parent']:
 p=root/(name+'-1.0.0-py3-none-any.whl')
 with zipfile.ZipFile(p,'w') as z:
  z.writestr(name+'.py','VALUE = 42\\n')
  info=name+'-1.0.0.dist-info/'
  z.writestr(info+'METADATA','Metadata-Version: 2.1\\nName: '+name+'\\nVersion: 1.0.0\\n'+('Requires-Dist: egress-child==1.0.0\\n' if name=='egress_parent' else '')+'\\n')
  z.writestr(info+'WHEEL','Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
  z.writestr(info+'RECORD','')
`,
      root,
    ]);
    for (const name of ['egress-child', 'egress-parent']) {
      const filename = name.replaceAll('-', '_') + '-1.0.0-py3-none-any.whl';
      const bytes = await readFile(join(root, filename));
      const target = 'https://files.pythonhosted.org/packages/' + filename;
      blobs.set(target, bytes);
      metadata.set(`https://pypi.org/pypi/${name}/json`, {
        info: { name },
        releases: {
          '1.0.0': [
            {
              filename,
              url: target,
              digests: {
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
              requires_python: '>=3',
              yanked: false,
            },
          ],
        },
      });
    }
    receipt = await gateway.prepare(binding, new AbortController().signal);
    await writeFile(
      join(root, '.npmrc'),
      `registry=${origin}/npm/\n//127.0.0.1:${port}/:_authToken=${capability!.capability}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, '.netrc'),
      `machine 127.0.0.1 login egress password ${capability!.capability}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'client-fixture', private: true }),
    );
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      NO_PROXY: '127.0.0.1',
      npm_config_userconfig: join(root, '.npmrc'),
      npm_config_cache: join(root, 'npm-cache'),
      PIP_CONFIG_FILE: '/dev/null',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      NETRC: join(root, '.netrc'),
    };
    await exec(
      'npm',
      ['install', '--no-audit', '--no-fund', 'egress-parent@1.0.0'],
      { cwd: root, env, timeout: 20000 },
    );
    expect(
      JSON.parse(
        await readFile(
          join(root, 'node_modules/egress-child/package.json'),
          'utf8',
        ),
      ).version,
    ).toBe('1.0.0');
    await exec(
      'python3',
      [
        '-m',
        'pip',
        'install',
        '--no-input',
        '--no-cache-dir',
        '--index-url',
        origin + '/python/simple/',
        '--trusted-host',
        '127.0.0.1',
        '--target',
        join(root, 'python-target'),
        'egress-parent==1.0.0',
      ],
      { cwd: root, env, timeout: 20000 },
    );
    expect(
      await readFile(join(root, 'python-target/egress_child.py'), 'utf8'),
    ).toContain('42');
    expect(requests.some((url) => url.endsWith('.whl'))).toBe(true);
    expect(requests.some((url) => url.endsWith('.tgz'))).toBe(true);
  } finally {
    if (receipt)
      await gateway.revoke(receipt, 'stop', new AbortController().signal);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
