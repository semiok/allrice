import { describe, expect, it } from 'vitest';
import {
  ProjectOutputSpecSchema,
  ProjectOutputSpecsSchema,
} from './project-outputs.ts';
import { ProjectWorkspaceCommandSchema } from './project-workspace.ts';

const parentObjectId = '963018c7-ddc0-4358-a19e-060f67eb07f3';
const project = {
  projectId: '19240de5-ded0-4cb5-b153-1d869a922171',
  snapshot: {
    kind: 'artifact',
    id: 'cd668b7c-63eb-4f0f-af4d-16ec5dfeb91c',
    checksum: 'sha256:' + 'a'.repeat(64),
  },
};
describe('project output lineage input contract', () => {
  it('rejects two sibling outputs targeting the same exact parent without changing legacy lists', () => {
    const outputs = [
      { path: 'a.zip', fileName: 'a.zip', format: 'zip' },
      { path: 'b.zip', fileName: 'b.zip', format: 'zip' },
    ];
    expect(ProjectOutputSpecsSchema.parse(outputs)).toEqual(outputs);
    expect(
      ProjectOutputSpecsSchema.safeParse(
        outputs.map((output) => ({ ...output, parentObjectId })),
      ).success,
    ).toBe(false);
  });
  it.each(['html', 'json', 'text', 'zip'] as const)(
    'preserves the optional exact parent UUID for %s without changing legacy input',
    (format) => {
      const legacy = { path: 'result', fileName: 'result', format };
      expect(ProjectOutputSpecSchema.parse(legacy)).toEqual(legacy);
      expect(
        ProjectOutputSpecSchema.parse({ ...legacy, parentObjectId }),
      ).toEqual({ ...legacy, parentObjectId });
      expect(
        ProjectOutputSpecSchema.safeParse({
          ...legacy,
          parentObjectId: 'not-a-uuid',
        }).success,
      ).toBe(false);
    },
  );
  it('rejects case variants of the same parent while preserving a frozen UUID', () => {
    const upperCaseParent = parentObjectId.toUpperCase();
    const output = { path: 'a.zip', fileName: 'a.zip', format: 'zip' };
    expect(
      ProjectOutputSpecSchema.parse({
        ...output,
        parentObjectId: upperCaseParent,
      }).parentObjectId,
    ).toBe(upperCaseParent);
    const result = ProjectOutputSpecsSchema.safeParse([
      { ...output, parentObjectId },
      {
        path: 'b.zip',
        fileName: 'b.zip',
        format: 'zip',
        parentObjectId: upperCaseParent,
      },
    ]);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'duplicate_project_output_parent',
          }),
        ]),
      );
  });
  it('keeps the source ZIP parent distinct from the source diff baseline', () => {
    const command = {
      action: 'deliver',
      project,
      baseline: project,
      parentObjectId,
    };
    expect(ProjectWorkspaceCommandSchema.parse(command)).toEqual(command);
    expect(
      ProjectWorkspaceCommandSchema.safeParse({
        ...command,
        parentObjectId: 'project-source.zip',
      }).success,
    ).toBe(false);
    expect(
      ProjectWorkspaceCommandSchema.safeParse({
        action: 'open',
        files: [],
        parentObjectId,
      }).success,
    ).toBe(false);
  });
});
