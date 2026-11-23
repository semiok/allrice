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
import { createHash, randomUUID } from 'node:crypto';
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
const values = dirname(
  require.resolve('@deepseek-ai/dsh-util-values/package.json'),
);
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
describe('real official generator and same-release artifact closure', () => {
  it('derives all three methods, original native result codecs and duplex uplinks from the current source', async () => {
    const originalContractManifest = await readFile(
      resolve(root, '../contracts/package.json'),
    );
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
        for (const [name, original] of [
          ['protocol', protocol],
          ['values', values],
        ] as const) {
          const declared = join(original, 'lib/types');
          const staged = join(scratch, 'packages', name);
          const source = join(staged, 'src');
          const names = (await readdir(declared))
            .filter((name) => name.endsWith('.d.ts'))
            .sort();
          if (name === 'values')
            expect(names).toEqual(['index.d.ts', 'partial-json.d.ts']);
          expect((await readdir(source)).sort()).toEqual(
            names.map((name) => name.replace(/\.d\.ts$/, '.ts')),
          );
          expect(await readFile(join(staged, 'package.json'))).toEqual(
            await readFile(join(original, 'package.json')),
          );
          for (const file of names)
            expect(
              await readFile(join(source, file.replace(/\.d\.ts$/, '.ts'))),
            ).toEqual(await readFile(join(declared, file)));
        }
        const config = JSON.parse(
          await readFile(join(scratch, 'tsconfig.host.json'), 'utf8'),
        );
        const paths: Record<string, string[]> = JSON.parse(
          await readFile(resolve(root, '../../tsconfig.base.json'), 'utf8'),
        ).compilerOptions.paths;
        const stagedPaths: Record<string, string[]> = {
          '@allrice/contracts': [
            join(scratch, 'packages/contracts/src/index.ts'),
          ],
          '@allrice/contracts/native-runtime': [
            join(scratch, 'packages/contracts/src/native-runtime.ts'),
          ],
          '@allrice/d-entry-principal/types': [
            join(scratch, 'packages/d-entry-principal/src/types.ts'),
          ],
        };
        for (const [name, targets] of Object.entries(paths))
          expect(config.compilerOptions.paths[name]).toEqual(
            stagedPaths[name] ??
              targets.map((target) => resolve(root, '../..', target)),
          );
        expect(
          config.compilerOptions.paths['@deepseek-ai/dsh-util-values'],
        ).toEqual([join(scratch, 'packages/values/src/index.ts')]);
        expect(
          config.compilerOptions.paths['@deepseek-ai/dsh-typert-protocol'],
        ).toEqual([join(scratch, 'packages/protocol/src/index.ts')]);
        expect(
          config.references.map((entry: { path: string }) => entry.path),
        ).toEqual([
          join(scratch, 'packages/d-entry-principal'),
          join(scratch, 'packages/contracts'),
          join(scratch, 'packages/protocol'),
          join(scratch, 'packages/values'),
        ]);
        const contracts = resolve(root, '../contracts');
        const contractManifest = JSON.parse(
          originalContractManifest.toString(),
        );
        expect(
          JSON.parse(
            await readFile(
              join(scratch, 'packages/contracts/package.json'),
              'utf8',
            ),
          ),
        ).toEqual({
          ...contractManifest,
          exports: {
            ...contractManifest.exports,
            '.': { ...contractManifest.exports['.'], types: './src/index.ts' },
            './native-runtime': {
              ...contractManifest.exports['./native-runtime'],
              types: './src/native-runtime.ts',
            },
          },
        });
        const contractSources = (
          await readdir(join(contracts, 'src'), { recursive: true })
        )
          .filter(
            (name) => /\.(?:ts|json)$/.test(name) && !name.endsWith('.test.ts'),
          )
          .sort();
        expect(contractSources).toContain('index.ts');
        expect(contractSources).toContain('d-entry.ts');
        for (const name of contractSources)
          expect(
            await readFile(join(scratch, 'packages/contracts/src', name)),
          ).toEqual(await readFile(join(contracts, 'src', name)));
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
    expect(await readFile(resolve(root, '../contracts/package.json'))).toEqual(
      originalContractManifest,
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
  it('retains legal native JSON emit fields and rejects non-JSON values in the generated stream result codec', () => {
    const codec =
      TYPERT_REMOTE.methods['allricePrincipal/streamScoped'].result.create();
    const frame = {
      type: 'item',
      scopeId: randomUUID(),
      value: {
        type: 'emit',
        event: 'codec-domain-only',
        args: [null, true, false, '', -7, 0, [1, { nested: ['x', null] }]],
      },
    };
    // Codec coverage supplies no notification permission to the product Peer.
    expect(codec.parse(frame)).toEqual(frame);
    for (const args of [[undefined], [Infinity], [() => undefined]])
      expect(() =>
        codec.parse({ ...frame, value: { ...frame.value, args } }),
      ).toThrow();
  });
  it('publishes a closed manifest only after every generated/Node/Host byte is sealed', async () => {
    const receiptPath = require.resolve('@allrice/d-entry-principal/artifact');
    const manifest = JSON.parse(await readFile(receiptPath, 'utf8'));
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
          .update(await readFile(resolve(dirname(receiptPath), file.path)))
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
    const originals = await Promise.all(
      [protocol, values].map(async (path) => ({
        path,
        bytes: await readFile(join(path, 'lib/types/index.d.ts')),
      })),
    );
    const failure = Error('analysis consumer rejected');
    let scratch = '';
    let dependencyTargets: string[] = [];
    await expect(
      withPrincipalGeneratorInput(async (options: WorkspaceAnalyzerOptions) => {
        scratch = options.root;
        dependencyTargets = await Promise.all(
          ['protocol', 'values'].map((name) =>
            realpath(join(scratch, 'packages', name, 'node_modules')),
          ),
        );
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const target of dependencyTargets)
      expect((await stat(target)).isDirectory()).toBe(true);
    for (const { path, bytes } of originals)
      expect(digest(await readFile(join(path, 'lib/types/index.d.ts')))).toBe(
        digest(bytes),
      );
  });
  describe.each([
    ['protocol', protocol, 'PROTOCOL'],
    ['values', values, 'VALUES'],
  ] as const)('%s declaration closure', (name, original, label) => {
    it.each(['hash', 'closure', 'metadata'] as const)(
      'rejects %s drift before the official analyzer without changing the provided declaration source',
      async (drift) => {
        const fixture = await realpath(
          await mkdtemp(join(tmpdir(), `principal-${name}-negative-`)),
        );
        const isolated = join(fixture, name);
        try {
          await mkdir(isolated);
          await cp(
            join(original, 'package.json'),
            join(isolated, 'package.json'),
          );
          await cp(join(original, 'lib/types'), join(isolated, 'lib/types'), {
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
            withPrincipalGeneratorInput(
              () => {
                analyzed = true;
              },
              name === 'protocol' ? isolated : protocol,
              name === 'values' ? isolated : values,
            ),
          ).rejects.toThrow(
            drift === 'metadata'
              ? `PRINCIPAL_${label}_PACKAGE_CHANGED`
              : `PRINCIPAL_${label}_DECLARATIONS_CHANGED`,
          );
          expect(analyzed).toBe(false);
          expect(
            await readFile(join(isolated, 'lib/types/index.d.ts')),
          ).toEqual(before);
        } finally {
          await rm(fixture, { recursive: true, force: true });
        }
      },
    );
  });
});
