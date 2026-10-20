import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  nativeSessionRecoveryFailure,
  selectDshNativeTools,
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
it.each([
  '请每隔两分钟提醒我喝水。',
  '请每天09:30，时区Asia/Shanghai，提醒我检查报表。',
])(
  'uses the existing canonical envelope for an explicit current recurring request: %s',
  async (request) => {
    for (const vocabulary of [
      ['workspace.file.list'],
      ['workspace.file.list', 'automation.create'],
    ]) {
      const entry = await artifact(vocabulary);
      expect(
        await selectDshNativeTools(
          ['workspace.file.list', 'automation.create'],
          entry,
          request,
        ),
      ).toEqual(['workspace.file.list']);
    }
    expect(
      await selectDshNativeTools(['automation.create'], undefined, request),
    ).toEqual([]);
  },
);
it.each([
  undefined,
  '',
  '请在15分钟后提醒我喝水。',
  '请解释示例：“每十五分钟提醒我喝水”。',
  '“请每隔两分钟提醒我喝水。”',
  '如果我确认了，再每十五分钟提醒我喝水。',
  '每天九点提醒我。',
  '请每30秒提醒我喝水。',
])(
  'preserves once and uncertain transport without new recurring authority: %s',
  async (request) => {
    const current = await artifact(['automation.create']);
    expect(
      await selectDshNativeTools(['automation.create'], current, request),
    ).toEqual(['automation.create']);
    const older = await artifact(['workspace.file.list']);
    expect(
      await selectDshNativeTools(['automation.create'], older, request),
    ).toEqual([]);
  },
);
it('still validates the selected artifact when recurring transport removes its only native tool', async () => {
  const entry = await artifact(null);
  await expect(
    selectDshNativeTools(
      ['automation.create'],
      entry,
      '请每隔两分钟提醒我喝水。',
    ),
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
