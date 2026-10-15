import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  EmployeeContentMutationSchema,
  EmployeeMethodSaveSchema,
  EmployeeMethodSharedTargetSchema,
} from './employee-content.ts';
function input() {
  return {
    operation: 'save_draft',
    workspaceId: randomUUID(),
    setId: randomUUID(),
    requestId: randomUUID(),
    expectedRevision: 0,
    ownership: {
      scope: 'personal',
      organizationId: randomUUID(),
      ownerId: randomUUID(),
    },
    target: { kind: 'instance', instanceId: randomUUID() },
    changeSummary: 'Set up scenes',
    manifest: {
      schemaVersion: 1,
      common: [],
      scenes: [],
      declaredConflicts: [],
    },
    textEdits: [],
  };
}
describe('employee content input boundaries', () => {
  it('requires an exact department target and forbids department identity on company scope', () => {
    const company = {
      scope: 'company',
      setId: randomUUID(),
      employeeId: randomUUID(),
    };
    const department = {
      ...company,
      scope: 'department',
      departmentId: randomUUID(),
    };
    expect(EmployeeMethodSharedTargetSchema.parse(company)).toEqual(company);
    expect(EmployeeMethodSharedTargetSchema.parse(department)).toEqual(
      department,
    );
    for (const target of [
      { ...company, departmentId: department.departmentId },
      { ...company, departmentId: null },
      { ...company, scope: 'department' },
      { ...company, organizationId: randomUUID() },
      { ...company, ownerId: randomUUID() },
    ])
      expect(EmployeeMethodSharedTargetSchema.safeParse(target).success).toBe(
        false,
      );
  });
  it('requires new text and exact, distinct replacement pins, without source re-addition', () => {
    const ref = {
      sourceKind: 'procedure',
      contentId: randomUUID(),
      revisionId: randomUUID(),
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const valid = {
      expectedRevision: 1,
      section: 'scene',
      scene: { id: randomUUID() },
      procedure: '新版流程',
      replaceTextReferences: [ref],
      changeSummary: '替换旧流程',
    };
    expect(EmployeeMethodSaveSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, procedure: undefined },
      { ...valid, replaceTextReferences: [ref, ref] },
      { ...valid, references: [ref] },
      {
        ...valid,
        replaceTextReferences: [{ ...ref, sourceKind: 'knowledge' }],
      },
      { ...valid, operation: 'remove_scene' },
    ])
      expect(EmployeeMethodSaveSchema.safeParse(invalid).success).toBe(false);
  });
  it('accepts bounded existing-scene edits and rejects ambiguous removal payloads', () => {
    const base = {
      expectedRevision: 2,
      section: 'scene',
      scene: { id: randomUUID() },
      changeSummary: '候选调整',
    };
    expect(
      EmployeeMethodSaveSchema.safeParse({
        ...base,
        scene: { ...base.scene, name: '周度回款' },
      }).success,
    ).toBe(true);
    expect(
      EmployeeMethodSaveSchema.safeParse({ ...base, operation: 'remove_scene' })
        .success,
    ).toBe(true);
    for (const value of [
      base,
      { ...base, scene: { name: '缺少适用条件' } },
      { ...base, operation: 'remove_scene', section: 'common' },
      {
        ...base,
        operation: 'remove_scene',
        scene: { ...base.scene, name: '不要静默忽略' },
      },
      { ...base, operation: 'remove_scene', procedure: '不得同时编辑' },
      { ...base, operation: 'remove_scene', references: [] },
      { ...base, operation: 'remove_scene', activate: true },
      {
        ...base,
        removeReferences: [
          {
            sourceKind: 'requirement',
            contentId: randomUUID(),
            revisionId: randomUUID(),
            digest: `sha256:${'0'.repeat(64)}`,
          },
        ],
      },
    ])
      expect(EmployeeMethodSaveSchema.safeParse(value).success).toBe(false);
  });
  it('rejects authority/tool fields, foreign target kinds, ambiguous scene IDs and unresolved text edits', () => {
    const base = input(),
      scene = {
        id: randomUUID(),
        name: 'Weekly',
        appliesWhen: 'Weekly research',
        references: [],
      };
    expect(EmployeeContentMutationSchema.safeParse(base).success).toBe(true);
    for (const value of [
      { ...base, toolGrants: ['workspace.command'] },
      { ...base, ownership: { scope: 'platform' } },
      { ...base, target: { kind: 'employee', employeeId: randomUUID() } },
      { ...base, manifest: { ...base.manifest, scenes: [scene, scene] } },
      {
        ...base,
        manifest: {
          ...base.manifest,
          common: [{ sourceKind: 'draft_text', contentId: randomUUID() }],
        },
      },
    ])
      expect(EmployeeContentMutationSchema.safeParse(value).success).toBe(
        false,
      );
  });
  it('bounds total references and UTF-8 text without silently truncating requirements', () => {
    const base = input(),
      id = randomUUID(),
      revisionId = randomUUID();
    const edit = {
      kind: 'requirement',
      title: 'Rule',
      body: '字'.repeat(8000),
      contentId: id,
      revisionId,
      expectedRevision: 0,
    };
    const other = {
      ...edit,
      contentId: randomUUID(),
      revisionId: randomUUID(),
    };
    const tooMuch = {
      ...base,
      textEdits: [edit, other],
      manifest: {
        ...base.manifest,
        common: [edit, other].map((e) => ({
          sourceKind: 'draft_text',
          contentId: e.contentId,
        })),
      },
    };
    expect(EmployeeContentMutationSchema.safeParse(tooMuch).success).toBe(
      false,
    );
    const ref = {
      sourceKind: 'knowledge',
      contentId: id,
      revisionId,
      digest: `sha256:${'0'.repeat(64)}`,
    };
    expect(
      EmployeeContentMutationSchema.safeParse({
        ...base,
        manifest: {
          ...base.manifest,
          common: [ref],
          scenes: [
            {
              id: randomUUID(),
              name: 'Many',
              appliesWhen: 'Research',
              references: Array(128).fill(ref),
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
