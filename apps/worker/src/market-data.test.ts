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
});
