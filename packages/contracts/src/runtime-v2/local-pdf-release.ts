import type {
  RuntimeLocalPdfPins,
  RuntimeLocalPdfProfile,
} from './local-pdf.ts';

export interface LocalPdfRelease {
  contractVersion: 1;
  profileVersion: 1;
  platform: 'macos-x64' | 'macos-arm64';
  nativeSupported: true;
  pins: RuntimeLocalPdfPins;
}

/** Locked mature reader resources and fixed policy. Native probes remain
 * mandatory; a checksum does not imply that an installed Bridge is ready. */
export function pdfReadReleaseForPlatform(
  platform: string,
): LocalPdfRelease | null {
  if (platform !== 'macos-x64' && platform !== 'macos-arm64') return null;
  return {
    contractVersion: 1,
    profileVersion: 1,
    platform,
    nativeSupported: true,
    pins: {
      nodeVersion: '22.23.2',
      parserVersion: '2.4.5',
      pdfJsVersion: '5.4.296',
      canvasVersion: '0.1.80',
      resourceManifestChecksum:
        platform === 'macos-arm64'
          ? 'sha256:019c64f66f346c2e95fdb40cda21d2606d659872ffae6502c3b97f7a920ad8ca'
          : 'sha256:ed7b2874d70fe5087f6b045489ab62bf812ea8dc00f06882aed5d1dde6150d68',
      policyChecksum:
        'sha256:ff68ca0be9f1c81cb0191aa401da1a334c6ebdb63272b23842addd46a0969800',
    },
  };
}

export function localPdfProfileMatchesRelease(
  profile: RuntimeLocalPdfProfile,
  release: LocalPdfRelease,
) {
  return (
    profile.platform === release.platform &&
    profile.contractVersion === release.contractVersion &&
    profile.profileVersion === release.profileVersion &&
    Object.keys(release.pins).every(
      (key) =>
        profile.pins[key as keyof RuntimeLocalPdfPins] ===
        release.pins[key as keyof RuntimeLocalPdfPins],
    )
  );
}
