import { randomUUID } from 'node:crypto';
import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('P19 XLSX tool uses actual DSH native JSON-RPC, preserves lineage and rejects model-supplied results before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.reconciliation.export',
    wireName: 'workspace_reconciliation_export',
    args: {
      artifactId: randomUUID(),
      fileName: '对账',
      parentObjectId: randomUUID(),
    },
    invalidArgs: {
      artifactId: randomUUID(),
      fileName: '对账',
      results: { invented_cents: 100 },
    },
  });
}, 45000);
