import { PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { BridgeConfig } from './config.js';
import type { BridgeRuntimeState } from './core.js';
import type * as Client from './client.js';

const ports = vi.hoisted(() => ({
  config: vi.fn(),
  credentials: vi.fn(),
  pair: vi.fn(),
  revoke: vi.fn(),
  start: vi.fn(),
  grant: vi.fn(),
  request: vi.fn(),
}));
// These are controller protocol tests, not native/Keychain acceptance. No real
// core, config, network or filesystem port is imported or invoked.
vi.mock('./core.js', () => ({
  createFolderGrant: ports.grant,
  pair: ports.pair,
  revoke: ports.revoke,
  start: ports.start,
}));
vi.mock('./config.js', () => ({
  readConfig: ports.config,
  readDeviceCredentials: ports.credentials,
}));
vi.mock('./keychain.js', () => ({
  KeychainUnavailableError: class extends Error {
    constructor(public readonly reason: string) {
      super('KEYCHAIN_UNAVAILABLE');
    }
  },
}));
vi.mock('./client.js', async (original) => ({
  ...(await original<typeof Client>()),
  bridgeRequest: ports.request,
}));
import { BridgeClientError } from './client.js';
import { runDesktopController } from './desktop-controller.js';

const oldDevice = '00000000-0000-4000-8000-000000000091';
const newDevice = '00000000-0000-4000-8000-000000000092';
const syntheticToken = 'synthetic-secret-never-exported';
const syntheticPath = '/private/synthetic-do-not-read-workspace';
type Frame = {
  v: number;
  type: string;
  id?: string;
  pickerId?: string;
  ok?: boolean;
  code?: string;
  data?: Record<string, unknown>;
  state?: Record<string, unknown>;
};
const configuration = (deviceId: string): BridgeConfig => ({
  deviceId,
  deviceName: 'Synthetic controller device',
  server: 'https://synthetic.example/',
  grants: [
    {
      id: 'synthetic-grant',
      label: 'Synthetic workspace',
      rootPath: syntheticPath,
      rootFingerprint: 'synthetic-fingerprint',
    },
  ],
});

async function fixture(configDeleted: boolean, rejectedPairing = false) {
  for (const port of Object.values(ports)) port.mockReset();
  let current: BridgeConfig | null = configuration(oldDevice);
  const starts: string[] = [];
  const stops: string[] = [];
  let chooseFile:
    | ((root: string, signal?: AbortSignal) => Promise<string | null>)
    | undefined;
  ports.config.mockImplementation(async () => {
    if (!current)
      throw Object.assign(Error('synthetic missing config'), {
        code: 'ENOENT',
      });
    return current;
  });
  ports.credentials.mockResolvedValue({
    token: syntheticToken,
    storage: 'private-file',
    privateFileSecure: true,
    keychainUnavailableReason: 'interaction-not-allowed',
  });
  ports.request.mockRejectedValue(
    new BridgeClientError(
      'Bridge device credential is invalid or revoked',
      401,
      'AUTHENTICATION_REQUIRED',
    ),
  );
  ports.start.mockImplementation(
    (options: {
      signal: AbortSignal;
      onState: (state: BridgeRuntimeState) => void;
      chooseFile?: typeof chooseFile;
    }) => {
      chooseFile = options.chooseFile;
      const deviceId = current!.deviceId;
      starts.push(deviceId);
      const state: BridgeRuntimeState = {
        phase: 'online',
        workspaceLabels: ['Synthetic workspace'],
        activeForeground: 0,
        activeServices: 0,
        pendingReceipts: 0,
        unknownOperations: 0,
      };
      if (rejectedPairing && deviceId === oldDevice) {
        stops.push(deviceId);
        options.onState({ ...state, phase: 'stopped', pairingRequired: true });
        return Promise.resolve();
      }
      options.onState(state);
      return new Promise<void>((resolve) => {
        const stop = () => {
          stops.push(deviceId);
          options.onState({ ...state, phase: 'stopped' });
          resolve();
        };
        if (options.signal.aborted) stop();
        else options.signal.addEventListener('abort', stop, { once: true });
      });
    },
  );
  ports.revoke.mockImplementation(async () => {
    // Assert the controller has actually stopped the old runtime first.
    expect(stops).toEqual([oldDevice]);
    if (configDeleted) current = null;
    return {
      serverRevoked: true,
      cleanupComplete: false,
      configDeleted,
      credentialCleanup: {
        complete: false,
        keychainDeleted: false,
        localFilesDeleted: true,
        keychainUnavailableReason: 'interaction-not-allowed',
      },
    };
  });
  ports.pair.mockImplementation(async (args: string[]) => {
    if (rejectedPairing) expect(current?.deviceId).toBe(oldDevice);
    else expect(current).toBeNull();
    expect(args).toEqual([
      '--server',
      'https://synthetic.example/',
      '--code',
      'ABCDEF12',
    ]);
    current = configuration(newDevice);
  });
  ports.grant.mockImplementation(() => {
    throw Error('UNEXPECTED_WORKSPACE_MUTATION');
  });

  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  let buffered = '';
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    while (buffered.includes('\n')) {
      const boundary = buffered.indexOf('\n');
      frames.push(JSON.parse(buffered.slice(0, boundary)) as Frame);
      buffered = buffered.slice(boundary + 1);
    }
  });
  const stdin = vi
    .spyOn(process, 'stdin', 'get')
    .mockReturnValue(input as unknown as typeof process.stdin);
  const stdout = vi
    .spyOn(process, 'stdout', 'get')
    .mockReturnValue(output as unknown as typeof process.stdout);
  let sequence = 0;
  const done = runDesktopController();
  const request = async (
    type: string,
    fields: Record<string, unknown> = {},
  ) => {
    const id = `request-${++sequence}`;
    input.write(`${JSON.stringify({ v: 1, id, type, ...fields })}\n`);
    await vi.waitFor(() => {
      expect(
        frames.some((frame) => frame.type === 'response' && frame.id === id),
      ).toBe(true);
    });
    return frames.find(
      (frame) => frame.type === 'response' && frame.id === id,
    )!;
  };
  const close = async () => {
    try {
      input.end();
      await done;
      expect(starts).toEqual(stops);
      expect(JSON.stringify(frames)).not.toContain(syntheticToken);
      // Only the private picker IPC carries its authorized native root.
      expect(
        JSON.stringify(frames.filter((frame) => frame.type !== 'picker')),
      ).not.toContain(syntheticPath);
      expect(ports.grant).not.toHaveBeenCalled();
    } finally {
      stdin.mockRestore();
      stdout.mockRestore();
      input.destroy();
      output.destroy();
    }
  };
  try {
    await vi.waitFor(() => {
      expect(
        frames.some(
          (frame) =>
            frame.type === 'state' &&
            (rejectedPairing
              ? frame.state?.pairingRequired === true
              : frame.state?.connection === 'online'),
        ),
      ).toBe(true);
    });
  } catch (error) {
    await close();
    throw error;
  }
  const completeNextRevoke = () => {
    ports.revoke.mockImplementationOnce(async () => {
      expect(current?.deviceId).toBe(newDevice);
      expect(stops).toEqual([oldDevice, newDevice]);
      current = null;
      return {
        serverRevoked: true,
        cleanupComplete: true,
        configDeleted: true,
        credentialCleanup: {
          complete: true,
          keychainDeleted: true,
          localFilesDeleted: true,
        },
      };
    });
  };
  const pickFile = (signal?: AbortSignal) => {
    if (!chooseFile) throw Error('SYNTHETIC_PICKER_UNAVAILABLE');
    return chooseFile(syntheticPath, signal);
  };
  return { request, close, starts, frames, completeNextRevoke, pickFile };
}

