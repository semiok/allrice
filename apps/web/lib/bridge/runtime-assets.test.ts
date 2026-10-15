import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  openManagedPythonPayload,
  managedRuntimeAssetResponse,
} from './runtime-assets';
const mocks = vi.hoisted(() => ({ release: vi.fn(), nodeRelease: vi.fn() }));
vi.mock('@allrice/contracts', () => ({
  managedPythonPayloadForPlatform: mocks.release,
  managedNodePayloadForPlatform: mocks.nodeRelease,
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
it('uses the same fixed SHA and byte checks for the additional Node runtime archive', async () => {
  const f = await fixture();
  mocks.release.mockReturnValue(null);
  mocks.nodeRelease.mockImplementation((platform) =>
    platform === 'macos-x64' ? f.release : null,
  );
  const opened = await openManagedPythonPayload('linux-amd64', f.archive);
  expect(opened).not.toBeNull();
  await opened!.handle.close();
  expect(await openManagedPythonPayload('linux-arm64', f.archive)).toBeNull();
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

it.each(['bytes=4-', 'bytes=4-8', 'bytes=-5'])(
  'serves exact verified bytes for %s with strong validators',
  async (range) => {
    const f = await fixture();
    const opened = await openManagedPythonPayload('linux-amd64', f.archive);
    const response = await managedRuntimeAssetResponse(
      new Request('https://assets.example/runtime', {
        headers: { Range: range, 'If-Range': `"${f.release.archive.sha256}"` },
      }),
      opened!,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('etag')).toBe(`"${f.release.archive.sha256}"`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      range === 'bytes=-5'
        ? f.bytes.subarray(-5)
        : f.bytes.subarray(4, range === 'bytes=4-8' ? 9 : undefined),
    );
  },
);
it.each(['bytes=999-', 'bytes=6-2', 'bytes=0-3,5-9', 'bytes=-0', 'bytes=-'])(
  'rejects unsatisfiable or unsupported %s',
  async (range) => {
    const f = await fixture();
    const response = await managedRuntimeAssetResponse(
      new Request('https://assets.example/runtime', {
        headers: { Range: range },
      }),
      (await openManagedPythonPayload('linux-amd64', f.archive))!,
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(
      `bytes */${f.bytes.length}`,
    );
    expect(await response.text()).toBe('');
  },
);
it('falls back to a full response for a changed validator and ignores Range on HEAD', async () => {
  const f = await fixture();
  for (const method of ['GET', 'HEAD']) {
    const response = await managedRuntimeAssetResponse(
      new Request('https://assets.example/runtime', {
        method,
        headers: { Range: 'bytes=4-', 'If-Range': '"old"' },
      }),
      (await openManagedPythonPayload('linux-amd64', f.archive))!,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(f.bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      method === 'GET' ? f.bytes : Buffer.alloc(0),
    );
  }
});
