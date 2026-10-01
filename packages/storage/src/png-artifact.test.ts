import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  validatePngArtifact,
  type PngArtifactValidation,
} from './png-artifact.ts';

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const report = (content = bytes): PngArtifactValidation => ({
  checker: 'pillow-11.3.0',
  width: 1,
  height: 1,
  checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
});

describe('PNG captured-byte publication boundary', () => {
  it('requires the isolated decoder report and matches checksum and dimensions', () => {
    expect(validatePngArtifact(bytes, report())).toEqual(report());
    for (const proof of [
      undefined,
      { ...report(), width: 2 },
      { ...report(), checksum: `sha256:${'0'.repeat(64)}` },
    ])
      expect(() => validatePngArtifact(bytes, proof)).toThrow();
    const changed = Buffer.from(bytes);
    changed[40] = changed[40]! ^ 1;
    expect(() => validatePngArtifact(changed, report())).toThrow();
  });

  it('enforces the native raster preview dimensions/pixels and total byte ceiling', () => {
    for (const [width, height] of [
      [8193, 1],
      [4001, 4000],
      [0, 1],
    ]) {
      const changed = Buffer.from(bytes);
      changed.writeUInt32BE(width!, 16);
      changed.writeUInt32BE(height!, 20);
      expect(() =>
        validatePngArtifact(changed, {
          ...report(changed),
          width: width!,
          height: height!,
        }),
      ).toThrow();
    }
    const large = Buffer.alloc(4000001);
    expect(() => validatePngArtifact(large, report(large))).toThrow();
    expect(() =>
      validatePngArtifact(Buffer.from('not an image'), report()),
    ).toThrow();
  });
});
