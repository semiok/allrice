import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  isRuntimeRelativePath,
  type RuntimeInputSource,
} from '@allrice/contracts';

const block = 512;
function header(path: string, size: number, type = '0', mode = 0o444) {
  const h = Buffer.alloc(block);
  const put = (s: string, at: number, n: number) => h.write(s, at, n, 'utf8');
  put(path, 0, 100);
  put(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  // PAX carries sizes that do not fit the ustar field.
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put('00000000000\0', 136, 12);
  h.fill(32, 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(
    h
      .reduce((sum, n) => sum + n, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    8,
  );
  return h;
}
function pax(key: string, value: string) {
  const record = ` ${key}=${value}\n`;
  let size = Buffer.byteLength(record) + 1;
  for (;;) {
    const next = Buffer.byteLength(record) + String(size).length;
    if (next === size) return Buffer.from(`${size}${record}`);
    size = next;
  }
}
const padding = (size: number) => (block - (size % block)) % block;

export function bufferedInput(path: string, bytes: Buffer): RuntimeInputSource {
  return {
    path,
    sizeBytes: bytes.length,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    async open(signal) {
      signal.throwIfAborted();
      return new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      });
    },
  };
}

/** A bounded-memory tar producer. The start/control message must be sent only
 * after the daemon acknowledges the entire verified archive. Partial or corrupt
 * transfers therefore never execute tenant code. */
export function createInputArchive(
  files: RuntimeInputSource[],
  signal: AbortSignal,
  onRead?: (bytes: number) => void,
) {
  const paths = files.map((f) => f.path);
  if (
    paths.some(
      (p) =>
        !isRuntimeRelativePath(p) ||
        paths.some((q) => q !== p && q.startsWith(p + '/')),
    ) ||
    new Set(paths).size !== paths.length
  )
    throw Error('INPUT_PATH_CHANGED');
  const entries = files.map((file, index) => {
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(file.checksum)
    )
      throw Error('INPUT_VERSION_CHANGED');
    const records = [
      ...(Buffer.byteLength(file.path) > 100 ? [pax('path', file.path)] : []),
      ...(file.sizeBytes > 0o77777777777
        ? [pax('size', String(file.sizeBytes))]
        : []),
    ];
    const metadata = records.length ? Buffer.concat(records) : null;
    const prefix = metadata
      ? [
          header(`PaxHeaders/file${index}`, metadata.length, 'x'),
          metadata,
          Buffer.alloc(padding(metadata.length)),
        ]
      : [];
    prefix.push(
      header(
        Buffer.byteLength(file.path) > 100 ? `file${index}` : file.path,
        file.sizeBytes > 0o77777777777 ? 0 : file.sizeBytes,
      ),
    );
    return { file, prefix };
  });
  const size = entries.reduce(
    (n, { file, prefix }) =>
      n +
      prefix.reduce((s, b) => s + b.length, 0) +
      file.sizeBytes +
      padding(file.sizeBytes),
    1024,
  );
  if (!Number.isSafeInteger(size)) throw Error('INPUT_VERSION_CHANGED');
  async function* chunks() {
    for (const { file, prefix } of entries) {
      signal.throwIfAborted();
      yield* prefix;
      const reader = (await file.open(signal)).getReader();
      const abort = () => {
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      const hash = createHash('sha256');
      let received = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          received += next.value.length;
          if (received > file.sizeBytes) throw Error('INPUT_VERSION_CHANGED');
          hash.update(next.value);
          onRead?.(next.value.length);
          yield next.value;
        }
        if (
          received !== file.sizeBytes ||
          `sha256:${hash.digest('hex')}` !== file.checksum
        )
          throw Error('INPUT_VERSION_CHANGED');
      } finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      yield Buffer.alloc(padding(file.sizeBytes));
    }
    signal.throwIfAborted();
    yield Buffer.alloc(1024);
  }
  return { size, stream: Readable.from(chunks(), { objectMode: false }) };
}
