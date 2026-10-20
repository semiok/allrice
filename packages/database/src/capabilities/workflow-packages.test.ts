import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkflowDefinitionSchema,
  WorkflowPackageManifestSchema,
  type EmployeeContentReference,
  type RequestContext,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { capabilityChecksum } from './capability-registry.ts';
import { workflowPackageChecksum } from './workflow-package-model.ts';

const stubs = vi.hoisted(() => ({
  database: vi.fn(),
  principal: vi.fn(),
  instance: vi.fn(),
  snapshot: vi.fn(),
  source: vi.fn(),
}));
vi.mock('../core/client.ts', () => ({ getDatabase: stubs.database }));
vi.mock('../content-maintenance.ts', async (original) => ({
  ...(await original<object>()),
  readContentPrincipal: stubs.principal,
}));
vi.mock('../employees/employee-instances.ts', async (original) => ({
  ...(await original<object>()),
  getEmployeeInstance: stubs.instance,
}));
vi.mock('../employees/employee-content.ts', async (original) => ({
  ...(await original<object>()),
  freezeEmployeeRuntimeContent: stubs.snapshot,
}));
vi.mock('../employees/employee-content-sources.ts', async (original) => ({
  ...(await original<object>()),
  resolveEmployeeContentSource: stubs.source,
}));

import {
  assertWorkflowPackageExecution,
  registerWorkflowPackage,
} from './workflow-packages.ts';

