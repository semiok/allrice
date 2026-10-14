import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SendChatMessageInputSchema } from './workspace.ts';
import { EmployeePromptSnapshotSchema } from './employees.ts';
import { ReferenceSelectionSchema } from './reference-library.ts';
describe('fixed references in ordinary chat', () => {
  const id = randomUUID(),
    base = { clientMessageId: randomUUID(), text: '按这份资料核对' };
  it('preserves historical request shape and accepts only distinct ordinary tasks', () => {
    expect(SendChatMessageInputSchema.parse(base)).not.toHaveProperty(
      'referenceRevisionIds',
    );
    expect(
      SendChatMessageInputSchema.parse({
        ...base,
        referenceRevisionIds: [id.toUpperCase()],
        deliveryMode: 'follow_up',
      }).referenceRevisionIds,
    ).toEqual([id]);
    for (const fields of [
      { referenceRevisionIds: [id] },
      { referenceRevisionIds: [id], deliveryMode: 'steer' },
      {
        referenceRevisionIds: [id, id.toUpperCase()],
        deliveryMode: 'follow_up',
      },
      {
        referenceRevisionIds: Array.from({ length: 4 }, () => randomUUID()),
        deliveryMode: 'follow_up',
      },
      {
        referenceRevisionIds: [id],
        deliveryMode: 'follow_up',
        referenceSelections: [],
      },
    ])
      expect(
        SendChatMessageInputSchema.safeParse({ ...base, ...fields }).success,
      ).toBe(false);
  });
  it('keeps manifest and file checksums separate in frozen prompt snapshots', () => {
    const selection = ReferenceSelectionSchema.parse({
      sourceId: id,
      revisionId: randomUUID(),
      revision: 1,
      fileName: '预算.txt',
      purpose: '核对',
      digest: `sha256:${'a'.repeat(64)}`,
      checksum: `sha256:${'b'.repeat(64)}`,
      ownership: { scope: 'company', organizationId: randomUUID() },
    });
    const prompt = {
      systemPrompt: '助手',
      conversation: [],
      memories: [],
      userRequest: '核对',
    };
    expect(EmployeePromptSnapshotSchema.parse(prompt)).not.toHaveProperty(
      'referenceSelections',
    );
    expect(
      EmployeePromptSnapshotSchema.parse({
        ...prompt,
        referenceSelections: [selection],
      }).referenceSelections,
    ).toEqual([selection]);
  });
});
