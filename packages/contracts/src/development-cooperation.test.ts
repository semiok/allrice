import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DevelopmentPathsSchema,
  composeDevelopmentChangesets,
} from './development-cooperation.ts';
import type { ChangesetDocument } from './runtime-v2/artifact-review.ts';
const side = (text: string) => ({
  text,
  checksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
});
const document = (files: ChangesetDocument['files']): ChangesetDocument => ({
  contractVersion: 1,
  comparisonScope: 'changeset',
  execution: {
    targetId: randomUUID(),
    targetKind: 'rice_bridge',
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    workCopy: { id: randomUUID(), kind: 'in_place' },
  },
  files,
});
describe('MET-144 version composition contracts (not physical execution)', () => {
  it.each([
    ['src/x.ts', 'src/x.ts'],
    ['src', 'src/x.ts'],
    ['SRC', 'src/x.ts'],
    ['Café.ts', 'Cafe\u0301.ts'],
    ['../x'],
    ['src//x'],
    ['/x'],
    ['x\\y'],
  ])('rejects conflicting or ambiguous paths %j', (...paths) => {
    expect(() => DevelopmentPathsSchema.parse(paths)).toThrow();
  });
  it('keeps the original before-text when composing successive modifications', () => {
    const head = document([
      { path: 'x', before: side('old'), after: side('first') },
    ]);
    const result = composeDevelopmentChangesets(head, [
      document([{ path: 'x', before: side('first'), after: side('second') }]),
    ]);
    expect(result).toEqual({
      ...head,
      files: [{ path: 'x', before: side('old'), after: side('second') }],
    });
    expect(result).not.toHaveProperty('approved');
    expect(result).not.toHaveProperty('tested');
  });
  it('does not silently merge stale baselines or two changes to the same file', () => {
    const head = document([
      { path: 'x', before: side('old'), after: side('new') },
    ]);
    expect(() =>
      composeDevelopmentChangesets(head, [
        document([{ path: 'x', before: side('old'), after: side('other') }]),
      ]),
    ).toThrow('baseline_conflict');
    const p = document([
      { path: 'x', before: side('new'), after: side('third') },
    ]);
    expect(() => composeDevelopmentChangesets(head, [p, p])).toThrow();
  });
  it('preserves deletions, accepts new files, and drops created-then-deleted files', () => {
    const head = document([
      { path: 'kept', before: side('old'), after: side('old') },
      { path: 'temp', before: null, after: side('temp') },
    ]);
    const result = composeDevelopmentChangesets(head, [
      document([
        { path: 'temp', before: side('temp'), after: null },
        { path: 'kept', before: side('old'), after: null },
        { path: 'new', before: null, after: side('new') },
      ]),
    ]);
    expect(result.files).toEqual([
      { path: 'kept', before: side('old'), after: null },
      { path: 'new', before: null, after: side('new') },
    ]);
  });
});
