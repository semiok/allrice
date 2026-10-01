import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  buildPayload,
  imageMeasurements,
  parseRequirements,
  verifyBytes,
} from './build-managed-python-payload.mjs';

const amd64Lock = await readFile(
  new URL('../infra/managed-python/requirements-amd64.lock', import.meta.url),
  'utf8',
);
const arm64Lock = await readFile(
  new URL('../infra/managed-python/requirements-arm64.lock', import.meta.url),
  'utf8',
);

describe('fixed managed Python payload release inputs', () => {
  it('locks the same package versions to independently pinned architecture wheels', () => {
    const amd64 = parseRequirements(amd64Lock);
    const arm64 = parseRequirements(arm64Lock);
    expect(amd64.map(({ name, version }) => ({ name, version }))).toEqual(
      arm64.map(({ name, version }) => ({ name, version })),
    );
    expect(amd64).toContainEqual(
      expect.objectContaining({ name: 'pillow', version: '11.3.0' }),
    );
    expect(amd64).toContainEqual(
      expect.objectContaining({ name: 'python-docx', version: '1.2.0' }),
    );
    expect(amd64.find(({ name }) => name === 'numpy').sha256).not.toBe(
      arm64.find(({ name }) => name === 'numpy').sha256,
    );
  });

  it('rejects absent/multiple hashes, unpinned dependencies and duplicate package names', () => {
    expect(() =>
      parseRequirements(amd64Lock.replace(/\s+--hash=sha256:[a-f0-9]{64}/, '')),
    ).toThrow();
    expect(() =>
      parseRequirements(
        amd64Lock.replace(/(--hash=sha256:[a-f0-9]{64})/, '$1\n    $1'),
      ),
    ).toThrow();
    expect(() =>
      parseRequirements(amd64Lock.replace('pillow==11.3.0', 'pillow>=11.3.0')),
    ).toThrow();
    expect(() =>
      parseRequirements(amd64Lock.replace('pillow==11.3.0', 'numpy==11.3.0')),
    ).toThrow('requirements_duplicate');
  });

  it('rejects input mutation even when the expected size or checksum alone matches', () => {
    const bytes = Buffer.from('fixed payload bytes');
    const expected = {
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    expect(() => verifyBytes(bytes, expected)).not.toThrow();
    expect(() =>
      verifyBytes(Buffer.from('Fixed payload bytes'), expected),
    ).toThrow('payload_input_changed');
    expect(() =>
      verifyBytes(bytes, { ...expected, sizeBytes: bytes.length + 1 }),
    ).toThrow('payload_input_changed');
  });

  it('rejects an unapproved architecture or implicit Docker context before touching release files', async () => {
    await expect(buildPayload({ architecture: 'ppc64le' })).rejects.toThrow(
      'unsupported_architecture',
    );
    await expect(
      buildPayload({ architecture: 'amd64', socket: 'default' }),
    ).rejects.toThrow('explicit_unix_socket_required');
  });

  it('counts unpacked layers instead of only compressed content on the containerd store', () => {
    const image = { Id: 'sha256:fixed', Size: 200, Descriptor: {} };
    expect(imageMeasurements(image, { Id: image.Id, Size: 760 })).toMatchObject(
      {
        imageSizeBytes: 560,
        imageContentSizeBytes: 200,
        imageStorageSizeBytes: 760,
      },
    );
    expect(
      imageMeasurements(
        { Id: image.Id, Size: 560 },
        { Id: image.Id, Size: 560 },
      ),
    ).toMatchObject({
      imageSizeBytes: 560,
      imageContentSizeBytes: null,
    });
    expect(() =>
      imageMeasurements(image, { Id: 'different', Size: 760 }),
    ).toThrow();
    expect(() =>
      imageMeasurements(image, { Id: image.Id, Size: 150 }),
    ).toThrow();
  });
});
