import { isRuntimeRelativePath } from '@allrice/contracts';
import { LocalCommandError } from './local-command-inputs.js';

const block = 512;
function header(name: string, size: number, type = '0', mode = 0o400) {
  const h = Buffer.alloc(block),
    put = (s: string, start: number, length: number) =>
      h.write(s, start, length, 'utf8');
  put(name, 0, 100);
  put(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put('00000000000\0', 136, 12);
  h.fill(32, 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const sum = h.reduce((s, n) => s + n, 0);
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function entry(name: string, bytes: Buffer, type = '0', mode = 0o400) {
  return [
    header(name, bytes.length, type, mode),
    bytes,
    Buffer.alloc((block - (bytes.length % block)) % block),
  ];
}
function paxPath(path: string) {
  const value = ` path=${path}\n`;
  let length = Buffer.byteLength(value) + 1;
  for (;;) {
    const next = Buffer.byteLength(value) + String(length).length;
    if (next === length) return Buffer.from(`${length}${value}`);
    length = next;
  }
}

/** Only platform-resolved buffers enter this archive. No host filesystem traversal. */
export function createLocalPythonArchive(
  files: { path: string; bytes: Buffer; mode?: number }[],
) {
  const parts: Buffer[] = [];
  for (const [i, file] of files.entries()) {
    if (!isRuntimeRelativePath(file.path))
      throw new LocalCommandError('INPUT_PATH_CHANGED');
    if (Buffer.byteLength(file.path) > 100)
      parts.push(...entry(`PaxHeaders/file${i}`, paxPath(file.path), 'x'));
    parts.push(
      ...entry(
        Buffer.byteLength(file.path) > 100 ? `file${i}` : file.path,
        file.bytes,
        '0',
        file.mode ?? 0o400,
      ),
    );
  }
  parts.push(Buffer.alloc(1024));
  const bytes = Buffer.concat(parts);
  if (bytes.length > 24_000_000) throw new LocalCommandError('INPUT_LIMIT');
  return bytes;
}

/** Docker's one-file archive cannot smuggle another item, link or extraction path. */
export function readLocalPythonArchive(
  bytes: Buffer,
  expectedName: string,
  maximum: number,
) {
  if (!isRuntimeRelativePath(expectedName) || expectedName.includes('/'))
    throw new LocalCommandError('ARTIFACT_PATH_CHANGED');
  let offset = 0,
    pax: string | undefined,
    output: Buffer | undefined;
  const text = (h: Buffer, start: number, length: number) =>
    h
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '')
      .trimEnd();
  while (offset + block <= bytes.length) {
    const h = bytes.subarray(offset, offset + block);
    offset += block;
    if (h.every((n) => n === 0)) {
      if (bytes.subarray(offset).some((n) => n !== 0))
        throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
      if (!output) throw new LocalCommandError('ARTIFACT_MISSING');
      return output;
    }
    const checksum = parseInt(text(h, 148, 8).trim(), 8),
      copy = Buffer.from(h);
    copy.fill(32, 148, 156);
    const rawSize = text(h, 124, 12).trim();
    if (
      !/^[0-7]+$/.test(rawSize) ||
      checksum !== copy.reduce((s, n) => s + n, 0)
    )
      throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
    const size = parseInt(rawSize, 8),
      type = text(h, 156, 1),
      name = text(h, 0, 100),
      prefix = text(h, 345, 155),
      link = text(h, 157, 100);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > (type === 'x' ? 4096 : maximum) ||
      offset + Math.ceil(size / block) * block > bytes.length ||
      link
    )
      throw new LocalCommandError('ARTIFACT_LIMIT');
    const body = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / block) * block;
    if (type === 'x') {
      if (pax || size > 4096)
        throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
      let p = 0;
      while (p < body.length) {
        const space = body.indexOf(32, p),
          length = Number(body.subarray(p, space).toString('ascii'));
        if (
          space < 0 ||
          !Number.isSafeInteger(length) ||
          length < 4 ||
          p + length > body.length ||
          body[p + length - 1] !== 10
        )
          throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
        const record = body
            .subarray(space + 1, p + length - 1)
            .toString('utf8'),
          equal = record.indexOf('='),
          key = record.slice(0, equal);
        if (key === 'path') {
          if (pax) throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
          pax = record.slice(equal + 1);
        } else if (
          !['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(
            key,
          )
        )
          throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
        p += length;
      }
      continue;
    }
    const actual = pax ?? (prefix ? `${prefix}/${name}` : name);
    pax = undefined;
    if (
      !['0', ''].includes(type) ||
      actual !== expectedName ||
      output ||
      size < 1
    )
      throw new LocalCommandError('ARTIFACT_ARCHIVE_INVALID');
    output = Buffer.from(body);
  }
  throw new LocalCommandError('ARTIFACT_ARCHIVE_INCOMPLETE');
}
