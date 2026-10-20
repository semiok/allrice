import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrandContentBoardSchema,
  StartBrandContentWorkflowSchema,
  type BrandContentBoard,
  type StartBrandContentWorkflow,
} from '@allrice/contracts';
const ports = vi.hoisted(() => ({
  unused: vi.fn(() => {
    throw Error('Stage input must not call persistence or execution ports');
  }),
}));
// The real function below is pure. Fail if it starts consulting mutable state,
// and avoid eagerly importing unrelated database services in this unit suite.
vi.mock('../core/client.ts', () => ({ getDatabase: ports.unused }));
vi.mock('../runtime-policy.ts', () => ({ runtimePolicyDigest: ports.unused }));
vi.mock('../capabilities/workflow-packages.ts', () => ({
  assertWorkflowPackageExecution: ports.unused,
  listWorkflowPackages: ports.unused,
}));
vi.mock('../employees/employee-chat-authority.ts', () => ({
  employeeChatUuid: ports.unused,
}));
vi.mock('./authority.ts', () => ({ requireBrandContentScope: ports.unused }));
vi.mock('./reads.ts', () => ({ getBrandContentBoard: ports.unused }));
import { brandContentStageInput } from './workflow-start.ts';

afterEach(() => {
  expect(ports.unused).not.toHaveBeenCalled();
});

// Pure business-version fixtures: no database, HTTP, model, or publication.
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checksum = (character: string) => `sha256:${character.repeat(64)}`;
const now = '2026-10-20T00:00:00.000Z';
function fixture(): BrandContentBoard {
  return BrandContentBoardSchema.parse({
    brand: {
      id: id(1),
      name: '后来修改的品牌名',
      revision: 2,
      contextRevisionId: id(3),
      createdAt: now,
      updatedAt: now,
    },
    contexts: [
      {
        id: id(3),
        brandName: '后来修改的品牌名',
        number: 2,
        digest: checksum('b'),
        createdAt: now,
        content: {
          audience: '后来修改的受众',
          tone: '新语气',
          requirements: '新规则',
          facts: [{ id: 'new_fact', text: '后来修改的事实' }],
          sourceFiles: [{ objectId: id(32), checksum: checksum('b') }],
          visualBrief: '新视觉要求',
          strategies: [],
        },
      },
      {
        id: id(2),
        brandName: '采纳时的品牌名',
        number: 1,
        digest: checksum('a'),
        createdAt: now,
        content: {
          audience: '采纳时的受众',
          tone: '原语气',
          requirements: '采纳时的规则',
          facts: [{ id: 'accepted_fact', text: '采纳时已经确认的事实' }],
          sourceFiles: [{ objectId: id(31), checksum: checksum('a') }],
          visualBrief: '采纳时的视觉要求',
          strategies: [],
        },
      },
    ],
    batches: [
      {
        id: id(4),
        contextRevisionId: id(2),
        platform: '小红书',
        revision: 2,
        topicIds: [id(5)],
        workflow: null,
        createdAt: now,
      },
    ],
    topics: [
      {
        id: id(5),
        contextRevisionId: id(2),
        platform: '小红书',
        candidate: {
          title: '已采纳方向',
          angle: '采用原始事实',
          outline: '已采纳提纲',
          audience: '原受众',
          rationale: '已有可核对来源',
          factIds: ['accepted_fact'],
          imageBrief: '原配图建议',
          suggestedWindow: '',
        },
        state: 'accepted',
        revision: 2,
        decisionReason: '人工确认',
        createdAt: now,
      },
    ],
    articles: [
      {
        id: id(6),
        topicId: id(5),
        topicRevision: 2,
        contextRevisionId: id(2),
        platform: '小红书',
        sessionId: id(7),
        revision: 4,
        state: 'changes_requested',
        currentBundleId: id(9),
        createdAt: now,
        updatedAt: now,
      },
    ],
    bundles: [
      {
        id: id(9),
        articleId: id(6),
        number: 2,
        content: {
          objectId: id(10),
          versionId: id(11),
          checksum: checksum('c'),
        },
        images: [
          {
            slotKey: 'cover',
            file: { objectId: id(12), checksum: checksum('d') },
            sourceKind: 'uploaded',
            caption: '当前实拍图',
          },
        ],
        digest: checksum('e'),
        parentBundleId: id(8),
        changeSummary: '当前版本',
        sourceReviewId: null,
        workflow: null,
        createdAt: now,
      },
      {
        id: id(8),
        articleId: id(6),
        number: 1,
        content: {
          objectId: id(13),
          versionId: id(14),
          checksum: checksum('f'),
        },
        images: [],
        digest: checksum('0'),
        parentBundleId: null,
        changeSummary: '历史版本',
        sourceReviewId: null,
        workflow: null,
        createdAt: now,
      },
    ],
    reviews: [
      {
        id: id(15),
        articleId: id(6),
        bundleId: id(8),
        bundleDigest: checksum('0'),
        decision: 'approved',
        reason: '历史版本通过，与当前稿无关',
        decidedBy: id(30),
        createdAt: now,
      },
      {
        id: id(16),
        articleId: id(6),
        bundleId: id(9),
        bundleDigest: checksum('e'),
        decision: 'rejected',
        reason: '请补充当前版本的真实事实来源',
        decidedBy: id(30),
        createdAt: now,
      },
    ],
    plans: [],
    receipts: [],
    truncated: false,
  });
}
function request(
  stage: StartBrandContentWorkflow['stage'],
  extra: Partial<StartBrandContentWorkflow> = {},
) {
  return StartBrandContentWorkflowSchema.parse({
    workspaceId: id(40),
    brandId: id(1),
    requestId: id(41),
    stage,
    ...(stage === 'topics'
      ? { platform: '微信公众号', count: 7 }
      : stage === 'article'
        ? { topicId: id(5) }
        : { articleId: id(6) }),
    ...extra,
  });
}
function approveCurrent(board: BrandContentBoard) {
  board.articles[0]!.state = 'approved';
  board.reviews[1]!.decision = 'approved';
  board.reviews[1]!.reason = '当前准确版本已经人工审稿通过';
}

