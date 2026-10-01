import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validatePngArtifact } from '@allrice/storage';
import { boundedRaster } from './raster-preview';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2QAAAAASUVORK5CYII=',
  'base64',
);
describe('static raster header gate', () => {
  it('previews the actual fixed-Python Chinese chart through the existing raster path', () => {
    // Captured from the fixed image and synthetic CSV, not tenant content.
    // The physical suite separately verifies trusted Pillow decoding.
    const chart = readFileSync(
      new URL('./fixtures/met166-cjk-chart.png', import.meta.url),
    );
    const proof = {
      checker: 'pillow-11.3.0' as const,
      checksum:
        'sha256:83780a798b38c1ee8b7b15a11ad67e6673282c041cb63f9d7cdf35d92eb14237',
      width: 1080,
      height: 600,
    };
    expect(validatePngArtifact(chart, proof)).toEqual(proof);
    expect(boundedRaster(chart, 'image/png')).toBe(true);
    expect(boundedRaster(chart, 'text/plain')).toBe(false);
  });

  it('allows bounded PNG but rejects MIME spoofing, truncation and huge pixels', () => {
    expect(boundedRaster(png, 'image/png')).toBe(true);
    for (const type of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/svg+xml',
    ])
      expect(boundedRaster(Buffer.from('<svg onload="alert(1)"/>'), type)).toBe(
        false,
      );
    for (let length = 0; length < png.length; length++)
      expect(boundedRaster(png.subarray(0, length), 'image/png')).toBe(false);
    const big = Buffer.from(png);
    big.writeUInt32BE(8000, 16);
    big.writeUInt32BE(8000, 20);
    expect(boundedRaster(big, 'image/png')).toBe(false);
    const animated = Buffer.from(png);
    animated.write('acTL', 37, 'ascii');
    expect(boundedRaster(animated, 'image/png')).toBe(false);
  });
  it('bounds JPEG SOF dimensions and fails closed on malformed segments', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0, 8, 8, 0, 2, 0, 3, 1]);
    expect(boundedRaster(jpg, 'image/jpeg')).toBe(true);
    jpg.writeUInt16BE(9000, 9);
    expect(boundedRaster(jpg, 'image/jpeg')).toBe(false);
    jpg.writeUInt16BE(65535, 4);
    expect(boundedRaster(jpg, 'image/jpeg')).toBe(false);
  });
  it('rejects animated and unbounded WebP containers', () => {
    const webp = Buffer.alloc(30);
    webp.write('RIFF');
    webp.writeUInt32LE(22, 4);
    webp.write('WEBPVP8X', 8);
    webp.writeUInt32LE(10, 16);
    expect(boundedRaster(webp, 'image/webp')).toBe(true);
    webp[20] = 2;
    expect(boundedRaster(webp, 'image/webp')).toBe(false);
    webp[20] = 0;
    webp.writeUIntLE(8192, 24, 3);
    expect(boundedRaster(webp, 'image/webp')).toBe(false);
    webp.writeUInt32LE(100, 4);
    expect(boundedRaster(webp, 'image/webp')).toBe(false);
  });
});
