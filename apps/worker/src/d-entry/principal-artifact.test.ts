import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDEntryPrincipalHostArtifact } from './principal-artifact.js';

const state = vi.hoisted(() => ({ corrupt: false, breakClosure: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const value = await actual.readFile(...args);
    const path = String(args[0]);
    if (state.corrupt && path.endsWith('/lib/host.js')) return `${String(value)}\n// corrupted sealed artifact`;
    if (state.breakClosure && path.endsWith('/current-principal.manifest.json')) { const manifest = JSON.parse(String(value)); manifest.files.push({ path: '../escape.js', sha256: 'a'.repeat(64) }); return JSON.stringify(manifest); }
    return value;
  } };
});
afterEach(() => { state.corrupt = false; state.breakClosure = false; });

describe('principal artifact preparation reads only the installed sealed release', () => {
  it('stages the exact file artifact and checks the Node remote/metadata bytes from the same receipt', async () => {
    const artifact = await readDEntryPrincipalHostArtifact();
    const require = createRequire(import.meta.url);
    expect(artifact).toBe(await readFile(require.resolve('@allrice/d-entry-principal/host'), 'utf8'));
  });
  it('refuses changed artifact bytes and incomplete/escaping closure without fallback or guest installation', async () => {
    state.corrupt = true;
    await expect(readDEntryPrincipalHostArtifact()).rejects.toThrow('PRINCIPAL_ARTIFACT_HASH_INVALID');
    state.corrupt = false; state.breakClosure = true;
    await expect(readDEntryPrincipalHostArtifact()).rejects.toThrow('PRINCIPAL_ARTIFACT_CLOSURE_INVALID');
  });
});
