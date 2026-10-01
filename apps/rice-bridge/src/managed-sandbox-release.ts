/** Fixed upstream distribution. Existing Node VM and all cloud image pins stay intact. */
const limaBase = 'https://github.com/lima-vm/lima/releases/download/v2.2.0/';
const colimaBase =
  'https://github.com/abiosoft/colima/releases/download/v0.10.3/';
const guestBase =
  'https://github.com/abiosoft/colima-core/releases/download/v0.10.4/';
export const managedSandboxVersion =
  'colima-0.10.3-lima-2.2.0-docker-cli-29.8.2' as const;
export const managedSandboxProfile = 'allrice-office-v1' as const;
export const managedSandboxReleases = {
  'macos-x64': {
    architecture: 'amd64',
    nativeArchitecture: 'x86_64',
    minimumMacOS: '13.5',
    colima: {
      fileName: 'colima',
      url: colimaBase + 'colima-Darwin-x86_64',
      sizeBytes: 16954240,
      sha256:
        '3082737fe8a98afda11cba7d9a20b6e56fe80c6153464beda04bec630758770b',
    },
    lima: {
      fileName: 'lima.tar.gz',
      url: limaBase + 'lima-2.2.0-Darwin-x86_64.tar.gz',
      sizeBytes: 24415554,
      sha256:
        '0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31',
    },
    agents: {
      fileName: 'agents.tar.gz',
      url: limaBase + 'lima-additional-guestagents-2.2.0-Darwin-x86_64.tar.gz',
      sizeBytes: 37753231,
      sha256:
        'd710253c44c5b46116c08cabd784b0e75ea8e7c494d0f75dfa55ee6ea6c5720c',
    },
    docker: {
      fileName: 'docker.tar.gz',
      url: 'https://download.docker.com/mac/static/stable/x86_64/docker-29.8.2.tgz',
      sizeBytes: 20888615,
      sha256:
        '384d9b259c1efd2265e6a0ff05512d5998035df0877053cb7763405caf17ca23',
    },
    guest: {
      fileName: 'ubuntu-24.04-minimal-cloudimg-amd64-docker.raw.gz',
      url: guestBase + 'ubuntu-24.04-minimal-cloudimg-amd64-docker.raw.gz',
      sizeBytes: 358298593,
      sha256:
        '4cd967d2c58aa6971621343d372255b14ffbfe28a185cda0e3c34ac8a1eb15e6',
      sha512:
        '27652801b6606b457f4f34836358c0e9978aeb98757d0271165e3f09672f930ccc2d957e15726f7e7f22c302b20a3d30c64ead68adaa5f24a4f959cd34b56b5b',
    },
  },
  'macos-arm64': {
    architecture: 'arm64',
    nativeArchitecture: 'aarch64',
    minimumMacOS: '13.5',
    colima: {
      fileName: 'colima',
      url: colimaBase + 'colima-Darwin-arm64',
      sizeBytes: 15656320,
      sha256:
        '980ad8bf61a4ca370243f4cb41401a61276dcd2c2502bee7b9b86f9250169f34',
    },
    lima: {
      fileName: 'lima.tar.gz',
      url: limaBase + 'lima-2.2.0-Darwin-arm64.tar.gz',
      sizeBytes: 37586365,
      sha256:
        'bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3',
    },
    agents: {
      fileName: 'agents.tar.gz',
      url: limaBase + 'lima-additional-guestagents-2.2.0-Darwin-arm64.tar.gz',
      sizeBytes: 38554314,
      sha256:
        '3aff4453eb3c359eb4f3b458056db24f2c5c15019232531292f49e04050554ed',
    },
    docker: {
      fileName: 'docker.tar.gz',
      url: 'https://download.docker.com/mac/static/stable/aarch64/docker-29.8.2.tgz',
      sizeBytes: 19612997,
      sha256:
        '5ffa2bafbabe073470f0333f4a129599230b73d1170bb61146b3d9b08e1d1325',
    },
    guest: {
      fileName: 'ubuntu-24.04-minimal-cloudimg-arm64-docker.raw.gz',
      url: guestBase + 'ubuntu-24.04-minimal-cloudimg-arm64-docker.raw.gz',
      sizeBytes: 332354401,
      sha256:
        '1fc0354f4f99734ce3886628cc7af8b0437c1a1d391b126bd09cba0df35ee53f',
      sha512:
        '32242674b046b5057e60c4aba334b51e3665f05412cda89ed081cc2de153ae5c41f6b105b5c442cbe48d78e2cc21e9ba1950e406b6fb4fc2fd1dd2259240abbd',
    },
  },
} as const;
