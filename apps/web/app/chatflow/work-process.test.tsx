import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import { WorkProcess } from './work-process';
import type { NativeExperienceItem } from '../../lib/chatflow/native-experience';
import { workProcessPresentation } from '../../lib/chatflow/work-process-presentation';

const items: NativeExperienceItem[] = [
  {
    id: 'tool:read',
    kind: 'tool',
    toolName: 'read',
    status: 'started',
    title: '读取文件',
    activityDetail: '检查入口文件',
    sequence: 2,
  },
];
const parts = [
  {
    kind: 'reply' as const,
    id: 'progress',
    sequence: 1,
    text: '先检查已有资料',
  },
  { kind: 'steps' as const, id: 'steps', sequence: 2, items },
  {
    kind: 'reply' as const,
    id: 'final-reply',
    sequence: 3,
    text: '最终交付',
    finalAnswer: true,
  },
];
const render = (overrides: Partial<ComponentProps<typeof WorkProcess>> = {}) =>
  renderToStaticMarkup(
    <WorkProcess
      items={items}
      parts={parts}
      running={false}
      streaming={false}
      failed={false}
      canceled={false}
      onRetry={() => {}}
      assistantCount={0}
      assistantAttention={0}
      {...overrides}
    />,
  );

describe('native process display surface', () => {
  it('retains the accepted final answer outside completed process folding', () => {
    const html = render();
    expect(html).toContain('data-process-open="false"');
    expect(html).toMatch(/data-work-reply="progress" hidden=""/);
    expect(html).toMatch(/data-work-reply="final-reply">/);
    expect(html).toContain('最终交付');
  });
  it('shows actual live details in standard while compact keeps only activity labels', () => {
    const compact = render({ running: true, transcriptView: 'compact' });
    const standard = render({ running: true, transcriptView: 'standard' });
    expect(compact).not.toContain('检查入口文件');
    expect(standard).toContain('检查入口文件');
    expect(compact).toContain('阅读 · 1 项');
    const detailed = render({ running: true, transcriptView: 'detailed' });
    expect(detailed).toContain('检查入口文件');
    expect(detailed).not.toContain('阅读 · 1 项');
  });
  it('keeps verbose history fully visible without a step-group control', () => {
    const html = render({ transcriptView: 'verbose' });
    expect(html).toContain('data-process-open="true"');
    expect(html).not.toMatch(/data-work-reply="progress" hidden/);
    expect(html).toContain('检查入口文件');
    expect(html).not.toContain('阅读 · 1 项');
  });
  it.each(['failed', 'canceled'] as const)(
    'keeps a %s process visible',
    (state) => {
      expect(render({ [state]: true })).toContain('data-process-open="true"');
    },
  );
  it('uses the same next-input timing for unified output and streaming processes', () => {
    const presentation = workProcessPresentation([], parts, 'run', false);
    for (const processParts of [undefined, parts]) {
      expect(
        render({
          parts: processParts,
          collapseTiming: 'next-input',
          presentation,
        }),
      ).toContain('data-process-open="true"');
      expect(
        render({
          parts: processParts,
          collapseTiming: 'next-input',
          presentation: { ...presentation, hasNextInput: true },
        }),
      ).toContain('data-process-open="false"');
    }
  });
});
