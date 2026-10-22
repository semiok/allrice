import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import {
  prepareTerminalRuntime,
  verifyTerminalPackage,
} from './rice-bridge-terminal-runtime.mjs';
import { verifyTerminalRuntime } from './rice-bridge-terminal-loader.mjs';

test('fixed terminal loader rejects tampered, injected, writable and symlinked sidecars', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-terminal-integrity-')),
  );
  try {
    const entry = join(root, 'probe.js');
    const source = 'export const probe = 1;\n';
    await writeFile(entry, source, { mode: 0o644 });
    const packages = [
      ['@deepseek-ai/cordis', '4.0.5'],
      ['@deepseek-ai/dsh-api-terminal-controller', '0.2.1-rc.2'],
      ['@deepseek-ai/dsh-subprocess-local', '0.2.1-rc.2'],
      ['node-pty', '1.2.0-beta.15'],
      ['koffi', '3.1.1'],
      ['@koromix/koffi-darwin-x64', '3.1.1'],
    ].map(([name, version]) => ({ name, version }));
    const manifest = {
      version: 1,
      platform: 'macos-x64',
      packages,
      files: [
        {
          path: 'probe.js',
          sizeBytes: Buffer.byteLength(source),
          sha256: createHash('sha256').update(source).digest('hex'),
          executable: false,
        },
      ],
    };
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { mode: 0o644 },
    );
    const check = () =>
      verifyTerminalRuntime(root, manifest, {
        platform: 'darwin',
        architecture: 'x64',
        nodeVersion: '22.23.2',
      });
    assert.equal(typeof check(), 'function');
    await writeFile(entry, source.replace('1', '2'));
    assert.throws(check, /INTEGRITY_FAILED/);
    await writeFile(entry, source);
    await writeFile(join(root, 'injected.js'), '');
    assert.throws(check, /INTEGRITY_FAILED/);
    await unlink(join(root, 'injected.js'));
    await chmod(entry, 0o666);
    assert.throws(check, /INTEGRITY_FAILED/);
    await chmod(entry, 0o644);
    await unlink(entry);
    await symlink(join(root, 'manifest.json'), entry);
    assert.throws(check, /INTEGRITY_FAILED/);
    assert.throws(
      () =>
        verifyTerminalRuntime(root, manifest, {
          platform: 'darwin',
          architecture: 'arm64',
          nodeVersion: '22.23.2',
        }),
      /INTEGRITY_FAILED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin')(
  'copied locked native closure opens a real PTY and retains required helper permissions',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-terminal-runtime-')),
    );
    let ctx;
    try {
      const built = await prepareTerminalRuntime(join(root, 'RiceBridge'));
      await verifyTerminalPackage(join(root, 'RiceBridge'), {
        architecture: process.arch,
        manifestSha256: built.manifestSha256,
      });
      const require = verifyTerminalRuntime(built.runtime, built.manifest);
      const { Context } = require('@deepseek-ai/cordis');
      const {
        LocalSubprocessRuntime,
      } = require('@deepseek-ai/dsh-subprocess-local');
      const {
        TerminalController,
      } = require('@deepseek-ai/dsh-api-terminal-controller');
      ctx = new Context();
      const subprocess = new LocalSubprocessRuntime(ctx);
      ctx.provide('sandboxPolicy', {});
      ctx.provide('workingDirectory', {
        get: () => root,
        ensure: async () => root,
      });
      const controller = new TerminalController(
        ctx,
        TerminalController.Config({
          ...TerminalController.Config(),
          shell: { path: '/bin/zsh', name: 'zsh', args: ['-f', '-i'] },
          unattendedTimeoutMs: 0,
        }),
      );
      const agent = {
        id: 'copied-native-owner',
        session: { id: 'copied-native-owner' },
        ctx,
      };
      const created = await controller.create(
        agent,
        { id: 'copied-native-terminal', cols: 80, rows: 24 },
        new globalThis.AbortController().signal,
      );
      assert.equal(created.cwd, root);
      await controller.close(agent, created.id);
      const handle = await subprocess.spawnTerminal({
        argv: ['/bin/zsh', '-f', '-i'],
        cwd: root,
        cols: 80,
        rows: 24,
        terminalType: 'xterm-256color',
        graceMs: 1000,
      });
      let output = '';
      handle.output.on('data', (chunk) => {
        output += chunk.toString();
      });
      try {
        await handle.write("test -t 0 && printf 'COPIED_NATIVE_TTY\\n'\r");
        const deadline = performance.now() + 5000;
        while (!output.includes('COPIED_NATIVE_TTY\r\n')) {
          assert.ok(
            performance.now() < deadline,
            'copied native PTY did not answer',
          );
          await delay(5);
        }
      } finally {
        await handle.terminate();
      }
      const helper = built.manifest.files.find((file) =>
        file.path.endsWith('/spawn-helper'),
      );
      assert.ok(helper.executable);
      assert.ok((await lstat(join(built.runtime, helper.path))).mode & 0o111);
      console.log(
        JSON.stringify({
          terminalRuntime: {
            packages: built.manifest.packages.length,
            files: built.manifest.files.length,
            bytes: built.manifest.files.reduce(
              (sum, file) => sum + file.sizeBytes,
              0,
            ),
            platform: built.manifest.platform,
            native: 'PTY TTY and DSH controller creation/close passed',
            integrity: 'sha256 and exact resource tree verified',
          },
        }),
      );
    } finally {
      await ctx?.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
