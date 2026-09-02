import { HandlerError } from './errors.js';

const yahooOrigin = 'https://query1.finance.yahoo.com';
const maximumResponseBytes = 2_000_000;
const symbolPattern = /^[A-Z0-9^.=-]{1,32}$/i;

interface YahooChartResponse {
  chart?: {
    result?: {
      meta?: Record<string, unknown>;
      timestamp?: number[];
      indicators?: {
        quote?: Record<string, (number | null)[]>[];
        adjclose?: { adjclose?: (number | null)[] }[];
      };
    }[];
    error?: { code?: string; description?: string } | null;
  };
}

function marketSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  if (!symbolPattern.test(symbol)) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'symbol 只能包含市场代码常用的字母、数字、^、.、= 和 -',
      false,
    );
  }
  return symbol;
}

async function boundedYahooJson(path: string) {
  const response = await fetch(new URL(path, yahooOrigin), {
    headers: {
      accept: 'application/json',
      'user-agent': 'AllRice-Market-Data/0.1',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumResponseBytes) {
    throw new HandlerError(
      'TOOL_RESPONSE_TOO_LARGE',
      '市场数据响应超过 2 MB 安全上限',
      false,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumResponseBytes) {
    throw new HandlerError(
      'TOOL_RESPONSE_TOO_LARGE',
      '市场数据响应超过 2 MB 安全上限',
      false,
    );
  }
  if (!response.ok) {
    throw new HandlerError(
      'MARKET_DATA_UNAVAILABLE',
      `Yahoo Finance 返回 HTTP ${response.status}`,
      true,
    );
  }
  try {
    return JSON.parse(text) as YahooChartResponse;
  } catch {
    throw new HandlerError(
      'MARKET_DATA_INVALID',
      'Yahoo Finance 返回了无法解析的数据',
      true,
    );
  }
}

function firstChartResult(response: YahooChartResponse) {
  const error = response.chart?.error;
  if (error) {
    throw new HandlerError(
      'MARKET_SYMBOL_NOT_FOUND',
      error.description ?? error.code ?? '未找到该市场代码',
      false,
    );
  }
  const result = response.chart?.result?.[0];
  if (!result) {
    throw new HandlerError(
      'MARKET_SYMBOL_NOT_FOUND',
      '未找到该市场代码',
      false,
    );
  }
  return result;
}

export async function getMarketQuote(symbolInput: string) {
  const symbol = marketSymbol(symbolInput);
  const response = await boundedYahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&events=div%2Csplits`,
  );
  const result = firstChartResult(response);
  const meta = result.meta ?? {};
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const points = timestamps.flatMap((timestamp, index) => {
    const close = closes[index];
    return typeof close === 'number' ? [{ timestamp, close }] : [];
  });
  const latest = points.at(-1) ?? null;
  const previous = points.at(-2) ?? null;
  const marketPrice =
    typeof meta.regularMarketPrice === 'number'
      ? meta.regularMarketPrice
      : (latest?.close ?? null);
  const previousClose =
    typeof meta.regularMarketPreviousClose === 'number'
      ? meta.regularMarketPreviousClose
      : typeof meta.chartPreviousClose === 'number'
        ? meta.chartPreviousClose
        : (previous?.close ?? null);
  const change =
    marketPrice !== null && previousClose !== null
      ? Number((marketPrice - previousClose).toFixed(8))
      : null;
  const changePercent =
    marketPrice !== null && previousClose !== null && previousClose !== 0
      ? Number(
          (((marketPrice - previousClose) / previousClose) * 100).toFixed(4),
        )
      : null;
  return {
    provider: 'yahoo-finance-public',
    symbol,
    retrievedAt: new Date().toISOString(),
    quote: {
      name:
        typeof meta.longName === 'string'
          ? meta.longName
          : typeof meta.shortName === 'string'
            ? meta.shortName
            : symbol,
      exchange:
        typeof meta.exchangeName === 'string' ? meta.exchangeName : null,
      instrumentType:
        typeof meta.instrumentType === 'string' ? meta.instrumentType : null,
      currency: typeof meta.currency === 'string' ? meta.currency : null,
      timezone: typeof meta.timezone === 'string' ? meta.timezone : null,
      marketPrice,
      previousClose,
      change,
      changePercent,
      marketTime:
        typeof meta.regularMarketTime === 'number'
          ? meta.regularMarketTime
          : (latest?.timestamp ?? null),
      fiftyTwoWeekHigh:
        typeof meta.fiftyTwoWeekHigh === 'number'
          ? meta.fiftyTwoWeekHigh
          : null,
      fiftyTwoWeekLow:
        typeof meta.fiftyTwoWeekLow === 'number' ? meta.fiftyTwoWeekLow : null,
    },
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    notice: '公开行情可能延迟；交易决策应以持牌行情服务或券商数据为准。',
  };
}

const supportedRanges = new Set([
  '1d',
  '5d',
  '1mo',
  '3mo',
  '6mo',
  '1y',
  '2y',
  '5y',
  '10y',
  'ytd',
  'max',
]);
const supportedIntervals = new Set([
  '1m',
  '2m',
  '5m',
  '15m',
  '30m',
  '60m',
  '90m',
  '1h',
  '1d',
  '5d',
  '1wk',
  '1mo',
  '3mo',
]);

export async function getMarketHistory(input: {
  symbol: string;
  range?: string;
  interval?: string;
}) {
  const symbol = marketSymbol(input.symbol);
  const range = supportedRanges.has(input.range ?? '') ? input.range! : '1mo';
  const interval = supportedIntervals.has(input.interval ?? '')
    ? input.interval!
    : '1d';
  const response = await boundedYahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&events=div%2Csplits`,
  );
  const result = firstChartResult(response);
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const timestamps = result.timestamp ?? [];
  const numberAt = (values: unknown, index: number) =>
    Array.isArray(values) && typeof values[index] === 'number'
      ? values[index]
      : null;
  const rows = timestamps.slice(-1_000).map((timestamp, index) => ({
    timestamp,
    open: numberAt(quote.open, index),
    high: numberAt(quote.high, index),
    low: numberAt(quote.low, index),
    close: numberAt(quote.close, index),
    adjustedClose: numberAt(adjusted, index),
    volume: numberAt(quote.volume, index),
  }));
  return {
    provider: 'yahoo-finance-public',
    symbol,
    range,
    interval,
    retrievedAt: new Date().toISOString(),
    meta: result.meta ?? {},
    rows,
    truncated: timestamps.length > 1_000,
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history`,
    notice: '公开历史行情可能复权、延迟或缺失；交易决策应以持牌行情服务为准。',
  };
}
