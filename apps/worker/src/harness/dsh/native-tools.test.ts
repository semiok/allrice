import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  nativeSessionRecoveryFailure,
  selectDshNativeTools,
  supportsMcpSchemaLookup,
  mcpCatalogInstructions,
  mcpCatalogAdmissionInstructions,
} from './native-tools.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});
async function artifact(names: string[] | null) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-tools-'));
  roots.push(root);
  const module = join(root, 'node_modules/@allrice/contracts');
  await mkdir(module, { recursive: true });
  await writeFile(
    join(module, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.mjs' }),
  );
  await writeFile(
    join(module, 'index.mjs'),
    'export const allRiceToolManifest=' +
      JSON.stringify(
        names?.map((canonicalName) => ({
          canonicalName,
          transport: 'dsh_broker_native',
        })) ?? null,
      ),
  );
  return join(root, 'runtime.mjs');
}
it('does not bind a new business function to an older artifact or grant unrequested tools', async () => {
  const entry = await artifact(['workspace.file.list', 'web.search']);
  expect(
    await selectDshNativeTools(
      ['workspace.file.list', 'workspace.brand_content.read'],
      entry,
    ),
  ).toEqual(['workspace.file.list']);
});
it('keeps business tools native when the selected artifact provides them', async () => {
  const entry = await artifact(['workspace.brand_content.read']);
  expect(
    await selectDshNativeTools(['workspace.brand_content.read'], entry),
  ).toEqual(['workspace.brand_content.read']);
});
it('preserves offline fixture behavior and excludes envelope-only tools', async () => {
  expect(
    await selectDshNativeTools([
      'workspace.brand_content.read',
      'legacy.envelope.tool',
    ]),
  ).toEqual(['workspace.brand_content.read']);
});
it('rejects an invalid approved-artifact catalog before starting its runtime', async () => {
  const entry = await artifact(null);
  await expect(
    selectDshNativeTools(['web.search'], entry),
  ).rejects.toMatchObject({
    code: 'DSH_NATIVE_TOOL_CATALOG_UNAVAILABLE',
  });
});
it('always exposes automation through the complete host envelope, independently of the pinned native vocabulary', async () => {
  for (const vocabulary of [
    ['workspace.file.list'],
    ['workspace.file.list', 'automation.create'],
  ]) {
    const entry = await artifact(vocabulary);
    expect(
      await selectDshNativeTools(
        ['workspace.file.list', 'automation.create'],
        entry,
      ),
    ).toEqual(['workspace.file.list']);
  }
  expect(await selectDshNativeTools(['automation.create'])).toEqual([]);
});
it('still validates an artifact when its only capability uses the host envelope', async () => {
  const entry = await artifact(null);
  await expect(
    selectDshNativeTools(['automation.create'], entry),
  ).rejects.toMatchObject({ code: 'DSH_NATIVE_TOOL_CATALOG_UNAVAILABLE' });
});
it('distinguishes a native vocabulary mismatch from unavailable storage without exposing runtime text', () => {
  const error = nativeSessionRecoveryFailure(
    Error(
      'tools.restrict() names unknown global tool "workspace_brand_content_read"; known global tools: private-runtime-text',
    ),
  );
  expect(error.code).toBe('DSH_NATIVE_TOOL_CAPABILITY_MISMATCH');
  expect(error.message).not.toContain('private-runtime-text');
  expect(nativeSessionRecoveryFailure(Error('opaque failure')).code).toBe(
    'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE',
  );
});

it('enables deferred schemas only when the exact carrier both validates and advertises describe', async () => {
  expect(await supportsMcpSchemaLookup()).toBe(false);
  const absent = await artifact([]);
  expect(await supportsMcpSchemaLookup(absent)).toBe(false);
  for (const [valid, advertised, expected] of [
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ]) {
    const entry = await artifact(['cloud.mcp.call']);
    await writeFile(
      join(entry, '..', 'allrice-mcp-native-tools.mjs'),
      `export const McpNativeArgumentsSchema={safeParse:()=>({success:${valid}})};
      export const mcpNativeTools=[{canonicalName:'cloud.mcp.call',parameters:{action:{enum:${JSON.stringify(advertised ? ['describe'] : ['status'])}}}}];`,
    );
    expect(await supportsMcpSchemaLookup(entry)).toBe(expected);
  }
});
it('keeps the entire stable directory while loading schemas only on supported carriers', () => {
  const tools = ['z_read', 'a_write'].map((name) => ({
    connectionId: '00000000-0000-4000-8000-000000000001',
    name,
    description: 'Untrusted description',
    risk: 'read_only' as const,
    inputSchema: {
      type: 'object',
      properties: { value: { const: 'EXACT_SCHEMA_SENTINEL' } },
    },
  }));
  const deferred = mcpCatalogInstructions(tools, true);
  expect(deferred).toContain('action="describe"');
  expect(deferred).toContain('a_write');
  expect(deferred).toContain('z_read');
  expect(deferred).not.toContain('EXACT_SCHEMA_SENTINEL');
  expect(deferred).toBe(mcpCatalogInstructions([...tools].reverse(), true));
  expect(deferred).not.toBe(
    mcpCatalogInstructions(
      tools.map((t) => ({ ...t, inputSchema: { type: 'string' } })),
      true,
    ),
  );
  expect(mcpCatalogInstructions(tools, false)).toContain(
    'EXACT_SCHEMA_SENTINEL',
  );
});

it('bounds admission for both small-schema discovery rules and large legacy inline schemas', () => {
  const tool = {
    connectionId: '00000000-0000-4000-8000-000000000001',
    name: 'read',
    description: 'Read a public resource',
    risk: 'read_only' as const,
    inputSchema: { type: 'object' },
  };
  expect(mcpCatalogAdmissionInstructions(undefined)).toBe('');
  expect(mcpCatalogAdmissionInstructions([])).toBe('');
  expect(mcpCatalogAdmissionInstructions([tool])).toContain(
    'action="describe"',
  );
  expect(
    mcpCatalogAdmissionInstructions([
      {
        ...tool,
        inputSchema: {
          type: 'object',
          description: '完整参数约束'.repeat(1_000),
        },
      },
    ]),
  ).toContain('完整参数约束');
});
