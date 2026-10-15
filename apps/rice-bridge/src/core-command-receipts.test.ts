import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  BridgeCommand,
  BridgeWorkspaceSelectionRequest,
} from '@allrice/contracts';
import type * as Config from './config.js';
import type * as Executor from './executor.js';
import type * as Client from './client.js';

const ports = vi.hoisted(() => ({
  request: vi.fn(),
  config: vi.fn(),
  write: vi.fn(),
  execute: vi.fn(),
  configPath: vi.fn(),
}));
vi.mock('./client.js', async (original) => ({
  ...(await original<typeof Client>()),
  bridgeRequest: ports.request,
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof Config>()),
  readConfig: ports.config,
  writeConfig: ports.write,
  readDeviceToken: async () => 'synthetic',
  configPath: ports.configPath,
}));
vi.mock('./executor.js', async (original) => ({
  ...(await original<typeof Executor>()),
  executeLocalCommand: ports.execute,
}));
import {
  completeLegacyCommand,
  completeWorkspaceSelection,
  workspacePickerCanceled,
} from './core.js';
import { BridgeJournal } from './journal.js';

const folders: string[] = [],
  journals: BridgeJournal[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  ports.request.mockImplementation(async (input) => ({
    status: input.body?.status,
  }));
});
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of folders.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bridge-receipts-')),
  );
  folders.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  ports.configPath.mockReturnValue(join(root, 'config.json'));
  const config: Config.BridgeConfig = {
    server: 'https://tenant.example',
    deviceId: randomUUID(),
    deviceName: 'synthetic',
    grants: [],
  };
  const grant = {
    id: randomUUID(),
    deviceId: config.deviceId,
    rootPath: workspace,
    rootFingerprint: createHash('sha256').update(workspace).digest('hex'),
    label: 'workspace',
    revokedAt: null,
    createdAt: new Date().toISOString(),
  };
  const command: BridgeCommand = {
    id: randomUUID(),
    deviceId: config.deviceId,
    folderGrantId: grant.id,
    status: 'claimed',
    payload: {
      capability: 'local.fs.list',
      arguments: { path: '.', limit: 50 },
    },
    leaseToken: randomUUID(),
    createdAt: new Date().toISOString(),
    timeoutAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const selection: BridgeWorkspaceSelectionRequest = {
    id: randomUUID(),
    deviceId: config.deviceId,
    status: 'claimed',
    leaseToken: randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  const journalInput = {
    directory: join(root, 'journal'),
    server: config.server,
    deviceId: config.deviceId,
  };
  const journal = await BridgeJournal.open(journalInput);
  journals.push(journal);
  ports.config.mockResolvedValue(config);
  return {
    root,
    workspace,
    config,
    grant,
    command,
    selection,
    journalInput,
    journal,
  };
}
it('durably completes the original local.fs.list input when its local grant is missing', async () => {
  const f = await fixture();
  ports.request.mockRejectedValueOnce(Error('response lost'));
  await expect(
    completeLegacyCommand(f.config, 'synthetic', f.command, f.journal),
  ).rejects.toThrow('response lost');
  const [saved] = await f.journal.pendingFileCommands();
  expect(saved?.receipt).toMatchObject({
    status: 'failed',
    errorCode: 'GRANT_NOT_FOUND',
    leaseToken: f.command.leaseToken,
  });
  f.config.grants.push(f.grant);
  await completeLegacyCommand(f.config, 'synthetic', f.command, f.journal);
  expect(ports.execute).not.toHaveBeenCalled();
  expect(ports.request.mock.calls.map(([call]) => call.body)).toEqual([
    saved!.receipt,
    saved!.receipt,
  ]);
  expect(await f.journal.pendingFileCommands()).toEqual([]);
});
it('resends the same durable success after a lost ACK and restart without repeating a write', async () => {
  const f = await fixture();
  f.config.grants.push(f.grant);
  f.command.payload = {
    capability: 'local.fs.write',
    arguments: { path: 'result.txt', content: 'once' },
  };
  ports.execute.mockImplementation(async () => {
    await writeFile(join(f.workspace, 'result.txt'), 'once');
    return { output: { created: true }, summary: 'saved' };
  });
  ports.request.mockRejectedValueOnce(Error('ACK lost'));
  await expect(
    completeLegacyCommand(f.config, 'synthetic', f.command, f.journal),
  ).rejects.toThrow('ACK lost');
  await f.journal.close();
  const reopened = await BridgeJournal.open(f.journalInput);
  journals.push(reopened);
  await completeLegacyCommand(f.config, 'synthetic', f.command, reopened);
  expect(ports.execute).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('once');
  expect(ports.request.mock.calls[0]![0].body).toEqual(
    ports.request.mock.calls[1]![0].body,
  );
});
it('never repeats an interrupted execution whose result is unknown', async () => {
  const f = await fixture();
  f.config.grants.push(f.grant);
  await f.journal.beginCommand(f.command);
  await f.journal.close();
  const reopened = await BridgeJournal.open(f.journalInput);
  journals.push(reopened);
  await completeLegacyCommand(f.config, 'synthetic', f.command, reopened);
  expect(ports.execute).not.toHaveBeenCalled();
  expect(ports.request.mock.calls[0]![0].body).toMatchObject({
    status: 'unknown',
    errorCode: 'LOCAL_RESULT_UNKNOWN',
  });
  await expect(
    completeLegacyCommand(
      f.config,
      'synthetic',
      { ...f.command, leaseToken: randomUUID() },
      reopened,
    ),
  ).rejects.toThrow('JOURNAL_IDENTITY_MISMATCH');
});
it.each([
  ['DESKTOP_PICKER_CANCELED', 'NATIVE_PICKER_CANCELED'],
  ['DESKTOP_PICKER_INTERRUPTED', 'NATIVE_PICKER_FAILED'],
  ['picker crashed', 'NATIVE_PICKER_FAILED'],
])('distinguishes picker result %s', async (message, code) => {
  const f = await fixture();
  await completeWorkspaceSelection(
    f.config,
    'synthetic',
    f.selection,
    async () => {
      throw Error(message);
    },
    undefined,
    f.journal,
  );
  expect(ports.request.mock.calls[0]![0].body).toMatchObject({
    status: 'failed',
    errorCode: code,
  });
});
it.each([
  ['server', 'WORKSPACE_GRANT_CREATE_FAILED'],
  ['disk', 'WORKSPACE_GRANT_PERSIST_FAILED'],
])(
  'keeps %s grant failure distinct from user cancellation',
  async (failure, code) => {
    const f = await fixture();
    ports.request.mockImplementation(async ({ path, body }) => {
      if (path.endsWith('/grants')) {
        if (failure === 'server') throw Error('server failed');
        return { grant: { ...f.grant, rootPath: undefined } };
      }
      return { status: body?.status };
    });
    // The server schema must contain only public grant fields.
    const grant = Object.fromEntries(
      Object.entries(f.grant).filter(([key]) => key !== 'rootPath'),
    );
    if (failure === 'disk') {
      ports.request.mockImplementation(async ({ path, body }) =>
        path.endsWith('/grants') ? { grant } : { status: body?.status },
      );
      ports.write.mockRejectedValue(Error('disk failed'));
    }
    await completeWorkspaceSelection(
      f.config,
      'synthetic',
      f.selection,
      async () => f.workspace,
      undefined,
      f.journal,
    );
    expect(ports.request.mock.calls.at(-1)![0].body).toMatchObject({
      status: 'failed',
      errorCode: code,
    });
  },
);
it('retains a successful grant and retries only its receipt after response loss', async () => {
  const f = await fixture(),
    picker = vi.fn(async () => f.workspace);
  const grant = Object.fromEntries(
    Object.entries(f.grant).filter(([key]) => key !== 'rootPath'),
  );
  let lost = true;
  ports.request.mockImplementation(async ({ path, body }) => {
    if (path.endsWith('/grants')) return { grant };
    if (lost) {
      lost = false;
      throw Error('lost');
    }
    return { status: body?.status };
  });
  await expect(
    completeWorkspaceSelection(
      f.config,
      'synthetic',
      f.selection,
      picker,
      undefined,
      f.journal,
    ),
  ).rejects.toThrow('lost');
  expect(
    (await f.journal.pendingWorkspaceSelections())[0]?.receipt,
  ).toMatchObject({ status: 'succeeded', grantId: grant.id });
  await f.journal.close();
  const reopened = await BridgeJournal.open(f.journalInput);
  journals.push(reopened);
  await completeWorkspaceSelection(
    f.config,
    'synthetic',
    f.selection,
    picker,
    undefined,
    reopened,
  );
  expect(picker).toHaveBeenCalledTimes(1);
  expect(ports.write).toHaveBeenCalledTimes(1);
  expect(await reopened.pendingWorkspaceSelections()).toEqual([]);
});
it('recognizes only the native AppleScript cancellation code', () => {
  expect(
    workspacePickerCanceled(
      Object.assign(Error('exit 1'), { stderr: 'User canceled. (-128)' }),
    ),
  ).toBe(true);
  expect(
    workspacePickerCanceled(
      Object.assign(Error('exit 1'), { stderr: 'not authorized (-1743)' }),
    ),
  ).toBe(false);
});
