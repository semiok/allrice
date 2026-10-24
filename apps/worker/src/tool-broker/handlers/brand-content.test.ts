import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Delivery from './delivery.js';
import type { RiceToolHandlerContext } from '../types.js';
import {
  executeBrandContentStep,
  renderBrandContentArticleMarkdown,
} from './brand-content.js';

// Actual isolated acceptance v1 body; the only requested v2 edit was its opening.
const qaOpening =
  '一天开始时，不必急着写满整页。想用纸笔安排日常，可以先在桌前记下三件具体的小事。';
const qaBody = `# MET194隔离验收：桌面的三件小事

${qaOpening}

**① 今天要做的一件事**
例如：核对一份待提交的文件，写下计划处理的时间。

**② 今天要确认的一件事**
例如：把会议前想问的问题记下来，留一行填写后续答复。

**③ 下班前要回看的一件事**
回看上午记下的事项，完成的打勾，未完成的注明下一步；安排有变化，也可以重新写。

记录不需要统一模板，按自己的工作节奏选择即可。三件事只是一个起点，不是必须完成的打卡任务。

本次演示笔记本的已知规格为 **A5、48张、96页**。这里仅介绍给定规格，不延伸描述使用效果。

*本文为「演示纸品 · MET194隔离验收」隔离测试内容，不是真实商品广告。*`;
const qaSourceNotes = '\n\n---\n\n资料依据：fact_1。\n';

const ports = vi.hoisted(() => ({
  authorize: vi.fn(),
  board: vi.fn(),
  mutate: vi.fn(),
  atomicMutate: vi.fn(),
  published: vi.fn(),
  export: vi.fn(),
  fence: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  authorizeBrandContentTool: ports.authorize,
  getBrandContentBoard: ports.board,
  getBrandContentPublishedVersion: ports.published,
  getStoredFile: vi.fn(() => {
    throw Error('Unexpected file read');
  }),
  listBrandContentBrands: vi.fn(),
  mutateBrandContent: ports.mutate,
  mutateBrandContentInTransaction: ports.atomicMutate,
}));
vi.mock('./delivery.js', () => ({
  createControlledWorkspaceExport: ports.export,
}));

function fixture(stage: 'article' | 'revision' = 'article') {
  const contextId = randomUUID(),
    contextDigest = `sha256:${'a'.repeat(64)}`;
  const version = {
    objectId: randomUUID(),
    versionId: randomUUID(),
    checksum: contextDigest,
  };
  const article = {
    id: randomUUID(),
    expectedRevision: 7,
    content: version,
    images: [],
    bundleDigest: contextDigest,
    feedback: '只修改开头，保留规格',
  };
  const invocation = {
    instanceId: randomUUID(),
    workflowRevisionId: randomUUID(),
    packageDigest: contextDigest,
    input: {
      stage,
      brandId: randomUUID(),
      contextRevisionId: contextId,
      contextDigest,
      context: { facts: [{ id: 'size', text: 'A5' }] },
      topic: { id: randomUUID() },
      ...(stage === 'revision' ? { article } : {}),
    },
  };
  const input = {
    context: { runId: randomUUID() },
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    managedBrowserJobAttempt: 2,
    managedBrowserJobLeaseToken: randomUUID(),
    call: {
      id: 'stable-workflow-step',
      name: 'workspace.brand_content.step',
      arguments: {},
    },
    storageRoot: '/unused-brand-content-test',
  } as RiceToolHandlerContext['input'];
  const args = {
    workflowInput: {},
    configured: {
      action: 'save_article',
      toolName: 'workspace.brand_content.step',
      requiredCapability: 'storage:write',
    },
    dependencies: {
      compose: {
        answer: JSON.stringify({
          title: '一页记录',
          markdown: '# 一页记录\n\nA5 纸张。',
          factIds: ['size'],
          verificationNotes: [],
        }),
      },
    },
  };
  const authority = {
    context: { workspaceId: randomUUID() },
    instanceId: invocation.instanceId,
    invocation,
    beforeCommit: ports.fence,
  };
  ports.authorize.mockResolvedValue(authority);
  ports.board.mockResolvedValue({
    contexts: [{ id: contextId, digest: contextDigest }],
  });
  ports.published.mockResolvedValue(version);
  ports.atomicMutate.mockResolvedValue({
    requestId: input.call.id,
    result: { entityId: article.id },
  });
  return { input, args, authority, article, version };
}

