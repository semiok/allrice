import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('P19 native frozen script reference preserves only the Run-local locator and rejects conflicting inline bytes', async () => {
  const frozenScript = {
    skill: 'business-reconciliation',
    path: 'scripts/reconcile.mjs',
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'cloud.process.execute',
    wireName: 'cloud_process_execute',
    args: { frozenScript, inputs: [], outputs: [] },
    invalidArgs: { frozenScript, script: 'conflicting code' },
  });
}, 45000);
