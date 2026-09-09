import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserProfileSchema } from '@allrice/contracts';
import { startLocalBrowserDriver } from '../src/local-browser-driver.js';
import { LocalBrowserProfiles } from '../src/local-browser-profiles.js';
const root = process.argv[2]!;
let expiry = Number.POSITIVE_INFINITY;
const profile = BrowserProfileSchema.parse({
  version: 1,
  origins: ['https://site.example'],
});
const driver = await startLocalBrowserDriver({
  assertAlive: async () => {
    if (Date.now() >= expiry) throw Error('EXPIRED');
  },
  leaseExpiresAt: () => Math.min(expiry, Date.now() + 4900),
  binding: {
    version: 1,
    scope: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      projectId: null,
    },
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantRevision: 1,
    logicalProfileId: randomUUID(),
    persistLogin: false,
  },
  profiles: new LocalBrowserProfiles(
    join(root, 'config.json'),
    'https://saas.example',
  ),
  options: {
    profileId: randomUUID(),
    profile,
    assertCurrent: async () => {},
    requestStarted: () => () => {},
    requestSent: () => {},
    requestApproval: async () => {
      throw Error('DENIED');
    },
  },
});
const observed = await driver.observe(1);
const children = [];
async function ownedDescendants(
  parent: number,
): Promise<Array<{ pid: number; pgid: number }>> {
  let pids: number[];
  try {
    const result = await promisify(execFile)(
      '/usr/bin/pgrep',
      ['-P', String(parent)],
      { timeout: 2000, maxBuffer: 4096 },
    );
    pids = result.stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
  if (pids.length > 32) throw Error('OWNED_PROCESS_TREE_LIMIT');
  const result = [];
  for (const pid of pids) {
    const info = await promisify(execFile)(
      '/bin/ps',
      ['-p', String(pid), '-o', 'pgid='],
      { timeout: 2000, maxBuffer: 4096 },
    );
    result.push(
      { pid, pgid: Number(info.stdout.trim()) },
      ...(await ownedDescendants(pid)),
    );
  }
  return result;
}
for (const name of await readdir(root)) {
  if (!name.startsWith('allrice-browser-')) continue;
  const directory = join(root, name);
  const status = JSON.parse(
    await readFile(join(directory, 'process.json'), 'utf8'),
  );
  if (status.parentPid !== process.pid || status.stopped)
    throw Error('INVALID_OWNER');
  children.push({
    pid: status.childPid,
    helperPid: status.helperPid,
    userDataDir: join(directory, 'profile'),
    directory,
    nonce: status.nonce,
    descendants: await ownedDescendants(status.childPid),
  });
}
process.stdout.write(
  JSON.stringify({
    ready: true,
    observationUrl: observed.observation.url,
    bytes: observed.screenshot.length,
    children,
  }) + '\n',
);
process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'expire') expiry = Date.now() + 1000;
  if (data.toString().trim() === 'close')
    void driver.close('lost').then(
      () => process.exit(0),
      () => process.exit(2),
    );
});
process.stdin.resume();
