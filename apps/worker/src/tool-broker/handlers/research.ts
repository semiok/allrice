import { searchCodexHostedWeb } from '../../codex-search-broker.js';
import { HandlerError } from '../../errors.js';
import { getMarketHistory, getMarketQuote } from '../../market-data.js';
import { fetchPublicWebPage } from '../../web-fetch.js';
import {
  readWechatArticle,
  searchWechatArticles,
} from '../../wechat-articles.js';
import { limitValue, stringValue } from '../input-values.js';
import type { ResearchToolOverrides, RiceToolResult } from '../types.js';

export type { ResearchToolOverrides } from '../types.js';

const researchToolNames = new Set([
  'web.search',
  'web.fetch',
  'wechat.article.search',
  'wechat.article.read',
  'market.quote',
  'market.history',
]);

export type ResearchToolName =
  | 'web.search'
  | 'web.fetch'
  | 'wechat.article.search'
  | 'wechat.article.read'
  | 'market.quote'
  | 'market.history';

export function isResearchToolName(name: string): name is ResearchToolName {
  return researchToolNames.has(name);
}

export async function executeResearchTool(input: {
  name: ResearchToolName;
  arguments: Record<string, unknown>;
  overrides?: ResearchToolOverrides;
}): Promise<RiceToolResult> {
  const args = input.arguments;
  if (input.name === 'web.search') {
    const query = stringValue(args.query, 'query');
    if (query.length > 2_000) {
      throw new HandlerError(
        'TOOL_INPUT_INVALID',
        'query 不能超过 2000 个字符',
        false,
      );
    }
    const search = await (input.overrides?.codexSearch ?? searchCodexHostedWeb)(
      query,
      limitValue(args.maxResults, 5, 10),
    );
    return {
      modelContent: JSON.stringify({
        provider: search.provider,
        query: search.query,
        retrievedAt: new Date().toISOString(),
        output: search.output,
        sources: search.results,
      }),
      summary: `已通过 Codex 检索“${query}”`,
      itemCount: search.results.length,
    };
  }
  if (input.name === 'web.fetch') {
    const page = await (input.overrides?.webFetch ?? fetchPublicWebPage)(
      stringValue(args.url, 'url'),
    );
    return {
      modelContent: JSON.stringify(page),
      summary: `已读取 ${new URL(page.url).hostname}`,
      itemCount: 1,
    };
  }
  if (input.name === 'wechat.article.search') {
    const query = stringValue(args.query, 'query');
    const articles = await (
      input.overrides?.wechatSearch ?? searchWechatArticles
    )(query, limitValue(args.limit, 5, 10));
    return {
      modelContent: JSON.stringify({
        provider: 'sogou-weixin',
        query,
        retrievedAt: new Date().toISOString(),
        results: articles,
      }),
      summary: `找到 ${articles.length} 篇公众号公开文章`,
      itemCount: articles.length,
    };
  }
  if (input.name === 'wechat.article.read') {
    const article = await (input.overrides?.wechatRead ?? readWechatArticle)(
      stringValue(args.url, 'url'),
    );
    return {
      modelContent: JSON.stringify(article),
      summary: `已读取公众号文章《${article.title}》`,
      itemCount: 1,
    };
  }
  if (input.name === 'market.quote') {
    const quote = await (input.overrides?.marketQuote ?? getMarketQuote)(
      stringValue(args.symbol, 'symbol'),
    );
    return {
      modelContent: JSON.stringify(quote),
      summary: `已查询 ${quote.symbol} 公开行情`,
      itemCount: 1,
    };
  }
  const history = await (input.overrides?.marketHistory ?? getMarketHistory)({
    symbol: stringValue(args.symbol, 'symbol'),
    ...(typeof args.range === 'string' ? { range: args.range } : {}),
    ...(typeof args.interval === 'string' ? { interval: args.interval } : {}),
  });
  return {
    modelContent: JSON.stringify(history),
    summary: `已查询 ${history.symbol} · ${history.range} 历史行情`,
    itemCount: history.rows.length,
  };
}
