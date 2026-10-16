import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RiceToolHandlerContext } from '../types.js';
const ports = vi.hoisted(() => ({
  version: vi.fn(),
  profile: vi.fn(),
  method: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  personalSkillVersionFromChat: ports.version,
  personalSkillVersionConfirmationFiles: vi.fn(async () => []),
  updateEmployeeProfileFromChat: ports.profile,
  inspectEmployeeMethodFromChat: ports.method,
}));
import { EmployeeAccessBusyError, DataAccessError } from '@allrice/database';
import { isConfirmedToolFailure } from '../../errors.js';
import { versionPersonalSkill } from './personal-skills.js';
import { updateEmployeeProfile } from './employee-profile.js';
import { inspectEmployeeMethod } from './employee-method.js';
beforeEach(() => vi.clearAllMocks());
it.each([
  {
    tool: 'workspace.personal_skill.version',
    execute: versionPersonalSkill,
    port: ports.version,
    code: 'PERSONAL_SKILL_BUSY',
  },
  {
    tool: 'workspace.employee.profile',
    execute: updateEmployeeProfile,
    port: ports.profile,
    code: 'EMPLOYEE_PROFILE_BUSY',
  },
  {
    tool: 'workspace.employee.method.inspect',
    execute: inspectEmployeeMethod,
    port: ports.method,
    code: 'EMPLOYEE_METHOD_BUSY',
  },
])(
  'distinguishes contention, permission denial and unknown outcome for $tool',
  async ({ tool, execute, port, code }) => {
    const organizationId = randomUUID(),
      ownerId = randomUUID();
    const input: RiceToolHandlerContext['input'] = {
      context: {
        executionId: randomUUID(),
        runId: randomUUID(),
        jobId: randomUUID(),
        worker: { type: 'worker', id: randomUUID() },
        delegatedBy: { type: 'user', id: ownerId },
        organizationId,
        workspaceId: randomUUID(),
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: randomUUID(),
          organizationId,
          subjectId: ownerId,
          version: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          memberships: [],
          grants: [],
        },
      },
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      storageRoot: '/unused-synthetic',
      capabilities: [],
      call: {
        id: randomUUID(),
        name: tool,
        arguments: { operation: 'inspect' },
      },
      managedBrowserJobAttempt: 1,
      managedBrowserJobLeaseToken: randomUUID(),
    };
    const identity = {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: tool,
    };
    port.mockRejectedValueOnce(new EmployeeAccessBusyError());
    const busy = await execute({
      input,
      arguments: input.call.arguments,
    }).catch((error: unknown) => error);
    expect(busy).toMatchObject({ code, retryable: false });
    expect(isConfirmedToolFailure(busy, identity)).toBe(true);
    port.mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    const denied = await execute({
      input,
      arguments: input.call.arguments,
    }).catch((error: unknown) => error);
    expect(denied).toMatchObject({ retryable: false });
    expect(denied).not.toHaveProperty('code', code);
    const unknown = new Error('connection lost after an uncertain commit');
    port.mockRejectedValueOnce(unknown);
    expect(
      await execute({ input, arguments: input.call.arguments }).catch(
        (error: unknown) => error,
      ),
    ).toBe(unknown);
    expect(isConfirmedToolFailure(unknown, identity)).toBe(false);
  },
);
