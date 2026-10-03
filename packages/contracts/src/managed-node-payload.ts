import { localCommandToolchainImageV1 } from './runtime-v2/local-command.ts';

/** The existing immutable Node OCI index, exported on each native architecture.
 * Imported through the same verified asset channel as managed Office/Python.
 * The VM resolver remains disabled; tenant containers always have network=none.
 */
export function managedNodePayloadForPlatform(platform: string) {
  if (platform !== 'macos-x64' && platform !== 'macos-arm64') return null;
  const arm = platform === 'macos-arm64';
  return {
    platform,
    imageId: localCommandToolchainImageV1,
    architecture: arm ? ('arm64' as const) : ('amd64' as const),
    archive: arm
      ? {
          fileName: 'managed-node-v1-arm64.tar.gz',
          sizeBytes: 79789165,
          sha256:
            'sha256:13a2fe3b37fa7ad150c3da4f9acccc771d8dc10559dbac63eb48c85b8a708900',
        }
      : {
          fileName: 'managed-node-v1-amd64.tar.gz',
          sizeBytes: 79879783,
          sha256:
            'sha256:86fa8f263aa1592c54bafcd44ce9200b14e194bb4d92bf6aa73ee6a5ab887ce2',
        },
  };
}
