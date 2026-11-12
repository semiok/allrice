import { expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { EmployeeContentError } from '@allrice/database';
import type { RiceToolHandlerContext } from '../types.js';
const ports = vi.hoisted(() => ({
  save: vi.fn(),
  restore: vi.fn(),
  activate: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  saveEmployeeMethodAndPublishFromChat: ports.save,
  restoreEmployeeMethodAndPublishFromChat: ports.restore,
  activateEmployeeMethodFromChat: ports.activate,
}));
import {
  saveEmployeeMethod,
  restoreEmployeeMethod,
  activateEmployeeMethod,
} from './employee-method.js';

it.each([
  { execute: saveEmployeeMethod, port: ports.save },
  { execute: restoreEmployeeMethod, port: ports.restore },
  { execute: activateEmployeeMethod, port: ports.activate },
])(
  'reads the original personal/shared receipt without claiming another save or current effectiveness',
  async ({ execute, port }) => {
    const input = {
      context: { runId: 'synthetic-run' },
      sessionId: 'synthetic-session',
      userMessageId: 'synthetic-human-message',
      managedBrowserJobAttempt: 1,
      managedBrowserJobLeaseToken: 'synthetic-lease',
      call: { id: 'synthetic-call', name: 'synthetic-method' },
    } as unknown as RiceToolHandlerContext['input'];
    port.mockResolvedValueOnce({ revision: 2, personalTextOnly: true });
    const personal = JSON.parse(
      (await execute({ input, arguments: {} })).modelContent,
    );
    expect(personal).toMatchObject({
      revision: 2,
      receiptOnly: true,
      historicalReplay: true,
      status: 'historical_receipt',
      personalTextOnly: true,
    });
    expect(personal.nextStep).toContain(
      'does not replace or load a personal Workflow package',
    );
    expect(personal.nextStep).not.toContain(
      'subsequent independent tasks use this version',
    );
    expect(personal).not.toHaveProperty('enabled');
    port.mockResolvedValueOnce({ revision: 2, enabled: true });
    const legacy = JSON.parse(
      (await execute({ input, arguments: {} })).modelContent,
    );
    expect(legacy).toMatchObject({
      receiptOnly: true,
      historicalReplay: true,
      status: 'historical_receipt',
    });
    expect(legacy).not.toHaveProperty('enabled');
    expect(legacy.nextStep).toContain(
      'does not assert that the historical revision is currently effective',
    );
    expect(legacy).not.toHaveProperty('personalTextOnly');
  },
);

it.each([
  { execute: saveEmployeeMethod, port: ports.save },
  { execute: restoreEmployeeMethod, port: ports.restore },
  { execute: activateEmployeeMethod, port: ports.activate },
])(
  'reports retirement while preserving commit uncertainty',
  async ({ execute, port }) => {
    const input = {
      context: { runId: 'synthetic-run' },
      sessionId: 'synthetic-session',
      userMessageId: 'synthetic-human-message',
      managedBrowserJobAttempt: 1,
      managedBrowserJobLeaseToken: 'synthetic-lease',
      call: { id: 'synthetic-call', name: 'synthetic-method' },
    } as unknown as RiceToolHandlerContext['input'];
    port.mockRejectedValueOnce(
      new EmployeeContentError('legacy_method_retired'),
    );
    await expect(execute({ input, arguments: {} })).rejects.toMatchObject({
      code: 'EMPLOYEE_METHOD_RETIRED',
      retryable: false,
    });
    const unknown = Error('transport closed after possible historical commit');
    port.mockRejectedValueOnce(unknown);
    await expect(execute({ input, arguments: {} })).rejects.toBe(unknown);
  },
);
