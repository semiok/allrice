import { PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { BridgeConfig } from './config.js';
import type { BridgeRuntimeState } from './core.js';

const ports = vi.hoisted(() => ({
  config: vi.fn(),
  credentials: vi.fn(),
  pair: vi.fn(),
  revoke: vi.fn(),
  start: vi.fn(),
  grant: vi.fn(),
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
import { runDesktopController } from './desktop-controller.js';

const oldDevice = '00000000-0000-4000-8000-000000000091';
const newDevice = '00000000-0000-4000-8000-000000000092';
const syntheticToken = 'synthetic-secret-never-exported';
const syntheticPath = '/private/synthetic-do-not-read-workspace';
type Frame = {
  v: number;
  type: string;
  id?: string;
  ok?: boolean;
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

async function fixture(configDeleted: boolean) {
  for (const port of Object.values(ports)) port.mockReset();
  let current: BridgeConfig | null = configuration(oldDevice);
  const starts: string[] = [];
  const stops: string[] = [];
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
  ports.start.mockImplementation(
    (options: {
      signal: AbortSignal;
      onState: (state: BridgeRuntimeState) => void;
    }) => {
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
    expect(current).toBeNull();
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
      expect(JSON.stringify(frames)).not.toContain(syntheticPath);
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
            frame.type === 'state' && frame.state?.connection === 'online',
        ),
      ).toBe(true);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { request, close, starts, frames };
}

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
