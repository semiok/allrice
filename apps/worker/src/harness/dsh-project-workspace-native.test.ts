import { expect, it } from 'vitest';
import { ProjectWorkspaceToolInputSchema } from '@allrice/contracts';
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
  { action: 'deliver', project, baseline: project },
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
        expect(ProjectWorkspaceToolInputSchema.parse(call.arguments)).toEqual(
          ProjectWorkspaceToolInputSchema.parse(args),
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

it('canonical project execution reaches real DSH with original bounded arguments and no backend-owned fields', async () => {
  const args = {
    action: 'execute',
    project,
    executable: '/usr/local/bin/node',
    args: ['verify.cjs'],
    path: '.',
    outputs: [
      { path: 'dist/index.html', fileName: 'index.html', format: 'html' },
    ],
    limits: {
      timeoutMs: 10000,
      outputBytes: 16384,
      memoryMiB: 256,
      cpuMillis: 1000,
      pids: 64,
    },
    projectPreparation: {
      version: 1,
      projectId: project.projectId,
      sourceDigest: 'sha256:' + 'a'.repeat(64),
      lockChecksum: 'sha256:' + 'b'.repeat(64),
      offline: true,
      manager: 'pnpm',
      managerVersion: '10.33.3',
      lockPath: 'pnpm-lock.yaml',
      scripts: 'disabled',
      packages: [],
    },
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.project',
    wireName: 'workspace_project',
    args,
    invalidArgs: { ...args, deviceId: project.projectId },
    inspectSchema(schema) {
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('projectPreparation');
      expect(props).toHaveProperty('outputs');
      expect(props).not.toHaveProperty('projectSource');
      expect(props).not.toHaveProperty('deviceId');
    },
    onToolCall: async (call) => {
      expect(ProjectWorkspaceToolInputSchema.parse(call.arguments)).toEqual(
        args,
      );
      return {
        modelContent: 'Synthetic execution route accepted.',
        summary: '合成原生项目执行接线验证',
      };
    },
  });
}, 45000);

const serviceId = 'f4008668-b158-4280-b43a-6d2e99cb2e20';
const requestId = 'bd2b4d85-2716-4e0c-983f-f615d7a56ac7';
it.each([
  {
    action: 'service_start',
    project,
    executable: '/usr/local/bin/node',
    args: ['node_modules/vite/bin/vite.js'],
    path: '.',
    service: {
      port: 3100,
      path: '/',
      readinessTimeoutMs: 10000,
      leaseMs: 600000,
    },
    limits: {
      timeoutMs: 30000,
      outputBytes: 16384,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64,
    },
    projectPreparation: {
      version: 1,
      projectId: project.projectId,
      sourceDigest: 'sha256:' + 'a'.repeat(64),
      lockChecksum: 'sha256:' + 'b'.repeat(64),
      offline: true,
      manager: 'pnpm',
      managerVersion: '10.33.3',
      lockPath: 'pnpm-lock.yaml',
      scripts: 'disabled',
      packages: [],
    },
  },
  { action: 'service_status', serviceId },
  { action: 'service_stop', serviceId },
  { action: 'service_renew', serviceId, requestId, leaseMs: 600000 },
  {
    action: 'service_sync',
    serviceId,
    requestId,
    expectedProject: project,
    project,
  },
])(
  'project service parameters survive real DSH and Broker unchanged (%j)',
  async (args) => {
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.project',
      wireName: 'workspace_project',
      args,
      invalidArgs: { ...args, containerId: 'a'.repeat(64) },
      inspectSchema(schema) {
        expect(schema.properties).toHaveProperty('service');
        expect(schema.properties).toHaveProperty('expectedProject');
        expect(schema.properties).not.toHaveProperty('containerId');
        expect(schema.properties).not.toHaveProperty('deviceId');
        expect(schema.properties).not.toHaveProperty('previewHost');
      },
      onToolCall: async (call) => {
        expect(ProjectWorkspaceToolInputSchema.parse(call.arguments)).toEqual(
          args,
        );
        return {
          modelContent: 'Synthetic native service roundtrip accepted.',
          summary: '项目服务原生参数往返验证',
        };
      },
    });
  },
  45000,
);
