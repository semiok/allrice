import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EmployeeRuntimePackageSchema,
  WorkbenchArtifactSchema,
  type EmployeeManifest,
  type WorkbenchArtifact,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import {
  projectTaskNextSteps,
  type NextStepsFacts,
} from './task-next-steps-projector.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const scope = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  viewerId: randomUUID(),
  sessionId: randomUUID(),
  employeeAssignmentId: randomUUID(),
  employeeVersionId: randomUUID(),
};
const run = { id: randomUUID(), state: 'succeeded', errorCode: null };
function manifest(office = false): EmployeeManifest {
  const toolNames = [
    'workspace.document.read',
    'workspace.export.create',
    'workspace.skill.read',
    'python.execute',
  ];
  return employeeManifest({
    key: 'synthetic',
    name: 'Synthetic',
    description: 'Synthetic capabilities',
    toolNames,
    ...(office
      ? {
          runtimePackage: EmployeeRuntimePackageSchema.parse({
            schemaVersion: 1,
            packageVersion: 'synthetic-v1',
            checksum: hash,
            capabilityFingerprint: hash,
            files: {
              agentsMd: 'Synthetic',
              identityMd: 'Synthetic',
              soulMd: 'Synthetic',
              userMd: 'Synthetic',
            },
            skills: [
              {
                id: randomUUID(),
                name: 'office',
                description: 'Synthetic Office',
                content: '# Synthetic Office',
                checksum: hash,
                invocation: { modelInvocable: true, userInvocable: true },
                requiredToolRefs: toolNames.slice(0, 3),
              },
            ],
            runtimeManifest: {
              source: 'allrice-published-runtime',
              harness: 'dsh',
              distributionGeneration: 'synthetic',
              provider: 'openai-codex',
              model: 'synthetic',
              toolNames,
              deniedCapabilities: [],
              skillGovernance: [],
              instructionPrecedence: [
                'platform-hard-policy',
                'identity',
                'behavior',
                'work-rules',
                'tenant-user-context',
                'runtime-authorization',
                'user-request',
                'skill-details',
              ],
            },
          }),
        }
      : {}),
  });
}
function artifact(
  format: WorkbenchArtifact['version']['format'] = 'xlsx',
): WorkbenchArtifact {
  const id = randomUUID(),
    objectId = randomUUID();
  const owner = {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.viewerId,
  };
  return WorkbenchArtifactSchema.parse({
    contractVersion: 1,
    id,
    kind: 'document',
    version: {
      ...owner,
      id,
      objectId,
      seriesId: randomUUID(),
      version: 1,
      parentVersionId: null,
      parentObjectId: null,
      sessionId: scope.sessionId,
      platformTestRunId: null,
      fileName: '未审计{{slot}}.xlsx',
      format,
      changeSummary: null,
      createdAt: '2026-10-02T00:00:00.000Z',
    },
    object: {
      ...owner,
      id: objectId,
      key: `organizations/${scope.organizationId}/workspaces/${scope.workspaceId}/owners/${scope.viewerId}/exports/${objectId}`,
      checksum: hash,
      mediaType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 20,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    },
    provenance: {
      kind: 'model_proposal',
      runId: run.id,
      operationId: null,
      stepId: null,
    },
    execution: null,
    latestVersionId: id,
    stale: false,
  });
}
function facts(): NextStepsFacts {
  const a = artifact();
  return {
    scope,
    manifest: manifest(true),
    run,
    unknown: false,
    errorCodes: [],
    artifacts: [a],
    visibility: { [a.object.id]: 'private' },
    bridgePreparationAllowed: true,
  };
}
describe('next steps from formal current-turn facts', () => {
  it('uses actual published versions, capabilities and Office Skill; excludes filenames from templates and private runtime fields', () => {
    const f = facts(),
      before = JSON.stringify(f.manifest),
      checksum = employeeManifestChecksum(f.manifest);
    const response = projectTaskNextSteps(f);
    expect(response.suggestions.map((s) => s.task.title)).toEqual([
      '检查数据与异常',
      '制作数据图表',
      '准备汇报',
    ]);
    expect(
      response.suggestions.every(
        (s) => s.references[0]?.versionId === f.artifacts[0]!.id,
      ),
    ).toBe(true);
    expect(
      response.suggestions.some((s) => s.task.template.includes('{{slot}}')),
    ).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(
      /credentialReference|toolNames|runtimePackage|securityPolicy|object_key|\/owners\//,
    );
    expect(JSON.stringify(f.manifest)).toBe(before);
    expect(employeeManifestChecksum(f.manifest)).toBe(checksum);
    expect(projectTaskNextSteps(f)).toEqual(response);
  });
  it('matches the effective next-turn version rather than the employee name or older frozen tools', () => {
    const f = facts();
    f.manifest = manifest(false);
    expect(
      projectTaskNextSteps(f).suggestions.map((s) => s.task.title),
    ).toEqual(['检查数据与异常', '制作数据图表']);
    if (f.manifest.schemaVersion !== 2) throw Error('v2 required');
    f.manifest.name = 'Office';
    f.manifest.capabilityBindings.toolNames = ['workspace.document.read'];
    expect(
      projectTaskNextSteps(f).suggestions.map((s) => s.task.title),
    ).toEqual(['检查数据与异常']);
    f.manifest.securityPolicy.deniedCapabilities.push('storage:read');
    expect(projectTaskNextSteps(f).suggestions).toEqual([]);
  });
  it('does not treat old, stale, unlinked, foreign or missing artifacts as current delivery', () => {
    for (const patch of [
      { provenance: { ...artifact().provenance, runId: randomUUID() } },
      {
        provenance: {
          ...artifact().provenance,
          kind: 'legacy_deliverable' as const,
          runId: null,
        },
      },
      { stale: true },
      { version: { ...artifact().version, sessionId: randomUUID() } },
      { object: { ...artifact().object, ownerId: randomUUID() } },
      { object: { ...artifact().object, organizationId: randomUUID() } },
      { object: { ...artifact().object, workspaceId: randomUUID() } },
      { object: { ...artifact().object, deletedAt: '2026-10-02T00:00:00Z' } },
    ]) {
      const f = facts();
      f.artifacts = [{ ...f.artifacts[0]!, ...patch }];
      expect(projectTaskNextSteps(f).readableArtifactCount).toBe(0);
      expect(projectTaskNextSteps(f).suggestions).toEqual([]);
    }
    const f = facts();
    f.visibility = {};
    expect(projectTaskNextSteps(f).suggestions).toEqual([]);
  });
  it('keeps cancellation/partial delivery truthful, never replays unknown or active work, and does not guess generic errors', () => {
    const f = facts();
    f.run = { ...run, state: 'failed', errorCode: 'TOOL_EXECUTION_FAILED' };
    const partial = projectTaskNextSteps(f);
    expect(partial.state).toBe('failed');
    expect(partial.notice).toContain('未全部完成');
    expect(partial.suggestions).toHaveLength(3);
    f.run.state = 'canceled';
    expect(projectTaskNextSteps(f).notice).toContain('已取消');
    f.unknown = true;
    expect(projectTaskNextSteps(f)).toMatchObject({
      state: 'unknown',
      suggestions: [],
    });
    f.unknown = false;
    f.run.state = 'running';
    expect(projectTaskNextSteps(f)).toMatchObject({
      state: 'running',
      suggestions: [],
    });
    f.run.state = 'failed';
    f.artifacts = [];
    expect(projectTaskNextSteps(f).suggestions).toEqual([]);
    f.errorCodes = ['TOOL_FILE_NOT_FOUND'];
    expect(projectTaskNextSteps(f).suggestions[0]?.task.preparation).toEqual([
      'files',
    ]);
  });
  it('deduplicates action kinds and changes context identity for each required scope and source revision', () => {
    const f = facts(),
      other = artifact();
    f.artifacts.push(other);
    f.visibility[other.object.id] = 'private';
    const initial = projectTaskNextSteps(f);
    expect(initial.suggestions).toHaveLength(3);
    for (const key of [
      'organizationId',
      'workspaceId',
      'viewerId',
      'sessionId',
      'employeeAssignmentId',
      'employeeVersionId',
    ] as const)
      expect(
        projectTaskNextSteps({ ...f, scope: { ...scope, [key]: randomUUID() } })
          .scope.contextRevision,
      ).not.toBe(initial.scope.contextRevision);
    expect(
      projectTaskNextSteps({ ...f, run: { ...run, id: randomUUID() } }).scope
        .contextRevision,
    ).not.toBe(initial.scope.contextRevision);
  });
  it('offers Bridge preparation only for a known unavailable backend and current immutable publication access', () => {
    const f = facts();
    f.artifacts = [];
    f.run = { ...run, state: 'failed', errorCode: 'PDF_LOCAL_UNAVAILABLE' };
    expect(projectTaskNextSteps(f).suggestions[0]?.task.preparation).toEqual([
      'bridge',
    ]);
    f.bridgePreparationAllowed = false;
    expect(projectTaskNextSteps(f).suggestions).toEqual([]);
    f.bridgePreparationAllowed = true;
    f.run.errorCode = 'TOOL_EXECUTION_FAILED';
    expect(projectTaskNextSteps(f).suggestions).toEqual([]);
  });
  it('offers programmer changeset checks and document synthesis only from declared formats and permissions', () => {
    const f = facts();
    f.artifacts[0]!.kind = 'changeset';
    expect(
      projectTaskNextSteps(f).suggestions.map((s) => s.task.title),
    ).toEqual(['检查变更与风险']);
    f.artifacts[0]!.kind = 'document';
    f.artifacts[0]!.version.format = 'pdf';
    expect(
      projectTaskNextSteps(f).suggestions.map((s) => s.task.title),
    ).toEqual(['提炼重点与待办', '准备汇报']);
  });
});
