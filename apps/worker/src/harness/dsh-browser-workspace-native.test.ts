import { randomUUID } from 'node:crypto';
import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
it('P21 browser uses native DSH to the existing Broker, with exact action envelope', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'browser.workspace',
    wireName: 'browser_workspace',
    args: {
      command: 'act',
      workspaceId: randomUUID(),
      profileId: randomUUID(),
      fence: 1,
      observationId: randomUUID(),
      action: { type: 'click', elementId: 'e1' },
    },
    invalidArgs: {
      command: 'act',
      workspaceId: 'wrong',
      fence: 1,
      action: { type: 'click', elementId: 'e1' },
    },
  });
}, 45000);
