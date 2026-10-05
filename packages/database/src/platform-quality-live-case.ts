/** Pinned fifth-round Vite fixture; only formal gateway HMR port differs.
 * Source and dependency integrity are frozen in the existing quality admission. */
export const qualityLiveFiles = [
  {
    path: 'package.json',
    text: '{\n  "name": "allrice-pr5a-vite",\n  "version": "1.0.0",\n  "private": true,\n  "type": "module",\n  "packageManager": "pnpm@10.33.3",\n  "devDependencies": {\n    "vite": "4.5.14"\n  }\n}\n',
  },
  {
    path: 'pnpm-lock.yaml',
    text: '# Fixed QA sample: only the two supported Linux VM architectures.\nlockfileVersion: "9.0"\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    devDependencies:\n      vite:\n        specifier: 4.5.14\n        version: 4.5.14(lightningcss@1.33.0)\npackages:\n  "@esbuild/linux-arm64@0.18.20":\n    resolution:\n      integrity: sha512-2YbscF+UL7SQAVIpnWvYwM+3LskyDmPhe31pE7/aoTMFKKzIc9lLbyGUpmmb8a8AixOL61sQ/mFh3jEjHYFvdA==\n    engines:\n      node: ">=12"\n    cpu:\n      - arm64\n    os:\n      - linux\n  "@esbuild/linux-x64@0.18.20":\n    resolution:\n      integrity: sha512-UYqiqemphJcNsFEskc73jQ7B9jgwjWrSayxawS6UVFZGWrAAtkzjxSqnoclCXxWtfwLdzU+vTpcNYhpn43uP1w==\n    engines:\n      node: ">=12"\n    cpu:\n      - x64\n    os:\n      - linux\n  detect-libc@2.1.2:\n    resolution:\n      integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==\n    engines:\n      node: ">=8"\n  esbuild@0.18.20:\n    resolution:\n      integrity: sha512-ceqxoedUrcayh7Y7ZX6NdbbDzGROiyVBgC4PriJThBKSVPWnnFHZAkfI1lJT8QFkOwH4qOS2SJkS4wvpGl8BpA==\n    engines:\n      node: ">=12"\n    hasBin: true\n  lightningcss-linux-arm64-gnu@1.33.0:\n    resolution:\n      integrity: sha512-j2v/itmy4HlNxlc6voKXYgBqNi0Ng2LShg4z7GufpEgs05P+2suBVyi9I6YHq5uoVFx9ETin3eCEhLVyXGQnKg==\n    engines:\n      node: ">= 12.0.0"\n    cpu:\n      - arm64\n    os:\n      - linux\n    libc:\n      - glibc\n  lightningcss-linux-arm64-musl@1.33.0:\n    resolution:\n      integrity: sha512-yiO5ROMuYQgXbC60yjZU5CYSFZGKXL0HFATXt9mHJn1+zW55oCtMI9NfcVhYLMFDL7gV7oBPon/EmMMGg2OvtQ==\n    engines:\n      node: ">= 12.0.0"\n    cpu:\n      - arm64\n    os:\n      - linux\n    libc:\n      - musl\n  lightningcss-linux-x64-gnu@1.33.0:\n    resolution:\n      integrity: sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==\n    engines:\n      node: ">= 12.0.0"\n    cpu:\n      - x64\n    os:\n      - linux\n    libc:\n      - glibc\n  lightningcss-linux-x64-musl@1.33.0:\n    resolution:\n      integrity: sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw==\n    engines:\n      node: ">= 12.0.0"\n    cpu:\n      - x64\n    os:\n      - linux\n    libc:\n      - musl\n  lightningcss@1.33.0:\n    resolution:\n      integrity: sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==\n    engines:\n      node: ">= 12.0.0"\n  nanoid@3.3.19:\n    resolution:\n      integrity: sha512-Y2tUNy4ouw6tq5oDSKeQYGOyhkUBhNOcGV/02KC+6kd9eDGqdZd++mjMiIDilrBYvjEnCYvVtsuHCuP+okSfug==\n    engines:\n      node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1\n    hasBin: true\n  picocolors@1.1.1:\n    resolution:\n      integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==\n  postcss@8.5.28:\n    resolution:\n      integrity: sha512-RRuzqDtt5Y9h3quz5hWhK+TPnsmVs6WwSU6LkJMeY4HstUEDuYTG8UJSdawMRzmzAtV+KEoG8N3Qg2qLy5vM/A==\n    engines:\n      node: ^10 || ^12 || >=14\n  rollup@3.30.0:\n    resolution:\n      integrity: sha512-kQvGasUgN+AlWGliFn2POSajRQEsULVYFGTvOZmK06d7vCD+YhZztt70kGk3qaeAXeWYL5eO7zx+rAubBc55eA==\n    engines:\n      node: ">=14.18.0"\n      npm: ">=8.0.0"\n    hasBin: true\n  source-map-js@1.2.2:\n    resolution:\n      integrity: sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==\n    engines:\n      node: ">=0.10.0"\n  vite@4.5.14:\n    resolution:\n      integrity: sha512-+v57oAaoYNnO3hIu5Z/tJRZjq5aHM2zDve9YZ8HngVHbhk66RStobhb1sqPMIPEleV6cNKYK4eGrAbE9Ulbl2g==\n    engines:\n      node: ^14.18.0 || >=16.0.0\n    hasBin: true\n    peerDependencies:\n      "@types/node": ">= 14"\n      less: "*"\n      lightningcss: ^1.21.0\n      sass: "*"\n      stylus: "*"\n      sugarss: "*"\n      terser: ^5.4.0\n    peerDependenciesMeta:\n      "@types/node":\n        optional: true\n      less:\n        optional: true\n      lightningcss:\n        optional: true\n      sass:\n        optional: true\n      stylus:\n        optional: true\n      sugarss:\n        optional: true\n      terser:\n        optional: true\nsnapshots:\n  "@esbuild/linux-arm64@0.18.20":\n    optional: true\n  "@esbuild/linux-x64@0.18.20":\n    optional: true\n  detect-libc@2.1.2:\n    optional: true\n  esbuild@0.18.20:\n    optionalDependencies:\n      "@esbuild/linux-arm64": 0.18.20\n      "@esbuild/linux-x64": 0.18.20\n  lightningcss-linux-arm64-gnu@1.33.0:\n    optional: true\n  lightningcss-linux-arm64-musl@1.33.0:\n    optional: true\n  lightningcss-linux-x64-gnu@1.33.0:\n    optional: true\n  lightningcss-linux-x64-musl@1.33.0:\n    optional: true\n  lightningcss@1.33.0:\n    dependencies:\n      detect-libc: 2.1.2\n    optionalDependencies:\n      lightningcss-linux-arm64-gnu: 1.33.0\n      lightningcss-linux-arm64-musl: 1.33.0\n      lightningcss-linux-x64-gnu: 1.33.0\n      lightningcss-linux-x64-musl: 1.33.0\n    optional: true\n  nanoid@3.3.19: {}\n  picocolors@1.1.1: {}\n  postcss@8.5.28:\n    dependencies:\n      nanoid: 3.3.19\n      picocolors: 1.1.1\n      source-map-js: 1.2.2\n  rollup@3.30.0:\n    optionalDependencies: {}\n  source-map-js@1.2.2: {}\n  vite@4.5.14(lightningcss@1.33.0):\n    dependencies:\n      esbuild: 0.18.20\n      postcss: 8.5.28\n      rollup: 3.30.0\n    optionalDependencies:\n      lightningcss: 1.33.0\n',
  },
  {
    path: 'index.html',
    text: '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>AllRice live preview</title>\n  </head>\n  <body>\n    <h1>Local project service</h1>\n    <p id="result"></p>\n    <script type="module" src="/main.js"></script>\n  </body>\n</html>\n',
  },
  {
    path: 'main.js',
    text: "globalThis.document.querySelector('#result').textContent = 'source:42';\nif (import.meta.hot) import.meta.hot.accept();\n",
  },
  {
    path: 'vite.config.js',
    text: "export default { server: { host: '127.0.0.1', port: 4173, strictPort: true, hmr: { protocol: 'wss', clientPort: 443 } } };\n",
  },
].sort((a, b) => a.path.localeCompare(b.path));
export const qualityLivePackages = [
  {
    name: '@esbuild/linux-arm64',
    version: '0.18.20',
    integrity:
      'sha512-2YbscF+UL7SQAVIpnWvYwM+3LskyDmPhe31pE7/aoTMFKKzIc9lLbyGUpmmb8a8AixOL61sQ/mFh3jEjHYFvdA==',
  },
  {
    name: '@esbuild/linux-x64',
    version: '0.18.20',
    integrity:
      'sha512-UYqiqemphJcNsFEskc73jQ7B9jgwjWrSayxawS6UVFZGWrAAtkzjxSqnoclCXxWtfwLdzU+vTpcNYhpn43uP1w==',
  },
  {
    name: 'detect-libc',
    version: '2.1.2',
    integrity:
      'sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==',
  },
  {
    name: 'esbuild',
    version: '0.18.20',
    integrity:
      'sha512-ceqxoedUrcayh7Y7ZX6NdbbDzGROiyVBgC4PriJThBKSVPWnnFHZAkfI1lJT8QFkOwH4qOS2SJkS4wvpGl8BpA==',
  },
  {
    name: 'lightningcss-linux-arm64-gnu',
    version: '1.33.0',
    integrity:
      'sha512-j2v/itmy4HlNxlc6voKXYgBqNi0Ng2LShg4z7GufpEgs05P+2suBVyi9I6YHq5uoVFx9ETin3eCEhLVyXGQnKg==',
  },
  {
    name: 'lightningcss-linux-arm64-musl',
    version: '1.33.0',
    integrity:
      'sha512-yiO5ROMuYQgXbC60yjZU5CYSFZGKXL0HFATXt9mHJn1+zW55oCtMI9NfcVhYLMFDL7gV7oBPon/EmMMGg2OvtQ==',
  },
  {
    name: 'lightningcss-linux-x64-gnu',
    version: '1.33.0',
    integrity:
      'sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==',
  },
  {
    name: 'lightningcss-linux-x64-musl',
    version: '1.33.0',
    integrity:
      'sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw==',
  },
  {
    name: 'lightningcss',
    version: '1.33.0',
    integrity:
      'sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==',
  },
  {
    name: 'nanoid',
    version: '3.3.19',
    integrity:
      'sha512-Y2tUNy4ouw6tq5oDSKeQYGOyhkUBhNOcGV/02KC+6kd9eDGqdZd++mjMiIDilrBYvjEnCYvVtsuHCuP+okSfug==',
  },
  {
    name: 'picocolors',
    version: '1.1.1',
    integrity:
      'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==',
  },
  {
    name: 'postcss',
    version: '8.5.28',
    integrity:
      'sha512-RRuzqDtt5Y9h3quz5hWhK+TPnsmVs6WwSU6LkJMeY4HstUEDuYTG8UJSdawMRzmzAtV+KEoG8N3Qg2qLy5vM/A==',
  },
  {
    name: 'rollup',
    version: '3.30.0',
    integrity:
      'sha512-kQvGasUgN+AlWGliFn2POSajRQEsULVYFGTvOZmK06d7vCD+YhZztt70kGk3qaeAXeWYL5eO7zx+rAubBc55eA==',
  },
  {
    name: 'source-map-js',
    version: '1.2.2',
    integrity:
      'sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==',
  },
  {
    name: 'vite',
    version: '4.5.14',
    integrity:
      'sha512-+v57oAaoYNnO3hIu5Z/tJRZjq5aHM2zDve9YZ8HngVHbhk66RStobhb1sqPMIPEleV6cNKYK4eGrAbE9Ulbl2g==',
  },
];
export const qualityLiveAssertion = {
  version: 1,
  before: 'source:42',
  after: 'source:43',
  websocketProtocol: 'vite-hmr',
  mainFrameNavigations: 0,
} as const;
export const qualityLiveRunnerVersion = 'fixed-project-live/1';
export const qualityLiveLeaseMs = 120_000;
