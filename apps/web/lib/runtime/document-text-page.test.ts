import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StorageObject, StoragePort } from '@allrice/contracts';
import {
  readDocumentTextPage,
  readDocumentTextPageFromStream,
} from './document-text-page';
import { setImmediate as turn } from 'node:timers/promises';
function fixture(text: string | Buffer, chunk = 79) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const object = {
    sizeBytes: bytes.length,
    checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  } as StorageObject;
  const get = vi.fn(
    async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += chunk)
            controller.enqueue(bytes.subarray(i, i + chunk));
          controller.close();
        },
      }),
  );
  return { object, storage: { get } as unknown as StoragePort };
}
describe('authenticated document text pages', () => {
  it('reads beyond the former 512 KB cap, preserves split UTF-8 and page boundaries', async () => {
    const lines = Array.from(
      { length: 6003 },
      (_, i) => `${i}:${'中文'.repeat(25)}`,
    );
    const { object, storage } = fixture(lines.join('\n') + '\n');
    const first = await readDocumentTextPage(storage, object);
    const next = await readDocumentTextPage(
      storage,
      object,
      first.offset + first.lines,
    );
    expect(first).toMatchObject({ offset: 1, lines: 5000, eof: false });
    expect(next).toMatchObject({ offset: 5001, lines: 1003, eof: true });
    expect(first.text + '\n' + next.text).toBe(lines.join('\n'));
  });
  it.each(['', 'a', 'a\n', '\n', 'a\n\n'])(
    'does not append phantom final lines: %j',
    async (text) => {
      const { object, storage } = fixture(text, 1);
      const page = await readDocumentTextPage(storage, object);
      expect(page.text).toBe(text.endsWith('\n') ? text.slice(0, -1) : text);
      expect(page.eof).toBe(true);
    },
  );
  it('fails if immutable bytes change, even after the requested page', async () => {
    const { object, storage } = fixture('first\n' + 'tail\n'.repeat(5002));
    object.checksum = `sha256:${'a'.repeat(64)}`;
    await expect(readDocumentTextPage(storage, object)).rejects.toThrow(
      'content_changed',
    );
  });
  it.each([Buffer.from([0xff]), Buffer.from('hello\0world')])(
    'rejects binary text',
    async (text) => {
      const { object, storage } = fixture(text);
      await expect(readDocumentTextPage(storage, object)).rejects.toThrow(
        'preview_not_text',
      );
    },
  );
  it('bounds huge lines rather than allocating the full file', async () => {
    const { object, storage } = fixture('x'.repeat(2 * 1024 * 1024 + 1), 64000);
    await expect(readDocumentTextPage(storage, object)).rejects.toThrow(
      'preview_page_too_large',
    );
  });
  it.each([0, -1, 1.5, NaN, Infinity])(
    'rejects invalid page offsets %s',
    async (offset) => {
      const { object, storage } = fixture('line');
      await expect(
        readDocumentTextPage(storage, object, offset),
      ).rejects.toThrow('invalid_page');
      expect(storage.get).not.toHaveBeenCalled();
    },
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('authorized source page cancellation and exact pin', () => {
  it('validates a complete source even for an offset beyond EOF', async () => {
    const bytes = Buffer.from('中文\n第二行\n'),
      object = {
        sizeBytes: bytes.length,
        checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      };
    const open = vi.fn(async () => new Blob([bytes]).stream());
    expect(await readDocumentTextPageFromStream(open, object, 999)).toEqual({
      text: '',
      offset: 999,
      lines: 0,
      eof: true,
    });
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('joins a source open that was already in progress when the page was canceled', async () => {
    const opened = deferred(),
      release = deferred(),
      canceled = deferred(),
      cleanup = deferred(),
      stop = new AbortController();
    const reading = readDocumentTextPageFromStream(
      async () => {
        opened.resolve();
        await release.promise;
        return new ReadableStream({
          cancel() {
            canceled.resolve();
            return cleanup.promise;
          },
        });
      },
      {
        sizeBytes: 0,
        checksum: 'sha256:' + createHash('sha256').digest('hex'),
      },
      1,
      stop.signal,
    );
    let settled = false;
    const result = reading.finally(() => {
      settled = true;
    });
    await opened.promise;
    const reason = Error('page retired');
    stop.abort(reason);
    await turn();
    expect(settled).toBe(false);
    release.resolve();
    await canceled.promise;
    await turn();
    expect(settled).toBe(false);
    cleanup.resolve();
    await expect(result).rejects.toBe(reason);
  });
  it('waits for real cancel on a pending read before reporting request cancellation', async () => {
    const entered = deferred(),
      canceled = deferred(),
      cleanup = deferred(),
      stop = new AbortController();
    const result = readDocumentTextPageFromStream(
      async () =>
        new ReadableStream({
          pull() {
            entered.resolve();
          },
          cancel() {
            canceled.resolve();
            return cleanup.promise;
          },
        }),
      { sizeBytes: 1, checksum: 'sha256:' + 'a'.repeat(64) },
      1,
      stop.signal,
    );
    let settled = false;
    const observed = result.finally(() => {
      settled = true;
    });
    await entered.promise;
    stop.abort(Error('request closed'));
    await canceled.promise;
    await turn();
    expect(settled).toBe(false);
    cleanup.resolve();
    await expect(observed).rejects.toThrow('request closed');
  });
  it('preserves binary-source failure and a source cleanup rejection together', async () => {
    const bytes = Buffer.from('binary\0text'),
      cleanup = Error('cancel failed');
    const error: unknown = await readDocumentTextPageFromStream(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
          },
          cancel: async () => {
            throw cleanup;
          },
        }),
      {
        sizeBytes: bytes.length,
        checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      },
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String((error as AggregateError).cause)).toContain(
      'preview_not_text',
    );
    expect((error as AggregateError).errors).toContain(cleanup);
  });
  it('rejects a changed checksum outside the selected page instead of changing revision', async () => {
    const bytes = Buffer.from('one\n' + 'tail\n'.repeat(5001));
    await expect(
      readDocumentTextPageFromStream(
        async () => new Blob([bytes]).stream(),
        { sizeBytes: bytes.length, checksum: 'sha256:' + 'b'.repeat(64) },
        1,
      ),
    ).rejects.toThrow('content_changed');
  });
});
