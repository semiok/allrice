import { describe, it, expect } from 'vitest';
import { validateMemoryDraftOutput } from './memory-consolidation.ts';
const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const draft = {
  sourceIds: [ids[0]],
  category: 'business_preference',
  content: '合成偏好',
  reason: '真人来源',
};
const empty = { schemaVersion: 2, drafts: [], discarded: [], suggestions: [] };
describe('bounded memory proposals, no automatic adoption', () => {
  it('accepts an entirely discarded batch and a non-memory suggestion', () => {
    expect(
      validateMemoryDraftOutput(
        {
          ...empty,
          discarded: [
            {
              sourceIds: [ids[0]],
              category: 'profile_owned',
              reason: '属于表达方式',
            },
          ],
          suggestions: [
            {
              sourceIds: [ids[1]],
              category: 'workflow_steps',
              reason: '应整理到Workflow',
            },
          ],
        },
        ids,
      ).drafts,
    ).toEqual([]);
  });
  it.each([
    { ...empty, drafts: [draft, draft] },
    { ...empty, drafts: [draft] },
    {
      ...empty,
      discarded: [
        {
          sourceIds: [...ids, '10000000-0000-4000-8000-000000000003'],
          category: 'not_reusable',
          reason: '未知来源',
        },
      ],
    },
  ])('rejects duplicate, omitted or invented sources', (output) =>
    expect(() => validateMemoryDraftOutput(output, ids)).toThrow(
      'MEMORY_DRAFT_SOURCE_MISMATCH',
    ),
  );
  it('limits actual UTF-8 bytes without cropping', () => {
    expect(
      validateMemoryDraftOutput(
        { ...empty, drafts: [{ ...draft, content: '米'.repeat(333) }] },
        [ids[0]!],
      ).drafts[0]!.content,
    ).toHaveLength(333);
    expect(() =>
      validateMemoryDraftOutput(
        { ...empty, drafts: [{ ...draft, content: '米'.repeat(334) }] },
        [ids[0]!],
      ),
    ).toThrow();
  });
  it.each(['profile_owned', 'company_fact', 'workflow_steps'])(
    'does not accept %s as a memory candidate',
    (category) => {
      expect(() =>
        validateMemoryDraftOutput(
          { ...empty, drafts: [{ ...draft, category }] },
          [ids[0]!],
        ),
      ).toThrow();
    },
  );
  it('rejects the old auto-validation output contract', () => {
    expect(() =>
      validateMemoryDraftOutput(
        {
          schemaVersion: 1,
          drafts: [
            {
              sourceIds: ids,
              rule: '旧规则',
              validation: { kind: 'preference', check: '自评通过' },
            },
          ],
          discarded: [],
        },
        ids,
      ),
    ).toThrow();
  });
});
