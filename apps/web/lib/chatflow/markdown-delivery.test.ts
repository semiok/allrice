import { describe, expect, it } from 'vitest';
import { markdownDeliveryText } from './markdown-delivery';

const id = '8e11d67c-6718-42c9-99f2-de4530771fdd';
const path = `/api/v1/files/${id}/download`;
const files = [{ object: { id }, version: { fileName: '报告.md' } }];
const origin = 'https://allrice.example';
const target = `${origin}${path}?name=${encodeURIComponent('报告.md')}`;

describe('native Markdown SaaS delivery adaptation', () => {
  it('renders existing authenticated uploads even when the final Run created no new Artifact', () => {
    const uploaded = [{ id, fileName: '财务 样本.zip' }];
    const text = `[下载「财务 样本.zip」](${path}?name=wrong)`;
    expect(markdownDeliveryText(text, [], true, origin, uploaded)).toBe(
      `[下载「财务 样本.zip」](<${origin}${path}?name=${encodeURIComponent(uploaded[0]!.fileName)}>)`,
    );
    expect(markdownDeliveryText(text, [], true, origin, [])).toBe(text);
    expect(
      markdownDeliveryText(`\`[代码](${path})\``, [], true, origin, uploaded),
    ).toBe(`\`[代码](${path})\``);
  });
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

  it('repairs malformed Office links by their exact delivered filename, retaining native formatting', () => {
    const broken = '/api/v1/files/2e8e0f0e-3fee-49a5-8d47-47-6c?name=QA';
    expect(
      markdownDeliveryText(
        `[下载 **报告.md**](${broken})`,
        files,
        true,
        origin,
      ),
    ).toBe(`[下载 **报告.md**](<${target}>)`);
    expect(
      markdownDeliveryText(
        `[下载 报告.md](${broken})`,
        [...files, ...files],
        true,
        origin,
      ),
    ).toBe(`[下载 报告.md](${broken})`);
    expect(
      markdownDeliveryText(
        `\`[下载 报告.md](${broken})\``,
        files,
        true,
        origin,
      ),
    ).toBe(`\`[下载 报告.md](${broken})\``);
  });

  it('removes remote images even inside a rewritten file link', () => {
    const text = `[![封面](https://tracker.invalid/pixel)](${path})`;
    const adapted = markdownDeliveryText(text, files, false, origin);
    expect(adapted).toBe(`[&#91;图片：封面&#93;](<${target}>)`);
    expect(adapted).not.toContain('tracker.invalid');
  });
});
