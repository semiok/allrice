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
