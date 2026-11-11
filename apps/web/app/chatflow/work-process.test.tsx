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
  it.each([false, true])(
    'keeps each failed create/list fact and unknown outcome with parts=%s',
    (withParts) => {
      const calls: NativeExperienceItem[] = [
        {
          id: 'tool:create',
          toolName: 'subagent',
          status: 'completed',
          activityDetail: '独立复核合计',
        },
        {
          id: 'tool:create-failed',
          toolName: 'subagent_fork',
          status: 'failed',
          detail: '授权读取被拒绝',
        },
        {
          id: 'tool:list-failed',
          toolName: 'list_agents',
          status: 'failed',
          detail: '读取服务暂不可用',
        },
        { id: 'tool:create-unknown', toolName: 'subagent', status: 'info' },
        {
          id: 'tool:list-completed',
          toolName: 'list_agents',
          status: 'completed',
        },
        { id: 'tool:message', toolName: 'send_message', status: 'completed' },
      ].map((call, sequence) => ({
        kind: 'tool',
        title: call.toolName,
        sequence,
        ...call,
      })) as NativeExperienceItem[];
      const processParts = withParts
        ? [
            {
              kind: 'steps' as const,
              id: 'native-calls',
              sequence: 1,
              items: calls,
            },
            parts[2]!,
          ]
        : undefined;
      const presentation = {
        ...workProcessPresentation([], processParts, 'native-run', false),
        identityKnown: true,
      };
      const html = render({
        items: calls,
        parts: processParts,
        presentation,
        transcriptView: 'verbose',
        onOpenSubagents: () => {},
        subagentCount: 2,
      });
      for (const id of [
        'create',
        'create-failed',
        'list-failed',
        'create-unknown',
        'message',
      ])
        expect(
          html.match(new RegExp(`data-step-id="tool:${id}"`, 'g')),
        ).toHaveLength(1);
      expect(html).toContain('创建子智能体 · 独立复核合计');
      expect(html).toContain('授权读取被拒绝');
      expect(html).toContain('读取服务暂不可用');
      expect(html).toContain('结果未确认');
      expect(html).toContain('send_message');
      expect(html).not.toContain('data-step-id="tool:list-completed"');
      expect(html).toContain('2 个智能体');
      expect(html).not.toContain('childId');
      if (withParts) {
        const directoryId = html.match(/id="([^"]+-subagents)"/)![1]!;
        expect(html.match(/aria-owns="([^"]+)"/)![1]!.split(' ')).toContain(
          directoryId,
        );
        expect(html.indexOf(`id="${directoryId}"`)).toBeLessThan(
          html.indexOf('data-work-reply="final-reply"'),
        );
      }
      const unbound = render({
        items: calls,
        parts: undefined,
        presentation: { ...presentation, identityKnown: false },
        onOpenSubagents: () => {},
      });
      expect(unbound).toContain('data-step-id="tool:list-completed"');
      expect(unbound).not.toContain('个智能体');
    },
  );
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
    const html = render({
      traceStatus: 'failed',
      children: <p>继续读取的历史说明</p>,
    });
    expect(html).toContain('data-process-open="false"');
    expect(html).toMatch(/data-work-reply="progress"[^>]* hidden=""/);
    expect(html).toMatch(/data-work-reply="final-reply"[^>]*>/);
    expect(html).not.toMatch(/data-work-reply="final-reply"[^>]* hidden/);
    expect(html).toContain('最终交付');
    expect(html.match(/data-work-reply="final-reply"/g)).toHaveLength(1);
    expect(html.lastIndexOf('</section>')).toBeLessThan(
      html.indexOf('data-work-reply="final-reply"'),
    );
    const region = html.match(/<section[^>]*aria-label="工作过程"[^>]*>/)![0];
    const owned = region.match(/aria-owns="([^"]+)"/)![1]!.split(' ');
    const members = [
      ...html.matchAll(/<div[^>]*data-process-member="true"[^>]*>/g),
    ];
    const memberIds = members.map(([tag]) => tag.match(/ id="([^"]+)"/)![1]!);
    expect(owned).toEqual(memberIds);
    expect(new Set(owned).size).toBe(4);
    expect(members[0]![0]).toContain('data-work-reply="progress"');
    expect(html).toContain('过程加载失败，点击重试');
    expect(html).toContain('继续读取的历史说明');
    const finalTag = html.match(
      /<div[^>]*data-work-reply="final-reply"[^>]*>/,
    )![0];
    expect(finalTag).not.toContain('data-process-member');
    expect(owned).not.toContain(finalTag.match(/ id="([^"]+)"/)![1]);
    for (const id of owned) {
      expect(html.split(`id="${id}"`)).toHaveLength(2);
      expect(html.indexOf(`id="${id}"`)).toBeLessThan(
        html.indexOf('data-work-reply="final-reply"'),
      );
    }
    expect(html.indexOf(`id="${owned[1]}"`)).toBeLessThan(
      html.indexOf('data-step-id="tool:read"'),
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
