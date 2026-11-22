import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BuiltinSkillSourceError,
  createBuiltinSkillSourcesPort,
  skillBytesChecksum,
} from '@allrice/database';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary: string[] = [];
const signal = () => new AbortController().signal;
async function copiedSources() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-builtin-sources-')),
  );
  temporary.push(directory);
  await cp(join(repositoryRoot, 'skills'), join(directory, 'skills'), {
    recursive: true,
  });
  return directory;
}
afterEach(async () => {
  const prefix = join(await realpath(tmpdir()), 'allrice-builtin-sources-');
  for (const directory of temporary.splice(0)) {
    if (!directory.startsWith(prefix))
      throw Error('unsafe source test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('builtin Skill sources public port', () => {
  it('returns every real source body and metadata without mounting or grants', async () => {
    const port = createBuiltinSkillSourcesPort();
    const catalog = await port.listSources(signal());
    expect(catalog.sources.map((source) => source.name)).toEqual([
      'business-reconciliation',
      'web-research',
      'workspace-briefing',
      'wechat-research',
      'market-data',
      'research-synthesis',
      'governed-memory',
      'workflow-automation',
      'browser-research',
      'office',
      'project-development',
      'scientific-analysis',
      'operations-review',
      'employee-customization',
    ]);
    expect(catalog.sources.flatMap((source) => source.resources)).toHaveLength(
      17,
    );
    expect(catalog.catalogChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const source of catalog.sources) {
      expect(source).not.toHaveProperty('content');
      expect(source).not.toHaveProperty('contentFile');
      expect(source).not.toHaveProperty('installed');
      expect(source).not.toHaveProperty('enabled');
      expect(source).not.toHaveProperty('executionPermission');
      expect(JSON.stringify(source)).not.toContain(repositoryRoot);
      const result = await port.readPackage(source.selector, signal());
      const raw = await readFile(
        join(repositoryRoot, 'skills', source.name, 'SKILL.md'),
        'utf8',
      );
      expect(result.source).toEqual(source);
      expect(result.content).toBe(
        `${raw.slice(raw.indexOf('\n---\n') + 5).trim()}\n`,
      );
      expect(skillBytesChecksum(result.content)).toBe(
        source.selector.contentChecksum,
      );
      expect(result.bundle?.checksum ?? null).toBe(
        source.selector.bundleChecksum,
      );
      for (const metadata of source.resources) {
        expect(metadata).not.toHaveProperty('contentBase64');
        const resource = result.bundle!.resources.find(
          (entry) => entry.path === metadata.path,
        )!;
        const bytes = await readFile(
          join(repositoryRoot, 'skills', source.name, metadata.path),
        );
        expect(Buffer.from(resource.contentBase64, 'base64')).toEqual(bytes);
        expect(skillBytesChecksum(bytes)).toBe(metadata.checksum);
      }
    }
  });

  it('keeps finance scripts/CSV and Office charts/checker/license bytes reachable', async () => {
    const port = createBuiltinSkillSourcesPort();
    const catalog = await port.listSources(signal());
    const operations = catalog.sources.find(
      (source) => source.name === 'operations-review',
    )!;
    expect(
      (await port.readPackage(operations.selector, signal())).content,
    ).toContain('references/charts.md');
    const office = catalog.sources.find((source) => source.name === 'office')!;
    expect(office.selector.version).toBe('1.7.7');
    const finance = catalog.sources.find(
      (source) => source.name === 'business-reconciliation',
    )!;
    for (const [source, paths] of [
      [
        office,
        [
          'references/charts.md',
          'scripts/check_office.py',
          'references/LICENSE.dsh',
        ],
      ],
      [
        finance,
        ['scripts/reconcile.mjs', 'assets/invoices.csv', 'assets/payments.csv'],
      ],
    ] as const) {
      for (const path of paths) {
        const metadata = source.resources.find((entry) => entry.path === path)!;
        const result = await port.readResource(
          { ...source.selector, path, checksum: metadata.checksum },
          signal(),
        );
        expect(result.bytes).toEqual(
          await readFile(join(repositoryRoot, 'skills', source.name, path)),
        );
        expect(result.byteLength).toBe(result.bytes.length);
        expect(result.checksum).toBe(skillBytesChecksum(result.bytes));
      }
    }
    expect(
      office.resources.find((entry) => entry.path === 'references/charts.md')
        ?.checksum,
    ).toBe(
      'sha256:e1b8ff25b52921eb74a2d31a9b5f5362d808d661cbb1afcdc9349722c3efd1bf',
    );
    expect(
      office.resources.find((entry) => entry.path === 'scripts/check_office.py')
        ?.checksum,
    ).toBe(
      'sha256:d94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66',
    );
  });

  it('compares every package pin and never substitutes a name or latest source', async () => {
    const port = createBuiltinSkillSourcesPort();
    const { sources } = await port.listSources(signal());
    const office = sources.find((source) => source.name === 'office')!;
    const web = sources.find((source) => source.name === 'web-research')!;
    expect((await port.readPackage(web.selector, signal())).bundle).toBeNull();
    for (const changed of [
      { version: '9.9.9' },
      { contentChecksum: `sha256:${'0'.repeat(64)}` },
      { bundleChecksum: null },
      { bundleChecksum: `sha256:${'0'.repeat(64)}` },
    ])
      await expect(
        port.readPackage({ ...office.selector, ...changed }, signal()),
      ).rejects.toMatchObject({ code: 'pin_mismatch' });
    await expect(
      port.readPackage(
        { ...web.selector, bundleChecksum: office.selector.bundleChecksum },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'pin_mismatch' });
    await expect(
      port.readPackage(
        { ...office.selector, id: '10000000-0000-4000-8000-000000000001' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    const resource = office.resources[0]!;
    await expect(
      port.readResource(
        {
          ...office.selector,
          path: resource.path,
          checksum: `sha256:${'0'.repeat(64)}`,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'pin_mismatch' });
    await expect(
      port.readResource(
        {
          ...office.selector,
          path: 'references/missing.md',
          checksum: resource.checksum,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      port.readResource(
        { ...web.selector, path: resource.path, checksum: resource.checksum },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('revalidates changed source bytes and hides raw filesystem paths on failure', async () => {
    const directory = await copiedSources();
    const port = createBuiltinSkillSourcesPort(directory);
    const { sources } = await port.listSources(signal());
    const office = sources.find((source) => source.name === 'office')!;
    await writeFile(
      join(directory, 'skills/office/references/charts.md'),
      'changed',
    );
    await expect(
      port.readPackage(office.selector, signal()),
    ).rejects.toMatchObject({
      code: 'source_unavailable',
    });
    await rm(join(directory, 'skills/catalog.json'));
    const error = await port
      .listSources(signal())
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BuiltinSkillSourceError);
    expect(JSON.stringify(error)).not.toContain(directory);
    expect((error as Error).message).toBe('builtin_skill_source_unavailable');
    expect(error).not.toHaveProperty('path');
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects invalid selectors before I/O and retains the caller cancellation reason', async () => {
    const port = createBuiltinSkillSourcesPort('/not/a/source/root');
    await expect(
      port.readPackage({ name: 'office' }, signal()),
    ).rejects.toMatchObject({
      name: 'ZodError',
    });
    const controller = new AbortController();
    const reason = new Error('source read canceled');
    controller.abort(reason);
    await Promise.all(
      [
        port.listSources(controller.signal),
        port.readPackage({}, controller.signal),
        port.readResource({}, controller.signal),
      ].map((result) => expect(result).rejects.toBe(reason)),
    );
  });
});
