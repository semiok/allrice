/** Header-only resource gate, not an image sanitizer. The browser still decodes
 * a fixed raster MIME in <img>; unsupported, animated and oversized input downloads.
 * Never render declared HTML/SVG as an image or inspect a remote URL here. */
export function boundedRaster(bytes: Buffer, mediaType: string): boolean {
  const limit = (w: number, h: number) =>
    w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= 16_000_000;
  try {
    if (mediaType === 'image/png') {
      if (
        bytes.length < 45 ||
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      )
        return false;
      if (
        bytes.readUInt32BE(8) !== 13 ||
        bytes.toString('ascii', 12, 16) !== 'IHDR'
      )
        return false;
      if (!limit(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return false;
      let at = 8;
      while (at + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(at),
          kind = bytes.toString('ascii', at + 4, at + 8);
        if (size > bytes.length - at - 12 || kind === 'acTL') return false;
        at += 12 + size;
        if (kind === 'IEND') return size === 0 && at === bytes.length;
      }
      return false;
    }
    if (mediaType === 'image/jpeg') {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
      let at = 2;
      while (at + 4 <= bytes.length) {
        if (bytes[at++] !== 0xff) return false;
        while (bytes[at] === 0xff) at++;
        const marker = bytes[at++]!;
        if (marker === 0xda || marker === 0xd9) return false;
        const size = bytes.readUInt16BE(at);
        if (size < 2 || at + size > bytes.length) return false;
        if ([0xc0, 0xc1, 0xc2].includes(marker))
          return (
            size >= 8 &&
            limit(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3))
          );
        at += size;
      }
      return false;
    }
    if (mediaType === 'image/webp') {
      if (
        bytes.length < 30 ||
        bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WEBP' ||
        bytes.readUInt32LE(4) + 8 !== bytes.length
      )
        return false;
      const kind = bytes.toString('ascii', 12, 16),
        size = bytes.readUInt32LE(16);
      if (size > bytes.length - 20) return false;
      if (kind === 'VP8X')
        return (
          size >= 10 &&
          !(bytes[20]! & 2) &&
          limit(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
        );
      if (
        kind === 'VP8 ' &&
        size >= 10 &&
        bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
      )
        return limit(
          bytes.readUInt16LE(26) & 0x3fff,
          bytes.readUInt16LE(28) & 0x3fff,
        );
      if (kind === 'VP8L' && size >= 5 && bytes[20] === 0x2f)
        return limit(
          1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
          1 +
            ((bytes[22]! >> 6) |
              (bytes[23]! << 2) |
              ((bytes[24]! & 0xf) << 10)),
        );
    }
    return false;
  } catch {
    return false;
  }
}