function setup() {
  const scope = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    assignmentId: randomUUID(),
    employeeId: randomUUID(),
    instanceId: randomUUID(),
  };
  const request = {
    workspaceId: scope.workspaceId,
    instanceId: scope.instanceId,
    sceneId: null,
    workflowRevisionId: randomUUID(),
  };
  const context = {
    actor: { type: 'user', id: scope.ownerId },
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    requestId: randomUUID(),
  } as RequestContext;
  const definition = WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    steps: [{ key: 'write', name: '准备候选', kind: 'model' }],
  });
  const method = {
    sourceKind: 'procedure' as const,
    contentId: randomUUID(),
    revisionId: randomUUID(),
    digest: `sha256:${'a'.repeat(64)}`,
  };
  const manifest = WorkflowPackageManifestSchema.parse({
    schemaVersion: 1,
    templateKey: 'brand-content-operations.topics',
    method,
    definitionChecksum: runtimePolicyDigest(definition),
  });
  const workflowChecksum = capabilityChecksum({
    name: '品牌选题',
    description: '按品牌方法策划',
    definition,
  });
  const packageChecksum = workflowPackageChecksum({
    workflowChecksum,
    manifest,
  });
  const packageRow = {
    workflow_revision_id: request.workflowRevisionId,
    organization_id: scope.organizationId,
    workspace_id: scope.workspaceId,
    owner_id: scope.ownerId,
    assignment_id: scope.assignmentId,
    employee_id: scope.employeeId,
    instance_id: scope.instanceId,
    scene_id: null as string | null,
    manifest,
    checksum: packageChecksum,
    created_at: new Date('2026-10-19T16:00:00Z'),
    workflow_id: randomUUID(),
    slug: 'brand-topics-12345678',
    name: '品牌选题',
    description: '按品牌方法策划',
    revision: 1,
    status: 'published',
    workflow_checksum: workflowChecksum,
    definition,
    published_at: new Date('2026-10-19T16:00:00Z'),
    workflow_status: 'active',
  };
  const bound = {
    id: randomUUID(),
    organization_id: scope.organizationId,
    workspace_id: scope.workspaceId,
    owner_id: scope.ownerId,
    assignment_id: scope.assignmentId,
    employee_id: scope.employeeId,
    instance_id: scope.instanceId,
    scene_id: null,
    workflow_revision_id: request.workflowRevisionId,
    package_checksum: packageChecksum,
    binding_revision: 1,
    enabled: true,
    bound_at: new Date('2026-10-19T16:00:00Z'),
  };
  const state = {
    principalActive: true,
    principalWritable: true,
    assigned: true,
    methodReadable: true,
    currentRevisionPublished: true,
    methodPins: [method] as EmployeeContentReference[],
  };
  const queries: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim();
      if (query === 'for share' || query === '') return { fragment: query };
      queries.push(query);
      if (
        query.startsWith(
          'select employee_id,employee_version_id from allrice_employee_assignments',
        )
      )
        return Promise.resolve(
          state.assigned
            ? [
                {
                  employee_id: scope.employeeId,
                  employee_version_id: randomUUID(),
                },
              ]
            : [],
        );
      if (
        query.includes(
          'from allrice_workflow_packages p join allrice_workflow_revisions',
        )
      )
        return Promise.resolve(
          packageRow.scene_id === null || values.includes(packageRow.scene_id)
            ? [packageRow]
            : [],
        );
      if (query.startsWith('select * from allrice_employee_workflow_bindings'))
        return Promise.resolve(
          bound.workflow_revision_id === request.workflowRevisionId
            ? [bound]
            : [],
        );
      if (
        query.startsWith('select b.* from allrice_employee_workflow_bindings')
      )
        return Promise.resolve(
          bound.enabled && state.currentRevisionPublished ? [bound] : [],
        );
      if (
        query.startsWith(
          'select operation,input_digest,instance_id,response from allrice_workflow_package_requests',
        )
      )
        return Promise.resolve([]);
      throw Error(`Unscripted query: ${query}`);
    },
    {
      begin: async (...args: unknown[]) =>
        (args.at(-1) as (transaction: unknown) => unknown)(sql),
      json: (value: unknown) => value,
    },
  );
  stubs.database.mockReturnValue(sql);
  stubs.principal.mockImplementation(async (actual) =>
    state.principalActive &&
    actual.actor.id === scope.ownerId &&
    actual.organizationId === scope.organizationId &&
    actual.workspaceId === scope.workspaceId
      ? { writable: state.principalWritable }
      : null,
  );
  stubs.instance.mockImplementation(async (actual, id) => {
    if (
      actual.actor.id !== scope.ownerId ||
      actual.organizationId !== scope.organizationId ||
      id !== scope.instanceId
    )
      throw Error('authorization_denied');
    return {
      id: scope.instanceId,
      assignmentId: scope.assignmentId,
      kind: 'custom',
      source: { employeeVersionId: randomUUID() },
    };
  });
  stubs.snapshot.mockImplementation(async () => ({
    layers: [{ common: state.methodPins, scenes: [] }],
  }));
  stubs.source.mockImplementation(async () => ({
    dto: { available: state.methodReadable, body: '先理解品牌再策划。' },
  }));
  return {
    context,
    request,
    definition,
    manifest,
    packageRow,
    bound,
    state,
    queries,
    packageChecksum,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Workflow package execution admission (scripted DB ports, no SQL server)', () => {
  it('admits a new Run only for its current exact enabled package', async () => {
    const f = setup();
    const result = await assertWorkflowPackageExecution(f.context, f.request);
    expect(result.package.workflow.id).toBe(f.request.workflowRevisionId);
    expect(result.binding?.enabled).toBe(true);
  });

  it('refuses a new Run selecting a historical version after the slot upgrades', async () => {
    const f = setup();
    f.bound.workflow_revision_id = randomUUID();
    f.bound.binding_revision = 2;
    await expect(
      assertWorkflowPackageExecution(f.context, f.request),
    ).rejects.toThrow('source_unavailable');
  });

  it('keeps a frozen Run on its original immutable version when the enabled pointer upgrades', async () => {
    const f = setup();
    f.bound.workflow_revision_id = randomUUID();
    f.bound.binding_revision = 2;
    const result = await assertWorkflowPackageExecution(f.context, {
      ...f.request,
      frozenPackageDigest: f.packageChecksum,
    });
    expect(result.package.workflow.id).toBe(f.request.workflowRevisionId);
    expect(result.binding?.workflowRevisionId).toBe(
      f.bound.workflow_revision_id,
    );
  });

  it.each([
    'disable',
    'revoke_current',
    'revoke_original',
    'withdraw_assignment',
    'withdraw_method',
    'inactive_member',
    'read_only_member',
  ])('refuses frozen execution after %s', async (change) => {
    const f = setup();
    if (change === 'disable') f.bound.enabled = false;
    if (change === 'revoke_current') f.state.currentRevisionPublished = false;
    if (change === 'revoke_original') f.packageRow.status = 'revoked';
    if (change === 'withdraw_assignment') f.state.assigned = false;
    if (change === 'withdraw_method') f.state.methodReadable = false;
    if (change === 'inactive_member') f.state.principalActive = false;
    if (change === 'read_only_member') f.state.principalWritable = false;
    await expect(
      assertWorkflowPackageExecution(f.context, {
        ...f.request,
        frozenPackageDigest: f.packageChecksum,
      }),
    ).rejects.toThrow();
  });

  it('does not turn a changed frozen digest into permission for another package', async () => {
    const f = setup();
    await expect(
      assertWorkflowPackageExecution(f.context, {
        ...f.request,
        frozenPackageDigest: `sha256:${'f'.repeat(64)}`,
      }),
    ).rejects.toThrow('source_unavailable');
  });

  it('preserves the old executable while showing an updated method as pending sync', async () => {
    const f = setup();
    f.state.methodPins = [{ ...f.manifest.method, revisionId: randomUUID() }];
    const result = await assertWorkflowPackageExecution(f.context, {
      ...f.request,
      frozenPackageDigest: f.packageChecksum,
    });
    expect(result.syncStatus).toBe('method_changed');
    expect(result.package.manifest.method.revisionId).toBe(
      f.manifest.method.revisionId,
    );
  });

  it('refuses another owner, company, instance, and a scene-only package without that scene', async () => {
    const f = setup();
    await expect(
      assertWorkflowPackageExecution(
        { ...f.context, actor: { type: 'user', id: randomUUID() } },
        f.request,
      ),
    ).rejects.toThrow('authorization_denied');
    await expect(
      assertWorkflowPackageExecution(
        { ...f.context, organizationId: randomUUID() },
        f.request,
      ),
    ).rejects.toThrow('authorization_denied');
    await expect(
      assertWorkflowPackageExecution(f.context, {
        ...f.request,
        instanceId: randomUUID(),
      }),
    ).rejects.toThrow('authorization_denied');
    f.packageRow.scene_id = randomUUID();
    await expect(
      assertWorkflowPackageExecution(f.context, f.request),
    ).rejects.toThrow('not_found');
  });

  it('rejects a non-current method before registering any immutable package or source', async () => {
    const f = setup();
    f.state.methodPins = [];
    await expect(
      registerWorkflowPackage(f.context, {
        workspaceId: f.request.workspaceId,
        instanceId: f.request.instanceId,
        sceneId: null,
        requestId: randomUUID(),
        expectedRevision: 0,
        slug: 'brand-topics',
        name: '品牌选题',
        description: '按品牌方法策划',
        definition: f.definition,
        manifest: f.manifest,
      }),
    ).rejects.toThrow('source_changed');
    expect(f.queries.some((query) => /^(insert|update) /i.test(query))).toBe(
      false,
    );
  });
});
