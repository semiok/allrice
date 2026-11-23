import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stagePersonVmConfiguration } from './stage-person-vm-config.mjs';
let root: string, release: string, source: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'private-host-stage-')));
  release = join(root, 'release');
  await mkdir(release);
  source = join(root, 'operator-private.json');
  await writeFile(source, '{"synthetic":"private input"}', { mode: 0o600 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('stages explicit private bytes into the original release and leaves no temporary file', async () => {
  await stagePersonVmConfiguration(release, source);
  const target = join(release, '.local/person-vm-host.json');
  expect(await readFile(target, 'utf8')).toBe(await readFile(source, 'utf8'));
  expect((await lstat(target)).mode & 0o777).toBe(0o600);
  await expect(lstat(target + '.tmp')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it.each(['outside', 'inside'] as const)(
  'refuses a %s .local symlink without writing through it',
  async (kind) => {
    const destination = join(
      kind === 'inside' ? release : root,
      'alias-destination',
    );
    await mkdir(destination);
    await symlink(destination, join(release, '.local'));
    await expect(stagePersonVmConfiguration(release, source)).rejects.toThrow(
      'DEV_BUILD_PRIVATE_CONFIG_INVALID',
    );
    await expect(
      lstat(join(destination, 'person-vm-host.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it('refuses .local when it is a regular file instead of a real private directory', async () => {
  await writeFile(join(release, '.local'), 'keep');
  await expect(stagePersonVmConfiguration(release, source)).rejects.toThrow(
    'DEV_BUILD_PRIVATE_CONFIG_INVALID',
  );
  expect(await readFile(join(release, '.local'), 'utf8')).toBe('keep');
});
it.each(['symlink', 'directory', 'public-file'] as const)(
  'refuses an existing %s target without overwriting it',
  async (kind) => {
    const local = join(release, '.local'),
      target = join(local, 'person-vm-host.json');
    await mkdir(local, { mode: 0o700 });
    if (kind === 'symlink') await symlink(source, target);
    else if (kind === 'directory') await mkdir(target);
    else await writeFile(target, 'preserve public file', { mode: 0o644 });
    await expect(stagePersonVmConfiguration(release, source)).rejects.toThrow(
      'DEV_BUILD_PRIVATE_CONFIG_INVALID',
    );
    if (kind === 'symlink')
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
    else if (kind === 'directory')
      expect((await lstat(target)).isDirectory()).toBe(true);
    else expect(await readFile(target, 'utf8')).toBe('preserve public file');
    expect(await readFile(source, 'utf8')).toBe(
      '{"synthetic":"private input"}',
    );
  },
);
it('refuses a temporary collision and preserves the previous target and foreign temporary bytes', async () => {
  const local = join(release, '.local'),
    target = join(local, 'person-vm-host.json');
  await mkdir(local, { mode: 0o700 });
  await writeFile(target, 'old private', { mode: 0o600 });
  await writeFile(target + '.tmp', 'other preparation', { mode: 0o600 });
  await expect(stagePersonVmConfiguration(release, source)).rejects.toThrow(
    'DEV_BUILD_PRIVATE_CONFIG_INVALID',
  );
  expect(await readFile(target, 'utf8')).toBe('old private');
  expect(await readFile(target + '.tmp', 'utf8')).toBe('other preparation');
});
it('replaces an existing private regular file only after validating its directory', async () => {
  await stagePersonVmConfiguration(release, source);
  await writeFile(source, '{"synthetic":"next private input"}');
  await stagePersonVmConfiguration(release, source);
  expect(
    await readFile(join(release, '.local/person-vm-host.json'), 'utf8'),
  ).toBe(await readFile(source, 'utf8'));
});
it('refuses a source alias and a source that is not private', async () => {
  const alias = join(root, 'alias.json');
  await symlink(source, alias);
  await expect(stagePersonVmConfiguration(release, alias)).rejects.toThrow(
    'DEV_BUILD_PRIVATE_CONFIG_INVALID',
  );
  await chmod(source, 0o644);
  await expect(stagePersonVmConfiguration(release, source)).rejects.toThrow(
    'DEV_BUILD_PRIVATE_CONFIG_INVALID',
  );
});
it('does not disclose private contents in an invalid-input error', async () => {
  await chmod(source, 0o644);
  await expect(stagePersonVmConfiguration(release, source)).rejects.toThrow(
    /^DEV_BUILD_PRIVATE_CONFIG_INVALID$/,
  );
});
