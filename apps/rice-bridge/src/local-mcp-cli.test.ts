import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from './config.js';
import {
  readLocalMcpCredential,
  type LocalMcpCredentialBinding,
} from './local-mcp-credentials.js';
import { BridgeInstanceLock } from './instance-lock.js';

let directory: string, binding: LocalMcpCredentialBinding;
const index = fileURLToPath(new URL('./index.ts', import.meta.url));
const project = fileURLToPath(new URL('../../../', import.meta.url));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'allrice-p17-cli-'));
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(directory, 'config.json'));
  binding = {
    server: 'https://synthetic.example',
    deviceId: randomUUID(),
    connectionId: randomUUID(),
    sourceDigest: `sha256:${'9'.repeat(64)}`,
    reference: { id: randomUUID(), revision: 1 },
  };
  await writeConfig({
    server: binding.server,
    deviceId: binding.deviceId,
    deviceName: 'Synthetic CLI',
    grants: [],
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function cli(args: string[], stdin = '') {
  return new Promise<{ code: number | null; output: string; argv: string[] }>(
    (resolve, reject) => {
      const argv = ['--import', 'tsx', index, 'local-mcp', ...args];
      // Only a test-owned Node CLI process, isolated config and minimal env. This
      // never starts the App, reads device credentials, runs security or Docker.
      const child = spawn(process.execPath, argv, {
        cwd: project,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NODE_NO_WARNINGS: '1',
          ALLRICE_BRIDGE_CONFIG_PATH: join(directory, 'config.json'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '',
        exceeded = false;
      const append = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 8192) {
          exceeded = true;
          child.kill('SIGKILL');
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        exceeded = true;
        child.kill('SIGKILL');
      }, 10000);
      child.on('error', () => {
        clearTimeout(timer);
        reject(Error('synthetic CLI spawn failed'));
      });
      child.stdin.on('error', () => undefined);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (exceeded) reject(Error('synthetic CLI bound exceeded'));
        else resolve({ code, output, argv });
      });
      child.stdin.end(stdin);
    },
  );
}
describe('P17 actual operator CLI with private synthetic credentials', () => {
  it('accepts secret only over stdin, persists bound record, then revokes through the actual command', async () => {
    const secret = 'synthetic-cli-token-"quoted"';
    const flags = [
      binding.connectionId,
      binding.sourceDigest,
      binding.reference.id,
      '1',
      '--private-file-unencrypted',
    ];
    const set = await cli(['credential', 'set', ...flags], secret + '\n');
    expect(set.code).toBe(0);
    expect(set.output).toContain('private-file-unencrypted');
    expect(set.output).not.toContain(secret);
    expect(set.argv.join(' ')).not.toContain(secret);
    expect(await readLocalMcpCredential(binding)).toBe(secret);
    const revoke = await cli(['credential', 'revoke', ...flags]);
    expect(revoke.code).toBe(0);
    expect(revoke.output).toContain('"cloudConnectionRevoked":false');
    await expect(readLocalMcpCredential(binding)).rejects.toThrow(
      'LOCAL_MCP_CREDENTIAL_REVOKED',
    );
  }, 15000);
  it('help/status remain read-only while a Bridge owner exists, but mutations respect the instance lock', async () => {
    const owner = await BridgeInstanceLock.acquire();
    try {
      expect((await cli(['--help'])).code).toBe(0);
      const status = await cli(['status']);
      expect(status.code).toBe(0);
      expect(status.output).toContain('"localMcpEnabled":false');
      const denied = await cli(['enable']);
      expect(denied.code).toBe(1);
      expect(denied.output).toContain('BRIDGE_ALREADY_RUNNING');
    } finally {
      owner.close();
    }
  }, 15000);
});
