import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AssistantMarkdown } from './assistant-markdown';

describe('AssistantMarkdown', () => {
  it('renders GFM formatting and safe external links', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text="**来源**：[Bitcoin](https://example.com/btc)" />,
    );

    expect(html).toContain('<strong>来源</strong>');
    expect(html).toContain('href="https://example.com/btc"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not render raw HTML from an assistant response', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown text={'<script>alert("x")</script>'} />,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
