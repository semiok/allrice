import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Delivery from './delivery.js';
import type { RiceToolHandlerContext } from '../types.js';
import { executeBrandContentStep } from './brand-content.js';

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
});
