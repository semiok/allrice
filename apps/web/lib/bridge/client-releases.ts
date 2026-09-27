import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type BridgeClientRelease = {
  platform: 'macos-arm64' | 'macos-x64';
  available: boolean;
  version: string | null;
};

const platforms = [
  ['macos-arm64', 'ALLRICE_BRIDGE_MACOS_ARM64_PATH'],
  ['macos-x64', 'ALLRICE_BRIDGE_MACOS_X64_PATH'],
] as const;

/** Read the distribution selected for downloads, which may differ from Web's
 * source version. Legacy archives remain downloadable without a version label. */
export async function bridgeClientReleases(): Promise<BridgeClientRelease[]> {
  return Promise.all(
    platforms.map(async ([platform, key]) => {
      const path = process.env[key];
      const release: BridgeClientRelease = {
        platform,
        available: false,
        version: null,
      };
      if (!path) return release;
      try {
        const archive = await stat(path);
        if (!archive.isFile() || archive.size === 0) return release;
        release.available = true;
        const manifestPath = join(dirname(path), 'release.json');
        const manifestStat = await stat(manifestPath);
        if (!manifestStat.isFile() || manifestStat.size > 32_768)
          return release;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (
          manifest.platform === platform &&
          typeof manifest.zip === 'string' &&
          basename(manifest.zip) === basename(path) &&
          typeof manifest.version === 'string' &&
          manifest.version.length <= 80 &&
          /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(manifest.version)
        ) {
          release.version = manifest.version;
        }
      } catch {
        // Missing/invalid metadata cannot advertise an unverified latest version.
      }
      return release;
    }),
  );
}
