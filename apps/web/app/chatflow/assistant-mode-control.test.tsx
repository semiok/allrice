import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantModeControl } from './assistant-mode-control';

describe('daily work mode selector', () => {
  const props = { busy: false, isRunning: false, steering: false };
  it('offers daily mode and marks planned modes as unavailable', () => {
    const html = renderToStaticMarkup(<AssistantModeControl {...props} />);
    expect(html).toContain('aria-label="工作模式"');
    expect(html).toContain('value="daily" selected=""');
    expect(html).toContain('value="boost" disabled=""');
    expect(html).toContain('value="teamwork" disabled=""');
    expect(html).toContain('深入攻关 · 规划中');
    expect(html).toContain('团队协作 · 规划中');
    expect(html).not.toMatch(/fieldset|checkbox|本次不使用助手|查看助手条件/);
  });
  it('labels the next task during a run and disables switching while steering', () => {
    const html = renderToStaticMarkup(
      <AssistantModeControl {...props} isRunning />,
    );
    expect(html).toContain('aria-label="下一项任务模式"');
    expect(html).not.toContain('<select disabled');
    for (const state of [{ busy: true }, { steering: true }]) {
      const disabled = renderToStaticMarkup(
        <AssistantModeControl {...props} {...state} isRunning />,
      );
      expect(disabled).toMatch(/<select[^>]*disabled=""/);
    }
  });
});
