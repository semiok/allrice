import assert from 'node:assert/strict';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertBridgeSigningAvailable,
  bridgeSigningConfiguration,
  signAndNotarizeBridge,
  verifyPackagedBridge,
} from './rice-bridge-signing.mjs';

const environment = {
  ALLRICE_BRIDGE_SIGNING_MODE: 'developer-id',
  ALLRICE_BRIDGE_SIGNING_IDENTITY: 'A'.repeat(40),
  ALLRICE_BRIDGE_SIGNING_TEAM_ID: 'SYNTHETIC1',
  ALLRICE_BRIDGE_NOTARY_PROFILE: 'synthetic-profile',
};
test('development cannot silently become a trusted release', () => {
  assert.deepEqual(bridgeSigningConfiguration({}), { mode: 'development' });
  assert.throws(
    () =>
      bridgeSigningConfiguration({
        ALLRICE_BRIDGE_SIGNING_MODE: 'developer-id',
      }),
    /CONFIGURATION_REQUIRED/,
  );
  assert.throws(
    () =>
      bridgeSigningConfiguration({ ALLRICE_BRIDGE_SIGNING_MODE: 'unknown' }),
    /MODE_INVALID/,
  );
});
test('no available Developer ID identity is a hard gate, never an ad-hoc fallback', () => {
  assert.throws(
    () =>
      assertBridgeSigningAvailable(
        bridgeSigningConfiguration(environment),
        () => '0 valid identities found',
      ),
    /DEVELOPER_ID_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      assertBridgeSigningAvailable(
        bridgeSigningConfiguration(environment),
        () => `${'A'.repeat(40)} Apple Development: Other (SYNTHETIC1)`,
      ),
    /DEVELOPER_ID_UNAVAILABLE/,
  );
});
test('synthetic command ports enforce inside-out runtime signing, Accepted, staple, validation, Gatekeeper', () => {
  const calls = [];
  const run = (program, args) => {
    calls.push([program, args]);
    return args.includes('submit') ? '{"status":"Accepted"}' : '';
  };
  const result = signAndNotarizeBridge(
    bridgeSigningConfiguration(environment),
    '/synthetic/Rice Bridge.app',
    '/synthetic',
    run,
  );
  assert.equal(result.notarization, 'accepted-and-stapled');
  assert.equal(
    calls[0][1].at(-1),
    '/synthetic/Rice Bridge.app/Contents/Resources/RiceBridgeCore',
  );
  assert.ok(calls[0][1].includes('--entitlements'));
  assert.ok(!calls[1][1].includes('--entitlements'));
  assert.equal(calls.at(-1)[0], '/usr/sbin/spctl');
  assert.ok(
    calls.find(([, args]) => args[0] === 'stapler' && args[1] === 'validate'),
  );
  assert.ok(
    calls
      .filter(([, args]) => args.includes('-R'))
      .every(([, args]) =>
        args.some(
          (arg) => arg.includes('subject.OU') && arg.includes('SYNTHETIC1'),
        ),
      ),
  );
});
test('rejected or failed notarization never reaches staple or successful release evidence', () => {
  const calls = [];
  assert.throws(
    () =>
      signAndNotarizeBridge(
        bridgeSigningConfiguration(environment),
        '/synthetic/Rice Bridge.app',
        '/synthetic',
        (program, args) => {
          calls.push([program, args]);
          return args.includes('submit') ? '{"status":"Invalid"}' : '';
        },
      ),
    /NOTARIZATION_NOT_ACCEPTED/,
  );
  assert.ok(!calls.some(([, args]) => args[0] === 'stapler'));
});
test('final ZIP extraction must retain Apple signature and stapled ticket', () => {
  const calls = [];
  verifyPackagedBridge(
    bridgeSigningConfiguration(environment),
    '/synthetic/extracted/Rice Bridge.app',
    (program, args) => {
      calls.push([program, args]);
      return '';
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1][0], '/usr/bin/xcrun');
  assert.deepEqual(calls[1][1].slice(0, 2), ['stapler', 'validate']);
  assert.equal(calls[2][0], '/usr/sbin/spctl');
});
test('offline metadata signer refuses unconfigured trust before reading any key/input or creating output', async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      'scripts/create-bridge-update-metadata.ts',
      '/nonexistent-synthetic-template',
      '/nonexistent-synthetic-key',
      '/nonexistent-synthetic-output',
    ]),
    (error) =>
      error.code === 1 &&
      error.stderr.trim() === 'UPDATE_METADATA_SIGNING_FAILED',
  );
});
