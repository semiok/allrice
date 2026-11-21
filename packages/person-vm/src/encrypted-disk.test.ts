import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ApfsPersonVmDisk, FilePersonVmKeyStore } from './encrypted-disk.ts';
import type { Command, CommandRunner } from './process.ts';
import { signal } from './test-support.ts';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ar-disk-')));
  temporary.push(path);
  return path;
}
const hash = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');

describe('APFS adapter protocol and private filesystem (not actual encryption acceptance)', () => {
  it('key仅stdin、AES-256参数、停止后挂卸/冷盘移动/重开保留同字节', async () => {
    const root = await directory(),
      volume = join(root, 'volume'),
      keyRoot = join(root, 'keys');
    const keys = new FilePersonVmKeyStore(keyRoot),
      ref = { vmId: randomUUID(), tier: 'warm' as const };
    const calls: Command[] = [],
      attachments = new Map<string, string>();
    let inputCount = 0;
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      const args = command.args;
      if (command.executable === '/usr/bin/plutil')
        return Buffer.from(command.input!).toString();
      if (args[0] === 'info')
        return JSON.stringify({
          images: [...attachments].map(([image, mount]) => ({
            'image-path': image,
            'system-entities': [{ 'mount-point': mount }],
          })),
        });
      if (args[0] === 'create' || args[0] === 'attach') {
        expect(command.input?.at(-1)).toBe(0);
        expect(command.input?.length).toBe(97);
        inputCount += 1;
        const secret = Buffer.from(command.input!.subarray(0, -1)).toString();
        expect(JSON.stringify(args)).not.toContain(secret);
        expect(JSON.stringify(command.env)).not.toContain(secret);
        if (args[0] === 'create')
          await writeFile(args.at(-1)!, 'synthetic-not-encrypted-image');
        else attachments.set(args[1]!, args[args.indexOf('-mountpoint') + 1]!);
      }
      if (args[0] === 'detach')
        for (const [image, mount] of attachments)
          if (mount === args[1]) attachments.delete(image);
      return '';
    };
    const disk = new ApfsPersonVmDisk({
      root: volume,
      keys,
      capacityGiB: 40,
      runner,
    });
    await disk.create(ref, signal());
    const image = join(volume, 'warm', ref.vmId + '.sparseimage');
    expect((await lstat(image)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(keyRoot, ref.vmId + '.key'))).mode & 0o777).toBe(
      0o600,
    );
    const original = hash(await readFile(image));
    await disk.attach(ref, signal());
    await expect(disk.move(ref, 'cold', signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(disk.delete(ref, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await disk.detach(ref, signal());
    const cold = await disk.move(ref, 'cold', signal());
    await disk.attach(cold, signal());
    await disk.detach(cold, signal());
    const warm = await disk.move(cold, 'warm', signal());
    expect(hash(await readFile(image))).toBe(original);
    expect(inputCount).toBe(3);
    const create = calls.find((call) => call.args[0] === 'create')!;
    expect(create.args).toEqual(
      expect.arrayContaining([
        '-encryption',
        'AES-256',
        '-fs',
        'APFS',
        '-stdinpass',
      ]),
    );
    expect(create.input?.every((byte) => byte === 0)).toBe(true);
    await disk.delete(warm, signal());
    await disk.delete(warm, signal());
    await expect(keys.read(ref.vmId)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keystore拒绝软链和路径穿越，不覆写已存在盘', async () => {
    const root = await directory(),
      keyRoot = join(root, 'keys');
    const keys = new FilePersonVmKeyStore(keyRoot),
      vmId = randomUUID();
    const first = await keys.readOrCreate(vmId);
    const second = await keys.readOrCreate(vmId);
    expect(hash(first)).toBe(hash(second));
    first.fill(0);
    second.fill(0);
    await expect(keys.read('../not-owned')).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    const other = randomUUID();
    await symlink(join(keyRoot, vmId + '.key'), join(keyRoot, other + '.key'));
    await expect(keys.read(other)).rejects.toBeDefined();
    const volume = join(root, 'volume');
    const disk = new ApfsPersonVmDisk({
      root: volume,
      keys,
      capacityGiB: 40,
      runner: async (command) => {
        await writeFile(command.args.at(-1)!, 'fixture');
        return '';
      },
    });
    const ref = { vmId, tier: 'warm' as const };
    await disk.create(ref, signal());
    await expect(disk.create(ref, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
  });
});
