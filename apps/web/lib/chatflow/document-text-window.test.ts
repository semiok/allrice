import { describe, expect, it } from 'vitest';
import { documentTextWindows, textRenderLimits } from './document-text-window';

describe('bounded document display windows', () => {
  it('preserves every character of long formatted and single-line documents', () => {
    for (const text of [
      '',
      'short\r\ntext\n',
      JSON.stringify(
        Array.from({ length: 10_000 }, (_, i) => ({ i, name: '测试' })),
        null,
        2,
      ),
      'x'.repeat(textRenderLimits.characters - 1) + '😀'.repeat(20_000),
    ]) {
      const pages = documentTextWindows(text);
      expect(pages.join('')).toBe(text);
      for (const page of pages) {
        expect(page.length).toBeLessThanOrEqual(textRenderLimits.characters);
        expect(page.split('\n').length).toBeLessThanOrEqual(
          textRenderLimits.lines + 1,
        );
        expect(new TextDecoder().decode(new TextEncoder().encode(page))).toBe(
          page,
        );
      }
    }
  });
});
