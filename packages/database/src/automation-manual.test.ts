import { describe, expect, it } from 'vitest';
import { manualAutomationRequestDigest } from './automation-manual.ts';
const scope = {
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
  task = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  input = {
    requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    expectedRevision: 2,
  },
  other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
describe('manual request correlation independent of native receipt/P', () => {
  it('preserves the same UUID identity regardless of representation case', () => {
    expect(manualAutomationRequestDigest(scope, task, input)).toBe(
      manualAutomationRequestDigest(
        {
          organizationId: scope.organizationId.toUpperCase(),
          workspaceId: scope.workspaceId.toUpperCase(),
          ownerId: scope.ownerId.toUpperCase(),
        },
        task.toUpperCase(),
        { ...input, requestId: input.requestId.toUpperCase() },
      ),
    );
  });
  it('binds tenant, owner, plan, request and original revision independently', () => {
    const digest = manualAutomationRequestDigest(scope, task, input);
    for (const changed of [
      manualAutomationRequestDigest(
        { ...scope, organizationId: other },
        task,
        input,
      ),
      manualAutomationRequestDigest(
        { ...scope, workspaceId: other },
        task,
        input,
      ),
      manualAutomationRequestDigest({ ...scope, ownerId: other }, task, input),
      manualAutomationRequestDigest(scope, other, input),
      manualAutomationRequestDigest(scope, task, {
        ...input,
        requestId: other,
      }),
      manualAutomationRequestDigest(scope, task, {
        ...input,
        expectedRevision: 3,
      }),
    ])
      expect(changed).not.toBe(digest);
  });
});
