import { expect, it } from 'vitest';
import { serializeMcpModelResult } from './result.js';

it('removes native duplicate content so a complete PR list fits without truncation', () => {
  const prs = Array.from({ length: 25 }, (_, i) => ({
    number: i + 1,
    title: '任务'.repeat(220),
    base: { ref: 'main' },
    head: { ref: `feature/${i}` },
  }));
  const content = [{ type: 'text', text: JSON.stringify(prs) }];
  const native = { isError: false, content, value: { content } };
  expect(JSON.stringify(native).length).toBeGreaterThan(20_000);
  const output = JSON.parse(serializeMcpModelResult(native));
  expect(output.truncated).toBeUndefined();
  expect(JSON.parse(output.content[0].text)).toEqual(prs);
});

it('returns explicit, parseable previews for oversized nested JSON and never invents totals', () => {
  const data = {
    total_count: 250,
    nextPage: 2,
    items: Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      body: '详细说明😀'.repeat(500),
    })),
  };
  const output = serializeMcpModelResult({
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(data) }],
  });
  expect(output.length).toBeLessThanOrEqual(20_000);
  const parsed = JSON.parse(output);
  expect(parsed.truncated).toBe(true);
  expect(parsed.notice).toContain('分页');
  const nested = JSON.parse(parsed.preview.content[0].text);
  expect(nested.total_count).toBe(250);
  expect(nested.nextPage).toBe(2);
  expect(nested.items.length).toBeLessThan(100);
  expect(nested.items[0].number).toBe(1);
});

it('retains distinct value data and exact small error results', () => {
  const value = {
    isError: true,
    content: [],
    error: { message: 'denied' },
    value: { structuredContent: { answer: 42 } },
  };
  expect(JSON.parse(serializeMcpModelResult(value))).toEqual(value);
});

it('bounds huge non-JSON content and deeply nested results with an explicit omission notice', () => {
  const result: Record<string, unknown> = {
    isError: true,
    content: [{ type: 'text', text: 'x'.repeat(40000) }],
  };
  const parsed = JSON.parse(serializeMcpModelResult(result));
  expect(parsed.isError).toBe(true);
  expect(parsed.truncated).toBe(true);
  expect(parsed.preview.content[0].text).toContain('已省略');
});
