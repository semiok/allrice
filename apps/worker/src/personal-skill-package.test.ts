import { describe, expect, it } from 'vitest';
import { createFileArchive } from '@allrice/file-archives';
import {
  inspectPersonalSkillPackage,
  readPersonalSkillArchive,
  type PersonalSkillPackageFile,
} from './personal-skill-package.js';

const raw = (
  name: string,
  body = 'Read references/rules.md and assets/template.md.',
) =>
  `---\nname: ${name}\ndescription: Synthetic package fixture\n---\n${body}\n`;
const file = (path: string, text: string): PersonalSkillPackageFile => ({
  path,
  bytes: Buffer.from(text),
});
const pack = (root: string, name = 'weekly-review') => [
  file(root + 'SKILL.md', raw(name)),
  file(root + 'references/rules.md', 'Count each synthetic row once.'),
  file(root + 'assets/template.md', '# Results\n'),
];

describe('private Skill package candidates and exact resources', () => {
  it('routes actual ZIP bytes through the shared codec and native candidate parser', async () => {
    const bytes = await createFileArchive([
      ...pack('repo/skills/weekly/'),
      ...pack('repo/skills/monthly/', 'monthly-review'),
    ]);
    const candidates = await readPersonalSkillArchive(bytes);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.issues.length === 0)).toBe(
      true,
    );
    expect(candidates[1]!.parsed!.definition.name).toBe('weekly-review');
    await expect(
      readPersonalSkillArchive(bytes, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'FILE_ARCHIVE_CANCELED' });
  });

  it('finds nested SKILL.md candidates with native parsing without selecting a sibling or README', async () => {
    const files = [
      file('README.md', raw('not-a-skill')),
      ...pack('repository/skills/weekly/'),
      ...pack('repository/skills/monthly/', 'monthly-review'),
    ];
    const candidates = await inspectPersonalSkillPackage(files);
    expect(
      candidates.map((candidate) => candidate.parsed?.definition.name),
    ).toEqual(['monthly-review', 'weekly-review']);
    for (const candidate of candidates) {
      expect(candidate.issues).toEqual([]);
      expect(candidate.resources.map((resource) => resource.path)).toEqual([
        'assets/template.md',
        'references/rules.md',
      ]);
      expect(candidate.parsed?.originalText).toBe(
        raw(candidate.parsed!.definition.name),
      );
    }
  });

  it('keeps exact binary/script bytes without evaluating package code', async () => {
    const script =
      'throw new Error("package code must not execute during import")';
    const binary = Uint8Array.from([0, 255, 137, 80, 78, 71]);
    const [candidate] = await inspectPersonalSkillPackage([
      ...pack(''),
      file('scripts/check.js', script),
      { path: 'assets/image.png', bytes: binary },
    ]);
    expect(candidate!.issues).toEqual([]);
    expect(
      candidate!.resources.find(
        (resource) => resource.path === 'assets/image.png',
      )!.bytes,
    ).toEqual(binary);
    expect(
      Buffer.from(
        candidate!.resources.find(
          (resource) => resource.path === 'scripts/check.js',
        )!.bytes,
      ).toString(),
    ).toBe(script);
  });

  it('keeps nested SKILL.md templates as resources when a source pins its candidate paths', async () => {
    const files = [
      ...pack('weekly/'),
      file('weekly/assets/example/SKILL.md', raw('example-template')),
      ...pack('monthly/', 'monthly-review'),
    ];
    const [candidate] = await inspectPersonalSkillPackage(files, undefined, [
      'weekly/SKILL.md',
    ]);
    expect(candidate!.parsed!.definition.name).toBe('weekly-review');
    expect(candidate!.resources.map((resource) => resource.path)).toContain(
      'assets/example/SKILL.md',
    );
    expect(candidate!.resources.map((resource) => resource.path)).not.toContain(
      'monthly/SKILL.md',
    );
    expect(await inspectPersonalSkillPackage(files)).toHaveLength(3);
    for (const paths of [
      [],
      ['missing/SKILL.md'],
      ['weekly/SKILL.md', 'weekly/SKILL.md'],
    ])
      await expect(
        inspectPersonalSkillPackage(files, undefined, paths),
      ).rejects.toThrow();
  });

  it('does not fill a missing reference from another candidate', async () => {
    const [first, second] = await inspectPersonalSkillPackage([
      file('a/SKILL.md', raw('first')),
      ...pack('b/', 'second'),
    ]);
    expect(first!.issues).toEqual([
      { code: 'missing_resource', path: 'references/rules.md' },
      { code: 'missing_resource', path: 'assets/template.md' },
    ]);
    expect(first!.manifestChecksum).toBeUndefined();
    expect(second!.issues).toEqual([]);
  });

  it('changes the package identity when only template bytes change, independent of archive order', async () => {
    const initial = pack('');
    const [first] = await inspectPersonalSkillPackage(initial);
    const [reordered] = await inspectPersonalSkillPackage(
      [...initial].reverse(),
    );
    const [changed] = await inspectPersonalSkillPackage([
      ...initial.slice(0, 2),
      file('assets/template.md', '# Corrected results\n'),
    ]);
    expect(first!.manifestChecksum).toBe(reordered!.manifestChecksum);
    expect(first!.parsed!.definition.checksum).toBe(
      changed!.parsed!.definition.checksum,
    );
    expect(first!.manifestChecksum).not.toBe(changed!.manifestChecksum);
  });

  it.each([
    '../SKILL.md',
    '/SKILL.md',
    'root/../SKILL.md',
    'root\\SKILL.md',
    'C:/SKILL.md',
    'a\0/SKILL.md',
  ])(
    'rejects unsafe source paths before native discovery: %s',
    async (path) => {
      await expect(
        inspectPersonalSkillPackage([file(path, raw('unsafe'))]),
      ).rejects.toThrow('unsafe_path');
    },
  );

  it('rejects case and Unicode aliases instead of silently choosing one', async () => {
    await expect(
      inspectPersonalSkillPackage([
        ...pack(''),
        file('skill.md', raw('alias')),
      ]),
    ).rejects.toThrow('path_conflict');
    await expect(
      inspectPersonalSkillPackage([
        ...pack(''),
        file('assets/é.md', 'one'),
        file('assets/e\u0301.md', 'two'),
      ]),
    ).rejects.toThrow('path_conflict');
  });

  it('reports invalid definitions separately and never reports them ready', async () => {
    const [bad, good] = await inspectPersonalSkillPackage([
      file('a/SKILL.md', 'No native frontmatter'),
      ...pack('b/'),
    ]);
    expect(bad!.issues).toContainEqual({
      code: 'invalid_definition',
      path: 'a/SKILL.md',
    });
    expect(bad!.manifestChecksum).toBeUndefined();
    expect(good!.issues).toEqual([]);
  });

  it('reports the existing resource size and count limits', async () => {
    const [tooLarge] = await inspectPersonalSkillPackage([
      file('SKILL.md', raw('large', 'Read assets/large.bin.')),
      { path: 'assets/large.bin', bytes: new Uint8Array(131_073) },
    ]);
    expect(tooLarge!.issues).toContainEqual({
      code: 'resource_limit',
      path: 'assets/large.bin',
    });
    const [tooMany] = await inspectPersonalSkillPackage([
      file('SKILL.md', raw('many', 'Use the supplied assets.')),
      ...Array.from({ length: 33 }, (_, i) => file(`assets/file-${i}.md`, 'x')),
    ]);
    expect(
      tooMany!.issues.some((issue) => issue.code === 'resource_limit'),
    ).toBe(true);
    expect(tooMany!.manifestChecksum).toBeUndefined();
  });

  it('rejects absent or excess definitions and honors cancellation', async () => {
    await expect(
      inspectPersonalSkillPackage([file('README.md', raw('readme'))]),
    ).rejects.toThrow('missing_skill');
    await expect(
      inspectPersonalSkillPackage(
        Array.from({ length: 9 }, (_, i) =>
          file(`${i}/SKILL.md`, raw(`skill-${i}`)),
        ),
      ),
    ).rejects.toThrow('candidate_limit');
    await expect(
      inspectPersonalSkillPackage(pack(''), AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
