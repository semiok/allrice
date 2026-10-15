import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('./core/client.ts', () => ({ getDatabase: () => ports.sql }));
import {
  BridgeCommandResultError,
  BridgeDataError,
  completeBridgeCommand,
  completeBridgeWorkspaceSelection,
} from './bridge.ts';
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(ports.sql, { json: (v: unknown) => v });
});
it.each([
  'GRANT_NOT_FOUND',
  'FOLDER_CHANGED',
  'broker_wait_timeout',
  'LOCAL_RESULT_UNKNOWN',
])('forwards actionable %s without any client message or path', (code) => {
  const error = new BridgeCommandResultError('unknown', code);
  expect(error).toBeInstanceOf(BridgeDataError);
  expect(error.code).toBe('command_unavailable');
  expect(error.errorCode).toBe(code);
  expect(error.summary.length).toBeLessThan(500);
});
it('does not accept arbitrary diagnostic text as a public reason', () => {
  const error = new BridgeCommandResultError(
    'failed',
    '/Users/private/token-secret',
  );
  expect(error.errorCode).toBe('LOCAL_EXECUTION_FAILED');
  expect(JSON.stringify(error)).not.toContain('private');
});
it('acknowledges the exact workspace receipt even after its grant was revoked', async () => {
  const deviceId = randomUUID(),
    leaseToken = randomUUID(),
    grantId = randomUUID();
  ports.sql.mockResolvedValueOnce([{ id: deviceId }]).mockResolvedValueOnce([
    {
      status: 'succeeded',
      lease_token: leaseToken,
      selected_grant_id: grantId,
      error_code: null,
    },
  ]);
  await expect(
    completeBridgeWorkspaceSelection('synthetic', randomUUID(), {
      leaseToken,
      status: 'succeeded',
      grantId,
    }),
  ).resolves.toEqual({ status: 'succeeded' });
  expect(ports.sql).toHaveBeenCalledTimes(2);
});
it.each(['lease', 'grant', 'status', 'error'])(
  'rejects workspace receipt replay with changed %s',
  async (changed) => {
    const leaseToken = randomUUID(),
      grantId = randomUUID();
    ports.sql
      .mockResolvedValueOnce([{ id: randomUUID() }])
      .mockResolvedValueOnce([
        {
          status: 'succeeded',
          lease_token: leaseToken,
          selected_grant_id: grantId,
          error_code: null,
        },
      ])
      .mockResolvedValueOnce([]);
    const receipt = {
      leaseToken,
      status: 'succeeded',
      grantId,
      ...(changed === 'error' ? { errorCode: 'changed' } : {}),
    };
    if (changed === 'lease') receipt.leaseToken = randomUUID();
    if (changed === 'grant') receipt.grantId = randomUUID();
    if (changed === 'status') {
      receipt.status = 'failed';
      Object.assign(receipt, { errorCode: 'NATIVE_PICKER_FAILED' });
    }
    await expect(
      completeBridgeWorkspaceSelection('synthetic', randomUUID(), receipt),
    ).rejects.toMatchObject({ code: 'lease_lost' });
  },
);
it('acknowledges a repeated legacy command receipt and rejects a changed result', async () => {
  const receipt = {
    leaseToken: randomUUID(),
    status: 'succeeded',
    output: { saved: true },
    summary: 'done',
  };
  const replies = () =>
    ports.sql
      .mockResolvedValueOnce([{ id: randomUUID() }])
      .mockResolvedValueOnce([{ capability: 'local.fs.write', arguments: {} }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          status: receipt.status,
          result: receipt.output,
          summary: receipt.summary,
          error_code: null,
        },
      ]);
  replies();
  await expect(
    completeBridgeCommand('synthetic', randomUUID(), receipt),
  ).resolves.toEqual({ status: 'succeeded' });
  replies();
  await expect(
    completeBridgeCommand('synthetic', randomUUID(), {
      ...receipt,
      output: { saved: false },
    }),
  ).rejects.toMatchObject({ code: 'lease_lost' });
});
