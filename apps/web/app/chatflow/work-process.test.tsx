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
      {...overrides}
    />,
  );

describe('native process display surface', () => {
  it('keeps live lifecycle-only thinking in the phase row without duplicating it as a step', () => {
    const thinking: NativeExperienceItem[] = [
      {
        id: 'think:1',
        kind: 'think',
        status: 'started',
        title: '正在处理',
        sequence: 1,
      },
    ];
    for (const processParts of [
      undefined,
      [
        {
          kind: 'steps' as const,
          id: 'thinking',
          sequence: 1,
          items: thinking,
        },
      ],
    ]) {
      const html = render({
        items: thinking,
        parts: processParts,
        running: true,
      });
      expect(html).toContain('思考中…');
      expect(html).not.toContain('分析任务与处理步骤');
      expect(html).not.toContain('aria-label="工作步骤"');
    }
    // The projection still retains settled lifecycle history and actual failures.
    expect(
      render({ items: thinking, parts: undefined, transcriptView: 'verbose' }),
    ).toContain('分析任务与处理步骤');
    expect(
      render({
        items: [{ ...thinking[0]!, status: 'failed' }],
        parts: undefined,
        running: true,
      }),
    ).toContain('分析任务与处理步骤');
  });

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
    // Group content remains mounted so a manually opened call survives folding.
    expect(compact).toContain('data-work-group-open="false"');
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

  it('renders each operation inside its own call disclosure, including unsettled history', () => {
    const operation = {
      ...items[0]!,
      operationId: 'op',
      status: 'completed' as const,
    };
    for (const status of [
      'succeeded',
      'waiting_user',
      'failed',
      'unknown',
      'partial',
    ] as const) {
      const html = render({
        items: [{ ...operation, operationStatus: status }],
        parts: undefined,
        renderOperation: () => <article>single receipt</article>,
      });
      expect(html.match(/data-work-call=/g)).toHaveLength(1);
      expect(html.match(/single receipt/g) ?? []).toHaveLength(
        status === 'succeeded' ? 0 : 1,
      );
      expect(html).toContain(`data-process-open="${status !== 'succeeded'}"`);
    }
  });
});
