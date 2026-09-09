import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePayload, sourceHash } from '../test/local-mcp.js';
import { localMcpSourceDigest } from './local-mcp-protocol.js';
import { readLocalMcpInputs } from './local-mcp-inputs.js';

let root: string, configRoot: string;
const source = 'console.log("synthetic source");';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-p17-input-'));
  configRoot = await mkdtemp(join(tmpdir(), 'allrice-p17-config-'));
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(configRoot, 'config.json'));
  await writeFile(join(root, 'server.mjs'), source);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(configRoot, { recursive: true, force: true });
});
describe('P17 exact source manifest into isolated working copy', () => {
  it('stages only declared frozen bytes and never installs packages', async () => {
    await writeFile(join(root, 'not-declared.txt'), 'private incidental data');
    const result = await readLocalMcpInputs(root, fixturePayload(source));
    expect(result.files).toEqual([
      { path: 'server.mjs', content: Buffer.from(source).toString('base64') },
    ]);
  });
  it('resolves source files relative to the authorized working directory', async () => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/server.mjs'), source);
    const payload = fixturePayload(source);
    payload.arguments.path = 'nested';
    expect((await readLocalMcpInputs(root, payload)).files[0]?.path).toBe(
      'nested/server.mjs',
    );
  });
  it('rejects a source version/hash mismatch or changed source bytes', async () => {
    const payload = fixturePayload(source);
    payload.arguments.source.version = '2';
    await expect(readLocalMcpInputs(root, payload)).rejects.toThrow(
      'LOCAL_MCP_SOURCE_CHANGED',
    );
    await writeFile(join(root, 'server.mjs'), 'changed');
    await expect(
      readLocalMcpInputs(root, fixturePayload(source)),
    ).rejects.toThrow('LOCAL_MCP_INPUT_DENIED');
  });
  it('never follows a manifest symlink or grants credential-directory overlap', async () => {
    await rm(join(root, 'server.mjs'));
    await symlink(join(configRoot, 'secret'), join(root, 'server.mjs'));
    await expect(
      readLocalMcpInputs(root, fixturePayload(source)),
    ).rejects.toThrow('LOCAL_MCP_INPUT_DENIED');
    vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(root, 'config.json'));
    await expect(
      readLocalMcpInputs(root, fixturePayload(source)),
    ).rejects.toThrow('LOCAL_MCP_INPUT_DENIED');
  });
  it('rejects known sensitive filenames even when explicitly hashed', async () => {
    await writeFile(join(root, '.env'), 'synthetic');
    const payload = fixturePayload(source);
    payload.arguments.source.files.push({
      path: '.env',
      sha256: sourceHash('synthetic'),
    });
    payload.arguments.source.digest = localMcpSourceDigest(
      payload.arguments.source,
    );
    await expect(readLocalMcpInputs(root, payload)).rejects.toThrow(
      'LOCAL_MCP_INPUT_DENIED',
    );
  });
});
