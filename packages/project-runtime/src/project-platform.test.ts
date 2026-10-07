import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { expect, it } from 'vitest';
import { projectFixture } from '../../../apps/rice-bridge/test/project-fixture.js';
import {
  projectDependencyIndexes,
  projectSourceDigest,
  projectInstallLock,
} from './project-preparation.js';
const hash = (s: Buffer) =>
  'sha256:' + createHash('sha256').update(s).digest('hex');
function fixture(optional = true) {
  const f = projectFixture('pnpm');
  const s = f.command.arguments.projectPreparation!;
  const lock = parseDocument(f.files['pnpm-lock.yaml']!.toString()).toJS();
  for (const [name, cpu, os, libc] of [
    ['@qa/native-x64', 'x64', 'linux', 'glibc'],
    ['@qa/native-arm64', 'arm64', 'linux', 'glibc'],
    ['@qa/darwin', 'x64', 'darwin', undefined],
    ['@qa/musl', 'x64', 'linux', 'musl'],
  ] as const) {
    const key = name + '@1.0.0';
    lock.packages[key] = {
      resolution: {
        integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
      },
      cpu: [cpu],
      os: [os],
      ...(libc ? { libc: [libc] } : {}),
    };
    lock.snapshots[key] = { optional };
    s.packages.push({
      name,
      version: '1.0.0',
      integrity: lock.packages[key].resolution.integrity,
    } as never);
  }
  const bytes = Buffer.from(JSON.stringify(lock));
  s.lockChecksum = hash(bytes);
  for (const v of f.bundle)
    if (v.path === 'pnpm-lock.yaml') v.content = bytes.toString('base64');
  for (const v of f.command.arguments.files)
    if (v.path === 'pnpm-lock.yaml') v.sha256 = hash(bytes);
  s.sourceDigest = projectSourceDigest(f.command.arguments.files);
  return f;
}
it('prepares exactly the Linux glibc target while retaining every version and SRI in the saved lock', () => {
  const f = fixture();
  expect(projectDependencyIndexes(f.command, f.bundle, 'amd64')).toEqual([
    0, 1,
  ]);
  expect(projectDependencyIndexes(f.command, f.bundle, 'arm64')).toEqual([
    0, 2,
  ]);
  const original = parseDocument(
    projectInstallLock(f.command, f.bundle)!.original.toString(),
  ).toJS();
  expect(Object.keys(original.packages)).toHaveLength(5);
  expect(
    original.packages['@qa/darwin@1.0.0'].resolution.tarball,
  ).toBeUndefined();
});
it('does not hide an incompatible mandatory dependency as an optional skip', () => {
  const f = fixture(false);
  expect(() => projectDependencyIndexes(f.command, f.bundle, 'amd64')).toThrow(
    'PROJECT_LOCK_UNSUPPORTED',
  );
});
