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
  try {
    return await requestYahooJson(path);
  } catch (error) {
    if (error instanceof HandlerError) throw error;
    const cause = error instanceof Error ? error.cause : undefined;
    const code =
      cause && typeof cause === 'object' && 'code' in cause
        ? String(cause.code)
        : '';
    const timedOut =
      (error instanceof Error && error.name === 'TimeoutError') ||
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code);
    // Do not expose raw fetch messages/URLs, credentials or upstream bodies.
    const detail = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
    ].includes(code)
      ? `（${code}）`
      : '';
    throw new HandlerError(
      timedOut ? 'MARKET_DATA_TIMEOUT' : 'MARKET_DATA_NETWORK_ERROR',
      timedOut
        ? 'Yahoo Finance 行情请求超时；可稍后重试或使用其他资料来源。'
        : `Yahoo Finance 行情连接失败${detail}；可稍后重试或使用其他资料来源。`,
      true,
    );
  }
}

async function requestYahooJson(path: string) {
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function exchangeDate(timestamp: number, meta: Record<string, unknown>) {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  if (typeof meta.exchangeTimezoneName === 'string') {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: meta.exchangeTimezoneName,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    } catch {
      // Some instruments only supply Yahoo's numeric exchange UTC offset.
    }
  }
  const offset = finiteNumber(meta.gmtoffset);
  if (offset === null || Math.abs(offset) > 86400) return null;
  return new Date((timestamp + offset) * 1000).toISOString().slice(0, 10);
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
  const points = timestamps
    .flatMap((timestamp, index) => {
      const close = finiteNumber(closes[index]);
      return finiteNumber(timestamp) !== null ? [{ timestamp, close }] : [];
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest =
    points.findLast((point) => point.close !== null && point.close > 0) ?? null;
  const regularMarketPrice = finiteNumber(meta.regularMarketPrice);
  const marketPrice = regularMarketPrice ?? latest?.close ?? null;
  const marketTime =
    regularMarketPrice !== null
      ? finiteNumber(meta.regularMarketTime)
      : (latest?.timestamp ?? null);
  const marketDate =
    marketTime === null ? null : exchangeDate(marketTime, meta);
  // chartPreviousClose is the baseline BEFORE the requested five-day range,
  // not yesterday's close. Compare exchange dates against the quote's session
  // (not the fetch date), including before the open, weekends and missing bars.
  const previous =
    marketDate === null
      ? undefined
      : points.findLast((point) => {
          const date = exchangeDate(point.timestamp, meta);
          return date !== null && date < marketDate;
        });
  const hint = finiteNumber(meta.priceHint);
  const previousPrice = previous?.close ?? null;
  const dailyClose =
    previousPrice === null || previousPrice <= 0
      ? null
      : hint !== null && Number.isInteger(hint) && hint >= 0 && hint <= 12
        ? Number(previousPrice.toFixed(hint))
        : previousPrice;
  const explicitClose = finiteNumber(meta.regularMarketPreviousClose);
  const previousClose =
    explicitClose !== null && explicitClose > 0 ? explicitClose : dailyClose;
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
      marketTime,
      fiftyTwoWeekHigh:
        typeof meta.fiftyTwoWeekHigh === 'number'
          ? meta.fiftyTwoWeekHigh
          : null,
      fiftyTwoWeekLow:
        typeof meta.fiftyTwoWeekLow === 'number' ? meta.fiftyTwoWeekLow : null,
    },
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    notice:
      '涨跌幅相对报价所属交易日的上一交易日收盘价；公开行情可能延迟，交易决策应以持牌行情服务或券商数据为准。',
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
