import { describe, expect, it, vi } from 'vitest';

import { executeResearchTool, isResearchToolName } from './research.js';

describe('Research Tool Broker handlers', () => {
  it('maps only actual native source fields without inventing dates or truncating snippets', async () => {
    const content = 'c'.repeat(14000),
      snippet = 's'.repeat(14000);
    const signal = new AbortController().signal;
    const codexSearch = vi.fn(async () => ({
      provider: 'codex-hosted-search' as const,
      query: 'q',
      output: content,
      results: [
        {
          url: 'https://one.test',
          title: 'One',
          snippet,
          publishedAt: '2026-11-05',
          ignored: 'not a native field',
        },
        {
          url: 'https://two.test',
          retrievedAt: 'must not become publication time',
        },
      ],
    }));
    const result = await executeResearchTool({
      name: 'web.search',
      arguments: { query: 'q' },
      signal,
      overrides: { codexSearch },
    });
    expect(codexSearch).toHaveBeenCalledWith('q', 5, signal);
    expect(JSON.parse(result.modelContent)).toEqual({
      content,
      truncated: false,
      sources: [
        {
          url: 'https://one.test',
          title: 'One',
          snippet,
          publishedAt: '2026-11-05',
        },
        { url: 'https://two.test' },
      ],
    });
  });

  it.each([null, {}, { url: 1 }, { url: 'https://one.test', snippet: {} }])(
    'refuses malformed source data without inventing a citation: %j',
    async (source) => {
      await expect(
        executeResearchTool({
          name: 'web.search',
          arguments: { query: 'q' },
          overrides: {
            codexSearch: async () => ({
              provider: 'codex-hosted-search',
              query: 'q',
              output: 'data',
              results: [source],
            }),
          },
        }),
      ).rejects.toMatchObject({ code: 'WEB_SEARCH_RESULT_INVALID' });
    },
  );
  it('owns only the read-only research tool family', () => {
    for (const name of [
      'web.search',
      'web.fetch',
      'wechat.article.search',
      'wechat.article.read',
      'market.quote',
      'market.history',
    ]) {
      expect(isResearchToolName(name)).toBe(true);
    }
    expect(isResearchToolName('browser.run')).toBe(false);
    expect(isResearchToolName('automation.create')).toBe(false);
  });

  it('normalizes hosted search without taking over Broker governance', async () => {
    const codexSearch = vi.fn(async (query: string, maxResults = 5) => ({
      provider: 'codex-hosted-search' as const,
      query,
      output: 'AllRice search summary',
      results: [
        {
          type: 'text_result',
          url: 'https://example.com/allrice',
          title: 'AllRice',
        },
      ].slice(0, maxResults),
    }));

    const result = await executeResearchTool({
      name: 'web.search',
      arguments: { query: '  AllRice  ', maxResults: 30 },
      overrides: { codexSearch },
    });

    expect(codexSearch).toHaveBeenCalledWith('AllRice', 10, undefined);
    expect(JSON.parse(result.modelContent)).toMatchObject({
      content: 'AllRice search summary',
      truncated: false,
      sources: [{ url: 'https://example.com/allrice' }],
    });
    expect(result.summary).toBe('已通过 Codex 检索“AllRice”');
  });

  it('keeps WeChat read result and summary shape stable', async () => {
    const wechatRead = vi.fn(async (url: string) => ({
      title: 'AllRice 公众号文章',
      account: 'AllRice',
      publishedAt: null,
      description: null,
      content: '正文',
      images: [],
      url,
      retrievedAt: '2026-09-01T00:00:00.000Z',
      truncated: false,
      externalContent: {
        source: 'wechat.article.read' as const,
        untrusted: true as const,
        wrapped: true as const,
      },
    }));

    const result = await executeResearchTool({
      name: 'wechat.article.read',
      arguments: { url: 'https://mp.weixin.qq.com/s/example' },
      overrides: { wechatRead },
    });

    expect(result.summary).toBe('已读取公众号文章《AllRice 公众号文章》');
    expect(JSON.parse(result.modelContent)).toMatchObject({ content: '正文' });
  });
});
