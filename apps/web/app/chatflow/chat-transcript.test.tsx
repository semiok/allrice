import { createRef, type ComponentProps } from 'react';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscript } from './chat-transcript';
import type { Message } from './chatflow-types';
import type {
  ChatFlowEventEnvelope,
  InteractionStatus,
} from '@allrice/contracts';

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
  panels.cloud.mockImplementation(
    ({ children }) =>
      children?.({
        operations: [],
        renderOperation: () => null,
        feedback: null,
      }) ?? null,
  );
  return renderToStaticMarkup(
    <ChatTranscript
      streamingOutput
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
  it('folds an actual scheduled wake without presenting internal instructions as human prose', () => {
    const text = '这项周期任务本期已经到期，请现在执行原始要求中的工作。';
    const wake: Message = {
      ...messages[0]!,
      role: 'user',
      content: { text },
      source: {
        kind: 'schedule',
        taskId: randomUUID(),
        occurrenceId: randomUUID(),
        scheduledAt: messages[0]!.createdAt,
      },
    };
    const scheduled = render(false, [wake, messages[0]!]);
    expect(scheduled).toContain('data-turn-trigger="true"');
    expect(scheduled).toContain('自动化任务');
    expect(scheduled).toContain('aria-expanded="false"');
    expect(scheduled).not.toContain(text);
    expect(scheduled).toContain('An existing answer');
    // Identical words from a real human must remain a normal, visible message.
    const human = render(false, [{ ...wake, source: undefined }]);
    expect(human).toContain(text);
    expect(human).not.toContain('data-turn-trigger');
  });
  it.each(['Rice 暂时无法完成这次请求，请稍后重试。', '已查到四个 PR。'])(
    'explains a masked disconnect while retaining completed content (%s)',
    (text) => {
      const html = render(
        false,
        [
          {
            ...messages[0]!,
            status: 'failed',
            errorCode: 'DSH_UNKNOWN',
            content: { text },
          },
        ],
        [],
        {
          runTraces: {
            'run-0': {
              status: 'loaded',
              events: [
                {
                  schemaVersion: 3,
                  eventId: 'failed-event',
                  organizationId: 'org',
                  workspaceId: 'workspace',
                  conversationId: 'session',
                  runId: 'run-0',
                  generation: 1,
                  cursor: 'run-0:1',
                  harness: 'dsh',
                  occurredAt: messages[0]!.createdAt,
                  sourceEvent: null,
                  sequence: 1,
                  type: 'turn.failed',
                  payload: {
                    threadId: 'dsh-root',
                    assistantDiagnostics: {
                      version: 1,
                      truncated: false,
                      failures: [
                        {
                          nativeSessionId: 'dsh-root',
                          callId: randomUUID(),
                          phase: 'finish',
                          code: 'TRANSPORT',
                          stopKind: 'error',
                          inputUsageKnown: false,
                          outputUsageKnown: false,
                          settlementConfirmed: true,
                        },
                      ],
                    },
                  },
                },
                {
                  schemaVersion: 3,
                  eventId: 'run-failed-event',
                  organizationId: 'org',
                  workspaceId: 'workspace',
                  conversationId: 'session',
                  runId: 'run-0',
                  generation: 1,
                  cursor: 'run-0:2',
                  harness: 'dsh',
                  occurredAt: messages[0]!.createdAt,
                  sourceEvent: null,
                  sequence: 2,
                  type: 'run.failed',
                  payload: {
                    code: 'DSH_UNKNOWN',
                    message: 'assistant_model_unknown_no_replay',
                  },
                },
              ],
            },
          },
        },
      );
      expect(html).toContain('连接中断，这次未完成');
      expect(html).not.toContain('Rice 暂时无法完成');
      expect(html).not.toContain('可以换个说法再试');
      if (text === '已查到四个 PR。') expect(html).toContain(text);
    },
  );
  it('retains the completed reply and explains a subsequent model disconnect', () => {
    const html = render(false, [
      {
        ...messages[0]!,
        status: 'failed',
        errorCode: 'DSH_TRANSPORT',
        content: { text: '已查到两项 CI 失败。' },
      },
    ]);
    expect(html).toContain('已查到两项 CI 失败。');
    expect(html).toContain('连接中断，这次未完成');
    expect(html).toContain('已有的内容都保留了');
    expect(html).not.toContain('可以换个说法再试');
  });

  afterEach(() => vi.clearAllMocks());

  it.each([false, true])(
    'retains tool-only history steps before the saved answer with streaming=%s',
    (streamingOutput) => {
      const text = '已完成历史资料检查。';
      const events: ChatFlowEventEnvelope[] = [
        {
          schemaVersion: 3,
          eventId: 'historical-read',
          organizationId: 'org',
          workspaceId: 'workspace',
          conversationId: 'session',
          runId: 'run-0',
          generation: 1,
          cursor: 'run-0:1',
          harness: 'dsh',
          occurredAt: messages[0]!.createdAt,
          sourceEvent: null,
          sequence: 1,
          type: 'tool.completed',
          payload: {
            toolCallId: 'read',
            name: 'read',
            summary: '已读取历史资料',
          },
        },
        {
          schemaVersion: 3,
          eventId: 'historical-failed-tool',
          organizationId: 'org',
          workspaceId: 'workspace',
          conversationId: 'session',
          runId: 'run-0',
          generation: 1,
          cursor: 'run-0:2',
          harness: 'dsh',
          occurredAt: messages[0]!.createdAt,
          sourceEvent: null,
          sequence: 2,
          type: 'tool.failed',
          payload: {
            toolCallId: 'query',
            name: 'market.quote',
            summary: '行情服务超时',
          },
        },
      ];
      const overrides = {
        streamingOutput,
        runTraces: { 'run-0': { status: 'loaded' as const, events } },
      };
      const history = [{ ...messages[0]!, content: { text } }];
      const folded = render(false, history, [], overrides);
      expect(folded).toContain('aria-label="工作步骤"');
      expect(folded).toContain('1 次未成功');
      expect(folded.split(text)).toHaveLength(2);

      const expanded = render(false, history, [], {
        ...overrides,
        transcriptView: 'verbose',
      });
      expect(expanded).toContain('已读取历史资料');
      expect(expanded).toContain('行情服务超时');
      expect(expanded.indexOf('已读取历史资料')).toBeLessThan(
        expanded.indexOf(text),
      );
      expect(expanded.split(text)).toHaveLength(2);
    },
  );

  it.each(['completed', 'failed'] as const)(
    'does not present settled %s history as running during a stale connection',
    (status) => {
      const html = render(false, [{ ...messages[0]!, status }], [], {
        runViews: {
          'run-0': {
            runId: 'run-0',
            status: 'connecting',
            cursor: null,
            reconnects: 1,
            events: [],
          },
        },
      });
      expect(html).not.toContain('思考中');
      expect(html).not.toContain('data-working="true"');
      expect(html).not.toContain('重新连接并恢复执行记录');
    },
  );

  it('keeps the native footer clock: time today, date and time for older replies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 18));
    try {
      for (const [date, label] of [
        [new Date(2026, 8, 27, 16, 37), '16:37'],
        [new Date(2026, 8, 8, 16, 37), '9月8日 16:37'],
        [new Date(2025, 8, 8, 16, 37), '2025年9月8日 16:37'],
      ] as const) {
        const html = render(false, [
          { ...messages[0]!, createdAt: date.toISOString() },
        ]);
        expect(html).toContain(`>${label}</span>`);
        expect(html).not.toContain('<time>');
        expect(html.match(/16:37/g)).toHaveLength(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

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
    // Native shimmer repeats presentation text in a hidden data attribute.
    expect(html.match(/>思考中…</g)).toHaveLength(1);
    expect(html).toContain('data-shimmer-text="思考中…"');
    expect(html).not.toContain('Rice');
    expect(html).not.toContain('助手任务');
  });
  it('shows native compaction while history is collapsed and clears it after completion or failure', () => {
    const event = (
      sequence: number,
      status: 'started' | 'updated' | 'completed' | 'failed',
      phase: string,
    ): ChatFlowEventEnvelope => ({
      schemaVersion: 3,
      eventId: `compact-${sequence}`,
      organizationId: 'org',
      workspaceId: 'workspace',
      conversationId: 'session',
      runId: 'run-0',
      generation: 1,
      cursor: `run-0:${sequence}`,
      harness: 'dsh',
      occurredAt: messages[0]!.createdAt,
      sequence,
      sourceEvent: {
        id: `dsh:${sequence}`,
        type: `compaction/${phase}`,
        occurredAt: messages[0]!.createdAt,
        payload: phase === 'prune' ? {} : { compactionId: 'compact-1' },
      },
      type: 'harness.native',
      payload: { presentation: 'compaction', status, label: '上下文整理' },
    });
    const show = (events: ChatFlowEventEnvelope[]) =>
      render(
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
          transcriptView: 'standard',
          runViews: {
            'run-0': {
              runId: 'run-0',
              status: 'running',
              cursor: null,
              reconnects: 0,
              events,
            },
          },
        },
      );
    const earlierReply: ChatFlowEventEnvelope = {
      ...event(0, 'completed', 'end'),
      type: 'assistant.text.delta',
      sourceEvent: null,
      payload: {
        replyId: 'first',
        text: '我先检查项目。',
        textMode: 'replace',
      },
    };
    const interleaved = show([earlierReply, event(1, 'started', 'start')]);
    expect(interleaved.match(/>正在整理对话…</g)).toHaveLength(1);
    expect(interleaved).not.toContain('回复中…');
    expect(interleaved).toContain('我先检查项目。');
    expect(interleaved).toContain('整理 · 1 项');
    const events = [event(1, 'started', 'start')];
    expect(show(events)).toContain('正在整理对话…');
    expect(show(events)).not.toContain('aria-expanded="true"');
    events.push(event(2, 'updated', 'summary'));
    expect(show(events)).toContain('正在整理对话…');
    for (const status of ['completed', 'failed'] as const) {
      const html = show([...events, event(3, status, 'end')]);
      expect(html).not.toContain('正在整理对话…');
      expect(html).toContain('思考中…');
    }
    expect(show([event(4, 'completed', 'prune')])).not.toContain(
      '正在整理对话…',
    );
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
  it('shows elapsed time once without allowing an empty work process to expand', () => {
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
    for (const text of ['工作过程', '用时 40分 12秒'])
      expect(html).toContain(text);
    expect(html).not.toContain('模型请求尝试');
    expect(html).not.toContain('策略来源');
    expect(html).toContain('本轮运行时间');
    expect(html).not.toContain('aria-expanded');
    expect(html.match(/用时 /g)).toHaveLength(1);
    expect(html).not.toContain('<time>');
    expect(html).not.toContain('助手任务');
  });

  it('shows execution with compact steps and waiting from the authoritative clock', () => {
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
        transcriptView: 'compact',
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
    expect(executing).not.toContain('查询实时行情');
    expect(executing).not.toContain('market.quote');
  });
  it('does not borrow another Run clock or invent timing for historical Runs', () => {
    expect(render(false, [messages[0]!])).not.toContain('用时');
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
    ).not.toContain('用时');
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
        expect(html).not.toContain('工作量太大');
      }
      for (const word of ['Token', 'Codex', '这次未完成'])
        expect(html).not.toContain(word);
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
      expect(html).not.toContain('工作量太大');
      expect(html).not.toContain('未完成');
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
      expect(html).toContain('未完成');
      for (const word of ['Token', 'Codex', '没有完成'])
        expect(html).not.toContain(word);
    },
  );

  it.each([
    ['MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED', '把任务拆小一点'],
    ['ASSISTANT_EXECUTION_UNRESOLVED', '结果待确认，请刷新查看'],
    ['RATE_LIMITED', '可以换个说法再试'],
  ])(
    'says once what happened and what to do next for %s',
    (errorCode, next) => {
      const html = render(false, [
        {
          ...messages[0]!,
          status: 'failed',
          errorCode,
          content: { text: 'Rice 暂时无法完成这次请求，请稍后重试。' },
        },
      ]);
      expect(html.split(next)).toHaveLength(2);
      for (const word of ['Rice 暂时无法', '待核实', 'Token', 'Codex'])
        expect(html).not.toContain(word);
    },
  );

  it('names an unlabeled knowledge source in words, not a code', () => {
    const html = render(false, [
      {
        ...messages[0]!,
        content: {
          text: 'An existing answer',
          citations: [
            {
              type: 'knowledge',
              id: 'k-1',
              label: '销售手册',
              reference: { kind: 'knowledge', id: 'k-1' },
            },
          ],
        },
      } as unknown as Message,
    ]);
    expect(html).toContain('参考资料 1');
    expect(html).not.toContain('[K1]');
  });

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

it('keeps the saved answer and explains a failed GitHub call without looking active', () => {
  const html = render(
    false,
    [
      {
        ...messages[0]!,
        status: 'failed',
        errorCode: 'ASSISTANT_EXECUTION_UNRESOLVED',
        applicationFailure: 'github_merge_permission',
        content: { text: 'Saved final explanation' },
      },
    ],
    [],
    {
      runTraces: { 'run-0': { status: 'loaded', events: [] } },
    },
  );
  expect(html).toContain('Saved final explanation');
  expect(html).toContain('GitHub 权限不足');
  expect(html.indexOf('本轮已结束')).toBeLessThan(
    html.indexOf('Saved final explanation'),
  );
  expect(html.match(/本轮已结束/g)).toHaveLength(1);
  expect(html).toContain('本轮已结束');
  expect(html).toContain('Contents');
  expect(html).not.toContain('部分调用的执行状态未能确认');
  expect(html).not.toContain('data-working="true"');
  expect(html).not.toContain('重新连接并恢复执行记录');
});
