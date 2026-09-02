import { describe, expect, it, vi } from 'vitest';

import { executeResearchTool, isResearchToolName } from './research.js';

describe('Research Tool Broker handlers', () => {
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

    expect(codexSearch).toHaveBeenCalledWith('AllRice', 10);
    expect(JSON.parse(result.modelContent)).toMatchObject({
      provider: 'codex-hosted-search',
      query: 'AllRice',
      output: 'AllRice search summary',
      sources: [{ url: 'https://example.com/allrice' }],
      retrievedAt: expect.any(String),
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
