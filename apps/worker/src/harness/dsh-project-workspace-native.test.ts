import { expect, it } from 'vitest';
import { ProjectWorkspaceCommandSchema } from '@allrice/contracts';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
const project = {
  projectId: 'db0bbe7d-1e71-4d27-89e2-fb09559d4b3f',
  snapshot: {
    kind: 'artifact',
    id: '6b829c99-d472-4cf2-8f46-12447361735d',
    checksum: 'sha256:' + 'a'.repeat(64),
  },
};
it.each([
  { action: 'open', files: [{ path: 'main.ts', text: 'const n=1;' }] },
  { action: 'open', source: project.snapshot },
  { action: 'read', project, path: 'main.ts' },
  {
    action: 'apply',
    expectedHead: project,
    proposal: {
      files: [
        { path: 'new.ts', before: null, after: 'const n=2;' },
        { path: 'old.ts', before: 'old', after: null },
      ],
    },
  },
])(
  'projects native schema and nullable edits through real DSH (%j)',
  async (args) => {
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.project',
      wireName: 'workspace_project',
      args,
      invalidArgs: { action: 'execute', project },
      inspectSchema(schema) {
        expect(schema.properties).toHaveProperty('files');
        expect(schema.properties).not.toHaveProperty('ownerId');
      },
      onToolCall: async (call) => {
        expect(ProjectWorkspaceCommandSchema.parse(call.arguments)).toEqual(
          ProjectWorkspaceCommandSchema.parse(args),
        );
        return {
          modelContent: 'Synthetic project transport accepted.',
          summary: '合成原生源码接线验证',
        };
      },
    });
  },
  45000,
);
