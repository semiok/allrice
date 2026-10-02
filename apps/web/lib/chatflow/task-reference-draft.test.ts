import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TaskNextStepReference } from '@allrice/contracts';
import { appendTaskReferences } from './task-reference-draft';

const ref: TaskNextStepReference = {
  objectId: randomUUID(),
  versionId: randomUUID(),
  checksum: `sha256:${'a'.repeat(64)}`,
  fileName: '原成果.xlsx',
  sizeBytes: 10,
  mediaType: 'application/octet-stream',
  visibility: 'private',
};
describe('draft references to existing Session artifacts', () => {
  it('retains pending uploads by identity and deduplicates repeated suggestion references', () => {
    const original = {
      id: randomUUID(),
      persistedId: null,
      fileName: '未上传.txt',
      mediaType: 'text/plain',
      sizeBytes: 1,
      status: 'draft' as const,
      visibility: 'workspace' as const,
      file: new File(['a'], '未上传.txt'),
    };
    const next = appendTaskReferences([original], [ref, ref]);
    expect(next[0]).toBe(original);
    expect(next[1]).toMatchObject({
      id: ref.objectId,
      persistedId: ref.objectId,
      status: 'ready',
      visibility: 'private',
    });
    expect(appendTaskReferences(next, [ref])).toEqual(next);
  });
  it('respects existing attachment count/byte budgets without replacing old chips', () => {
    const attached = appendTaskReferences([], [ref]);
    expect(() =>
      appendTaskReferences(
        Array.from({ length: 20 }, () => ({
          ...attached[0]!,
          id: randomUUID(),
          persistedId: null,
        })),
        [ref],
      ),
    ).toThrow('20');
    expect(() =>
      appendTaskReferences(
        [
          {
            ...attached[0]!,
            id: randomUUID(),
            persistedId: null,
            sizeBytes: 200 * 1024 * 1024,
          },
        ],
        [ref],
      ),
    ).toThrow('200 MB');
    expect(attached).toHaveLength(1);
  });
});
