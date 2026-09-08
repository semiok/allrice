import { describe, expect, it } from 'vitest';
import {
  isLocalCommandProfileForPlatform,
  localCommandToolchainForPlatform,
  localCommandToolchainImageV1,
} from './runtime-v2/local-command.ts';

describe('native local command admission', () => {
  it.each([
    ['macos-x64', 'amd64'],
    ['macos-arm64', 'arm64'],
  ])('binds %s to its native architecture', (platform, architecture) => {
    expect(localCommandToolchainForPlatform(platform!)).toEqual({
      architecture,
      imageDigest: localCommandToolchainImageV1,
    });
    expect(
      isLocalCommandProfileForPlatform(platform!, {
        architecture: architecture!,
        imageDigest: localCommandToolchainImageV1,
      }),
    ).toBe(true);
    for (const other of [
      'arm',
      'unknown',
      architecture === 'arm64' ? 'amd64' : 'arm64',
    ])
      expect(
        isLocalCommandProfileForPlatform(platform!, {
          architecture: other,
          imageDigest: localCommandToolchainImageV1,
        }),
      ).toBe(false);
    expect(
      isLocalCommandProfileForPlatform(platform!, {
        architecture: architecture!,
        imageDigest: `sha256:${'f'.repeat(64)}`,
      }),
    ).toBe(false);
  });
  it.each(['linux', 'windows', '', 'macos-arm', '__proto__'])(
    'denies unknown platform %s',
    (platform) => {
      expect(localCommandToolchainForPlatform(platform)).toBeNull();
      expect(
        isLocalCommandProfileForPlatform(platform, {
          architecture: 'arm64',
          imageDigest: localCommandToolchainImageV1,
        }),
      ).toBe(false);
    },
  );
});