describe('brand Workflow output publication', () => {
  beforeEach(() => vi.resetAllMocks());
  it('keeps the actual QA source footer once through initial publication and two opening-only revisions', async () => {
    ports.export.mockImplementation(
      async (
        _context: unknown,
        composition: NonNullable<
          Parameters<typeof Delivery.createControlledWorkspaceExport>[1]
        >,
      ) => {
        await composition.registered!(
          Symbol('existing publisher transaction') as never,
          randomUUID(),
        );
        return { modelContent: '{}', summary: '实际文件回执' };
      },
    );
    const publish = async (stage: 'article' | 'revision', markdown: string) => {
      const { input, args, authority } = fixture(stage);
      authority.invocation.input.context.facts = [
        { id: 'fact_1', text: 'A5，48张、96页。' },
      ];
      args.dependencies.compose.answer = JSON.stringify({
        title: 'MET194隔离验收：桌面的三件小事',
        markdown,
        factIds: ['fact_1'],
        verificationNotes: [],
      });
      await executeBrandContentStep({ input, arguments: args });
      const calls = ports.export.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1]![0].arguments.content as string;
    };
    const initial = await publish('article', qaBody);
    expect(initial).toBe(qaBody + qaSourceNotes);
    const revised = await publish(
      'revision',
      initial.replace(qaOpening, '今天先写下三件小事。'),
    );
    expect(revised).toBe(initial.replace(qaOpening, '今天先写下三件小事。'));
    const revisedAgain = await publish(
      'revision',
      revised.replace('今天先写下三件小事。', '今天从一件小事开始。'),
    );
    expect(revisedAgain).toBe(
      initial.replace(qaOpening, '今天从一件小事开始。'),
    );
    for (const markdown of [initial, revised, revisedAgain])
      expect(markdown.split('资料依据：fact_1。')).toHaveLength(2);
    expect(ports.export).toHaveBeenCalledTimes(3);
    expect(ports.atomicMutate).toHaveBeenCalledTimes(3);
    expect(ports.mutate).not.toHaveBeenCalled();
  });

  it('preserves the recorded v2 duplicate footer without appending a third block or deleting prior text', () => {
    const markdown =
      qaBody.replace(qaOpening, '今天先写下三件小事。') +
      qaSourceNotes.trimEnd() +
      qaSourceNotes;
    const draft = {
      title: 'MET194隔离验收：桌面的三件小事',
      markdown,
      factIds: ['fact_1'],
      verificationNotes: [],
    };
    const rendered = renderBrandContentArticleMarkdown(draft);
    expect(rendered).toBe(markdown);
    expect(
      renderBrandContentArticleMarkdown({ ...draft, markdown: rendered }),
    ).toBe(markdown);
  });

  it.each([
    {
      name: 'different fact identifiers',
      previous: '\n\n---\n\n资料依据：fact_2。\n',
      verificationNotes: [],
      current: qaSourceNotes,
    },
    {
      name: 'different verification notes',
      previous:
        '\n\n---\n\n资料依据：fact_1。\n\n待核实：\n- 旧说明仍需保留。\n',
      verificationNotes: ['当前说明需要补充。'],
      current:
        '\n\n---\n\n资料依据：fact_1。\n\n待核实：\n- 当前说明需要补充。\n',
    },
  ])(
    'preserves $name and appends the complete current footer only once',
    ({ previous, verificationNotes, current }) => {
      const draft = {
        title: '一页记录',
        markdown: qaBody + previous,
        factIds: ['fact_1'],
        verificationNotes,
      };
      const rendered = renderBrandContentArticleMarkdown(draft);
      expect(rendered).toBe(draft.markdown + current);
      expect(
        renderBrandContentArticleMarkdown({ ...draft, markdown: rendered }),
      ).toBe(rendered);
    },
  );

  it.each([
    '正文中的资料依据：fact_1。',
    '正文保留以下相似片段。\n\n---\n\n资料依据：fact_1。\n\n后面仍有正文。',
    '正文中的最后一句\n资料依据：fact_1。',
  ])('keeps similar or nonterminal source text untouched: %s', (markdown) => {
    expect(
      renderBrandContentArticleMarkdown({
        title: '一页记录',
        markdown,
        factIds: ['fact_1'],
        verificationNotes: [],
      }),
    ).toBe(markdown + qaSourceNotes);
  });

  it.each(['article', 'revision'] as const)(
    'commits %s artifact and exact business version through the same publisher transaction',
    async (stage) => {
      const { input, args, authority, article, version } = fixture(stage);
      const tx = Symbol('existing publisher transaction');
      ports.export.mockImplementation(
        async (
          _context: unknown,
          composition: NonNullable<
            Parameters<typeof Delivery.createControlledWorkspaceExport>[1]
          >,
        ) => {
          expect(composition.requiredTool).toBe('workspace.brand_content.step');
          expect(composition.admit).toBe(ports.fence);
          expect(composition.replayed).toBe(composition.registered);
          await composition.registered!(tx as never, version.versionId);
          return {
            modelContent: JSON.stringify({ objectId: version.objectId }),
            summary: '实际文件回执',
          };
        },
      );
      const result = await executeBrandContentStep({ input, arguments: args });
      expect(ports.published).toHaveBeenCalledWith(
        authority.context,
        input.sessionId,
        version.versionId,
        tx,
      );
      expect(ports.atomicMutate).toHaveBeenCalledWith(
        authority.context,
        expect.objectContaining({
          requestId: input.call.id,
          operation: 'article.submit',
          content: version,
          expectedRevision: stage === 'revision' ? article.expectedRevision : 0,
          ...(stage === 'revision'
            ? {
                parentVersionId: article.content.versionId,
                articleId: article.id,
              }
            : {}),
        }),
        tx,
        { authority: 'workflow', beforeCommit: ports.fence },
      );
      expect(ports.mutate).not.toHaveBeenCalled();
      expect(JSON.parse(result.modelContent).delivery.objectId).toBe(
        version.objectId,
      );
    },
  );
  it('propagates an atomic CAS rejection without a second business write or success claim', async () => {
    const { input, args } = fixture('revision');
    ports.atomicMutate.mockRejectedValue(Error('revision_conflict'));
    ports.export.mockImplementation(
      async (
        _context: unknown,
        composition: NonNullable<
          Parameters<typeof Delivery.createControlledWorkspaceExport>[1]
        >,
      ) => {
        await composition.registered!(
          Symbol('transaction') as never,
          randomUUID(),
        );
        throw Error('must not reach successful publisher return');
      },
    );
    await expect(
      executeBrandContentStep({ input, arguments: args }),
    ).rejects.toThrow('revision_conflict');
    expect(ports.mutate).not.toHaveBeenCalled();
    expect(ports.atomicMutate).toHaveBeenCalledOnce();
  });
  it('rejects unsupported fact references before publishing any file', async () => {
    const { input, args } = fixture();
    args.dependencies.compose.answer = JSON.stringify({
      title: '无依据',
      markdown: '虚构功效',
      factIds: ['invented'],
      verificationNotes: [],
    });
    await expect(
      executeBrandContentStep({ input, arguments: args }),
    ).rejects.toMatchObject({ code: 'BRAND_CONTENT_FACT_REFERENCE_INVALID' });
    expect(ports.export).not.toHaveBeenCalled();
    expect(ports.atomicMutate).not.toHaveBeenCalled();
  });
  it('does not claim a delivered business version if the publisher skips composition', async () => {
    const { input, args } = fixture();
    ports.export.mockResolvedValue({
      modelContent: '{}',
      summary: 'unconfirmed',
    });
    await expect(
      executeBrandContentStep({ input, arguments: args }),
    ).rejects.toMatchObject({ code: 'BRAND_CONTENT_PUBLICATION_UNCONFIRMED' });
    expect(ports.mutate).not.toHaveBeenCalled();
  });

  it('refuses invented experience citations before publishing an article', async () => {
    const { input, args } = fixture();
    args.dependencies.compose.answer = JSON.stringify({
      title: 'A5 纸张',
      markdown: 'A5。',
      factIds: ['size'],
      verificationNotes: [],
      experienceUses: [{ id: randomUUID(), reason: 'Not loaded for this Run' }],
    });
    await expect(
      executeBrandContentStep({ input, arguments: args }),
    ).rejects.toMatchObject({
      code: 'BRAND_CONTENT_EXPERIENCE_REFERENCE_INVALID',
    });
    expect(ports.export).not.toHaveBeenCalled();
    expect(ports.atomicMutate).not.toHaveBeenCalled();
  });

  it('binds a retrospective to the selected evidence and exposes the exact persisted source for human experience review', async () => {
    const { input, args, authority } = fixture();
    const feedbackId = randomUUID();
    Object.assign(authority.invocation.input, {
      stage: 'retrospective',
      platform: 'Bilibili',
      feedback: [{ id: feedbackId }],
    });
    args.configured.action = 'save_retrospective';
    const output = {
      summary: 'Observed likes are zero; views unknown.',
      rule: 'Keep unknown metrics explicit.',
      applicability: 'Same brand campaign on Bilibili.',
      limitations: 'One observation is not causal evidence.',
      feedbackIds: [feedbackId],
    };
    args.dependencies.compose.answer = JSON.stringify(output);
    const report = {
      id: randomUUID(),
      sourceText: 'Exact persisted source for human review.',
    };
    ports.mutate.mockResolvedValue({ result: { entityId: report.id } });
    ports.board.mockResolvedValue({
      contexts: [
        {
          id: authority.invocation.input.contextRevisionId,
          digest: authority.invocation.input.contextDigest,
        },
      ],
      retrospectives: [report],
    });
    const result = await executeBrandContentStep({ input, arguments: args });
    expect(result.summary).toContain(report.sourceText);
    expect(JSON.parse(result.modelContent).retrospective).toEqual(report);
    expect(ports.mutate).toHaveBeenCalledWith(
      authority.context,
      expect.objectContaining({
        operation: 'retrospective.save',
        runId: input.context.runId,
        sessionId: input.sessionId,
        output,
      }),
      { authority: 'workflow', beforeCommit: ports.fence },
    );
    ports.mutate.mockClear();
    args.dependencies.compose.answer = JSON.stringify({
      ...output,
      feedbackIds: [randomUUID()],
    });
    await expect(
      executeBrandContentStep({ input, arguments: args }),
    ).rejects.toMatchObject({
      code: 'BRAND_CONTENT_FEEDBACK_REFERENCE_INVALID',
    });
    expect(ports.mutate).not.toHaveBeenCalled();
  });
});
