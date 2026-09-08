import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('P18 frozen Skill resource uses actual DSH native JSON-RPC and rejects traversal before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.skill.read',
    wireName: 'workspace_skill_read',
    args: { skill: 'business-reconciliation', path: 'scripts/reconcile.mjs' },
    invalidArgs: {
      skill: 'business-reconciliation',
      path: 'scripts/../../private',
    },
  });
}, 45000);
