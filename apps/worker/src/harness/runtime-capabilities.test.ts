import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkerCapabilities } from './runtime-capabilities.js';

let directory: string;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture(content: string) {
  directory = mkdtempSync(resolve(tmpdir(), 'allrice-capabilities-'));
  symlinkSync(
    resolve(import.meta.dirname, '../../node_modules'),
    resolve(directory, 'node_modules'),
    'dir',
  );
  const path = resolve(directory, 'profile.yml');
  writeFileSync(path, content);
  return path;
}
describe('Worker capability facts', () => {
  it('reads the installed composition, including entries absent from the old UI catalog', () => {
    const result = readWorkerCapabilities(randomUUID());
    expect(result.profileStatus).toBe('read');
    expect(result.version).toBe('0.1.5-rc.3');
    expect(result.components.find((c) => c.id === 'agent-loop')).toMatchObject({
      packageName: '@deepseek-ai/dsh-agent-loop',
      version: result.version,
      state: 'configured',
    });
    expect(result.components.find((c) => c.id === 'session-title')?.state).toBe(
      'configured',
    );
    expect(
      result.components.every((c) => c.version && c.state === 'configured'),
    ).toBe(true);
  });
  it('does not execute !!js, disclose config, or count disabled/missing/conditional entries as configured', () => {
    const profilePath = fixture(`
- id: enabled
  name: '@deepseek-ai/dsh-session'
  config:
    apiKey: synthetic-secret-never-published
    probe: !!js (() => { throw new Error('must not execute') })()
- id: disabled
  name: '@deepseek-ai/dsh-session'
  disabled: true
- id: conditional
  name: '@deepseek-ai/dsh-session'
  disabled: !!js process.env.SYNTHETIC_FLAG
- id: missing
  name: '@allrice/nonexistent-plugin'
`);
    const result = readWorkerCapabilities(randomUUID(), { profilePath });
    expect(result.components.map((c) => c.state)).toEqual([
      'configured',
      'disabled',
      'conditional',
      'missing',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|SYNTHETIC_FLAG|must not execute/,
    );
  });
  it('reports an unreadable composition and a custom binary as unknown', () => {
    const profilePath = fixture('not-an-entry-list');
    expect(readWorkerCapabilities(randomUUID(), { profilePath })).toMatchObject(
      { profileStatus: 'unavailable', components: [] },
    );
    vi.stubEnv('ALLRICE_DSH_RUNTIME_COMMAND', '/synthetic/runtime');
    expect(readWorkerCapabilities(randomUUID())).toMatchObject({
      profileStatus: 'custom-runtime',
      version: null,
      components: [],
    });
  });
});
