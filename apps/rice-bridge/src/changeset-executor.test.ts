import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  mkdir,
  link,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type RuntimeChangeset,
  type ChangesetFileResult,
  RuntimeBridgeDispatchSchema,
} from '@allrice/contracts';
import {
  executeChangeset,
  initialChangesetResults,
} from './changeset-executor.js';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { journalDispatch } from './journal-fixtures.js';

const roots: string[] = [];
async function folder() {
  const p = await mkdtemp(join(tmpdir(), 'allrice-p08-files-'));
  roots.push(p);
  return p;
}
afterEach(async () => {
  for (const p of roots.splice(0))
    await rm(p, { recursive: true, force: true });
});
const text = (s: string) => ({
  text: s,
  checksum: `sha256:${createHash('sha256').update(s).digest('hex')}`,
});
const payload = (
  files: RuntimeChangeset['arguments']['files'],
): RuntimeChangeset => ({
  capability: 'local.fs.changeset',
  arguments: {
    path: '.',
    artifactId: randomUUID(),
    checksum: text('proposal').checksum,
    direction: 'apply',
    files,
  },
});
const check = async () => true;
const noop = async () => {};
describe('P08 real filesystem changesets', () => {
  it('creates, updates and deletes exact files and reverses confirmed results', async () => {
    const root = await folder();
    await writeFile(join(root, 'edit.txt'), 'old');
    await writeFile(join(root, 'remove.txt'), 'remove');
    const input = payload([
      { path: 'new.txt', before: null, after: text('new') },
      { path: 'edit.txt', before: text('old'), after: text('revised') },
      { path: 'remove.txt', before: text('remove'), after: null },
    ]);
    const seen: ChangesetFileResult[] = [];
    const result = await executeChangeset(root, input, {
      authorize: check,
      checkpoint: async (_, r) => {
        seen.push(r);
      },
    });
    expect(result.files.map((f) => f.status)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(seen.map((f) => f.status)).toEqual([
      'prepared',
      'applied',
      'prepared',
      'applied',
      'prepared',
      'applied',
    ]);
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('revised');
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new');
    await expect(lstat(join(root, 'remove.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const inverse = payload(
      [...input.arguments.files]
        .reverse()
        .map((f) => ({ path: f.path, before: f.after, after: f.before })),
    );
    inverse.arguments.direction = 'restore';
    expect(
      (
        await executeChangeset(root, inverse, {
          authorize: check,
          checkpoint: noop,
        })
      ).files.every((f) => f.status === 'applied'),
    ).toBe(true);
    expect(await readFile(join(root, 'edit.txt'), 'utf8')).toBe('old');
    expect(await readFile(join(root, 'remove.txt'), 'utf8')).toBe('remove');
    await expect(lstat(join(root, 'new.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('preflights all baselines before writing and rejects tampered after bytes', async () => {
    const root = await folder();
    await writeFile(join(root, 'b.txt'), 'user edit');
    const input = payload([
      { path: 'a.txt', before: null, after: text('a') },
      { path: 'b.txt', before: text('old'), after: text('new') },
    ]);
    const result = await executeChangeset(root, input, {
      authorize: check,
      checkpoint: noop,
    });
    expect(result.files.map((f) => f.status)).toEqual(['pending', 'conflict']);
    await expect(lstat(join(root, 'a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    input.arguments.files[0]!.after!.text = 'tampered';
    expect(
      (
        await executeChangeset(root, input, {
          authorize: check,
          checkpoint: noop,
        })
      ).files[0]?.status,
    ).toBe('conflict');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('user edit');
  });
  it('stops on a between-file conflict and preserves already-applied evidence', async () => {
    const root = await folder();
    await writeFile(join(root, 'b.txt'), 'old');
    const input = payload([
      { path: 'a.txt', before: null, after: text('a') },
      { path: 'b.txt', before: text('old'), after: text('new') },
      { path: 'c.txt', before: null, after: text('c') },
    ]);
    const result = await executeChangeset(root, input, {
      authorize: check,
      checkpoint: async (i, r) => {
        if (i === 0 && r.status === 'applied')
          await writeFile(join(root, 'b.txt'), 'user edit');
      },
    });
    expect(result.files.map((f) => f.status)).toEqual([
      'applied',
      'conflict',
      'pending',
    ]);
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('user edit');
    await expect(lstat(join(root, 'c.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('revocation before commit prevents a staged write; cancellation stops remaining files', async () => {
    const root = await folder(),
      input = payload([
        { path: 'a', before: null, after: text('a') },
        { path: 'b', before: null, after: text('b') },
      ]);
    let calls = 0;
    const revoked = await executeChangeset(root, input, {
      checkpoint: noop,
      authorize: async () => ++calls < 2,
    });
    expect(revoked.files.map((f) => f.status)).toEqual(['conflict', 'pending']);
    await expect(lstat(join(root, 'a'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    calls = 0;
    const partial = await executeChangeset(root, input, {
      checkpoint: noop,
      authorize: async () => ++calls < 3,
    });
    expect(partial.files.map((f) => f.status)).toEqual(['applied', 'canceled']);
    expect(await readFile(join(root, 'a'), 'utf8')).toBe('a');
    await expect(lstat(join(root, 'b'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('restore refuses new user edits including a file that was newly created', async () => {
    const root = await folder();
    await writeFile(join(root, 'created'), 'user changed it');
    const inverse = payload([
      { path: 'created', before: text('original created bytes'), after: null },
    ]);
    expect(
      (
        await executeChangeset(root, inverse, {
          authorize: check,
          checkpoint: noop,
        })
      ).files[0]?.status,
    ).toBe('conflict');
    expect(await readFile(join(root, 'created'), 'utf8')).toBe(
      'user changed it',
    );
  });
  it('rejects symlinks, hardlinks, secrets and directory deletion', async () => {
    const root = await folder(),
      outside = await folder();
    await writeFile(join(outside, 'data'), 'safe');
    await mkdir(join(root, 'directory'));
    await symlink(outside, join(root, 'linked'));
    await link(join(outside, 'data'), join(root, 'hard'));
    for (const path of ['linked/data', 'hard', '.env', 'directory']) {
      const result = await executeChangeset(
        root,
        payload([{ path, before: text('safe'), after: text('bad') }]),
        { authorize: check, checkpoint: noop },
      );
      expect(result.files[0]?.status).toBe('conflict');
    }
    expect(await readFile(join(outside, 'data'), 'utf8')).toBe('safe');
  });
  it('SIGKILL after one committed file and a second prepared checkpoint recovers without repeating writes', async () => {
    const parent = await folder(),
      original = journalDispatch(parent);
    const input = payload([
      { path: 'a', before: null, after: text('a') },
      { path: 'b', before: null, after: text('b') },
      { path: 'c', before: null, after: text('c') },
    ]);
    const dispatch = RuntimeBridgeDispatchSchema.parse({
      ...original,
      payload: input,
      snapshot: {
        ...original.snapshot,
        binding: {
          ...original.snapshot.binding,
          action: input.capability,
          inputDigest: bridgeDigest(input),
        },
      },
    });
    const config = {
      directory: join(parent, 'journal'),
      server: 'https://synthetic.invalid',
      deviceId: dispatch.snapshot.binding.execution.deviceId!,
    };
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      const {BridgeJournal}=await import(${JSON.stringify(new URL('./journal.ts', import.meta.url).href)});
      const {executeChangeset}=await import(${JSON.stringify(new URL('./changeset-executor.ts', import.meta.url).href)});
      const journal=await BridgeJournal.open(${JSON.stringify(config)}),dispatch=${JSON.stringify(dispatch)};
      const op=dispatch.snapshot.binding.attempt.operationId;await journal.receive(dispatch);await journal.begin(op);
      await executeChangeset(${JSON.stringify(parent)},dispatch.payload,{authorize:async()=>true,checkpoint:async(i,r)=>{await journal.changesetCheckpoint(op,i,r);if(i===1&&r.status==='prepared'){process.stdout.write('prepared\\n');await new Promise(()=>{setInterval(()=>{},1000);});}}});
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL('../../../tsconfig.base.json', import.meta.url),
          ),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('exit', (code) => reject(Error(`child ${code}: ${stderr}`)));
      });
      await expect(BridgeJournal.open(config)).rejects.toThrow(/locked/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const journal = await BridgeJournal.open(config);
      try {
        const receipt = (await journal.pending())[0]!;
        expect(
          (
            receipt.evidence?.output as { files: ChangesetFileResult[] }
          ).files.map((f) => f.status),
        ).toEqual(['applied', 'unknown', 'pending']);
        expect(await journal.receive(dispatch)).toBe('duplicate');
        await expect(
          journal.begin(dispatch.snapshot.binding.attempt.operationId),
        ).rejects.toThrow('JOURNAL_EXECUTION_ALREADY_CLAIMED');
      } finally {
        await journal.close();
      }
      expect(await readFile(join(parent, 'a'), 'utf8')).toBe('a');
      await expect(readFile(join(parent, 'b'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(parent, 'c'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 20000);
  it('cold journal retains exact partial/unknown file checkpoints without replay', async () => {
    const parent = await folder(),
      original = journalDispatch(parent);
    const input = payload([
      { path: 'a', before: null, after: text('a') },
      { path: 'b', before: null, after: text('b') },
      { path: 'c', before: null, after: text('c') },
    ]);
    const dispatch = RuntimeBridgeDispatchSchema.parse({
      ...original,
      payload: input,
      snapshot: {
        ...original.snapshot,
        binding: {
          ...original.snapshot.binding,
          action: input.capability,
          inputDigest: bridgeDigest(input),
        },
      },
    });
    const config = {
      directory: join(parent, 'journal'),
      server: 'https://synthetic.invalid',
      deviceId: dispatch.snapshot.binding.execution.deviceId!,
    };
    let journal = await BridgeJournal.open(config);
    const op = dispatch.snapshot.binding.attempt.operationId;
    await journal.receive(dispatch);
    await journal.begin(op);
    const initial = initialChangesetResults(input);
    await journal.changesetCheckpoint(op, 0, {
      ...initial[0]!,
      status: 'prepared',
    });
    await journal.changesetCheckpoint(op, 0, {
      ...initial[0]!,
      status: 'applied',
    });
    await journal.changesetCheckpoint(op, 1, {
      ...initial[1]!,
      status: 'prepared',
    });
    await journal.close();
    journal = await BridgeJournal.open(config);
    try {
      const receipt = (await journal.pending())[0]!;
      expect(receipt.signal.type).toBe('operation.uncertain');
      expect(
        (
          receipt.evidence?.output as { files: ChangesetFileResult[] }
        ).files.map((f) => f.status),
      ).toEqual(['applied', 'unknown', 'pending']);
      expect(await journal.receive(dispatch)).toBe('duplicate');
    } finally {
      await journal.close();
    }
  });
});
