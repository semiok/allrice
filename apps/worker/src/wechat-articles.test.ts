import { describe, expect, it, vi } from 'vitest';

import {
  parseSogouWechatResults,
  parseWechatArticle,
  readWechatArticle,
  searchWechatArticles,
  validateWechatArticleUrl,
  type WechatHttpRequest,
} from './wechat-articles.js';

const articleUrl = 'https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=abc';

function response(
  body: string,
  options: {
    status?: number;
    headers?: Record<string, string>;
    url?: string;
  } = {},
) {
  return {
    status: options.status ?? 200,
    headers: new Headers(options.headers),
    body,
    url: options.url ?? 'https://weixin.sogou.com/weixin',
  };
}

describe('cloud WeChat article tools', () => {
  it('parses Sogou result metadata without trusting page scripts', () => {
    const results = parseSogouWechatResults(`
      <ul class="news-list">
        <li id="sogou_vr_11002601_box_0">
          <h3><a target="_blank" href="/link?url=abc">公众号文章标题</a></h3>
          <p class="txt-info">文章摘要 &amp; 核验信息</p>
          <span class="all-time-y2">示例公众号</span>
          <span class="s2"><script>timeConvert('1788075187')</script></span>
        </li>
      </ul>
    `);

    expect(results).toEqual([
      expect.objectContaining({
        title: '公众号文章标题',
        account: '示例公众号',
        snippet: '文章摘要 & 核验信息',
        redirectUrl: 'https://weixin.sogou.com/link?url=abc',
        publishedAt: expect.stringMatching(/^2026-/),
      }),
    ]);
  });

  it('resolves only mp.weixin.qq.com article URLs from the cloud search path', async () => {
    const request = vi.fn<WechatHttpRequest>(async (url) => {
      if (url.startsWith('https://v.sogou.com/')) {
        return response('', {
          headers: { 'set-cookie': 'SNUID=cloud-token; Path=/; Secure' },
          url,
        });
      }
      if (url.startsWith('https://weixin.sogou.com/weixin?')) {
        return response(
          `<li id="sogou_vr_11002601_box_0">
             <h3><a target="_blank" href="/link?url=result">云端搜索结果</a></h3>
             <p class="txt-info">只读公开文章</p>
             <span class="all-time-y2">AllRice 测试号</span>
           </li>`,
          { url },
        );
      }
      return response(
        `<script>url += 'https://mp.weixin.qq.com/s?__biz=test&amp;mid=1';</script>`,
        { url },
      );
    });

    await expect(
      searchWechatArticles('AllRice 云端技能测试', 3, { request }),
    ).resolves.toEqual([
      {
        title: '云端搜索结果',
        account: 'AllRice 测试号',
        publishedAt: null,
        snippet: '只读公开文章',
        url: 'https://mp.weixin.qq.com/s?__biz=test&mid=1',
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(
        'query=AllRice+%E4%BA%91%E7%AB%AF%E6%8A%80%E8%83%BD%E6%B5%8B%E8%AF%95',
      ),
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: 'SNUID=cloud-token' }),
      }),
    );
  });

  it('extracts normalized public article text, metadata, and image URLs', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Rice 公众号能力" />
        <meta property="og:description" content="公开文章摘要" />
        <meta name="author" content="AllRice" />
        <meta property="article:published_time" content="2026-08-30T12:00:00+08:00" />
      </head><body>
        <div id="js_content">
          <p>第一段正文。</p><p>第二段<strong>核验</strong>信息。</p>
          <img data-src="https://mmbiz.qpic.cn/example.png" />
          <script>ignore()</script>
        </div>
      </body></html>`;
    const request = vi.fn<WechatHttpRequest>(async (url) =>
      response(html, { url }),
    );
    const article = await readWechatArticle(articleUrl, { request });

    expect(article).toMatchObject({
      title: 'Rice 公众号能力',
      account: 'AllRice',
      description: '公开文章摘要',
      publishedAt: '2026-08-30T12:00:00+08:00',
      images: ['https://mmbiz.qpic.cn/example.png'],
      url: articleUrl,
      externalContent: {
        source: 'wechat.article.read',
        untrusted: true,
        wrapped: true,
      },
    });
    expect(article.content).toContain('第一段正文');
    expect(article.content).toContain('第二段核验信息');
    expect(article.content).not.toContain('ignore');
  });

  it('blocks arbitrary hosts and reports anti-bot pages explicitly', () => {
    expect(
      validateWechatArticleUrl(
        'https://mp.weixin.qq.com/s/2DT0ZphY59qMh45EB28w_A',
      ).toString(),
    ).toBe('https://mp.weixin.qq.com/s/2DT0ZphY59qMh45EB28w_A');
    expect(() =>
      validateWechatArticleUrl('http://169.254.169.254/latest'),
    ).toThrow(/仅允许/);
    expect(() =>
      validateWechatArticleUrl('https://example.com/s?__biz=test'),
    ).toThrow(/仅允许/);
    expect(() =>
      validateWechatArticleUrl('https://mp.weixin.qq.com/s/article/nested'),
    ).toThrow(/仅允许/);
    expect(() =>
      parseWechatArticle('<h1>访问过于频繁，请输入验证码</h1>', articleUrl),
    ).toThrow(/验证码/);
  });
});
