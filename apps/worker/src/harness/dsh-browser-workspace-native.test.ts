import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
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

it.each([
  { command: 'open', url: 'https://example.com/' },
  {
    command: 'open',
    url: 'https://example.com/',
    location: 'local',
    requireLocalInputs: true,
  },
  {
    command: 'open',
    url: 'https://example.com/',
    location: 'cloud',
    requireLocalInputs: false,
  },
  {
    command: 'open',
    url: 'http://192.168.1.10:8080/',
    grantId: randomUUID(),
    requireLocalInputs: true,
  },
  { command: 'profiles' },
])(
  'passes browser open constraints unchanged through real DSH: %j',
  async (args) => {
    await nativeBrokerRoundtrip({
      canonicalName: 'browser.workspace',
      wireName: 'browser_workspace',
      args,
      invalidArgs: {
        command: 'open',
        url: 'https://example.com/',
        location: 'host',
      },
      inspectSchema(schema) {
        expect(schema.properties).toMatchObject({
          location: { type: 'string', enum: ['auto', 'local', 'cloud'] },
          requireLocalInputs: { type: 'boolean' },
          grantId: { type: 'string' },
        });
        expect(schema.required).not.toContain('location');
        expect(schema.required).not.toContain('requireLocalInputs');
      },
    });
  },
  45_000,
);

it('rejects an attempt to change an existing browser workspace location before the Broker', async () => {
  const args = { command: 'close', workspaceId: randomUUID(), fence: 1 };
  await nativeBrokerRoundtrip({
    canonicalName: 'browser.workspace',
    wireName: 'browser_workspace',
    args,
    invalidArgs: { ...args, location: 'cloud' },
    invalidResultIncludes: 'open-only',
  });
}, 45_000);
