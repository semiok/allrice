import { describe, expect, it } from 'vitest';
import { boundedRaster } from './raster-preview';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2QAAAAASUVORK5CYII=',
  'base64',
);
describe('static raster header gate', () => {
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
