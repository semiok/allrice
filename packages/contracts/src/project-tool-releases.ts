/** Fixed public manager distributions, verified against npm SRI and GitHub's
 * release asset digest. They run only inside the existing private VM images.
 */
export const projectToolReleases = Object.freeze({
  pnpm: {
    fileName: 'pnpm-10.33.3.tgz',
    url: 'https://registry.npmjs.org/pnpm/-/pnpm-10.33.3.tgz',
    sizeBytes: 4562322,
    sha256: '3e2a9063122a9b4991b336ca90163c820b8e8ac5f450fb3c9b0bd5694f94366f',
    // Hex encoding used by the managed download checker; the npm SRI is base64.
    sha512:
      'a19744364a7e248b92657a4ca5973f9354d21caf982579674b1c539f32c7420c47138ad8b1254df07aba9bc782d9b3029e3db34d5dbff974326eb74dac8ff489',
  },
  uv: {
    amd64: {
      fileName: 'uv-0.8.22-x86_64.tar.gz',
      url: 'https://github.com/astral-sh/uv/releases/download/0.8.22/uv-x86_64-unknown-linux-gnu.tar.gz',
      sizeBytes: 21291955,
      sha256:
        '741ff1f5742c5a4a25d2f829e8395355e43f7a5ae2ebc6368e9ae2df0efb69cf',
    },
    arm64: {
      fileName: 'uv-0.8.22-aarch64.tar.gz',
      url: 'https://github.com/astral-sh/uv/releases/download/0.8.22/uv-aarch64-unknown-linux-gnu.tar.gz',
      sizeBytes: 20161008,
      sha256:
        '726b72a137fda33565143325f7d31c42cd30ff9ccdf067e00d124d37b4081cb2',
    },
  },
});
