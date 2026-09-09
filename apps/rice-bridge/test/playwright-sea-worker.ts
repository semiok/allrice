/** Separate synthetic SEA entry, never part of the production CLI. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { BrowserProfileSchema } from '@allrice/contracts';
import { startLocalBrowserDriver } from '../src/local-browser-driver.js';
import { LocalBrowserProfiles } from '../src/local-browser-profiles.js';

async function main() {
  const directory = process.argv[2];
  assert(directory);
  const mode = process.argv[3];
  assert(mode === undefined || mode === 'hold');
  assert(process.argv.length <= 4);
  let ownedDirectory: string | undefined;
  // Private diagnostic only: identical arguments/transport, no override or retry.
  const launch = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = async (...args) => {
    try {
      const context = await launch(...args);
      ownedDirectory = dirname(args[0]);
      return context;
    } catch (error) {
      await writeFile(
        join(directory, 'launch-error.private.txt'),
        error instanceof Error ? error.message : 'FAILED',
        { mode: 0o600 },
      );
      throw error;
    }
  };
  let alive = true;
  let expiry = Number.POSITIVE_INFINITY;
  const current = async () => {
    if (!alive || Date.now() >= expiry) throw Error('SYNTHETIC_CLOSED');
  };
  const driver = await startLocalBrowserDriver({
    binding: {
      version: 1,
      scope: {
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        projectId: null,
      },
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      grantId: randomUUID(),
      grantRevision: 1,
      logicalProfileId: randomUUID(),
      persistLogin: false,
    },
    profiles: new LocalBrowserProfiles(
      join(directory, 'synthetic-config.json'),
      'https://saas.example.com',
    ),
    options: {
      profileId: randomUUID(),
      profile: BrowserProfileSchema.parse({
        version: 1,
        origins: ['https://example.com'],
      }),
      assertCurrent: current,
      requestStarted: () => () => {},
      requestSent: () => {
        throw Error('UNEXPECTED_NETWORK_EFFECT');
      },
      requestApproval: async () => {
        throw Error('SYNTHETIC_DENIED');
      },
    },
    assertAlive: current,
    leaseExpiresAt: () => Math.min(expiry, Date.now() + 4900),
  });
  try {
    const capture = await driver.observe(1);
    assert.equal(capture.observation.url, 'about:blank');
    assert(capture.screenshot.length > 100);
    if (mode === 'hold') {
      assert(ownedDirectory);
      const status = JSON.parse(
        await readFile(join(ownedDirectory, 'process.json'), 'utf8'),
      );
      assert.equal(status.parentPid, process.pid);
      assert.equal(status.stopped, false);
      assert(Number.isSafeInteger(status.childPid) && status.childPid > 1);
      assert(Number.isSafeInteger(status.helperPid) && status.helperPid > 1);
      console.log(
        JSON.stringify({
          ready: true,
          seaPid: process.pid,
          directory: ownedDirectory,
          processRecord: join(ownedDirectory, 'process.json'),
          childPid: status.childPid,
          helperPid: status.helperPid,
          nonce: status.nonce,
          maximumHoldMs: 15000,
        }),
      );
      const lines = createInterface({ input: process.stdin });
      try {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 15000);
          const finish = () => {
            clearTimeout(timeout);
            resolve();
          };
          lines.on('line', (line) => {
            if (line === 'expire') expiry = Date.now() + 1000;
            else if (line === 'close') finish();
            else {
              process.exitCode = 1;
              finish();
            }
          });
          lines.once('close', finish);
        });
      } finally {
        lines.close();
        process.stdin.pause();
      }
    }
  } finally {
    alive = false;
    await driver.close('lost');
  }
  console.log(
    JSON.stringify({
      passed: true,
      scope:
        'real SEA + production local driver + native supervisor + isolated installed Chrome; no account/network/model',
      physicalStopConfirmed: true,
    }),
  );
}
void main().catch(() => {
  console.error('SYNTHETIC_BROWSER_SEA_FAILED');
  process.exitCode = 1;
});
