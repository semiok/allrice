import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it.skipIf(process.platform !== 'darwin')(
  'compiles actual native Swift picker callbacks and isolates canceled/stale panel ownership',
  async () => {
    const [application, fixture] = await Promise.all([
      readFile(
        new URL('../macos/RiceBridgeApp.swift', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../test/desktop-picker-native.swift', import.meta.url),
        'utf8',
      ),
    ]);
    // Keep every production callback, excluding only the real app entrypoint.
    const entry = '\nlet application = NSApplication.shared\n';
    expect(application.split(entry)).toHaveLength(2);
    const root = await mkdtemp(join(tmpdir(), 'allrice-picker-swift-'));
    const source = join(root, 'PickerFixture.swift');
    const binary = join(root, 'PickerFixture');
    try {
      await writeFile(
        source,
        fixture.replace(
          '// PRODUCTION_APP_INSERT',
          application.split(entry)[0]!,
        ),
      );
      await execute(
        '/usr/bin/xcrun',
        [
          'swiftc',
          '-target',
          `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
          source,
          '-o',
          binary,
        ],
        { timeout: 25_000, maxBuffer: 64_000 },
      );
      const result = await execute(binary, [], {
        timeout: 5000,
        maxBuffer: 4096,
      });
      expect(result.stdout.trim()).toBe('native Swift picker ownership passed');
      expect(result.stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  35_000,
);
