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
  it('uses an action title for memory without claiming the memory was confirmed', () => {
    const memory: NativeExperienceItem[] = [
      {
        id: 'memory',
        kind: 'tool',
        toolName: 'workspace.memory.remember',
        title: 'workspace.memory.remember',
        status: 'completed',
        sequence: 1,
      },
    ];
    const html = render({ items: memory, parts: undefined });
    expect(html).toContain('整理工作记忆');
    expect(html).not.toContain('已调用工具');
    expect(html).not.toContain('记忆 · 1 项');
    expect(
      render({ items: memory, parts: undefined, transcriptView: 'standard' }),
    ).toContain('已调用工具');
    expect(html).not.toContain('已记住');
  });

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
    expect(html).toMatch(/data-work-reply="progress"[^>]* hidden=""/);
    expect(html).toMatch(/data-work-reply="final-reply"[^>]*>/);
    expect(html).not.toMatch(/data-work-reply="final-reply"[^>]* hidden/);
    expect(html).toContain('最终交付');
    expect(html.lastIndexOf('</section>')).toBeLessThan(
      html.indexOf('data-work-reply="final-reply"'),
    );
  });
  it.each([
    [200, '0.2秒'],
    [800, '0.8秒'],
    [1300, '1.3秒'],
    [61200, '1分 1.2秒'],
  ] as const)(
    'keeps the safe activity and recorded %ims beside its outcome as %s',
    (elapsed, duration) => {
      const html = render({
        parts: undefined,
        transcriptView: 'verbose',
        items: [
          {
            ...items[0]!,
            status: 'completed',
            startedAt: '2026-11-10T00:00:00Z',
            finishedAt: new Date(
              Date.parse('2026-11-10T00:00:00Z') + elapsed,
            ).toISOString(),
            detail: '入口文件已经读取',
          },
        ],
      });
      expect(html).toContain('检查入口文件');
      expect(html).toContain(`已完成 · ${duration}`);
      expect(html).toContain('data-step-id="tool:read"');
      expect(html).not.toContain('过程加载失败');
      const unknownTime = render({
        parts: undefined,
        transcriptView: 'verbose',
        items: [{ ...items[0]!, status: 'completed' }],
      });
      expect(unknownTime).not.toContain('已完成 · 0秒');
    },
  );
  it('shows actual live details in standard while compact keeps only activity labels', () => {
    const compact = render({ running: true, transcriptView: 'compact' });
    const standard = render({ running: true, transcriptView: 'standard' });
    expect(compact).not.toContain('检查入口文件');
    expect(standard).toContain('检查入口文件');
    expect(compact).toContain('正在读取文件');
    const detailed = render({ running: true, transcriptView: 'detailed' });
    expect(detailed).toContain('检查入口文件');
    expect(detailed).not.toContain('正在读取文件');
  });
  it('keeps verbose history fully visible without a step-group control', () => {
    const html = render({ transcriptView: 'verbose' });
    expect(html).toContain('data-process-open="true"');
    expect(html).not.toMatch(/data-work-reply="progress"[^>]* hidden/);
    expect(html).toContain('检查入口文件');
    expect(html).not.toContain('正在读取文件');
  });
  it('does not call an unfinished plan complete or leave a settled question waiting', () => {
    const html = render({
      parts: undefined,
      transcriptView: 'verbose',
      items: [
        { ...items[0]!, id: 'plan', kind: 'todo', status: 'updated' },
        {
          ...items[0]!,
          id: 'question',
          toolName: 'ask_user_question',
          activityDetail: undefined,
          status: 'completed',
        },
      ],
    });
    expect(html).toContain('data-status="结果未确认"');
    expect(html).toContain('提问');
    expect(html).not.toContain('等待你的回答');
    expect(html.match(/data-status="已完成"/g)).toHaveLength(1);
  });
  it.each([
    [true, false, false, '等待回答'],
    [false, false, false, '工作过程'],
    [false, true, false, '未完成'],
    [false, false, true, '已停止'],
  ] as const)(
    'limits an old pending question to the current run state (%s/%s/%s)',
    (running, failed, canceled, title) => {
      for (const submitted of [false, true]) {
        const html = render({
          running,
          failed,
          canceled,
          parts: undefined,
          transcriptView: 'verbose',
          items: [
            { ...items[0]!, id: 'tool:ask', toolName: 'ask_user_question' },
          ],
          questions: [
            {
              callId: 'ask',
              pending: true,
              answered: false,
              request: {
                questionId: 'native:ask',
                nativeSessionId: 'native',
                callId: 'ask',
                durable: true,
                questions: [
                  { id: 'sort', question: '按什么排序？', multiSelect: false },
                ],
              },
              answer: submitted
                ? {
                    id: 'answer',
                    text: '排序：跳过',
                    createdAt: '2026-11-10T00:00:00Z',
                    status: 'pending',
                    answer: {
                      questionId: 'native:ask',
                      answers: [{ id: 'sort', selected: [] }],
                    },
                  }
                : undefined,
            },
          ],
        });
        expect(html).toContain(
          `>${running && submitted ? '回答已提交' : title}<`,
        );
        if (!running) {
          expect(html).not.toContain('等待回答');
          expect(html).not.toContain('回答已提交');
          expect(html).not.toContain('Rice 已收到你的回答');
        }
      }
    },
  );
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
