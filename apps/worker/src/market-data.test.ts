import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMarketHistory, getMarketQuote } from './market-data.js';

const response = {
  chart: {
    result: [
      {
        meta: {
          longName: 'NVIDIA Corporation',
          regularMarketPrice: 211,
          regularMarketPreviousClose: 209,
          chartPreviousClose: 209,
          currency: 'USD',
          exchangeName: 'NMS',
        },
        timestamp: [1_700_000_000, 1_700_086_400],
        indicators: {
          quote: [
            {
              open: [207, 210],
              high: [212, 214],
              low: [205, 208],
              close: [209, 211],
              volume: [100, 120],
            },
          ],
          adjclose: [{ adjclose: [209, 211] }],
        },
      },
    ],
    error: null,
  },
};

describe('market data provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes a public quote with timestamp and source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const quote = await getMarketQuote('nvda');
    expect(quote.symbol).toBe('NVDA');
    expect(quote.quote.marketPrice).toBe(211);
    expect(quote.quote.previousClose).toBe(209);
    expect(quote.quote.change).toBe(2);
    expect(quote.quote.changePercent).toBeCloseTo(0.9569);
    expect(quote.sourceUrl).toContain('/NVDA');
  });

  it('returns bounded historical OHLCV rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const history = await getMarketHistory({
      symbol: 'BTC-USD',
      range: '1mo',
      interval: '1d',
    });
    expect(history.rows).toHaveLength(2);
    expect(history.rows[1]?.close).toBe(211);
  });

  it.each([
    {
      failure: new DOMException('sensitive request URL', 'TimeoutError'),
      code: 'MARKET_DATA_TIMEOUT',
      detail: '超时',
    },
    {
      failure: new TypeError('fetch failed with private details', {
        cause: { code: 'ECONNRESET' },
      }),
      code: 'MARKET_DATA_NETWORK_ERROR',
      detail: 'ECONNRESET',
    },
    {
      failure: new TypeError('fetch failed', {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      }),
      code: 'MARKET_DATA_TIMEOUT',
      detail: '超时',
    },
  ])(
    'preserves safe $code diagnostics for a transport failure',
    async ({ failure, code, detail }) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
      await expect(getMarketQuote('BOTZ')).rejects.toMatchObject({
        code,
        retryable: true,
        message: expect.stringContaining(detail),
      });
      await expect(getMarketQuote('BOTZ')).rejects.not.toThrow(
        /sensitive|private/,
      );
    },
  );

  it('classifies a response-body connection reset too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: new Headers(),
        text: async () => {
          throw new TypeError('terminated', {
            cause: { code: 'UND_ERR_SOCKET' },
          });
        },
      }),
    );
    await expect(getMarketHistory({ symbol: 'AIQ' })).rejects.toMatchObject({
      code: 'MARKET_DATA_NETWORK_ERROR',
      message: expect.stringContaining('UND_ERR_SOCKET'),
    });
  });

  it.each([429, 503])(
    'keeps HTTP %s available in the native error instead of a generic connection failure',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response('upstream body not disclosed', { status }),
          ),
      );
      await expect(getMarketQuote('ARM')).rejects.toMatchObject({
        code: 'MARKET_DATA_UNAVAILABLE',
        message: `Yahoo Finance 返回 HTTP ${status}`,
        retryable: true,
      });
    },
  );
});
