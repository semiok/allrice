import {
  ManagedPythonPayloadReleaseSchema,
  type ManagedPythonPayloadRelease,
} from './runtime-v2/local-python.ts';

/** Fixed, byte-verified local releases; readiness still requires a native execution and stop probe.
 * Both Mac architectures are pinned after native verification; installation
 * still needs a fresh runtime and physical stop probe on the device.
 * Existing frozen cloud Node/Python/Office profiles are independent of this allowlist.
 */
export const managedPythonPayloadsV1: readonly ManagedPythonPayloadRelease[] =
  Object.freeze(
    [
      {
        contractVersion: 1,
        profileVersion: 1,
        platform: 'macos-x64',
        architecture: 'amd64',
        nativeSupported: true,
        imageId:
          'sha256:5dfe667dcf0cfc31e8067dbb291f3025dcc46de0f111bc3115a26ad33aa72ae6',
        pythonVersion: '3.11.13',
        archive: {
          fileName: 'managed-python-v1-amd64.tar.gz',
          sizeBytes: 152879354,
          sha256:
            'sha256:d20c58ec2ac7c7f54165a7fa27ab3c970bb1f728ab139fe980459a14b0e70f2b',
        },
        packagesChecksum:
          'sha256:75364277523525b875cd0cfd351d2c9df4f2a71a29d480ac31c6de3f3280f7ef',
        officeChecker: {
          sha256:
            'sha256:d94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66',
          upstream: '@deepseek-ai/dsh-skill-office@0.1.7-alpha.2',
        },
        pngChecker: {
          sha256:
            'sha256:7109e40138f9089b3f260e66bc2b91fd7f1a90c57f3c43cbc2debf184c6a995f',
        },
        font: {
          fileName: 'NotoSansCJK-Regular.ttc',
          sha256:
            'sha256:b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a',
        },
      },
      {
        contractVersion: 1,
        profileVersion: 1,
        architecture: 'arm64',
        nativeSupported: true,
        imageId:
          'sha256:236473556f8fd8eeaddd0f48a12c609c409d278e4d1c03aaf5333a1074db1b45',
        pythonVersion: '3.11.13',
        archive: {
          fileName: 'managed-python-v1-arm64.tar.gz',
          sizeBytes: 148679127,
          sha256:
            'sha256:4c6ad570743d7d3607d57c127d274e8348c1af5e5504ac9b3d3117410ec660e8',
        },
        packagesChecksum:
          'sha256:cf9c84d6941b97f314ccef8feb3f9ec9e61f617ab6ff36464a77be059883bbfb',
        officeChecker: {
          sha256:
            'sha256:d94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66',
          upstream: '@deepseek-ai/dsh-skill-office@0.1.7-alpha.2',
        },
        pngChecker: {
          sha256:
            'sha256:7109e40138f9089b3f260e66bc2b91fd7f1a90c57f3c43cbc2debf184c6a995f',
        },
        font: {
          fileName: 'NotoSansCJK-Regular.ttc',
          sha256:
            'sha256:b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a',
        },
        platform: 'macos-arm64',
      },
    ].map((payload) =>
      Object.freeze(ManagedPythonPayloadReleaseSchema.parse(payload)),
    ),
  );

export function managedPythonPayloadForPlatform(
  platform: string,
): ManagedPythonPayloadRelease | undefined {
  return managedPythonPayloadsV1.find(
    (payload) => payload.platform === platform,
  );
}
