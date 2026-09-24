import { createRef, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from './chat-transcript';
import type { Message } from './chatflow-types';
import type { InteractionStatus } from '@allrice/contracts';

const panels = vi.hoisted(() => ({ local: vi.fn(), cloud: vi.fn() }));
vi.mock('./local-command-panel', () => ({ LocalCommandPanel: panels.local }));
vi.mock('./cloud-operation-panel', () => ({
  CloudOperationPanel: panels.cloud,
}));

const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
  id: `message-${index}`,
  role: 'assistant',
  content: { text: 'An existing answer' },
  status: 'completed',
  runId: `run-${index}`,
  createdAt: '2026-09-08T11:00:00Z',
}));
function render(
  enabled?: boolean,
  shownMessages = messages,
  runTimings?: InteractionStatus['runTimings'],
  overrides: Partial<ComponentProps<typeof ChatTranscript>> = {},
) {
  panels.local.mockReturnValue(null);
  panels.cloud.mockReturnValue(null);
  return renderToStaticMarkup(
    <ChatTranscript
      atBottom
      localCommandsEnabled={enabled}
      messages={shownMessages}
      runTimings={runTimings}
      runTraces={{}}
      runViews={{}}
      tenantHeaders={{}}
      transcriptColumn={createRef<HTMLDivElement>()}
      workspaceId="synthetic-workspace"
      onLoadRunTrace={() => {}}
      onRecoverRun={() => {}}
      onScrollToBottom={() => {}}
      {...overrides}
    />,
  );
}
describe('historical transcript capability gating', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows the configured employee and only one thinking status before any output', () => {
    const html = render(
      false,
      [
        {
          ...messages[0]!,
          status: 'pending',
          content: { text: 'Rice 正在处理…' },
        },
      ],
      undefined,
      { employeeName: 'Alan' },
    );
    expect(html).toContain('Alan');
    expect(html.match(/思考中…/g)).toHaveLength(1);
    expect(html).not.toContain('Rice');
    expect(html).not.toContain('助手任务');
  });
  it('removes placeholder text and microstatus while streaming, but retains a cursor and actual output', () => {
    const html = render(
      false,
      [
        {
          ...messages[0]!,
          status: 'pending',
          content: { text: 'Rice 正在处理…' },
        },
      ],
      undefined,
      {
        runViews: {
          'run-0': {
            runId: 'run-0',
            status: 'running',
            cursor: null,
            reconnects: 0,
            events: [
              {
                schemaVersion: 3,
                eventId: 'event-1',
                organizationId: 'org',
                workspaceId: 'workspace',
                conversationId: 'session',
                runId: 'run-0',
                generation: 1,
                cursor: 'run-0:1',
                harness: 'dsh',
                occurredAt: messages[0]!.createdAt,
                sourceEvent: null,
                type: 'assistant.text.delta',
                payload: { text: '已有结论' },
                sequence: 1,
              },
            ],
          },
        },
      },
    );
    expect(html).toContain('已有结论');
    expect(html).toContain('data-streaming="true"');
    expect(html).not.toContain('思考中');
    expect(html).not.toContain('正在生成回复');
    expect(html).not.toContain('Rice 正在处理');
  });
  it('shows only server elapsed time in a collapsed ordinary Run without model accounting', () => {
    const html = render(
      false,
      [messages[0]!],
      [
        {
          runId: 'run-0',
          timing: {
            activeMs: 12460,
            waitingMs: 2400000,
            wallMs: 2412460,
            timeoutMs: 0,
            remainingMs: null,
            phase: 'waiting',
            sources: [{ scope: 'user', timeoutMs: 0 }],
            calls: null,
          },
        },
      ],
    );
    for (const text of [
      '工作过程',
      '总耗时 40 分 12 秒',
      'aria-expanded="false"',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('模型请求尝试');
    expect(html).not.toContain('策略来源');
    expect(html).toContain('本轮运行时间');
    expect(html).not.toContain('助手任务');
  });

  it('shows execution for actual tool work and waiting from the authoritative clock', () => {
    const run = {
      runId: 'run-0',
      status: 'running' as const,
      cursor: null,
      reconnects: 0,
      events: [],
    };
    const waiting = render(
      false,
      [{ ...messages[0]!, status: 'pending' }],
      [
        {
          runId: 'run-0',
          timing: {
            activeMs: 1000,
            waitingMs: 2000,
            wallMs: 3000,
            timeoutMs: 3600000,
            remainingMs: 3599000,
            phase: 'waiting',
            sources: [],
            calls: null,
          },
        },
      ],
      { runViews: { 'run-0': run } },
    );
    expect(waiting).toContain('等待处理…');
    expect(waiting).not.toContain('思考中…');
    const executing = render(
      false,
      [{ ...messages[0]!, status: 'pending' }],
      undefined,
      {
        runTraces: {
          'run-0': {
            status: 'loaded',
            events: [
              {
                schemaVersion: 3,
                eventId: 'event-1',
                organizationId: 'org',
                workspaceId: 'workspace',
                conversationId: 'session',
                runId: 'run-0',
                generation: 1,
                cursor: 'run-0:1',
                sequence: 1,
                harness: 'dsh',
                occurredAt: messages[0]!.createdAt,
                sourceEvent: null,
                type: 'tool.started',
                payload: { toolCallId: 'tool-1', name: 'market.quote' },
              },
            ],
          },
        },
      },
    );
    expect(executing).toContain('执行中…');
    expect(executing).toContain('查询实时行情');
    expect(executing).not.toContain('market.quote');
  });
  it('does not borrow another Run clock or invent timing for historical Runs', () => {
    expect(render(false, [messages[0]!])).not.toContain('总耗时');
    expect(
      render(
        false,
        [messages[0]!],
        [
          {
            runId: 'another-run',
            timing: {
              activeMs: 1,
              waitingMs: 0,
              wallMs: 1,
              timeoutMs: 3600000,
              remainingMs: 3599999,
              phase: 'active',
              sources: [],
              calls: null,
            },
          },
        ],
      ),
    ).not.toContain('总耗时');
  });

  it.each(['failed', 'completed'] as const)(
    'keeps the answer and only explains a recovered historical failure (%s)',
    (status) => {
      const html = render(false, [
        {
          ...messages[0]!,
          status,
          errorCode:
            status === 'failed' ? 'MODEL_OUTPUT_BUDGET_EXCEEDED' : null,
          content: {
            text: 'Preserved complete answer',
            budgetWarning: 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
          },
        },
      ]);
      expect(html).toContain('Preserved complete answer');
      if (status === 'failed') {
        expect(html).toContain('答案已保留');
      } else {
        expect(html).not.toContain('答案已保留');
        expect(html).not.toContain('超过平台内部预期');
        expect(html).not.toContain('周额度');
      }
      expect(html).not.toContain('这次没有完成');
    },
  );

  it('does not warn for either kind of completed internal budget overrun', () => {
    for (const budgetWarning of [
      'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
      'MODEL_OUTPUT_BUDGET_EXCEEDED',
    ] as const) {
      const html = render(false, [
        {
          ...messages[0]!,
          content: { text: 'Normal completed answer', budgetWarning },
        },
      ]);
      expect(html).toContain('Normal completed answer');
      expect(html).not.toContain('超过平台内部预期');
      expect(html).not.toContain('这次没有完成');
    }
  });

  it.each(['MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED', 'TIMEOUT', 'RATE_LIMITED'])(
    'keeps real failures visible: %s',
    (errorCode) => {
      const html = render(false, [
        {
          ...messages[0]!,
          status: 'failed',
          errorCode,
        },
      ]);
      expect(html).toContain('这次没有完成');
    },
  );

  it.each([undefined, false])(
    'never mounts a local request panel while disabled (%s)',
    (enabled) => {
      expect(render(enabled)).toContain('An existing answer');
      expect(panels.local).not.toHaveBeenCalled();
      // Cloud history stays readable when new execution is OFF.
      expect(panels.cloud).toHaveBeenCalledTimes(20);
    },
  );

  it('preserves command approval/history panels when all server flags allow the route', () => {
    render(true);
    expect(panels.local).toHaveBeenCalledTimes(20);
    expect(panels.local.mock.calls[0]![0]).toMatchObject({
      runId: 'run-0',
      runActive: false,
    });
  });
});
