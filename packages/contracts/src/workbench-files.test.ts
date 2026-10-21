import { describe, expect, it } from 'vitest';
import {
  WorkbenchFileSharingSchema,
  WorkbenchFileUpdateSchema,
  WorkbenchFileUploadSchema,
} from './workbench-files.ts';
const a = '00000000-0000-4000-8000-000000000001',
  b = '00000000-0000-4000-8000-000000000002';
describe('workspace file sharing inputs', () => {
  it('defaults an upload to personal independently of a browsing filter', () => {
    expect(
      WorkbenchFileUploadSchema.parse({
        workspaceId: a,
        requestId: b,
        fileName: 'report.csv',
        mediaType: 'text/csv',
        contentBase64: 'YQ==',
      }).sharing,
    ).toEqual({ scope: 'personal', departmentIds: [] });
  });
  it('requires explicit departments only for department sharing', () => {
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
  it('does not accept a role/owner claim or an empty mutation', () => {
    expect(
      WorkbenchFileUpdateSchema.safeParse({
        workspaceId: a,
        requestId: b,
        expectedRevision: 0,
        role: 'admin',
        sharing: { scope: 'company' },
      }).success,
    ).toBe(false);
    expect(
      WorkbenchFileUpdateSchema.safeParse({
        workspaceId: a,
        requestId: b,
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });
});
