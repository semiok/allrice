import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalBrowserSupervisor } from './local-browser-supervisor.js';
import { writeCredentialRecordFile } from './credential-files.js';

const roots: string[] = [];
const supervisors: Awaited<ReturnType<typeof startLocalBrowserSupervisor>>[] =
  [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0))
    await supervisor.stop().catch(() => undefined);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'allrice-browser-unit-'));
  roots.push(directory);
  let allowed = true;
  const expiresAt = Date.now() + 4500;
  const supervisor = await startLocalBrowserSupervisor({
    directory,
    proxyPort: 39999,
    assertAlive: async () => {
      if (!allowed) throw Error('LOST');
    },
    expiresAt: () => expiresAt,
  });
  supervisors.push(supervisor);
  return {
    directory,
    supervisor,
    expiresAt,
    disable: () => {
      allowed = false;
    },
  };
}
describe('P22 private watchdog lease mirror, not an offline authority', () => {
  it('never extends the server deadline and records explicit local stop', async () => {
    const { directory, supervisor, expiresAt } = await fixture();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const lease = JSON.parse(
      await readFile(join(directory, 'lease.json'), 'utf8'),
    );
    expect(lease).toMatchObject({
      version: 1,
      parentPid: process.pid,
      expiresAt,
      stop: false,
    });
    await supervisor.stop();
    expect(
      JSON.parse(await readFile(join(directory, 'lease.json'), 'utf8')),
    ).toMatchObject({ expiresAt, stop: true });
  });
  it('an opt-out or lost pairing stops refresh rather than renewing a lease', async () => {
    const { directory, disable } = await fixture();
    disable();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      JSON.parse(await readFile(join(directory, 'lease.json'), 'utf8')).stop,
    ).toBe(true);
  });
  it('does not treat absent, wrong-identity or still-live process receipts as cleanup success', async () => {
    const { directory, supervisor } = await fixture();
    expect(await supervisor.confirmed()).toBe(false);
    const lease = JSON.parse(
      await readFile(join(directory, 'lease.json'), 'utf8'),
    );
    for (const value of [
      {
        version: 1,
        nonce: randomUUID(),
        parentPid: process.pid,
        childPid: process.pid,
        stopped: true,
      },
      {
        version: 1,
        nonce: lease.nonce,
        parentPid: process.pid + 1,
        childPid: process.pid,
        stopped: true,
      },
      {
        version: 1,
        nonce: lease.nonce,
        parentPid: process.pid,
        childPid: process.pid,
        stopped: true,
      },
      {
        version: 1,
        nonce: lease.nonce,
        parentPid: process.pid,
        childPid: 1,
        stopped: true,
      },
    ]) {
      await writeCredentialRecordFile(
        directory,
        'process.json',
        JSON.stringify(value),
      );
      expect(await supervisor.confirmed()).toBe(false);
    }
    await chmod(join(directory, 'process.json'), 0o644);
    await expect(supervisor.confirmed()).rejects.toThrow(
      'BRIDGE_CREDENTIAL_FILE_UNSAFE',
    );
  });
  it('rejects a locally invented lease longer than 5 seconds before writing or spawning anything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-browser-unit-'));
    roots.push(directory);
    await expect(
      startLocalBrowserSupervisor({
        directory,
        proxyPort: 39999,
        assertAlive: async () => {},
        expiresAt: () => Date.now() + 10000,
      }),
    ).rejects.toThrow('LOCAL_BROWSER_LEASE_LOST');
    await expect(readFile(join(directory, 'lease.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
});
