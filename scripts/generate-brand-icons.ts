// Run with: pnpm exec tsx scripts/generate-brand-icons.ts
// Render every browser icon from the same vector master as the React mark.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import {
  allriceBrandColors as colors,
  allriceRiceGrains,
} from '../apps/web/lib/brand/rice-star.ts';

const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const sharp = createRequire(webRequire.resolve('next/package.json'))('sharp');
const publicDirectory = new URL('../apps/web/public/', import.meta.url);
const brandDirectory = new URL('brand/', publicDirectory);
await mkdir(brandDirectory, { recursive: true });

const paths = allriceRiceGrains
  .map(
    (d, index) =>
      `<path d="${d}" fill="${index === 7 ? colors.gold : colors.paper}"/>`,
  )
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="104" fill="${colors.ink}"/><g transform="translate(48 48) scale(.8125)">${paths}</g></svg>\n`;
await writeFile(new URL('allrice-icon-v1.svg', brandDirectory), svg);
await sharp(Buffer.from(svg))
  .resize(180, 180)
  .png()
  .toFile(new URL('apple-touch-icon-v1.png', brandDirectory).pathname);

const sizes = [16, 32, 48];
const images = await Promise.all(
  sizes.map((size) =>
    sharp(Buffer.from(svg)).resize(size, size).png().toBuffer(),
  ),
);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); // ICO image type.
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const image = images[index]!;
  const entry = 6 + index * 16;
  header.writeUInt8(size, entry);
  header.writeUInt8(size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
await writeFile(
  new URL('favicon.ico', publicDirectory),
  Buffer.concat([header, ...images]),
);
