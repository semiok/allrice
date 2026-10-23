import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { BridgeDataError } from './bridge.ts';
import { DataAccessError } from './data.ts';
import { resolveWorkbenchTerminalTarget } from './workbench-terminal.ts';

// No database connection is used: the real resolver and session authority
// checks consume the same read results as a current, private terminal target.
vi.mock('./core/client.ts', () => ({
  getDatabase: () => {
    throw Error('Unexpected database connection in terminal unit test');
  },
}));

function fixture({ targetExists = true, memberActive = true } = {}) {
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  const context: RequestContext = {
    actor: { type: 'user', id: ownerId },
    organizationId: randomUUID(),
    workspaceId,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    authenticatedAt: new Date().toISOString(),
    memberships: [],
  };
  const input = {
    workspaceId,
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
  };
  const target = {
    label: 'Authorized directory',
    root_fingerprint: 'a'.repeat(64),
    runtime_generation: 1,
    name: 'Synthetic Bridge',
    present: true,
    environment: {
      version: 1,
      clientVersion: '0.6.0-dev.62',
      paused: true,
      browser: 'paused',
      sandbox: 'paused',
      preview: 'paused',
      humanTerminalVersion: 2,
    },
  };
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('from allrice_bridge_devices d'))
      return targetExists ? [target] : [];
    if (sql.includes('from allrice_organizations'))
      return [{ id: context.organizationId }];
    if (sql.includes('from allrice_workspaces')) return [{ id: workspaceId }];
    if (sql.includes('from allrice_users')) return [{ id: ownerId }];
    if (sql.includes('from allrice_memberships'))
      return memberActive ? [{ role: 'member' }] : [];
    if (sql.includes('from allrice_chat_sessions'))
      return [{ id: input.sessionId }];
    throw Error('Unexpected terminal authority read');
  });
  const db = {
    begin: async (callback: (tx: unknown) => unknown) => callback(query),
  } as unknown as NonNullable<
    Parameters<typeof resolveWorkbenchTerminalTarget>[2]
  >;
  return { context, input, target, query, db };
}

describe('human terminal availability classification', () => {
  it.each([true, false])(
    'reports pause as retryable unavailability with requirePresence=%s and accepts the same target after resume',
    async (requirePresence) => {
      const f = fixture();
      const resolve = () =>
        resolveWorkbenchTerminalTarget(f.context, f.input, f.db, {
          requirePresence,
        });
      await expect(resolve()).rejects.toBeInstanceOf(BridgeDataError);
      await expect(resolve()).rejects.toMatchObject({ code: 'device_offline' });
      f.target.environment.paused = false;
      await expect(resolve()).resolves.toMatchObject({
        streamMode: 'push',
        target: {
          ...f.input,
          organizationId: f.context.organizationId,
          ownerId: f.context.actor.id,
          loginSessionId: f.context.sessionId,
          grantVersion: 1,
          rootFingerprint: f.target.root_fingerprint,
        },
      });
    },
  );

  it('keeps an absent or revoked target denied instead of treating it as offline', async () => {
    const f = fixture({ targetExists: false });
    await expect(
      resolveWorkbenchTerminalTarget(f.context, f.input, f.db),
    ).rejects.toBeInstanceOf(DataAccessError);
    await expect(
      resolveWorkbenchTerminalTarget(f.context, f.input, f.db),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('checks current membership before classifying a paused device', async () => {
    const f = fixture({ memberActive: false });
    await expect(
      resolveWorkbenchTerminalTarget(f.context, f.input, f.db),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('requires a real login before reading a paused target', async () => {
    const f = fixture();
    await expect(
      resolveWorkbenchTerminalTarget(
        { ...f.context, sessionId: '' },
        f.input,
        f.db,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.query).not.toHaveBeenCalled();
  });
});
