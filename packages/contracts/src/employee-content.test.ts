import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { EmployeeContentMutationSchema } from './employee-content.ts';
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
