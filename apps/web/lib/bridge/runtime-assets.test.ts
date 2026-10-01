import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openManagedPythonPayload } from './runtime-assets';
const mocks = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock('@allrice/contracts', () => ({
  managedPythonPayloadForPlatform: mocks.release,
}));
let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'allrice-runtime-assets-'));
  vi.stubEnv('ALLRICE_BRIDGE_RUNTIME_ASSET_DIR', directory);
  const bytes = Buffer.from('fixed runtime software fixture'),
    sha = createHash('sha256').update(bytes).digest('hex');
  const release = {
    archive: {
      fileName: 'office-python-amd64.docker.tar.gz',
      sha256: `sha256:${sha}`,
      sizeBytes: bytes.length,
    },
  };
  mocks.release.mockImplementation((platform) =>
    platform === 'macos-x64' ? release : null,
  );
  await writeFile(join(directory, release.archive.fileName), bytes);
  return { bytes, archive: `${sha}.docker.tar.gz`, release };
}
it('streams exactly the opened and hash-verified fixed software bytes', async () => {
  const f = await fixture(),
    result = await openManagedPythonPayload('linux-amd64', f.archive);
  expect(result).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of result!.handle.createReadStream({
    start: 0,
    autoClose: true,
  }))
    chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(f.bytes);
});
it('rejects unknown architecture, SHA, missing configuration, corruption and oversized releases', async () => {
  const f = await fixture();
  expect(await openManagedPythonPayload('linux-arm64', f.archive)).toBeNull();
  expect(await openManagedPythonPayload('linux-amd64', '../.env')).toBeNull();
  expect(
    await openManagedPythonPayload(
      'linux-amd64',
      `${'b'.repeat(64)}.docker.tar.gz`,
    ),
  ).toBeNull();
  await writeFile(
    join(directory!, f.release.archive.fileName),
    Buffer.alloc(f.bytes.length, 120),
  );
  expect(await openManagedPythonPayload('linux-amd64', f.archive)).toBeNull();
  mocks.release.mockReturnValue({
    archive: { ...f.release.archive, sizeBytes: 256 * 1024 * 1024 + 1 },
  });
  expect(await openManagedPythonPayload('linux-amd64', f.archive)).toBeNull();
  vi.stubEnv('ALLRICE_BRIDGE_RUNTIME_ASSET_DIR', '');
  expect(await openManagedPythonPayload('linux-amd64', f.archive)).toBeNull();
});
it('rejects a symlink even when its target has the expected bytes', async () => {
  const f = await fixture(),
    asset = join(directory!, f.release.archive.fileName),
    target = join(directory!, 'different-file');
  await writeFile(target, f.bytes);
  await rm(asset);
  await symlink(target, asset);
  expect(await openManagedPythonPayload('linux-amd64', f.archive)).toBeNull();
});