it('rechecks rejected authorization before deliberately pairing a new identity, without revoking or deleting the old evidence', async () => {
  const app = await fixture(false, true);
  try {
    expect((await app.request('status')).data).toMatchObject({
      deviceId: oldDevice,
      pairingRequired: true,
    });
    expect(
      await app.request('pair', {
        server: 'https://synthetic.example/',
        code: 'ABCDEF12',
      }),
    ).toMatchObject({ ok: true });
    expect(ports.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        server: 'https://synthetic.example/',
        path: '/api/v1/bridge/device/status',
        token: syntheticToken,
      }),
    );
    expect(ports.revoke).not.toHaveBeenCalled();
    expect((await app.request('status')).data).toMatchObject({
      deviceId: newDevice,
      pairingRequired: false,
      connection: 'online',
    });
  } finally {
    await app.close();
  }
});

it.each(['unavailable', 'authorized', 'new-pair-rejected'])(
  'retains the old identity when recovery is %s',
  async (kind) => {
    const app = await fixture(false, true);
    try {
      if (kind === 'unavailable')
        ports.request.mockRejectedValueOnce(
          new BridgeClientError('private proxy failure', 503),
        );
      if (kind === 'authorized') ports.request.mockResolvedValueOnce({});
      if (kind === 'new-pair-rejected')
        ports.pair.mockRejectedValueOnce(Error('PAIRING_EXPIRED'));
      expect(
        (
          await app.request('pair', {
            server: 'https://synthetic.example/',
            code: 'ABCDEF12',
          })
        ).ok,
      ).toBe(false);
      expect((await app.request('status')).data).toMatchObject({
        deviceId: oldDevice,
        pairingRequired: true,
      });
      expect(ports.revoke).not.toHaveBeenCalled();
      if (kind !== 'new-pair-rejected')
        expect(ports.pair).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('keeps canceled picker IDs invalid without affecting the next user cancel or selection', async () => {
  const app = await fixture(false);
  try {
    const canceled = new AbortController();
    const canceledChoice = app.pickFile(canceled.signal);
    const oldPicker = app.frames.findLast((frame) => frame.type === 'picker')!;
    canceled.abort();
    expect(await canceledChoice).toBeNull();
    expect(
      app.frames.findLast((frame) => frame.type === 'pickerCancel'),
    ).toMatchObject({
      pickerId: oldPicker.pickerId,
    });
    expect(
      await app.request('picker', { pickerId: oldPicker.pickerId, path: null }),
    ).toMatchObject({ ok: false, code: 'DESKTOP_REQUEST_INVALID' });

    const userCancel = app.pickFile();
    const nextPicker = app.frames.findLast((frame) => frame.type === 'picker')!;
    expect(nextPicker.pickerId).not.toBe(oldPicker.pickerId);
    expect(
      await app.request('picker', { pickerId: oldPicker.pickerId, path: null }),
    ).toMatchObject({ ok: false, code: 'DESKTOP_REQUEST_INVALID' });
    expect(
      await app.request('picker', {
        pickerId: nextPicker.pickerId,
        path: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await userCancel).toBeNull();

    const confirmed = app.pickFile();
    const finalPicker = app.frames.findLast(
      (frame) => frame.type === 'picker',
    )!;
    expect(
      await app.request('picker', {
        pickerId: finalPicker.pickerId,
        path: `${syntheticPath}/中文 空格.xlsx`,
      }),
    ).toMatchObject({ ok: true });
    expect(await confirmed).toBe(`${syntheticPath}/中文 空格.xlsx`);
    expect((await app.request('status')).data).toMatchObject({
      mode: 'running',
      connection: 'online',
      errorCode: null,
    });
  } finally {
    await app.close();
  }
}, 5000);

it('reports unpaired plus pending cleanup and an explicit partial-success response when config was removed', async () => {
  const app = await fixture(true);
  try {
    expect(
      await app.request('revoke', { confirmDeviceId: oldDevice }),
    ).toMatchObject({
      ok: true,
      data: {
        serverRevoked: true,
        cleanupComplete: false,
        configDeleted: true,
      },
    });
    expect((await app.request('status')).data).toMatchObject({
      mode: 'unpaired',
      deviceId: null,
      connection: 'stopped',
      credentialCleanupPending: true,
      errorCode: 'DESKTOP_REVOKED_CLEANUP_PENDING',
    });
    expect((await app.request('diagnostics')).data).toMatchObject({
      credentialCleanupPending: true,
      notices: expect.arrayContaining([
        expect.objectContaining({ code: 'DESKTOP_REVOKED_CLEANUP_PENDING' }),
      ]),
    });
    expect(app.starts).toEqual([oldDevice]);
    expect(ports.revoke).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
}, 5000);

it('keeps the retained config in error without automatically restarting the revoked runtime', async () => {
  const app = await fixture(false);
  try {
    expect(
      await app.request('revoke', { confirmDeviceId: oldDevice }),
    ).toMatchObject({
      ok: true,
      data: {
        serverRevoked: true,
        cleanupComplete: false,
        configDeleted: false,
      },
    });
    await turn();
    for (const type of ['status', 'diagnostics']) {
      expect((await app.request(type)).data).toMatchObject({
        mode: 'error',
        connection: 'stopped',
        credentialCleanupPending: true,
      });
    }
    expect((await app.request('status')).data).toMatchObject({
      deviceId: oldDevice,
      errorCode: 'DESKTOP_REVOKED_CLEANUP_PENDING',
    });
    expect(app.starts).toEqual([oldDevice]);
    expect(ports.pair).not.toHaveBeenCalled();
    expect(ports.revoke).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
}, 5000);

it('retains the old cleanup warning while a deliberately newly paired device starts normally', async () => {
  const app = await fixture(true);
  try {
    await app.request('revoke', { confirmDeviceId: oldDevice });
    expect(
      await app.request('pair', {
        server: 'https://synthetic.example/',
        code: 'ABCDEF12',
      }),
    ).toMatchObject({ ok: true });
    expect((await app.request('status')).data).toMatchObject({
      mode: 'running',
      deviceId: newDevice,
      connection: 'online',
      errorCode: null,
      credentialCleanupPending: true,
    });
    expect((await app.request('diagnostics')).data).toMatchObject({
      mode: 'running',
      connection: 'online',
      credentialCleanupPending: true,
    });
    expect(app.starts).toEqual([oldDevice, newDevice]);
    expect(ports.pair).toHaveBeenCalledTimes(1);
    expect(ports.revoke).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
}, 5000);

it('does not erase prior pending cleanup when the new device later revokes completely', async () => {
  const app = await fixture(true);
  try {
    expect(
      await app.request('revoke', { confirmDeviceId: oldDevice }),
    ).toMatchObject({
      ok: true,
      data: {
        serverRevoked: true,
        cleanupComplete: false,
        configDeleted: true,
      },
    });
    expect(
      await app.request('pair', {
        server: 'https://synthetic.example/',
        code: 'ABCDEF12',
      }),
    ).toMatchObject({ ok: true });
    app.completeNextRevoke();
    expect(
      await app.request('revoke', { confirmDeviceId: newDevice }),
    ).toMatchObject({
      ok: true,
      data: { serverRevoked: true, cleanupComplete: true, configDeleted: true },
    });
    expect((await app.request('status')).data).toMatchObject({
      mode: 'unpaired',
      deviceId: null,
      connection: 'stopped',
      credentialCleanupPending: true,
      errorCode: 'DESKTOP_REVOKED_CLEANUP_PENDING',
    });
    expect((await app.request('diagnostics')).data).toMatchObject({
      mode: 'unpaired',
      connection: 'stopped',
      credentialCleanupPending: true,
      notices: expect.arrayContaining([
        expect.objectContaining({ code: 'DESKTOP_REVOKED_CLEANUP_PENDING' }),
      ]),
    });
    expect(app.starts).toEqual([oldDevice, newDevice]);
    expect(ports.pair).toHaveBeenCalledTimes(1);
    expect(ports.revoke).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
}, 5000);
