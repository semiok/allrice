// Parser/IO fixtures only: no product evidence or external services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import {
  parseJson,
  readSafe,
  safeDirectory,
  safeFile,
} from './internal-evidence-io.mjs';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'met148-io-test-')));
  temporary.push(root);
  writeFileSync(join(root, 'example.json'), '{"observed":true}');
  mkdirSync(join(root, 'observations'));
  return root;
}

test('valid nested JSON and escaped quoted values remain valid', () => {
  const value = { a: [{ x: 1 }, { x: 2 }], b: '"a":0', c: { a: true } };
  assert.deepEqual(parseJson(Buffer.from(JSON.stringify(value))), value);
});

test.each(['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":[{"x":1,"x":2}]}'])(
  'duplicate keys are rejected including escaped and nested aliases: %s',
  (input) => {
    assert.throws(() => parseJson(Buffer.from(input)), /duplicate-json-key/);
  },
);

test('malformed UTF-8 cannot be silently normalized under a reviewed byte pin', () => {
  assert.throws(() => parseJson(Buffer.from([0x22, 0xff, 0x22])));
});

test('regular file reads are bounded and directory checks do not accept files', () => {
  const root = fixture();
  assert.equal(readSafe(root, 'example.json').toString(), '{"observed":true}');
  assert.throws(() => readSafe(root, 'example.json', 1));
  assert.throws(() => safeFile(root, 'observations'));
  assert.throws(() => safeDirectory(root, 'example.json'));
  assert.equal(safeDirectory(root, 'observations'), join(root, 'observations'));
});

test.each([
  '../example.json',
  './example.json',
  '.env',
  'observations//file',
  '/etc/passwd',
  'observations\\file',
])('unsafe evidence path is rejected: %s', (path) => {
  assert.throws(() => readSafe(fixture(), path));
});

test('file, directory, and root symlinks are rejected', () => {
  const root = fixture();
  symlinkSync(join(root, 'example.json'), join(root, 'alias.json'));
  symlinkSync(join(root, 'observations'), join(root, 'alias-dir'));
  symlinkSync(root, join(root, 'alias-root'));
  assert.throws(() => readSafe(root, 'alias.json'));
  assert.throws(() => safeDirectory(root, 'alias-dir'));
  assert.throws(() => readSafe(join(root, 'alias-root'), 'example.json'));
});

test('named pipes are rejected before a potentially blocking open', () => {
  const root = fixture();
  const fifo = join(root, 'not-an-observation');
  const created = spawnSync('mkfifo', [fifo], { timeout: 3000 });
  assert.equal(created.status, 0, 'This Mac/Linux test requires mkfifo.');
  assert.throws(
    () => readSafe(root, 'not-an-observation'),
    /not-bounded-regular-file/,
  );
});
