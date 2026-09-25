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

// Shape and float32 daily closes from the AMD incident. Yahoo chart metadata
// has no regularMarketPreviousClose; the five-day baseline is Sep 17, not Sep 23.
const amd = {
  meta: {
    regularMarketPrice: 625.21,
    regularMarketTime: Date.parse('2026-09-24T17:13:13Z') / 1000,
    chartPreviousClose: 545.09,
    regularMarketChangePercent: 1.725,
    exchangeTimezoneName: 'America/New_York',
    gmtoffset: -14400,
    priceHint: 2,
  },
  timestamp: [
    '2026-09-18',
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
  ].map((day) => Date.parse(`${day}T13:30:00Z`) / 1000),
  indicators: {
    quote: [
      {
        close: [559.82, 615.52, 623.77, 614.61, 625.21].map(Math.fround),
      },
    ],
  },
};

function serveChart(result: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ chart: { result: [result], error: null } }),
        ),
    ),
  );
}

describe('market data provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports AMD daily +1.72%, not the five-day +14.70% returned in the incident', async () => {
    serveChart(amd);
    expect((await getMarketQuote('AMD')).quote).toMatchObject({
      marketPrice: 625.21,
      previousClose: 614.61,
      change: 10.6,
      changePercent: 1.7247,
    });
  });

  it('uses the prior session even when the current daily bar is missing', async () => {
    serveChart({
      ...amd,
      indicators: {
        quote: [
          { close: [...amd.indicators.quote[0]!.close.slice(0, -1), null] },
        ],
      },
    });
    expect((await getMarketQuote('AMD')).quote.previousClose).toBe(614.61);
  });

  it('does not skip a missing previous close and silently report a multi-day return', async () => {
    const close = [...amd.indicators.quote[0]!.close] as (number | null)[];
    close[3] = null;
    serveChart({ ...amd, indicators: { quote: [{ close }] } });
    expect((await getMarketQuote('AMD')).quote).toMatchObject({
      previousClose: null,
      change: null,
      changePercent: null,
    });
  });

  it.each(['2026-09-24T12:00:00Z', '2026-09-26T12:00:00Z'])(
    'anchors the previous close to the quote session rather than retrieval time %s',
    async (now) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(now));
        serveChart({
          ...amd,
          meta: {
            ...amd.meta,
            regularMarketPrice: 614.61,
            regularMarketTime: Date.parse('2026-09-23T20:00:00Z') / 1000,
          },
        });
        expect((await getMarketQuote('AMD')).quote).toMatchObject({
          previousClose: 623.77,
          changePercent: -1.4685,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('matches exchange dates when an Australian trading session crosses UTC midnight', async () => {
    serveChart({
      ...amd,
      meta: {
        ...amd.meta,
        exchangeTimezoneName: 'Australia/Sydney',
        regularMarketPrice: 105,
        regularMarketTime: Date.parse('2026-09-24T01:00:00Z') / 1000,
      },
      timestamp: ['2026-09-23T00:00:00Z', '2026-09-23T23:00:00Z'].map(
        (time) => Date.parse(time) / 1000,
      ),
      indicators: { quote: [{ close: [100, 105] }] },
    });
    expect((await getMarketQuote('TEST.AX')).quote).toMatchObject({
      previousClose: 100,
      changePercent: 5,
    });
  });

  it('uses the supplied UTC offset when the exchange timezone name is unavailable', async () => {
    serveChart({
      ...amd,
      meta: { ...amd.meta, exchangeTimezoneName: undefined },
    });
    expect((await getMarketQuote('AMD')).quote.previousClose).toBe(614.61);
  });

  it.each(['no_previous_bar', 'no_quote_time', 'no_exchange_time'])(
    'leaves the daily change unknown instead of using the range baseline: %s',
    async (mode) => {
      serveChart({
        ...amd,
        meta: {
          ...amd.meta,
          ...(mode === 'no_quote_time' ? { regularMarketTime: undefined } : {}),
          ...(mode === 'no_exchange_time'
            ? { exchangeTimezoneName: undefined, gmtoffset: undefined }
            : {}),
        },
        ...(mode === 'no_previous_bar'
          ? {
              timestamp: [amd.timestamp[4]],
              indicators: { quote: [{ close: [625.21] }] },
            }
          : {}),
      });
      expect((await getMarketQuote('AMD')).quote).toMatchObject({
        previousClose: null,
        change: null,
        changePercent: null,
      });
    },
  );

  it('keeps price and timestamp on the same daily candle when live metadata is absent', async () => {
    serveChart({
      ...amd,
      meta: {
        ...amd.meta,
        regularMarketPrice: undefined,
        regularMarketTime: Date.parse('2026-09-23T20:00:00Z') / 1000,
      },
    });
    expect((await getMarketQuote('AMD')).quote).toMatchObject({
      previousClose: 614.61,
      marketTime: amd.timestamp[4],
    });
  });

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
