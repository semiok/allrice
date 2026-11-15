import { describe, expect, it } from 'vitest';
import {
  inspectReferenceImage,
  referenceReadCapabilities,
} from './reference-image.ts';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
describe('server-owned image eligibility facts', () => {
  it('requires complete static container metadata within dimensions, pixels and bytes', () => {
    const fact = inspectReferenceImage(png);
    expect(fact).toMatchObject({
      mediaType: 'image/png',
      width: 1,
      height: 1,
      static: true,
    });
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(8193, 16);
    const pixelLimit = Buffer.from(png);
    pixelLimit.writeUInt32BE(8192, 16);
    pixelLimit.writeUInt32BE(8192, 20);
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8);
    animation.write('acTL', 4);
    for (const value of [
      Buffer.from('fake.png'),
      png.subarray(0, 30),
      png.subarray(0, png.length - 1),
      oversized,
      pixelLimit,
      Buffer.alloc(20 * 1024 * 1024 + 1),
      Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]),
    ])
      expect(inspectReferenceImage(value)).toBeNull();
  });
  it('never promotes unverified MIME, stale facts, revoked copies or legacy images', () => {
    const fact = inspectReferenceImage(png)!;
    const input = {
      publication: true,
      available: true,
      textReady: false,
      definition: { referenceImageFacts: fact },
      checksum: fact.checksum,
      sizeBytes: png.length,
    };
    expect(referenceReadCapabilities(input)).toEqual({
      text: false,
      image: true,
      archive: false,
    });
    for (const patch of [
      { definition: {} },
      { checksum: `sha256:${'a'.repeat(64)}` },
      { available: false },
      { publication: false },
      { sizeBytes: png.length + 1 },
    ])
      expect(referenceReadCapabilities({ ...input, ...patch }).image).toBe(
        false,
      );
    expect(
      referenceReadCapabilities({
        ...input,
        definition: {},
        publication: false,
        textReady: true,
      }).text,
    ).toBe(true);
  });
});
