import { readdir } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import process from 'node:process';

/** Explicit service-owned roots disable Kit's optional Office AppData discovery.
 * Kit still owns font inventory, matching, caching and conversion. */
export async function officePreviewFontDirectories(
  platform = process.platform,
) {
  if (platform === 'darwin') {
    const assets = '/System/Library/AssetsV2';
    const names = await readdir(assets).catch(
      (error: NodeJS.ErrnoException) => {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code ?? '')) return [];
        throw error;
      },
    );
    return [
      '/System/Library/Fonts',
      '/Library/Fonts',
      ...names
        .filter((name) => /^com_apple_MobileAsset_Font\d*$/.test(name))
        .sort()
        .map((name) => join(assets, name)),
    ];
  }
  if (platform === 'win32')
    return [win32.join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'Fonts')];
  // Includes the pinned Noto CJK and DejaVu copied into the Linux images.
  return ['/usr/local/share/fonts', '/usr/share/fonts'];
}
