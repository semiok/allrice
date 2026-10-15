import { randomUUID } from 'node:crypto';
import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('P15 cloud tool uses actual DSH native JSON-RPC, preserves structured arguments and rejects excess bounds before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.process.execute',
    wireName: 'cloud_process_execute',
    args: {
      script: 'console.log("synthetic only")',
      inputs: [
        {
          path: 'sample.csv',
          objectId: randomUUID(),
          checksum: `sha256:${'a'.repeat(64)}`,
        },
      ],
      outputs: [
        { path: 'report.json', fileName: 'report.json', format: 'json' },
      ],
      limits: { timeoutMs: 60000, pids: 64 },
    },
    invalidArgs: { script: 'not executed', limits: { timeoutMs: 60001 } },
  });
}, 45000);

it('Python PNG declarations use the same DSH native broker and reject invalid binary outputs before execution', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.process.execute',
    wireName: 'cloud_process_execute',
    args: {
      language: 'python',
      script:
        'import matplotlib.pyplot as plt\nplt.savefig("output/中文图表.png")',
      outputs: [
        { path: '中文图表.png', fileName: '中文图表.png', format: 'png' },
      ],
    },
    invalidArgs: {
      language: 'python',
      script: 'not executed',
      limits: { artifactBytes: 4000001 },
    },
  });
}, 45000);

it('preserves controlled network requests through the actual native JSON-RPC schema', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.process.execute',
    wireName: 'cloud_process_execute',
    args: {
      script: 'console.log("synthetic only")',
      network: {
        mode: 'controlled_https',
        origins: ['https://registry.npmjs.org'],
      },
    },
    invalidArgs: {
      script: 'not executed',
      network: { mode: 'controlled_https', origins: ['https://127.0.0.1'] },
    },
  });
}, 45000);

it('preserves controlled network and finite budget requests through the actual native JSON-RPC schema', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.process.execute',
    wireName: 'cloud_process_execute',
    args: {
      script: 'console.log("synthetic only")',
      network: {
        mode: 'controlled_https',
        origins: ['https://registry.npmjs.org'],
      },
      execution: { version: 1, kind: 'install' },
    },
    invalidArgs: {
      script: 'not executed',
      network: {
        mode: 'controlled_https',
        origins: ['https://registry.npmjs.org'],
      },
      execution: { version: 1, kind: 'install', maxExecutionMs: 3600000 },
    },
  });
}, 45000);
