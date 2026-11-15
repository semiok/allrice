import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmployeeContentTextSchema } from '@allrice/contracts';
import { skillBundleChecksum } from '../skill-bundles.ts';
import { sceneSkillFixture } from './employee-scene-skills.fixture.ts';
import {
  validateSceneSkillPackage,
  validateHistoricalSceneSkillPackage,
} from './employee-scene-skill-package.ts';

describe('scene package content and controlled resources', () => {
  it.each(['workspace.memory.search', 'workspace.experience.read'])(
    'reads published retired dependency %s without allowing it in new scene imports',
    (name) => {
      const input = sceneSkillFixture();
      input.skillPackage.bundle.dependencies.push({ kind: 'tool', name });
      const { checksum: _checksum, ...payload } = input.skillPackage.bundle;
      void _checksum;
      input.skillPackage.bundle.checksum = skillBundleChecksum(payload);
      const original = structuredClone(input);
      expect(() =>
        validateHistoricalSceneSkillPackage(input.skillPackage, input.body, []),
      ).not.toThrow();
      expect(input).toEqual(original);
      expect(() =>
        validateSceneSkillPackage(input.skillPackage, input.body, []),
      ).toThrow('validation_failed');
      expect(() =>
        validateHistoricalSceneSkillPackage(
          input.skillPackage,
          input.body + 'changed',
          [],
        ),
      ).toThrow('validation_failed');
      input.skillPackage.resourceSources = [
        {
          path: 'assets/template.csv',
          references: [
            {
              sourceKind: 'knowledge',
              contentId: randomUUID(),
              revisionId: randomUUID(),
              digest: `sha256:${'a'.repeat(64)}`,
            },
          ],
        },
      ];
      expect(() =>
        validateHistoricalSceneSkillPackage(input.skillPackage, input.body, []),
      ).toThrow('validation_failed');
      input.skillPackage.resourceSources = [];
      input.skillPackage.bundle.dependencies.push({
        kind: 'tool',
        name: 'unknown.never_registered',
      });
      const { checksum: _unknown, ...unknownPayload } =
        input.skillPackage.bundle;
      void _unknown;
      input.skillPackage.bundle.checksum = skillBundleChecksum(unknownPayload);
      expect(() =>
        validateHistoricalSceneSkillPackage(input.skillPackage, input.body, []),
      ).toThrow('validation_failed');
    },
  );

  it('retains exact package body bytes while keeping ordinary text normalization', () => {
    const input = {
      kind: 'procedure',
      title: ' Scene ',
      ...sceneSkillFixture(),
    };
    expect(EmployeeContentTextSchema.parse(input).body).toBe(input.body);
    expect(
      EmployeeContentTextSchema.parse({
        kind: 'procedure',
        title: 'Text',
        body: ' text \n',
      }).body,
    ).toBe('text');
    expect(() =>
      validateSceneSkillPackage(input.skillPackage, input.body, []),
    ).not.toThrow();
    expect(
      EmployeeContentTextSchema.safeParse({ ...input, kind: 'requirement' })
        .success,
    ).toBe(false);
  });
  it('rejects altered body, resource bytes and bundle commitments', () => {
    const good = sceneSkillFixture();
    expect(() =>
      validateSceneSkillPackage(good.skillPackage, good.body.trim(), []),
    ).toThrow('validation_failed');
    const changed = structuredClone(good);
    changed.skillPackage.bundle.resources[0]!.contentBase64 =
      Buffer.from('changed').toString('base64');
    expect(() =>
      validateSceneSkillPackage(changed.skillPackage, changed.body, []),
    ).toThrow('validation_failed');
    const version = structuredClone(good);
    version.skillPackage.bundle.version = '2.0.0';
    expect(() =>
      validateSceneSkillPackage(version.skillPackage, version.body, []),
    ).toThrow('validation_failed');
  });
  it('requires each controlled resource source to remain an exact declared reference', () => {
    const input = sceneSkillFixture();
    const ref = {
      sourceKind: 'knowledge' as const,
      contentId: randomUUID(),
      revisionId: randomUUID(),
      digest: `sha256:${'a'.repeat(64)}`,
    };
    input.skillPackage.resourceSources = [
      { path: 'assets/template.csv', references: [ref] },
    ];
    expect(() =>
      validateSceneSkillPackage(input.skillPackage, input.body, [ref]),
    ).not.toThrow();
    expect(() =>
      validateSceneSkillPackage(input.skillPackage, input.body, []),
    ).toThrow('validation_failed');
    expect(() =>
      validateSceneSkillPackage(input.skillPackage, input.body, [
        { ...ref, revisionId: randomUUID() },
      ]),
    ).toThrow('validation_failed');
    input.skillPackage.resourceSources[0]!.path = 'assets/missing.csv';
    expect(
      EmployeeContentTextSchema.safeParse({
        kind: 'procedure',
        title: 'Scene',
        ...input,
      }).success,
    ).toBe(false);
  });
  it('keeps ordinary text and resource boundaries with the approved package body limit', () => {
    const input = { kind: 'procedure', title: 'Scene', ...sceneSkillFixture() };
    expect(
      EmployeeContentTextSchema.safeParse({ ...input, body: 'x'.repeat(8001) })
        .success,
    ).toBe(true);
    expect(
      EmployeeContentTextSchema.safeParse({
        ...input,
        body: 'x'.repeat(262145),
      }).success,
    ).toBe(false);
    expect(
      EmployeeContentTextSchema.safeParse({
        kind: 'procedure',
        title: 'Ordinary text',
        body: 'x'.repeat(8001),
      }).success,
    ).toBe(false);
    for (const path of ['../secrets', 'assets/../secrets', '/etc/passwd']) {
      const invalid = structuredClone(input);
      invalid.skillPackage.bundle.resources[0]!.path = path;
      expect(EmployeeContentTextSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
