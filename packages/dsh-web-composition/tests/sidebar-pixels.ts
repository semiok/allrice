import { inflateSync } from 'node:zlib';

/** Decode Chromium's non-interlaced, 8-bit RGB/RGBA screenshots, without
 * comparing PNG compression bytes or excluding antialiased/text pixels. */
export function screenshotPixels(png: Buffer) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('Screenshot is not a PNG');
  let width = 0,
    height = 0,
    channels = 0;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (!channels || data[8] !== 8 || data[10] || data[11] || data[12])
        throw new Error('Unsupported screenshot PNG encoding');
    }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (!width || !height || !channels) throw new Error('Missing PNG header');
  const stride = width * channels;
  const encoded = inflateSync(Buffer.concat(chunks));
  if (encoded.length !== height * (stride + 1))
    throw new Error('Incomplete screenshot PNG pixels');
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = encoded[y * (stride + 1)]!;
    if (filter > 4) throw new Error('Unsupported PNG row filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? raw[i - channels]! : 0;
      const up = y ? raw[i - stride]! : 0;
      const diagonal = y && x >= channels ? raw[i - stride - channels]! : 0;
      const p = left + up - diagonal;
      const pa = Math.abs(p - left),
        pb = Math.abs(p - up),
        pc = Math.abs(p - diagonal);
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : pa <= pb && pa <= pc
                  ? left
                  : pb <= pc
                    ? up
                    : diagonal;
      raw[i] = (encoded[y * (stride + 1) + x + 1]! + predictor) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < channels; c++) rgba[i * 4 + c] = raw[i * channels + c]!;
  return { width, height, rgba };
}

/** Exact pixel gate for two captures in the same context. A public token
 * difference is reported as a difference; there are no masks or tolerances. */
export function compareSidebarPixels(expectedPng: Buffer, actualPng: Buffer) {
  const expected = screenshotPixels(expectedPng),
    actual = screenshotPixels(actualPng);
  const dimensionsMatch =
    expected.width === actual.width && expected.height === actual.height;
  let changedPixels = 0,
    maxChannelDelta = 0;
  let firstDifference: { x: number; y: number } | null = null;
  if (dimensionsMatch)
    for (let i = 0; i < expected.width * expected.height; i++) {
      let changed = false;
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(
          expected.rgba[i * 4 + c]! - actual.rgba[i * 4 + c]!,
        );
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        changed ||= delta !== 0;
      }
      if (changed) {
        changedPixels++;
        firstDifference ??= {
          x: i % expected.width,
          y: Math.floor(i / expected.width),
        };
      }
    }
  return {
    expected: { width: expected.width, height: expected.height },
    actual: { width: actual.width, height: actual.height },
    dimensionsMatch,
    changedPixels: dimensionsMatch ? changedPixels : null,
    maxChannelDelta: dimensionsMatch ? maxChannelDelta : null,
    firstDifference,
  };
}
