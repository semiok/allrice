import { describe, expect, it } from 'vitest';
import type { ContentPrincipal } from '@allrice/contracts';
import {
  evaluateWorkbenchFilePolicy,
  type WorkbenchFilePolicy,
} from './workbench-file-access.ts';

const owner: ContentPrincipal = {
  userId: 'owner',
  organizationId: 'company',
  departmentId: 'marketing',
  maintenanceLevel: 'personal',
  writable: true,
};
const policy: WorkbenchFilePolicy = {
  object_id: 'file',
  organization_id: 'company',
  workspace_id: 'workspace',
  owner_id: owner.userId,
  series_id: null,
  file_name: 'report.docx',
  scope: 'personal',
  department_ids: [],
  reference_source_id: null,
  reference_enabled: false,
  revision: 1,
};
const access = (
  principal: ContentPrincipal | null,
  changes: Partial<WorkbenchFilePolicy> = {},
) => evaluateWorkbenchFilePolicy(principal, { ...policy, ...changes });

describe('retired original-file sharing does not confer ownership', () => {
  it('keeps another user private file private even for company maintainers', () => {
    expect(
      access({ ...owner, userId: 'other', maintenanceLevel: 'company' }),
    ).toEqual({ canRead: false, canMaintain: false });
    expect(access(owner)).toEqual({ canRead: true, canMaintain: true });
  });
  it('rejects formerly selected and unselected departments and foreign organizations', () => {
    const shared = {
      scope: 'departments' as const,
      department_ids: ['marketing', 'product'],
    };
    for (const departmentId of ['marketing', 'product', 'finance'])
      expect(
        access({ ...owner, userId: 'other', departmentId }, shared),
      ).toEqual({ canRead: false, canMaintain: false });
    expect(
      access({ ...owner, organizationId: 'foreign' }, shared).canRead,
    ).toBe(false);
    expect(access(null, shared).canRead).toBe(false);
  });
  it('preserves the owner after an old target department is removed', () => {
    const shared = {
      scope: 'departments' as const,
      department_ids: ['removed'],
    };
    expect(
      access(
        { ...owner, userId: 'other', maintenanceLevel: 'company' },
        shared,
      ),
    ).toEqual({ canRead: false, canMaintain: false });
    expect(access(owner, shared)).toEqual({ canRead: true, canMaintain: true });
  });
  it('never promotes department or company maintainers to original owner', () => {
    for (const maintenanceLevel of ['department', 'company'] as const)
      expect(
        access(
          { ...owner, userId: 'other', maintenanceLevel },
          {
            scope: 'departments',
            department_ids: ['marketing', 'product'],
          },
        ),
      ).toEqual({ canRead: false, canMaintain: false });
  });
  it('keeps read-only owners readable without granting maintenance', () => {
    expect(access({ ...owner, userId: 'other' }, { scope: 'company' })).toEqual(
      { canRead: false, canMaintain: false },
    );
    expect(access({ ...owner, writable: false }, { scope: 'company' })).toEqual(
      { canRead: true, canMaintain: false },
    );
  });
  it('does not revive old company sharing through reference flags or role claims', () => {
    expect(
      access(
        { ...owner, userId: 'other', maintenanceLevel: 'company' },
        {
          scope: 'company',
          reference_enabled: true,
          reference_source_id: 'old-source',
        },
      ),
    ).toEqual({ canRead: false, canMaintain: false });
  });
});
