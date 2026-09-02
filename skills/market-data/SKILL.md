---
name: market-data
description: 查询股票、指数、ETF、汇率、加密货币和商品的结构化公开行情与历史走势，明确数据时间、币种、来源和延迟限制。
---

# Market Data

Use the approved read-only market tools for structured public quotes and price history.

## Workflow

1. Resolve the requested instrument and symbol. If ambiguity could change the answer, ask for the exchange or symbol.
2. Use `market_quote` for latest price, change, previous close, currency, exchange, and 52-week range.
3. Use `market_history` only when the user asks for a trend, interval, comparison, or historical analysis.
4. Lead with the requested result, then state symbol, currency, data timestamp, and source limitation.
5. For analysis, separate observed price data from interpretation.

## Rules

- Prefer these tools over web search for supported structured行情.
- Public quotes may be delayed and are not broker execution data.
- Never invent a symbol, quote, timestamp, fundamental metric, forecast, or recommendation.
- This Skill is read-only and does not place orders or provide personalized financial advice.
