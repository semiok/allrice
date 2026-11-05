import { expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RiceToolHandlerContext } from '../types.js';
const ports = vi.hoisted(() => ({ save: vi.fn(), restore: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  saveEmployeeMethodAndPublishFromChat: ports.save,
  restoreEmployeeMethodAndPublishFromChat: ports.restore,
}));
import {
  saveEmployeeMethod,
  restoreEmployeeMethod,
} from './employee-method.js';

it.each([
  { execute: saveEmployeeMethod, port: ports.save },
  { execute: restoreEmployeeMethod, port: ports.restore },
])(
  'describes retained Rice text honestly without changing the legacy shared receipt',
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
      enabled: true,
      status: 'saved',
      personalTextOnly: true,
    });
    expect(personal.nextStep).toContain(
      'does not replace or load a personal Workflow package',
    );
    expect(personal.nextStep).not.toContain(
      'subsequent independent tasks use this version',
    );
    port.mockResolvedValueOnce({ revision: 2 });
    const legacy = JSON.parse(
      (await execute({ input, arguments: {} })).modelContent,
    );
    expect(legacy.nextStep).toContain(
      'subsequent independent tasks use this version',
    );
    expect(legacy).not.toHaveProperty('personalTextOnly');
  },
);
