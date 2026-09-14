import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantModeControl } from './assistant-mode-control';

describe('P26 next-task mode control', () => {
  const props = {
    allowAssistants: true,
    eligible: true,
    busy: false,
    isRunning: false,
    steering: false,
    onChange: () => {},
  };
  it('exposes daily mode, not clickable unreleased modes', () => {
    const html = renderToStaticMarkup(<AssistantModeControl {...props} />);
    expect(html).toContain('工作方式');
    expect(html).toContain('value="boost" disabled=""');
    expect(html).toContain('value="teamwork" disabled=""');
    expect(html).toContain('受既有权限与总预算约束');
  });
  it('separates running-task controls from the next-task preference', () => {
    const html = renderToStaticMarkup(
      <AssistantModeControl {...props} isRunning />,
    );
    expect(html).toContain('下一项任务');
    expect(html).toContain('不改变正在运行的任务');
    const steer = renderToStaticMarkup(
      <AssistantModeControl {...props} isRunning steering />,
    );
    expect(steer).toContain('disabled=""');
    expect(steer).toContain('不会更改当前任务配置');
  });
  it('does not offer permission that the employee does not have', () => {
    const html = renderToStaticMarkup(
      <AssistantModeControl {...props} eligible={false} />,
    );
    expect(html).toContain('checked=""');
    expect(html).toContain('当前员工未开放助手能力');
  });
});
