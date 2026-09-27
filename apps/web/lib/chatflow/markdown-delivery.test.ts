import { describe, expect, it } from 'vitest';
import { markdownDeliveryText } from './markdown-delivery';

const id = '8e11d67c-6718-42c9-99f2-de4530771fdd';
const path = `/api/v1/files/${id}/download`;
const files = [{ object: { id }, version: { fileName: '报告.md' } }];
const origin = 'https://allrice.example';
const target = `${origin}${path}?name=${encodeURIComponent('报告.md')}`;

describe('native Markdown SaaS delivery adaptation', () => {
  it.each([1, 2])(
    'repairs %i levels of escaped path separators from real deliveries',
    (depth) => {
      const escaped = path.replaceAll('/', '\\'.repeat(depth) + '/');
      expect(
        markdownDeliveryText(`[下载报告](${escaped})`, files, true, origin),
      ).toBe(`[下载报告](<${target}>)`);
    },
  );
  it('keeps formatting while resolving only verified file links to the current host', () => {
    expect(
      markdownDeliveryText(
        `[下载 **报告**](https://invented.invalid${path}?name=wrong)`,
        files,
        true,
        origin,
      ),
    ).toBe(`[下载 **报告**](<${target}>)`);
    expect(
      markdownDeliveryText(
        `[下载][report]\n\n[report]: ${path}`,
        files,
        true,
        origin,
      ),
    ).toBe(`[下载][report]\n\n[report]: <${target}>`);
  });

  it('leaves unknown links, code examples and ordinary text untouched', () => {
    const text = `\`[示例](${path})\`\n\n[未知](/api/v1/files/00000000-0000-4000-8000-000000000001/download)\n\n[来源](https://example.com)`;
    expect(markdownDeliveryText(text, files, true, origin)).toBe(text);
  });

  it('removes remote images even inside a rewritten file link', () => {
    const text = `[![封面](https://tracker.invalid/pixel)](${path})`;
    const adapted = markdownDeliveryText(text, files, false, origin);
    expect(adapted).toBe(`[&#91;图片：封面&#93;](<${target}>)`);
    expect(adapted).not.toContain('tracker.invalid');
  });
});
