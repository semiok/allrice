import {
  readFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceAnalyzer,
  FaceModelEmitter,
  type WorkspaceAnalyzerOptions,
} from '@deepseek-ai/dsh-typert-generator';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import { withPrincipalGeneratorInput } from '../build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const protocol = dirname(
  require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'),
);
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
describe('real official generator and same-release artifact closure', () => {
  it('derives all three methods, original native result codecs and duplex uplinks from the current source', async () => {
    let scratch = '';
    const emitted = await withPrincipalGeneratorInput(
      async (options: WorkspaceAnalyzerOptions) => {
        scratch = options.root;
        expect(options).toMatchObject({
          faces: ['host'],
          packages: ['@allrice/d-entry-principal'],
          checkDiagnostics: true,
          rejectBuildOutputs: true,
        });
        const declared = join(protocol, 'lib/types');
        const source = join(scratch, 'packages/protocol/src');
        const names = (await readdir(declared))
          .filter((name) => name.endsWith('.d.ts'))
          .sort();
        expect((await readdir(source)).sort()).toEqual(
          names.map((name) => name.replace(/\.d\.ts$/, '.ts')),
        );
        for (const name of names)
          expect(
            await readFile(join(source, name.replace(/\.d\.ts$/, '.ts'))),
          ).toEqual(await readFile(join(declared, name)));
        const config = JSON.parse(
          await readFile(join(scratch, 'tsconfig.host.json'), 'utf8'),
        );
        const paths: Record<string, string[]> = JSON.parse(
          await readFile(resolve(root, '../../tsconfig.base.json'), 'utf8'),
        ).compilerOptions.paths;
        for (const [name, targets] of Object.entries(paths))
          expect(config.compilerOptions.paths[name]).toEqual(
            targets.map((target) => resolve(root, '../..', target)),
          );
        const analysis = new WorkspaceAnalyzer(options).analyze();
        const face = analysis.faces.find((value) => value.face === 'host');
        if (!face) throw Error('actual Host model missing');
        const artifact = new FaceModelEmitter(face).emit(
          '@allrice/d-entry-principal',
        );
        if (!artifact.remote) throw Error('actual Remote model missing');
        return artifact;
      },
    );
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
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
  it('removes only its scratch when the analysis consumer rejects and leaves dependency symlink targets intact', async () => {
    const original = await readFile(join(protocol, 'lib/types/index.d.ts'));
    const failure = Error('analysis consumer rejected');
    let scratch = '';
    let dependencyTarget = '';
    await expect(
      withPrincipalGeneratorInput(async (options: WorkspaceAnalyzerOptions) => {
        scratch = options.root;
        dependencyTarget = await realpath(
          join(scratch, 'packages/protocol/node_modules'),
        );
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(dependencyTarget)).isDirectory()).toBe(true);
    expect(digest(await readFile(join(protocol, 'lib/types/index.d.ts')))).toBe(
      digest(original),
    );
  });
  it.each(['hash', 'closure', 'metadata'] as const)(
    'rejects %s drift before the official analyzer without changing the provided declaration source',
    async (drift) => {
      const fixture = await realpath(
        await mkdtemp(join(tmpdir(), 'principal-protocol-negative-')),
      );
      const isolated = join(fixture, 'protocol');
      try {
        await mkdir(isolated);
        await cp(
          join(protocol, 'package.json'),
          join(isolated, 'package.json'),
        );
        await cp(join(protocol, 'lib/types'), join(isolated, 'lib/types'), {
          recursive: true,
        });
        if (drift === 'hash')
          await writeFile(
            join(isolated, 'lib/types/index.d.ts'),
            Buffer.concat([
              await readFile(join(isolated, 'lib/types/index.d.ts')),
              Buffer.from('\n'),
            ]),
          );
        else if (drift === 'closure')
          await writeFile(
            join(isolated, 'lib/types/unexpected.d.ts'),
            'export {};\n',
          );
        else {
          const changed = JSON.parse(
            await readFile(join(isolated, 'package.json'), 'utf8'),
          );
          changed.version = 'different';
          await writeFile(
            join(isolated, 'package.json'),
            JSON.stringify(changed),
          );
        }
        const before = await readFile(join(isolated, 'lib/types/index.d.ts'));
        let analyzed = false;
        await expect(
          withPrincipalGeneratorInput(() => {
            analyzed = true;
          }, isolated),
        ).rejects.toThrow(
          drift === 'metadata'
            ? 'PRINCIPAL_PROTOCOL_PACKAGE_CHANGED'
            : 'PRINCIPAL_PROTOCOL_DECLARATIONS_CHANGED',
        );
        expect(analyzed).toBe(false);
        expect(await readFile(join(isolated, 'lib/types/index.d.ts'))).toEqual(
          before,
        );
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );
});
