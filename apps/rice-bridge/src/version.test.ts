import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { bridgeVersion } from './version.js';

it('keeps the native application version aligned with the public CLI version', async () => {
  const match = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/.exec(bridgeVersion);
  expect(match).not.toBeNull();
  const plist = await readFile(
    new URL('../macos/Info.plist', import.meta.url),
    'utf8',
  );
  expect(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
      plist,
    )?.[1],
  ).toBe(match![1]);
  expect(
    /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1],
  ).toBe(match![2]);
});
