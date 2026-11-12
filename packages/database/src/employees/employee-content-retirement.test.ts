import { describe, expect, it } from 'vitest';
import type { ContentTx } from './employee-content-model.ts';
import type {
  EmployeeContentManifest,
  EmployeeContentMutation,
  EmployeeContentReference,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { sceneSkillFixture } from './employee-scene-skills.fixture.ts';
import {
  assertEmployeeContentRetirement,
  assertEmployeeContentRetirementDelta,
} from './employee-content-retirement.ts';

type Save = Extract<EmployeeContentMutation, { operation: 'save_draft' }>;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pin = (
  n: number,
  sourceKind: EmployeeContentReference['sourceKind'] = 'procedure',
): EmployeeContentReference => ({
  sourceKind,
  contentId: uuid(n),
  revisionId: uuid(n + 100),
  digest: runtimePolicyDigest(n),
});
const manifest = (
  common: EmployeeContentReference[] = [],
  scenes: EmployeeContentManifest['scenes'] = [],
): EmployeeContentManifest => ({
  schemaVersion: 1,
  common,
  scenes,
  declaredConflicts: [],
});
const scene = (references: EmployeeContentReference[]) => ({
  id: uuid(50),
  name: 'Owned scene',
  appliesWhen: 'When explicitly requested',
  references,
});
const packaged = (...refs: EmployeeContentReference[]) =>
  new Set(refs.map(runtimePolicyDigest));
const check = (
  before: EmployeeContentManifest,
  after: Save['manifest'],
  packages = new Set<string>(),
  edits: Save['textEdits'] = [],
) => assertEmployeeContentRetirementDelta(before, after, edits, packages);
const retired = (run: () => void) =>
  expect(run).toThrow('legacy_method_retired');

describe('legacy text retirement at the shared content writer', () => {
  it.each(['requirement', 'procedure'] as const)(
    'rejects a newly authored %s before creating its source',
    (kind) => {
      retired(() =>
        check(
          manifest(),
          {
            ...manifest(),
            common: [{ sourceKind: 'draft_text', contentId: uuid(1) }],
          },
          new Set(),
          [
            {
              contentId: uuid(1),
              revisionId: uuid(2),
              expectedRevision: 0,
              kind,
              title: 'New text',
              body: 'Please save this for later tasks',
            },
          ],
        ),
      );
    },
  );

  it('rejects an old text pin introduced by raw references, restore, or a changed revision', () => {
    const old = pin(1),
      newer = {
        ...old,
        revisionId: uuid(999),
        digest: runtimePolicyDigest('newer'),
      };
    retired(() => check(manifest(), manifest([old])));
    retired(() => check(manifest([old]), manifest([newer])));
    retired(() => check(manifest(), manifest([], [scene([old])])));
  });

  it('cannot move, duplicate, rename, or broaden the use of an existing text pin', () => {
    const old = pin(1),
      before = manifest([], [scene([old])]);
    retired(() => check(manifest([old]), manifest([], [scene([old])])));
    retired(() =>
      check(before, manifest([], [{ ...scene([old]), name: 'Renamed use' }])),
    );
    retired(() =>
      check(
        before,
        manifest([], [{ ...scene([old]), appliesWhen: 'Every task' }]),
      ),
    );
    retired(() => check(manifest([old]), manifest([old, old])));
  });

  it('allows only monotonic removal of legacy references without changing their sources', () => {
    const a = pin(1),
      b = pin(2, 'requirement');
    expect(() => check(manifest([a, b]), manifest([a]))).not.toThrow();
    expect(() => check(manifest([a], [scene([b])]), manifest())).not.toThrow();
    retired(() => check(manifest([a, b]), manifest([a, pin(3)])));
    retired(() => check(manifest([a]), manifest([a])));
  });

  it.each(['common', 'scene references', 'scene order'] as const)(
    'rejects reordered legacy %s even alongside a legal Knowledge delta',
    (kind) => {
      const a = pin(1),
        b = pin(2),
        knowledge = pin(3, 'knowledge');
      const first = scene([a]),
        second = { ...scene([b]), id: uuid(51), name: 'Other scene' };
      const before =
        kind === 'common'
          ? manifest([a, b])
          : kind === 'scene references'
            ? manifest([], [scene([a, b])])
            : manifest([], [first, second]);
      const after =
        kind === 'common'
          ? manifest([b, knowledge, a])
          : kind === 'scene references'
            ? manifest([knowledge], [scene([b, a])])
            : manifest([knowledge], [second, first]);
      retired(() => check(before, after));
    },
  );

  it('unlinks Knowledge and removes legacy pins or scenes while preserving the surviving text order', () => {
    const a = pin(1),
      b = pin(2),
      c = pin(3),
      d = pin(4),
      knowledge = pin(5, 'knowledge');
    const before = manifest(
      [a, knowledge, b],
      [scene([c, d]), { ...scene([a]), id: uuid(51) }],
    );
    expect(() => check(before, manifest([a, b], [scene([d])]))).not.toThrow();
    expect(() => check(before, manifest([a, b], before.scenes))).not.toThrow();
  });

  it('saves a complete package while preserving unrelated old common and other scenes', () => {
    const old = pin(1),
      existingPackage = pin(2);
    const pkg = sceneSkillFixture();
    const edits: Save['textEdits'] = [
      {
        kind: 'procedure',
        title: 'Complete package',
        ...pkg,
        contentId: uuid(3),
        revisionId: uuid(103),
        expectedRevision: 0,
      },
    ];
    const before = manifest([old], [scene([existingPackage])]);
    const after: Save['manifest'] = {
      ...before,
      scenes: [
        ...before.scenes,
        {
          id: uuid(51),
          name: 'New package',
          appliesWhen: 'On request',
          references: [{ sourceKind: 'draft_text', contentId: uuid(3) }],
        },
      ],
    };
    expect(() =>
      check(before, after, packaged(existingPackage), edits),
    ).not.toThrow();
    expect(before.common).toEqual([old]);
    expect(before.scenes[0]!.references).toEqual([existingPackage]);
  });

  it('retains exact package update, historical package restore, and removal with old common intact', () => {
    const old = pin(1),
      v1 = pin(2),
      v2 = pin(3);
    const packages = packaged(v1, v2);
    const one = manifest([old], [scene([v1])]);
    const two = manifest([old], [scene([v2])]);
    expect(() => check(one, two, packages)).not.toThrow();
    expect(() => check(two, one, packages)).not.toThrow();
    expect(() => check(two, manifest([old]), packages)).not.toThrow();
  });

  it.each(['company_rule', 'knowledge', 'workflow', 'experience'] as const)(
    'preserves legal %s binding changes without treating that source layer as retired text',
    (kind) => {
      const old = pin(1),
        added = pin(2, kind);
      expect(() => check(manifest(), manifest([added]))).not.toThrow();
      expect(() =>
        check(manifest([old]), manifest([old, added])),
      ).not.toThrow();
      expect(() =>
        check(manifest([old, added]), manifest([old])),
      ).not.toThrow();
    },
  );

  it('recognizes a package only by its complete exact pin, not a reused revision ID', () => {
    const pkg = pin(1),
      forged = { ...pkg, contentId: uuid(999) };
    retired(() => check(manifest(), manifest([forged]), packaged(pkg)));
    retired(() =>
      check(
        manifest(),
        manifest([{ ...pkg, digest: runtimePolicyDigest('forged') }]),
        packaged(pkg),
      ),
    );
  });
});

describe('stored package qualification before reference-only mutations', () => {
  const sql = (content: unknown, source: EmployeeContentReference) => {
    const tagged = (strings: unknown) =>
      Array.isArray(strings) && 'raw' in strings
        ? Promise.resolve([
            {
              id: source.revisionId,
              asset_id: source.contentId,
              digest: source.digest,
              content,
            },
          ])
        : strings;
    return tagged as unknown as ContentTx;
  };
  const stored = (content: unknown) => ({
    ...pin(1),
    digest: runtimePolicyDigest(content),
  });

  it('uses the existing complete package validator for raw reference/restore/activation manifests', async () => {
    const pkg = sceneSkillFixture();
    const content = {
      kind: 'procedure',
      title: 'Stored complete package',
      ...pkg,
    };
    const ref = stored(content);
    await expect(
      assertEmployeeContentRetirement(
        uuid(900),
        manifest(),
        manifest([], [scene([ref])]),
        [],
        sql(content, ref),
      ),
    ).resolves.toBeUndefined();
    const corrupt = {
      ...content,
      skillPackage: {
        ...pkg.skillPackage,
        bundle: {
          ...pkg.skillPackage.bundle,
          checksum: runtimePolicyDigest('invalid checksum'),
        },
      },
    };
    const invalidRef = stored(corrupt);
    await expect(
      assertEmployeeContentRetirement(
        uuid(900),
        manifest(),
        manifest([], [scene([invalidRef])]),
        [],
        sql(corrupt, invalidRef),
      ),
    ).rejects.toThrow('legacy_method_retired');
  });

  it('does not classify plain text as a package merely because skillPackage exists', async () => {
    const content = {
      kind: 'procedure',
      title: 'Disguised text',
      body: 'old text',
      skillPackage: {},
    };
    const ref = stored(content);
    await expect(
      assertEmployeeContentRetirement(
        uuid(900),
        manifest(),
        manifest([ref]),
        [],
        sql(content, ref),
      ),
    ).rejects.toThrow('legacy_method_retired');
  });

  it('checks controlled source mappings in the actual destination reference scope', async () => {
    const pkg = sceneSkillFixture();
    const content = {
      kind: 'procedure',
      title: 'Requires an exact source',
      ...pkg,
      skillPackage: {
        ...pkg.skillPackage,
        resourceSources: [
          { path: 'assets/template.csv', references: [pin(55, 'knowledge')] },
        ],
      },
    };
    const ref = stored(content);
    await expect(
      assertEmployeeContentRetirement(
        uuid(900),
        manifest(),
        manifest([], [scene([ref])]),
        [],
        sql(content, ref),
      ),
    ).rejects.toThrow('legacy_method_retired');
    await expect(
      assertEmployeeContentRetirement(
        uuid(900),
        manifest(),
        manifest([], [scene([ref, pin(55, 'knowledge')])]),
        [],
        sql(content, ref),
      ),
    ).resolves.toBeUndefined();
  });
});
