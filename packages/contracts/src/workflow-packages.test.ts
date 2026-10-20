import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RegisterWorkflowPackageInputSchema,
  WorkflowPackageManifestSchema,
  WorkflowPackagePathSchema,
  WorkflowPackageSelectionSchema,
} from './workflow-packages.ts';

const checksum = `sha256:${'a'.repeat(64)}`;
const manifest = () => ({
  schemaVersion: 1,
  templateKey: 'brand-content-operations.topics',
  definitionChecksum: checksum,
  method: {
    sourceKind: 'procedure',
    contentId: randomUUID(),
    revisionId: randomUUID(),
    digest: checksum,
  },
});

describe('Workflow package contracts', () => {
  it('defaults a missing scene to common only and keeps exact source pins', () => {
    const input = {
      workspaceId: randomUUID(),
      instanceId: randomUUID(),
      workflowRevisionId: randomUUID(),
    };
    expect(WorkflowPackageSelectionSchema.parse(input).sceneId).toBeNull();
    expect(WorkflowPackageManifestSchema.parse(manifest())).toMatchObject({
      files: [],
      assets: [],
    });
  });

  it.each([
    '../secret',
    '/tmp/source',
    'scripts/../escape',
    'scripts\\escape',
    'scripts//x',
    'scripts/./x',
  ])('refuses nonportable path %s', (path) => {
    expect(WorkflowPackagePathSchema.safeParse(path).success).toBe(false);
  });

  it('rejects a file list without its immutable source object', () => {
    expect(
      WorkflowPackageManifestSchema.safeParse({
        ...manifest(),
        files: [{ path: 'scripts/check.mjs', checksum }],
      }).success,
    ).toBe(false);
  });

  it('requires both executable definition and method in a source package', () => {
    expect(
      WorkflowPackageManifestSchema.safeParse({
        ...manifest(),
        source: { objectId: randomUUID(), checksum },
        files: [{ path: 'workflow.json', checksum }],
      }).success,
    ).toBe(false);
  });

  it('rejects case-insensitive file/asset collisions', () => {
    expect(
      WorkflowPackageManifestSchema.safeParse({
        ...manifest(),
        assets: [
          { path: 'assets/logo.png', objectId: randomUUID(), checksum },
          { path: 'assets/Logo.png', objectId: randomUUID(), checksum },
        ],
      }).success,
    ).toBe(false);
  });

  it('does not accept a forged owner, tenant, or a different kind of method pin', () => {
    const input = { ...manifest(), ownerId: randomUUID() };
    expect(WorkflowPackageManifestSchema.safeParse(input).success).toBe(false);
    expect(
      WorkflowPackageManifestSchema.safeParse({
        ...manifest(),
        method: { ...manifest().method, sourceKind: 'knowledge' },
      }).success,
    ).toBe(false);
  });

  it('requires explicit version CAS for an update and zero for a new workflow', () => {
    const input = {
      workspaceId: randomUUID(),
      instanceId: randomUUID(),
      requestId: randomUUID(),
      slug: 'brand-topics',
      name: '品牌选题',
      description: '生成候选并保存',
      definition: {
        schemaVersion: 1,
        steps: [{ key: 'write', name: '写入', kind: 'tool' }],
      },
      manifest: manifest(),
      expectedRevision: 0,
    };
    expect(RegisterWorkflowPackageInputSchema.safeParse(input).success).toBe(
      true,
    );
    expect(
      RegisterWorkflowPackageInputSchema.safeParse({
        ...input,
        workflowId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      RegisterWorkflowPackageInputSchema.safeParse({
        ...input,
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      RegisterWorkflowPackageInputSchema.safeParse({
        ...input,
        workflowId: randomUUID(),
        expectedRevision: 1,
      }).success,
    ).toBe(true);
  });
});
