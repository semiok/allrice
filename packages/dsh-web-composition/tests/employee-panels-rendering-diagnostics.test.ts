// Pure public CDPSession doubles. No browser, Host, network or product is started.
import type { CDPSession } from 'playwright-core';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { readPanelsRenderingDiagnostics } from './employee-panels-rendering-diagnostics';

const confirmedRefusal =
  'cdpSession.send: Protocol error (Browser.getBrowserCommandLine): Command line not returned because --enable-automation not set.';
const system = {
  gpu: { devices: [{ vendorId: 0, deviceId: 0 }] },
  modelName: 'synthetic CDP unit fixture',
  modelVersion: '',
  commandLine: '',
};
const commandLine = { arguments: ['unchanged', 'synthetic'] };
const session = () => ({
  // Vitest's Mock flattens generic return types; retain the public CDP signature.
  send: vi.fn<CDPSession['send']>() as CDPSession['send'] &
    Mock<CDPSession['send']>,
  detach: vi.fn(async () => {}),
});

describe('optional panels rendering diagnostics', () => {
  it('preserves both successful public protocol responses and detaches', async () => {
    const cdp = session();
    cdp.send.mockResolvedValueOnce(system).mockResolvedValueOnce(commandLine);
    const result = await readPanelsRenderingDiagnostics(cdp);
    expect(result).toEqual({
      system,
      commandLine: { available: true, result: commandLine },
    });
    expect(cdp.send.mock.calls).toEqual([
      ['SystemInfo.getInfo'],
      ['Browser.getBrowserCommandLine'],
    ]);
    expect(cdp.detach).toHaveBeenCalledExactlyOnceWith();
  });

  it('retains SystemInfo plus the exact observed refusal as unavailable and detaches', async () => {
    const cdp = session(),
      refusal = new Error(confirmedRefusal);
    cdp.send.mockResolvedValueOnce(system).mockRejectedValueOnce(refusal);
    const result = await readPanelsRenderingDiagnostics(cdp);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      system,
      commandLine: {
        available: false,
        error: {
          name: refusal.name,
          message: refusal.message,
          stack: refusal.stack,
        },
      },
    });
    expect(cdp.detach).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    new Error(
      'cdpSession.send: Protocol error (Browser.getBrowserCommandLine): Access denied.',
    ),
    new Error(confirmedRefusal + ' Unexpected suffix.'),
    new Error(
      'cdpSession.send: Protocol error (SystemInfo.getInfo): Command line not returned because --enable-automation not set.',
    ),
    new TypeError(confirmedRefusal),
    confirmedRefusal,
  ])(
    'rethrows an unknown command-line rejection unchanged and detaches: %s',
    async (failure) => {
      const cdp = session();
      cdp.send.mockResolvedValueOnce(system).mockRejectedValueOnce(failure);
      await expect(readPanelsRenderingDiagnostics(cdp)).rejects.toBe(failure);
      expect(cdp.detach).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it.each([
    new Error(confirmedRefusal),
    new Error('actual SystemInfo target closed'),
  ])('never treats a SystemInfo failure as optional: %s', async (failure) => {
    const cdp = session();
    cdp.send.mockRejectedValueOnce(failure);
    await expect(readPanelsRenderingDiagnostics(cdp)).rejects.toBe(failure);
    expect(cdp.send.mock.calls).toEqual([['SystemInfo.getInfo']]);
    expect(cdp.detach).toHaveBeenCalledExactlyOnceWith();
  });

  it('does not swallow a session detach failure', async () => {
    const cdp = session(),
      failure = new Error('actual detach failure');
    cdp.send.mockResolvedValueOnce(system).mockResolvedValueOnce(commandLine);
    cdp.detach.mockRejectedValueOnce(failure);
    await expect(readPanelsRenderingDiagnostics(cdp)).rejects.toBe(failure);
  });
});
