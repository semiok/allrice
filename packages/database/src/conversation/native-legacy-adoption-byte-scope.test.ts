import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyLegacyAdoptionNativeByteFile } from './native-legacy-adoption.ts';

const roots: string[] = [];
const id = 'dsh-68e76b6b-2e75-45b7-b628-951945b12044';
const data = Buffer.from('owned synthetic attachment; no SDK/DB');
const sha = createHash('sha256').update(data).digest('hex');
function setup() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'allrice-adoption-byte-')),
  );
  roots.push(root);
  const scope = 'org/workspace/owner/chat';
  const source = join(root, 'source', scope, 'sessions');
  const target = join(root, 'target', scope, 'sessions');
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  return { root, source, target };
}
function make(namespace: string, selectedPath?: string) {
  const p =
    selectedPath ??
    join(dirname(namespace), 'attachments/v1/objects', sha.slice(0, 2), sha);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return {
    role: 'native_attachment' as const,
    nativeSessionId: id,
    pin: { path: p, sha256: sha, bytes: data.length },
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe('legacy adoption exact SDK sibling attachment layout', () => {
  it('accepts source and target own SDK hash paths; the old sessions-only predicate rejects this real layout', () => {
    const { source, target } = setup();
    for (const ns of [source, target]) {
      const file = make(ns);
      expect(file.pin.path.startsWith(ns + '/')).toBe(false);
      expect(() =>
        verifyLegacyAdoptionNativeByteFile(file, ns, id),
      ).not.toThrow();
    }
  });
  it('retains primary journal scope below the reviewed sessions namespace', () => {
    const { source } = setup();
    const file = {
      ...make(source, join(source, 'project', id, 'session.v3.jsonl')),
      role: 'journal' as const,
    };
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(file, source, id),
    ).not.toThrow();
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(
        { ...file, role: 'native_attachment' },
        source,
        id,
      ),
    ).toThrow('FILE_SCOPE');
  });
  it.each([
    'arbitrary.bin',
    'attachments/v1/other.bin',
    'attachments/v1/objects/xx/' + sha,
    'attachments/v1/objects/' + sha.slice(0, 2) + '/wronghash',
    'sessions/native-image.bin',
  ])('does not allow parent/sessions fallback: %s', (relative) => {
    const { source } = setup();
    const file = make(source, join(dirname(source), relative));
    expect(() => verifyLegacyAdoptionNativeByteFile(file, source, id)).toThrow(
      'FILE_SCOPE',
    );
  });
  it('refuses a source blob offered as target, and another owner/chat even with the same bytes', () => {
    const { source, target, root } = setup();
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(make(source), target, id),
    ).toThrow('FILE_SCOPE');
    const other = join(
      root,
      'source/org/workspace/another-owner/another-chat/sessions',
    );
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(make(other), source, id),
    ).toThrow('FILE_SCOPE');
  });
  it('refuses a normalized traversal spelling and a different native ID', () => {
    const { source } = setup();
    const file = make(source);
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(
        {
          ...file,
          pin: {
            ...file.pin,
            path: dirname(file.pin.path) + '/../' + sha.slice(0, 2) + '/' + sha,
          },
        },
        source,
        id,
      ),
    ).toThrow('FILE_SCOPE');
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(
        { ...file, nativeSessionId: 'dsh-another' },
        source,
        id,
      ),
    ).toThrow('FILE_SCOPE');
  });
  it('refuses checksum or byte-length drift at the otherwise exact SDK path', () => {
    const { source } = setup();
    const file = make(source);
    expect(() =>
      verifyLegacyAdoptionNativeByteFile(
        { ...file, pin: { ...file.pin, bytes: data.length + 1 } },
        source,
        id,
      ),
    ).toThrow('BYTE_DRIFT');
    writeFileSync(file.pin.path, Buffer.from('changed bytes'));
    expect(() => verifyLegacyAdoptionNativeByteFile(file, source, id)).toThrow(
      'BYTE_DRIFT',
    );
  });
  it('refuses a canonical path whose file is a symlink even to identical bytes', () => {
    const { source, target } = setup();
    const file = make(source),
      other = make(target);
    rmSync(file.pin.path);
    symlinkSync(other.pin.path, file.pin.path);
    expect(() => verifyLegacyAdoptionNativeByteFile(file, source, id)).toThrow(
      'BYTE_PATH',
    );
  });
  it('refuses a symlink in the attachment directory ancestry', () => {
    const { source, target } = setup();
    const other = make(target);
    symlinkSync(
      join(dirname(target), 'attachments'),
      join(dirname(source), 'attachments'),
    );
    const file = {
      ...other,
      pin: {
        ...other.pin,
        path: join(
          dirname(source),
          'attachments/v1/objects',
          sha.slice(0, 2),
          sha,
        ),
      },
    };
    expect(() => verifyLegacyAdoptionNativeByteFile(file, source, id)).toThrow(
      'BYTE_PATH',
    );
  });
});
