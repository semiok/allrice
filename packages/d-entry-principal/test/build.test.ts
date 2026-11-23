import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceAnalyzer,
  FaceModelEmitter,
} from '@deepseek-ai/dsh-typert-generator';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
describe('real official generator and same-release artifact closure', () => {
  it('derives all three methods, original native result codecs and duplex uplinks from the current source', async () => {
    const analysis = new WorkspaceAnalyzer({
      root: resolve(root, '../..'),
      hostConfig: 'packages/d-entry-principal/tsconfig.typert.json',
      packages: ['@allrice/d-entry-principal'],
      faces: ['host'],
      checkDiagnostics: true,
    }).analyze();
    const face = analysis.faces.find((value) => value.face === 'host');
    if (!face) throw Error('actual Host model missing');
    const emitted = new FaceModelEmitter(face).emit(
      '@allrice/d-entry-principal',
    );
    expect(await readFile(resolve(root, 'lib/typert.host.js'), 'utf8')).toBe(
      emitted.js,
    );
    expect(
      await readFile(resolve(root, 'lib/typert.remote-client.js'), 'utf8'),
    ).toBe(emitted.remote?.js);
    expect(Object.keys(TYPERT_REMOTE.methods).sort()).toEqual([
      'allricePrincipal/invokeScoped',
      'allricePrincipal/openScope',
      'allricePrincipal/streamScoped',
    ]);
    for (const endpoint of [
      'allricePrincipal/openScope',
      'allricePrincipal/streamScoped',
    ] as const) {
      const uplink = TYPERT_REMOTE.methods[endpoint].uplink;
      if (!uplink || uplink.codec.mode !== 'strict')
        throw Error('actual typed duplex codec missing');
      expect(uplink.codec.create().parse('close')).toBe('close');
      expect(() => uplink.codec.create().parse('cancelScope')).toThrow();
    }
  });
  it('publishes a closed manifest only after every generated/Node/Host byte is sealed', async () => {
    const manifest = JSON.parse(
      await readFile(
        resolve(root, 'lib/current-principal.manifest.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      schema: 1,
      package: '@allrice/d-entry-principal',
      version: '0.1.0',
      dshVersion: '0.2.1-rc.2',
    });
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining([
        'host.js',
        'typert.host.js',
        'typert.remote-client.js',
        'types/types.d.ts',
      ]),
    );
    for (const file of manifest.files)
      expect(
        createHash('sha256')
          .update(await readFile(resolve(root, file.path)))
          .digest('hex'),
      ).toBe(file.sha256);
    expect(
      manifest.modules.every(
        (entry: { specifier: string }) =>
          entry.specifier.startsWith('@deepseek-ai/') &&
          !entry.specifier.includes('/src/') &&
          !entry.specifier.includes('/internal'),
      ),
    ).toBe(true);
  });
});
