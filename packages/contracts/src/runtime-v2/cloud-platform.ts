/** Fixed server-side sandbox toolchains, one per VM architecture. Exactly one
 * is selected at process start; tenants and models never choose. gVisor cannot
 * run foreign binaries through Rosetta/binfmt, so the VM daemon, every image and
 * runsc must all be native to the host CPU. Preflight rejects any mismatch.
 *
 * The Node image is the multi-arch OCI index, so both platforms share its ID.
 * Locally built images (Python, Office, static browser) have per-arch IDs. */
export const cloudPlatforms = Object.freeze({
  amd64: Object.freeze({
    architecture: 'amd64',
    dockerArchitectures: Object.freeze(['x86_64', 'amd64']),
    linuxPlatform: 'linux-amd64',
    pythonPlatform: 'x86_64-unknown-linux-gnu',
    runtimeChecksum:
      'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
    images: Object.freeze({
      node: 'sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
      python:
        'sha256:d6a52afde3d7c99d8cba9c89ff5078a8e1b6a177f97512ff4facfa4f930fe38e',
      office:
        'sha256:97e65ad4564b1624b0b2a90448f8e1c69e5ce06c664675218e6e403ab2f72800',
      staticBrowser:
        'sha256:e0ef9ce00e900780e7b34a876a38549eb83ba597c62cb7d22c4986af2b725c77',
    }),
  }),
  arm64: Object.freeze({
    architecture: 'arm64',
    dockerArchitectures: Object.freeze(['aarch64', 'arm64']),
    linuxPlatform: 'linux-arm64',
    pythonPlatform: 'aarch64-unknown-linux-gnu',
    runtimeChecksum:
      'sha256:d5679775682cd4cb11ba7bf7bd8e04235622aa8797d518dd280064e5cd27ed5d',
    images: Object.freeze({
      node: 'sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
      python:
        'sha256:7ed9955c9d0de199f9902c3086581ddeb673975e4a8094067b9254168ffa8ccc',
      office:
        'sha256:626642de85da4eb15000882355d377355839cf5afcd5c1b4b1aa5e1808c231fa',
      staticBrowser:
        'sha256:36845fa95d472b53236d14322b9d10999bfd81b9a18f0cd8d2e5e967bb346cef',
    }),
  }),
} as const);
export type CloudArchitecture = keyof typeof cloudPlatforms;
export type CloudPlatform = (typeof cloudPlatforms)[CloudArchitecture];

/** Web and Worker share the host, so its CPU is the default and both always
 * agree. ALLRICE_CLOUD_ARCHITECTURE is only an explicit override. */
export function selectCloudArchitecture(
  value?: string,
  hostArchitecture?: string,
): CloudArchitecture {
  if (value === 'amd64' || value === 'arm64') return value;
  if (value !== undefined && value !== '')
    throw new Error('ALLRICE_CLOUD_ARCHITECTURE must be amd64 or arm64');
  return hostArchitecture === 'arm64' ? 'arm64' : 'amd64';
}

/** Browser bundles have no process; they never select a cloud toolchain. */
export const cloudPlatform: CloudPlatform =
  cloudPlatforms[
    selectCloudArchitecture(
      globalThis.process?.env?.ALLRICE_CLOUD_ARCHITECTURE,
      globalThis.process?.arch,
    )
  ];
