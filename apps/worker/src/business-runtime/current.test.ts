import type {
  CurrentEmployeeBusinessProjection,
  EmployeeBusinessTargetProjection,
  RequestContext,
} from '@allrice/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  currentEmployeeBusiness,
  requireCurrentAdministration,
} from './current.ts';

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const contractFakeContext: RequestContext = {
  requestId: id('1'),
  sessionId: id('2'),
  actor: { type: 'user', id: id('3') },
  organizationId: id('4'),
  workspaceId: id('5'),
  memberships: [],
  authenticatedAt: '2026-11-22T00:00:00Z',
};
const target: EmployeeBusinessTargetProjection = {
  workspaceId: id('5'),
  employeeInstanceId: id('6'),
  threadId: null,
  access: 'history',
  module: { kind: 'not-applicable' },
};
const contractFakeCurrent = (): CurrentEmployeeBusinessProjection => ({
  scope: {
    organizationId: id('4'),
    workspaceId: id('5'),
    ownerId: id('3'),
    employeeInstanceId: id('6'),
    employeeId: id('7'),
  },
  threadId: null,
  access: 'history',
  identityRevisionRef: 'contract-fake-identity',
  executionGeneration: null,
  module: { kind: 'not-applicable' },
});

describe('current business projection with explicit contract fakes', () => {
  it('reads cold history through its own current guard without executing or requiring B', async () => {
    const history = vi.fn(async () => contractFakeCurrent());
    const execute = vi.fn(async () => {
      throw new Error('must not start execution');
    });
    const signal = new AbortController().signal;
    const current = await currentEmployeeBusiness(
      { history, execute },
      contractFakeContext,
      target,
      signal,
    );
    expect(current.executionGeneration).toBeNull();
    expect(history).toHaveBeenCalledWith(contractFakeContext, target, signal);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not substitute history or VM admission for a missing management/execute source', async () => {
    const history = vi.fn(async () => contractFakeCurrent());
    for (const access of ['management', 'execute'] as const) {
      await expect(
        currentEmployeeBusiness({ history }, contractFakeContext, {
          ...target,
          access,
          threadId: access === 'execute' ? id('8') : null,
        }),
      ).rejects.toMatchObject({
        code: 'business_runtime_dependency_unavailable',
        dependency: `current.${access}`,
      });
    }
    expect(history).not.toHaveBeenCalled();
  });

  it.each([
    'organizationId',
    'workspaceId',
    'ownerId',
    'employeeInstanceId',
  ] as const)('rejects a current projection for another %s', async (field) => {
    const current = contractFakeCurrent();
    current.scope[field] = id('99');
    await expect(
      currentEmployeeBusiness(
        { history: async () => current },
        contractFakeContext,
        target,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });

  it('requires original 4.0 qualification for execution, independently of history eligibility', async () => {
    const executeTarget = {
      ...target,
      access: 'execute' as const,
      threadId: id('8'),
    };
    const current = {
      ...contractFakeCurrent(),
      access: 'execute',
      threadId: id('8'),
    };
    await expect(
      currentEmployeeBusiness(
        { execute: async () => current },
        contractFakeContext,
        executeTarget,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
    expect(
      (
        await currentEmployeeBusiness(
          { execute: async () => ({ ...current, executionGeneration: '4.0' }) },
          contractFakeContext,
          executeTarget,
        )
      ).executionGeneration,
    ).toBe('4.0');
  });

  it('requires the exact current module release and binding rather than instance existence', async () => {
    const release = {
      moduleId: 'contract-fake-module',
      contractVersion: 1 as const,
      contentVersion: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const current = {
      ...contractFakeCurrent(),
      module: {
        kind: 'required' as const,
        configDigest: 'owner-config-digest',
        binding: {
          organizationId: id('4'),
          workspaceId: id('5'),
          ownerId: id('3'),
          instanceId: id('6'),
          release,
          revision: 2,
          enabledAt: '2026-11-21T00:00:00Z',
          revokedAt: null,
        },
      },
    };
    const moduleTarget = {
      ...target,
      module: { kind: 'required' as const, release },
    };
    expect(
      await currentEmployeeBusiness(
        { history: async () => current },
        contractFakeContext,
        moduleTarget,
      ),
    ).toEqual(current);
    for (const binding of [
      { ...current.module.binding, revokedAt: '2026-11-22T00:00:00Z' },
      { ...current.module.binding, ownerId: id('99') },
      { ...current.module.binding, instanceId: id('99') },
      {
        ...current.module.binding,
        release: { ...release, contentVersion: '1.0.1' },
      },
      {
        ...current.module.binding,
        release: { ...release, digest: `sha256:${'b'.repeat(64)}` },
      },
    ])
      await expect(
        currentEmployeeBusiness(
          {
            history: async () => ({
              ...current,
              module: { ...current.module, binding },
            }),
          },
          contractFakeContext,
          moduleTarget,
        ),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
    await expect(
      currentEmployeeBusiness(
        { history: async () => contractFakeCurrent() },
        contractFakeContext,
        moduleTarget,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });

  it('retains source denial instead of trusting a schema-valid ID or historical membership', async () => {
    const denied = new Error('contract-fake current membership revoked');
    await expect(
      currentEmployeeBusiness(
        {
          history: async () => {
            throw denied;
          },
        },
        contractFakeContext,
        target,
      ),
    ).rejects.toBe(denied);
  });

  it('checks company administration through the original actor and exact target without execute qualification', async () => {
    const administration = vi.fn(async () => undefined);
    const execute = vi.fn(async () => {
      throw new Error('not administration');
    });
    const adminTarget = {
      organizationId: id('4'),
      operation: 'contract-fake.list-sources',
      targetRef: 'company-rules',
    };
    await requireCurrentAdministration(
      { administration, execute },
      contractFakeContext,
      adminTarget,
    );
    expect(administration).toHaveBeenCalledWith(
      contractFakeContext,
      adminTarget,
      undefined,
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(
      requireCurrentAdministration({}, contractFakeContext, adminTarget),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
  });
});
