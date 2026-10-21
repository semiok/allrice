import { describe, expect, it } from 'vitest';
import type { ContentPrincipal } from '@allrice/contracts';
import {
  canSetWorkbenchFileSharing,
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
  departments: string[] = [],
) =>
  evaluateWorkbenchFilePolicy(
    principal,
    { ...policy, ...changes },
    departments,
  );

describe('file ownership, sharing and content-maintenance authority', () => {
  it('keeps another user private file private even for company maintainers', () => {
    expect(
      access({ ...owner, userId: 'other', maintenanceLevel: 'company' }),
    ).toEqual({ canRead: false, canMaintain: false });
    expect(access(owner)).toEqual({ canRead: true, canMaintain: true });
  });
  it('allows either selected department but denies unselected and foreign companies', () => {
    const shared = {
      scope: 'departments' as const,
      department_ids: ['marketing', 'product'],
    };
    for (const departmentId of ['marketing', 'product'])
      expect(
        access(
          { ...owner, userId: 'other', departmentId },
          shared,
          shared.department_ids,
        ).canRead,
      ).toBe(true);
    expect(
      access(
        { ...owner, userId: 'other', departmentId: 'finance' },
        shared,
        shared.department_ids,
      ).canRead,
    ).toBe(false);
    expect(
      access(
        { ...owner, organizationId: 'foreign' },
        shared,
        shared.department_ids,
      ).canRead,
    ).toBe(false);
    expect(access(null, shared, shared.department_ids).canRead).toBe(false);
  });
  it('requires live departments and preserves owner access so a removed target can be repaired', () => {
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
  it('does not let one department maintainer rewrite a file shared with multiple departments', () => {
    const shared = {
      scope: 'departments' as const,
      department_ids: ['marketing', 'product'],
    };
    expect(
      access(
        { ...owner, userId: 'other', maintenanceLevel: 'department' },
        shared,
        shared.department_ids,
      ),
    ).toEqual({ canRead: true, canMaintain: false });
    expect(
      access(
        { ...owner, userId: 'other', maintenanceLevel: 'company' },
        shared,
        shared.department_ids,
      ),
    ).toEqual({ canRead: true, canMaintain: true });
  });
  it('does not confuse shared read access with maintenance or writability', () => {
    expect(access({ ...owner, userId: 'other' }, { scope: 'company' })).toEqual(
      { canRead: true, canMaintain: false },
    );
    expect(access({ ...owner, writable: false }, { scope: 'company' })).toEqual(
      { canRead: true, canMaintain: false },
    );
  });
  it('allows only the owner to make a file personal and bounds expansion by current authority', () => {
    const company = {
      ...owner,
      userId: 'maintainer',
      maintenanceLevel: 'company' as const,
    };
    expect(
      canSetWorkbenchFileSharing(company, owner.userId, {
        scope: 'personal',
        departmentIds: [],
      }),
    ).toBe(false);
    expect(
      canSetWorkbenchFileSharing(owner, owner.userId, {
        scope: 'personal',
        departmentIds: [],
      }),
    ).toBe(true);
    expect(
      canSetWorkbenchFileSharing(owner, owner.userId, {
        scope: 'company',
        departmentIds: [],
      }),
    ).toBe(false);
    expect(
      canSetWorkbenchFileSharing(company, owner.userId, {
        scope: 'departments',
        departmentIds: ['marketing', 'product'],
      }),
    ).toBe(true);
    const manager = { ...owner, maintenanceLevel: 'department' as const };
    expect(
      canSetWorkbenchFileSharing(manager, owner.userId, {
        scope: 'departments',
        departmentIds: ['marketing'],
      }),
    ).toBe(true);
    expect(
      canSetWorkbenchFileSharing(manager, owner.userId, {
        scope: 'departments',
        departmentIds: ['marketing', 'product'],
      }),
    ).toBe(false);
  });
});
