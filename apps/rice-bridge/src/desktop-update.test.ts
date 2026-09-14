import { afterEach, expect, it, vi } from 'vitest';
import {
  DesktopUpdater,
  validateDrainedUpdateTicket,
} from './desktop-update.js';
import { parseDesktopRequest } from './desktop-protocol.js';

afterEach(() => vi.unstubAllGlobals());
it('binds the drained install ticket to request, action and original host/Core PIDs', () => {
  const id = '00000000-0000-4000-8000-000000000011';
  const original = { hostPid: 4321, corePid: 4322 };
  const ticket = { v: 1, id, recovery: false, ...original };
  expect(validateDrainedUpdateTicket(ticket, id, false, original)).toEqual(
    ticket,
  );
  for (const patch of [
    { hostPid: 9999 },
    { corePid: 9999 },
    { id: '00000000-0000-4000-8000-000000000012' },
    { recovery: true },
    { corePid: 1 },
    { extra: true },
  ])
    expect(() =>
      validateDrainedUpdateTicket({ ...ticket, ...patch }, id, false, original),
    ).toThrow('UPDATE_STATE_UNSAFE');
  expect(
    validateDrainedUpdateTicket(
      { ...ticket, recovery: true, hostPid: 5431, corePid: 5432 },
      id,
      true,
      original,
    ),
  ).toMatchObject({ recovery: true, hostPid: 5431, corePid: 5432 });
});
it('no source-pinned trust means no network discovery, helper launch or installation', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const updater = new DesktopUpdater();
  expect(await updater.check()).toEqual({
    state: 'trust-unconfigured',
    canInstall: false,
    canRecover: false,
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(updater.prepare('0.6.0-dev.1')).rejects.toThrow(
    'UPDATE_CHECK_REQUIRED',
  );
  await expect(
    updater.handoff('00000000-0000-4000-8000-000000000000'),
  ).rejects.toThrow('UPDATE_TRUST_UNCONFIGURED');
  await expect(updater.recoveryRequest()).rejects.toThrow(
    'UPDATE_TRUST_UNCONFIGURED',
  );
});
it('native install confirmation carries only a strict exact release version, never a URL, publisher key or shell', () => {
  expect(
    parseDesktopRequest(
      JSON.stringify({
        v: 1,
        id: 'install',
        type: 'installUpdate',
        version: '0.6.0-dev.1',
      }),
    ),
  ).toMatchObject({ type: 'installUpdate', version: '0.6.0-dev.1' });
  for (const patch of [
    { version: 'latest' },
    { version: '0.6.0;exec' },
    { url: 'https://evil.test' },
    { key: 'untrusted' },
  ]) {
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({
          v: 1,
          id: 'install',
          type: 'installUpdate',
          version: '0.6.0-dev.1',
          ...patch,
        }),
      ),
    ).toThrow('DESKTOP_REQUEST_INVALID');
  }
});
