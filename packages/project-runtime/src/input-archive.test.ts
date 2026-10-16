import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bufferedInput, createInputArchive } from './input-archive.js';
import type { RuntimeInputSource } from '@allrice/contracts';

describe('immutable input streaming', () => {
  it('streams past the old JSON/archive/tmpfs boundaries without opening files eagerly', async () => {
    const chunk = Buffer.alloc(65536, 120),
      count = 640;
    const hash = createHash('sha256');
    for (let i = 0; i < count; i++) hash.update(chunk);
    let opened = 0,
      reads = 0,
      canceled = false;
    const file: RuntimeInputSource = {
      path: 'data.csv',
      sizeBytes: chunk.length * count,
      checksum: `sha256:${hash.digest('hex')}`,
      async open() {
        opened++;
        return new ReadableStream({
          pull(c) {
            if (reads++ < count) c.enqueue(chunk);
            else c.close();
          },
          cancel() {
            canceled = true;
          },
        });
      },
    };
    const archive = createInputArchive([file], new AbortController().signal);
    expect(opened).toBe(0);
    let bytes = 0,
      largest = 0;
    for await (const next of archive.stream) {
      bytes += next.length;
      largest = Math.max(largest, next.length);
    }
    expect(bytes).toBe(archive.size);
    expect(largest).toBeLessThan(1024 * 1024);
    expect(opened).toBe(1);
    expect(canceled).toBe(false);
  });
  it('produces an interoperable archive with nested Chinese paths and exact bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-input-tar-'));
    const path = 'input/' + '资料'.repeat(24) + '/数据.csv',
      bytes = Buffer.from('姓名,金额\n匿名,112\n');
    try {
      const archive = createInputArchive(
        [bufferedInput(path, bytes)],
        new AbortController().signal,
      );
      const chunks = [];
      for await (const chunk of archive.stream) chunks.push(chunk);
      const tar = join(directory, 'input.tar');
      await writeFile(tar, Buffer.concat(chunks));
      expect(execFileSync('tar', ['-xOf', tar, path])).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['size', 'checksum'])(
    'refuses corrupted %s before a complete tar can be acknowledged',
    async (defect) => {
      const file = bufferedInput('data', Buffer.from('original'));
      if (defect === 'size') file.sizeBytes++;
      else file.checksum = 'sha256:' + '0'.repeat(64);
      const archive = createInputArchive([file], new AbortController().signal);
      await expect(
        (async () => {
          for await (const chunk of archive.stream) void chunk;
        })(),
      ).rejects.toThrow('INPUT_VERSION_CHANGED');
    },
  );
  it('cancels a stalled source and releases its reader', async () => {
    const controller = new AbortController();
    let canceled = false;
    const file = bufferedInput('data', Buffer.from('a'));
    file.open = async () =>
      new ReadableStream({
        pull() {},
        cancel() {
          canceled = true;
        },
      });
    const archive = createInputArchive([file], controller.signal);
    const task = (async () => {
      for await (const chunk of archive.stream) {
        void chunk;
        setTimeout(() => controller.abort(), 5);
      }
    })();
    await expect(task).rejects.toThrow();
    expect(canceled).toBe(true);
  });
  it('rejects traversal, duplicates and file/directory collisions', () => {
    for (const paths of [['../secret'], ['x', 'x'], ['x', 'x/y']])
      expect(() =>
        createInputArchive(
          paths.map((p) => bufferedInput(p, Buffer.from('x'))),
          new AbortController().signal,
        ),
      ).toThrow('INPUT_PATH_CHANGED');
  });
});
