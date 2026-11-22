import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertReadonlyArtifactInspection,
  checkedReadonlyDshDirectory,
  readonlyArtifactReference,
  verifyReadonlyDshDirectory,
  type ReadonlyDshDirectory,
} from './readonly-artifact.ts';

const image =
  'docker.io/library/node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2';
const bins =
  'anthropic-ai-sdk cordis crc32 dsh dsoffice is-docker is-inside-container js-yaml node-which pi-ai playwright playwright-core semver which-command xlsx yaml'.split(
    ' ',
  );
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const roots: string[] = [];
async function remove(path: string) {
  if ((await lstat(path)).isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await remove(join(path, name));
  }
  await rm(path, { force: true, recursive: true });
}
afterEach(async () => {
  for (const path of roots.splice(0)) await remove(path);
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-ro-')));
  roots.push(root);
  const artifactSha256 = sha('small synthetic archive'),
    release = join(root, artifactSha256),
    hostDirectory = join(release, 'public');
  await mkdir(join(hostDirectory, 'node_modules/.bin'), {
    recursive: true,
    mode: 0o700,
  });
  const contents = 'synthetic public code\n';
  await writeFile(join(hostDirectory, 'node_modules/code.js'), contents, {
    mode: 0o444,
  });
  for (const name of bins)
    await symlink('../code.js', join(hostDirectory, 'node_modules/.bin', name));
  const entries = [
    { path: 'node_modules', kind: 'directory', mode: 0o755 },
    { path: 'node_modules/.bin', kind: 'directory', mode: 0o755 },
    {
      path: 'node_modules/code.js',
      kind: 'file',
      mode: 0o644,
      bytes: Buffer.byteLength(contents),
      sha256: sha(contents),
    },
    ...bins.map((name) => ({
      path: `node_modules/.bin/${name}`,
      kind: 'symlink',
      mode: 0o755,
      target: '../code.js',
    })),
  ];
  for (const dir of ['node_modules/.bin', 'node_modules', '.'])
    await chmod(join(hostDirectory, dir), 0o555);
  const manifest = JSON.stringify({
    platform: 'linux-arm64-gnu',
    containsAuthFiles: false,
    archive: { bytes: 512, sha256: artifactSha256 },
    files: entries,
  });
  const c = {
    hostDirectory,
    guestDirectory: `/opt/allrice/dsh/${artifactSha256}`,
    artifactSha256,
    manifestSha256: sha(manifest),
    descriptorPath: join(release, 'descriptor.json'),
  };
  await writeFile(join(release, 'manifest.json'), manifest, { mode: 0o600 });
  async function reseal() {
    const seals: Record<string, string[]> = {};
    for (const path of ['.', ...entries.map((e) => e.path)]) {
      const s = await lstat(join(hostDirectory, path), { bigint: true });
      seals[path] = [String(s.dev), String(s.ino), String(s.ctimeNs)];
    }
    await writeFile(
      c.descriptorPath,
      JSON.stringify({
        kind: 'allrice-dsh-readonly-directory-v1',
        ...c,
        baseImage: image,
        archiveBytes: 512,
        manifestBytes: Buffer.byteLength(manifest),
        dshVersion: '0.2.1-rc.2',
        nodeVersion: '22.23.2',
        publisherSha256: sha('synthetic publisher'),
        gateSha256: sha('synthetic gate'),
        seals,
      }),
      { mode: 0o600 },
    );
  }
  await reseal();
  return { root, c, entries, reseal };
}
const signal = () => new AbortController().signal;
function inspection(c: ReadonlyDshDirectory) {
  const config = {
    mounts: [
      {
        type: 'Bind',
        host: c.hostDirectory,
        guest: c.guestDirectory,
        options: { readonly: true, noexec: false, nosuid: false, nodev: false },
        stat_virtualization: 'strict',
        host_permissions: 'private',
        follow_root_symlinks: false,
        quota_mib: null,
      },
    ],
  };
  return {
    name: 'allrice-test',
    status: 'Running',
    config,
    active_config: structuredClone(config),
    pending_changes: [] as unknown[],
  };
}

it('actual sealed files and all16 links qualify; config is a frozen host copy', async () => {
  const { c } = await fixture(),
    config = checkedReadonlyDshDirectory(c);
  await expect(
    verifyReadonlyDshDirectory(config, image, signal()),
  ).resolves.toBe(sha(await readFile(c.descriptorPath, 'utf8')));
  expect(Object.isFrozen(config)).toBe(true);
  c.hostDirectory = '/different';
  expect(config.hostDirectory).not.toBe(c.hostDirectory);
  for (const name of bins)
    expect(
      await readlink(join(config.hostDirectory, 'node_modules/.bin', name)),
    ).toBe('../code.js');
});
it('full actual byte hash rejects tampering even if local seal metadata was refreshed', async () => {
  const f = await fixture(),
    path = join(f.c.hostDirectory, 'node_modules/code.js');
  await chmod(path, 0o644);
  await writeFile(path, 'changed public bytes\n');
  await chmod(path, 0o444);
  await f.reseal(); // Explicitly removes the inode/time guard to exercise actual content verification.
  await expect(
    verifyReadonlyDshDirectory(f.c, image, signal()),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
});
it('missing, extra, changed mode, linked root and substituted symlink targets all reject', async () => {
  for (const mutate of [
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(join(f.c.hostDirectory, 'node_modules/code.js'), 0o644);
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(f.c.hostDirectory, 0o755);
      await writeFile(join(f.c.hostDirectory, 'extra'), 'no');
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(join(f.c.hostDirectory, 'node_modules/.bin'), 0o755);
      const p = join(f.c.hostDirectory, 'node_modules/.bin/dsh');
      await rm(p);
      await symlink('/outside', p);
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(join(f.c.hostDirectory, 'node_modules'), 0o755);
      await rm(join(f.c.hostDirectory, 'node_modules/code.js'));
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await rm(f.c.descriptorPath);
    },
  ]) {
    const f = await fixture();
    await mutate(f);
    await expect(
      verifyReadonlyDshDirectory(f.c, image, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  }
  const f = await fixture(),
    aliasParent = join(f.root, 'aliases');
  await mkdir(aliasParent);
  const alias = join(aliasParent, f.c.artifactSha256);
  await symlink(dirname(f.c.hostDirectory), alias);
  const linked = {
    ...f.c,
    hostDirectory: join(alias, 'public'),
    descriptorPath: join(alias, 'descriptor.json'),
  };
  expect(() => checkedReadonlyDshDirectory(linked)).not.toThrow();
  await expect(
    verifyReadonlyDshDirectory(linked, image, signal()),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
});
it('wrong source pins, metadata permissions and already aborted reads cannot qualify', async () => {
  const f = await fixture();
  await expect(
    verifyReadonlyDshDirectory(
      { ...f.c, manifestSha256: 'a'.repeat(64) },
      image,
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  await expect(
    verifyReadonlyDshDirectory(f.c, 'other-image', signal()),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  await chmod(f.c.descriptorPath, 0o644);
  await expect(
    verifyReadonlyDshDirectory(f.c, image, signal()),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    verifyReadonlyDshDirectory(f.c, image, controller.signal),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
});
it('per-VM0600 derived receipt is create-only, exact, and does not confuse epoch with persisted code', async () => {
  const f = await fixture(),
    home = join(f.root, 'encrypted-msb-home');
  await mkdir(home, { mode: 0o700 });
  const descriptorSha256 = sha(await readFile(f.c.descriptorPath, 'utf8'));
  const binding = {
    vmId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 1,
  };
  await expect(
    readonlyArtifactReference(
      home,
      binding,
      f.c,
      false,
      signal(),
      descriptorSha256,
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  await readonlyArtifactReference(
    home,
    binding,
    f.c,
    true,
    signal(),
    descriptorSha256,
  );
  const path = join(home, 'allrice-readonly-dsh.json');
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  await readonlyArtifactReference(
    home,
    { ...binding, instanceId: randomUUID(), leaseEpoch: 2 },
    f.c,
    false,
    signal(),
    descriptorSha256,
  );
  await expect(
    readonlyArtifactReference(
      home,
      { ...binding, personId: randomUUID() },
      f.c,
      true,
      signal(),
      descriptorSha256,
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  await expect(
    readonlyArtifactReference(
      home,
      binding,
      f.c,
      false,
      signal(),
      'a'.repeat(64),
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  expect(JSON.parse(await readFile(path, 'utf8')).personId).toBe(
    binding.personId,
  );
});
it('real public inspect desired/active readonly fields are all required; no legacy/extra/pending fallback', async () => {
  const { c } = await fixture();
  expect(() =>
    assertReadonlyArtifactInspection(inspection(c), 'allrice-test', c, true),
  ).not.toThrow();
  for (const modify of [
    (v: ReturnType<typeof inspection>) => {
      v.name = 'wrong-vm';
    },
    (v: ReturnType<typeof inspection>) => {
      v.status = 'Stopped';
    },
    (v: ReturnType<typeof inspection>) => {
      v.active_config.mounts = [];
    },
    (v: ReturnType<typeof inspection>) => {
      v.pending_changes.push({ field: 'unrelated' });
    },
    (v: ReturnType<typeof inspection>) => {
      v.config.mounts.push(structuredClone(v.config.mounts[0]!));
    },
    ...[
      'host',
      'guest',
      'type',
      'stat_virtualization',
      'host_permissions',
      'follow_root_symlinks',
      'quota_mib',
    ].map((field) => (v: ReturnType<typeof inspection>) => {
      Object.assign(v.config.mounts[0]!, { [field]: 'wrong' });
    }),
    ...['readonly', 'noexec', 'nosuid', 'nodev'].map(
      (field) => (v: ReturnType<typeof inspection>) => {
        Object.assign(v.active_config.mounts[0]!.options, {
          [field]: field !== 'readonly',
        });
      },
    ),
    (v: ReturnType<typeof inspection>) => {
      Object.assign(v.config.mounts[0]!, { readonly: true });
    },
    (v: ReturnType<typeof inspection>) => {
      Object.assign(v.config.mounts[0]!.options, { override_uid: 0 });
    },
  ]) {
    const v = inspection(c);
    modify(v);
    expect(() =>
      assertReadonlyArtifactInspection(v, 'allrice-test', c, true),
    ).toThrow('PROVIDER_FAILED');
  }
  const stopped = { ...inspection(c), status: 'Stopped', active_config: null };
  expect(() =>
    assertReadonlyArtifactInspection(stopped, 'allrice-test', c, false),
  ).not.toThrow();
  expect(() =>
    assertReadonlyArtifactInspection(
      { ...stopped, active_config: undefined },
      'allrice-test',
      c,
      false,
    ),
  ).toThrow('PROVIDER_FAILED');
});
