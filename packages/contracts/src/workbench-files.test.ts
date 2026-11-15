import { describe, expect, it } from 'vitest';
import {
  WorkbenchFileSharingSchema,
  WorkbenchFileUploadSchema,
  WorkbenchFileFavoriteSchema,
  WorkbenchDeliverablesFilterSchema,
} from './workbench-files.ts';
const a = '00000000-0000-4000-8000-000000000001',
  b = '00000000-0000-4000-8000-000000000002';
describe('workspace file inputs after legacy sharing retirement', () => {
  const upload = {
    workspaceId: a,
    requestId: b,
    fileName: 'report.csv',
    mediaType: 'text/csv',
    contentBase64: 'YQ==',
  };
  it('accepts only an explicit personal favorite set/unset and the directory favorite filter', () => {
    for (const favorite of [true, false])
      expect(WorkbenchFileFavoriteSchema.parse({ favorite })).toEqual({
        favorite,
      });
    for (const input of [
      {},
      { favorite: 'true' },
      { favorite: true, viewerId: a },
      { favorite: false, ownerId: b },
    ])
      expect(WorkbenchFileFavoriteSchema.safeParse(input).success).toBe(false);
    expect(
      WorkbenchDeliverablesFilterSchema.parse({
        workspaceId: a,
        category: 'favorite',
        employeeInstanceId: b,
      }).category,
    ).toBe('favorite');
  });
  it('accepts an upload without a client-controlled visibility or reference flag', () => {
    expect(WorkbenchFileUploadSchema.parse(upload)).toEqual(upload);
  });
  it('preserves explicit department audience validation for retained publications', () => {
    expect(
      WorkbenchFileSharingSchema.safeParse({
        scope: 'departments',
        departmentIds: [],
      }).success,
    ).toBe(false);
    expect(
      WorkbenchFileSharingSchema.safeParse({
        scope: 'departments',
        departmentIds: [a, a],
      }).success,
    ).toBe(false);
    expect(
      WorkbenchFileSharingSchema.parse({
        scope: 'departments',
        departmentIds: [a, b],
      }).departmentIds,
    ).toEqual([a, b]);
    expect(
      WorkbenchFileSharingSchema.safeParse({
        scope: 'company',
        departmentIds: [a],
      }).success,
    ).toBe(false);
  });
  it('rejects retired sharing and reference writes, forged authority, and empty uploads', () => {
    for (const retiredOrForged of [
      { sharing: { scope: 'personal', departmentIds: [] } },
      { sharing: { scope: 'company', departmentIds: [] } },
      { sharing: { scope: 'departments', departmentIds: [a] } },
      { isReference: true },
      { isReference: false },
      { role: 'admin' },
      { ownerId: b },
      { expectedRevision: 0 },
    ])
      expect(
        WorkbenchFileUploadSchema.safeParse({
          ...upload,
          ...retiredOrForged,
        }).success,
      ).toBe(false);
    expect(WorkbenchFileUploadSchema.safeParse({}).success).toBe(false);
  });
});
