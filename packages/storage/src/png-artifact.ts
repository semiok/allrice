import { createHash } from 'node:crypto';

export type PngArtifactValidation = {
  checker: 'pillow-11.3.0';
  checksum: string;
  width: number;
  height: number;
};

/** Host publication boundary, matching the existing raster preview limits.
 * Full package/raster decoding belongs to the fixed isolated Pillow checker;
 * this gate verifies its report against the captured immutable bytes. */
export function validatePngArtifact(
  bytes: Buffer,
  report: PngArtifactValidation | undefined,
) {
  if (
    !report ||
    report.checker !== 'pillow-11.3.0' ||
    bytes.length < 45 ||
    bytes.length > 4_000_000 ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw Error('png_validation_missing_or_invalid');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_000_000 ||
    report.width !== width ||
    report.height !== height ||
    report.checksum !==
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  )
    throw Error('png_validation_changed');
  return report;
}
