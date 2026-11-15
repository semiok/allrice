import { createHash } from 'node:crypto';
import {
  ReferenceImageFactsSchema,
  referenceImagePolicy,
  type ReferenceImageFacts,
} from '@allrice/contracts';

/** Bounded container inspection only. The public DSH store owns full decode,
 * normalization and durable image identity at the actual tool read. */
export function inspectReferenceImage(
  bytes: Buffer,
  enforceLimits = true,
): ReferenceImageFacts | null {
  if (
    !bytes.length ||
    (enforceLimits && bytes.length > referenceImagePolicy.maximumBytes)
  )
    return null;
  let mediaType: 'image/png' | 'image/jpeg',
    width = 0,
    height = 0;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    mediaType = 'image/png';
    if (
      bytes.length < 33 ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      return null;
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    let end = false,
      hasImageData = false;
    for (let at = 8; at < bytes.length;) {
      if (at + 12 > bytes.length) return null;
      const size = bytes.readUInt32BE(at),
        kind = bytes.toString('ascii', at + 4, at + 8);
      if (
        size > bytes.length - at - 12 ||
        kind === 'acTL' ||
        kind === 'fcTL' ||
        kind === 'fdAT'
      )
        return null;
      if (kind === 'IDAT') hasImageData = true;
      if (kind === 'IHDR' && at !== 8) return null;
      at += size + 12;
      if (kind === 'IEND') {
        end = size === 0 && at === bytes.length;
        break;
      }
    }
    if (!end || !hasImageData) return null;
  } else if (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8) {
    mediaType = 'image/jpeg';
    let scan = false,
      inScan = false,
      ended = false;
    for (let at = 2; at < bytes.length;) {
      if (inScan) {
        while (at < bytes.length && bytes[at] !== 0xff) at++;
      }
      if (bytes[at++] !== 0xff) return null;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === undefined) return null;
      if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)))
        continue;
      if (marker === 0xd9) {
        ended = at === bytes.length;
        break;
      }
      if (marker === 0 || marker === 0xd8) return null;
      inScan = false;
      if (at + 2 > bytes.length) return null;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || size > bytes.length - at) return null;
      if (
        marker === 0xe2 &&
        bytes.toString('ascii', at + 2, at + 6) === 'MPF\0'
      )
        return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8 || width || height) return null;
        height = bytes.readUInt16BE(at + 3);
        width = bytes.readUInt16BE(at + 5);
      }
      at += size;
      if (marker === 0xda) {
        scan = true;
        inScan = true;
      }
    }
    if (!scan || !ended) return null;
  } else return null;
  if (
    !width ||
    !height ||
    (enforceLimits &&
      (width > referenceImagePolicy.maximumDimension ||
        height > referenceImagePolicy.maximumDimension ||
        width * height > referenceImagePolicy.maximumPixels))
  )
    return null;
  return {
    checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    mediaType,
    width,
    height,
    static: true,
  };
}

export function referenceReadCapabilities(input: {
  publication: boolean;
  available: boolean;
  textReady: boolean;
  definition: unknown;
  checksum: string;
  sizeBytes: number;
}) {
  const definition = input.definition as {
    referenceImageFacts?: unknown;
  } | null;
  const fact = ReferenceImageFactsSchema.safeParse(
    definition?.referenceImageFacts,
  );
  const image =
    input.publication &&
    input.available &&
    fact.success &&
    fact.data.checksum === input.checksum &&
    fact.data.sizeBytes === input.sizeBytes &&
    input.sizeBytes <= referenceImagePolicy.maximumBytes &&
    fact.data.width <= referenceImagePolicy.maximumDimension &&
    fact.data.height <= referenceImagePolicy.maximumDimension &&
    fact.data.width * fact.data.height <= referenceImagePolicy.maximumPixels;
  return { text: input.available && input.textReady, image, archive: false };
}
