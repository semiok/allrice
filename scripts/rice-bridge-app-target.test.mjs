import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  bridgeAppBundle,
  bridgeAppLocalizations,
  pinBridgeAppArch,
} from './rice-bridge-app-target.mjs';

const source = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('an Intel host without ALLRICE_BRIDGE_APP_ARCH still builds every part for Apple silicon', () => {
  const environment = { PATH: process.env.PATH };
  assert.equal(pinBridgeAppArch(environment), 'arm64');
  // The SEA, PDF, FileGuardian and terminal builds resolve
  // `ALLRICE_BRIDGE_APP_ARCH ?? process.arch` in the environment they inherit.
  assert.equal(
    execFileSync(
      process.execPath,
      ['-p', "process.env.ALLRICE_BRIDGE_APP_ARCH ?? 'x64'"],
      { env: environment, encoding: 'utf8' },
    ).trim(),
    'arm64',
  );
  assert.equal(pinBridgeAppArch({ ALLRICE_BRIDGE_APP_ARCH: 'arm64' }), 'arm64');
  assert.throws(
    () => pinBridgeAppArch({ ALLRICE_BRIDGE_APP_ARCH: 'x64' }),
    /Apple silicon/,
  );
});

test('Finder shows AllRice 助手 only while CFBundleDisplayName matches the unchanged bundle file name', async () => {
  const plist = await source('apps/rice-bridge/macos/Info.plist');
  const value = (key) =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
      plist,
    )?.[1];
  // macOS uses the localized name only when the file name equals this value.
  assert.equal(`${value('CFBundleDisplayName')}.app`, bridgeAppBundle);
  assert.equal(value('CFBundleName'), 'AllRice');
  assert.match(plist, /<key>LSHasLocalizedDisplayName<\/key>\s*<true\/>/);
  // Updates install over the same bundle name.
  assert.match(
    await source('apps/rice-bridge/src/update-installer.ts'),
    new RegExp(`const appName = '${bridgeAppBundle}';`),
  );
  for (const language of bridgeAppLocalizations) {
    const strings = await source(
      `apps/rice-bridge/macos/${language}.lproj/InfoPlist.strings`,
    );
    assert.match(strings, /^CFBundleDisplayName = "AllRice 助手";$/m);
    assert.match(strings, /^CFBundleName = "AllRice";$/m);
  }
});