describe('MET194 frozen brand-content stage input', () => {
  it('drafts from the accepted topic context even after the brand name, facts, files and rules change', () => {
    const board = fixture();
    const input = brandContentStageInput(
      board,
      request('article', { platform: '后来另选的平台' }),
    );
    expect(input).toMatchObject({
      stage: 'article',
      brandName: '采纳时的品牌名',
      contextRevisionId: id(2),
      contextDigest: checksum('a'),
      platform: '小红书',
      topic: { id: id(5) },
    });
    expect(input.context).toEqual(board.contexts[1]!.content);
    expect(JSON.stringify(input)).not.toContain('后来修改');
    expect(input.context.sourceFiles).toEqual([
      { objectId: id(31), checksum: checksum('a') },
    ]);
  });

  it('starts a new topic batch from the latest saved context and the explicitly requested platform and count', () => {
    const board = fixture();
    const input = brandContentStageInput(board, request('topics'));
    expect(input).toMatchObject({
      brandName: '后来修改的品牌名',
      contextRevisionId: id(3),
      contextDigest: checksum('b'),
      platform: '微信公众号',
      count: 7,
    });
    expect(input.context).toEqual(board.contexts[0]!.content);
    expect(input.topic).toBeUndefined();
    expect(input.article).toBeUndefined();
  });

  it.each(['candidate', 'rejected', 'missing'] as const)(
    'refuses to draft a %s topic rather than treating generation as acceptance',
    (state) => {
      const board = fixture();
      if (state === 'missing') board.topics = [];
      else board.topics[0]!.state = state;
      expect(() => brandContentStageInput(board, request('article'))).toThrow(
        'invalid_state',
      );
    },
  );

  it('refuses to silently substitute the new context when the accepted topic source is unavailable', () => {
    const board = fixture();
    board.contexts = board.contexts.filter((context) => context.id !== id(2));
    expect(() => brandContentStageInput(board, request('article'))).toThrow(
      'source_unavailable',
    );
  });

  it('revises the current content and image bundle using only its actual rejection', () => {
    const board = fixture();
    const input = brandContentStageInput(board, request('revision'));
    expect(input.contextRevisionId).toBe(id(2));
    expect(input.article).toEqual({
      id: id(6),
      expectedRevision: 4,
      content: board.bundles[0]!.content,
      bundleDigest: checksum('e'),
      images: board.bundles[0]!.images,
      feedback: '请补充当前版本的真实事实来源',
    });
    expect(input.article?.feedback).not.toContain('历史版本');
  });

  it.each([
    'historical_only',
    'other_article',
    'changed_digest',
    'approved',
    'not_returned',
  ] as const)(
    'does not turn %s feedback into a current-version revision request',
    (mismatch) => {
      const board = fixture();
      if (mismatch === 'historical_only') {
        board.reviews.splice(1);
        board.reviews[0]!.decision = 'rejected';
      }
      if (mismatch === 'other_article') board.reviews[1]!.articleId = id(99);
      if (mismatch === 'changed_digest')
        board.reviews[1]!.bundleDigest = checksum('9');
      if (mismatch === 'approved') board.reviews[1]!.decision = 'approved';
      if (mismatch === 'not_returned')
        board.articles[0]!.state = 'awaiting_review';
      expect(() => brandContentStageInput(board, request('revision'))).toThrow(
        'invalid_state',
      );
    },
  );

  it('hands off the current exactly approved bundle and its frozen topic facts', () => {
    const board = fixture();
    approveCurrent(board);
    const input = brandContentStageInput(board, request('handoff'));
    expect(input).toMatchObject({
      contextRevisionId: id(2),
      brandName: '采纳时的品牌名',
      article: {
        content: { objectId: id(10), versionId: id(11) },
        bundleDigest: checksum('e'),
        feedback: '当前准确版本已经人工审稿通过',
      },
    });
    expect(input.context.facts).toEqual([
      { id: 'accepted_fact', text: '采纳时已经确认的事实' },
    ]);
  });

  it.each([
    'historical_only',
    'other_article',
    'changed_digest',
    'rejected',
    'not_approved',
  ] as const)(
    'refuses handoff with %s approval instead of borrowing an old or foreign approval',
    (mismatch) => {
      const board = fixture();
      approveCurrent(board);
      if (mismatch === 'historical_only') board.reviews.splice(1);
      if (mismatch === 'other_article') board.reviews[1]!.articleId = id(99);
      if (mismatch === 'changed_digest')
        board.reviews[1]!.bundleDigest = checksum('9');
      if (mismatch === 'rejected') board.reviews[1]!.decision = 'rejected';
      if (mismatch === 'not_approved')
        board.articles[0]!.state = 'awaiting_review';
      expect(() => brandContentStageInput(board, request('handoff'))).toThrow(
        'invalid_state',
      );
    },
  );

  it.each(['revision', 'handoff'] as const)(
    'refuses %s when the current bundle is absent despite having historical content',
    (stage) => {
      const board = fixture();
      board.bundles = board.bundles.filter((bundle) => bundle.id !== id(9));
      expect(() => brandContentStageInput(board, request(stage))).toThrow(
        'source_unavailable',
      );
    },
  );
});
