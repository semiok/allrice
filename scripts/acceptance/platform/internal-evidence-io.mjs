// MET-148 read-only, bounded evidence IO. The staging root must be trusted and
// immutable during validation; this is not an openat hostile-filesystem sandbox.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const object = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const sha = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
export const text = (v) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 4096;

export function parseJson(bytes) {
  // Reject invalid UTF-8 instead of silently replacing bytes in a trusted file.
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(source);
  const stack = [];
  for (const token of source.match(
    /"(?:\\.|[^"\\])*"|[{}[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  ) ?? []) {
    const top = stack.at(-1);
    if (token === '{') stack.push({ object: true, key: true, seen: new Set() });
    else if (token === '[') stack.push({ object: false });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.object) top.key = true;
    else if (token.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(token);
      if (top.seen.has(key)) throw new Error('duplicate-json-key');
      top.seen.add(key);
      top.key = false;
    }
  }
  return value;
}

function safePath(root, path, maxBytes, directory) {
  if (
    !text(root) ||
    !isAbsolute(root) ||
    !text(path) ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p.startsWith('.'))
  )
    throw new Error('unsafe-path');
  let ancestor = '/';
  for (const part of resolve(root).split('/').filter(Boolean)) {
    ancestor = join(ancestor, part);
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('unsafe-root');
  }
  let current = resolve(root);
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 || directory
        ? !stat.isDirectory()
        : !stat.isFile() || stat.size > maxBytes)
    )
      throw new Error('not-bounded-regular-file');
  }
  return current;
}

export const safeFile = (root, path, maxBytes = 8 * 1024 * 1024) =>
  safePath(root, path, maxBytes, false);
export const safeDirectory = (root, path) => safePath(root, path, 0, true);

export function readSafe(root, path, maxBytes = 8 * 1024 * 1024) {
  const fd = openSync(
    safeFile(root, path, maxBytes),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('not-bounded-regular-file');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error('file-changed-during-read');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
