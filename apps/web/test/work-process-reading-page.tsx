// Real transcript, native projection, receipt polling and approval HTTP path.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '../app/styles/auth.css';
import '@allrice/ui/styles.css';
import { createRoot } from 'react-dom/client';
import { createRef, useState } from 'react';
import type {
  ChatFlowEventEnvelope,
  UserPreferences,
  UserQuestionRequest,
} from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import type { Message } from '../app/chatflow/chatflow-types';
import { InputStatusContext } from '../app/chatflow/transcript-user-message';
import {
  UserQuestionComposer,
  userQuestionAnswerText,
} from '../app/chatflow/user-question-composer';
import { projectPendingUserQuestion } from '../lib/chatflow/user-question-state';
import { applyTheme } from '../lib/theme/theme';
import { cloudOperations, ids } from './technical-details-fixtures';

type Stage = 'initial' | 'prefix' | 'split' | 'merge' | 'append';
const at = new Date().toISOString();
const memoryScenario = new URLSearchParams(location.search).has('memory');
const processScenario = new URLSearchParams(location.search).has('process');
const longField = '核对这次对外发送的内容及附件。'.repeat(60);
const longOutput = Array.from(
  { length: 160 },
  (_, i) =>
    `结果第 ${String(i).padStart(3, '0')} 行：核对记录的原文与对应动作。`,
).join('\n');
const samples = cloudOperations([]);
let stage: Stage = 'initial';
let changed = false;
let answered = false;
let appended = false;
const operation = (i: number): CloudOperationView => {
  const sample = samples[1]!;
  return {
    ...sample,
    nativeCallId: `call-${i}`,
    createdAt: at,
    proposal: {
      ...sample.proposal,
      arguments: { body: longField, channel: 'sales' },
    },
    snapshot: {
      ...sample.snapshot,
      status: i === 0 && !answered ? 'waiting_user' : 'succeeded',
      binding: {
        ...sample.snapshot.binding,
        attempt: { operationId: `reading-${i}` },
      },
    },
    approval:
      i === 0
        ? {
            ...sample.approval,
            response: answered ? { decision: 'approved' } : null,
          }
        : null,
    result:
      i === 0
        ? null
        : {
            code: 'OK',
            output: changed ? `内容已更新\n${longOutput}` : longOutput,
            trusted: true,
          },
  } as CloudOperationView;
};
function eventsFor(runId: string): ChatFlowEventEnvelope[] {
  const events: ChatFlowEventEnvelope[] = [];
  const add = (
    type: ChatFlowEventEnvelope['type'],
    payload: Record<string, unknown>,
  ) => {
    const seq = events.length + 1;
    events.push({
      schemaVersion: 3,
      eventId: `event-${seq}`,
      organizationId: ids.user,
      workspaceId: ids.workspace,
      conversationId: ids.session,
      runId,
      generation: 0,
      cursor: `${runId}:${seq}`,
      sequence: seq,
      harness: 'dsh',
      sourceEvent: null,
      occurredAt: at,
      type,
      payload,
    });
  };
  if (memoryScenario) {
    for (let i = 0; i < 5; i++) {
      add('harness.native', {
        presentation: 'compaction',
        status: 'completed',
        label: '工具结果已精简',
      });
      events.at(-1)!.sourceEvent = {
        id: `prune-${i}`,
        type: 'compaction/prune',
        occurredAt: at,
        payload: { entries: [], tokensPruned: 100 },
      };
    }
    add('tool.started', {
      toolCallId: 'memory',
      name: 'workspace.memory.remember',
    });
    add('tool.completed', {
      toolCallId: 'memory',
      name: 'workspace.memory.remember',
    });
    add('assistant.text.completed', {
      replyId: 'answer',
      text: '这次记忆请求已处理。',
    });
    return events;
  }
  if (stage !== 'initial')
    add('harness.native', { presentation: 'think', status: 'completed' });
  for (let i = 0; i < (appended ? 37 : 36); i++) {
    if (stage === 'split' && i === (appended ? 36 : 4))
      add('assistant.text.delta', {
        replyId: 'middle',
        text: '补充发现：继续核对后半部分。',
      });
    const payload = {
      toolCallId: `call-${i}`,
      name: 'cloud_mcp_call',
      summary: `核对第 ${i} 项资料`,
    };
    add('tool.started', payload);
    if (i !== 0) add('tool.completed', payload);
  }
  add('assistant.text.completed', {
    replyId: 'answer',
    text: '最后结论保留在这里。',
  });
  return events;
}
declare global {
  interface Window {
    readingUpdate: (stage: Stage, changed?: boolean) => void;
    readingRun: (run: string) => void;
    readingMount: (mounted: boolean) => void;
    readingWrites: { url: string; body: Record<string, unknown> }[];
    processAdopt: () => void;
    processTrace: () => void;
    processFinish: () => void;
    processView: (view: UserPreferences['transcriptView']) => void;
  }
}
window.readingWrites = [];
window.fetch = async (input, init) => {
  const url = String(input);
  if (processScenario && url.startsWith('/api/v1/files?'))
    return Response.json({
      files: [
        {
          id: ids.artifact,
          fileName: '核对结果.csv',
          mediaType: 'text/csv',
          sizeBytes: 32,
          visibility: 'private',
          ownedByMe: true,
          category: 'exports',
          deliverableVersion: 1,
        },
      ],
    });
  if (memoryScenario && url.startsWith('/api/v1/memories?'))
    return Response.json({ memories: [] });
  if (url.startsWith('/api/v1/runtime/cloud-operations'))
    return Response.json({
      operations: Array.from(
        { length: memoryScenario || processScenario ? 0 : appended ? 37 : 36 },
        (_, i) => operation(i),
      ),
    });
  if (url.startsWith('/api/v1/runtime/approvals/')) {
    window.readingWrites.push({ url, body: JSON.parse(String(init?.body)) });
    answered = true;
    return Response.json({});
  }
  return Response.json({});
};
const headers = {};
const column = createRef<HTMLDivElement>();
const user: Message = {
  id: 'user',
  role: 'user',
  content: {
    text: memoryScenario
      ? '我喜欢的球队是利物浦，记下来'
      : '帮我核对这些资料，发送之前先给我看。',
  },
  status: 'completed',
  runId: null,
  createdAt: at,
};
function Fixture() {
  const [current, setCurrent] = useState<Stage>(stage);
  const [run, setRun] = useState<string>(ids.run);
  const [mounted, setMounted] = useState(true);
  window.readingUpdate = (next, replace = false) => {
    stage = next;
    if (next === 'append') appended = true;
    changed = replace;
    setCurrent(next);
  };
  window.readingRun = setRun;
  window.readingMount = setMounted;
  const events = eventsFor(run);
  return (
    <main
      data-stage={current}
      data-run={run}
      style={{
        maxWidth: 780,
        margin: '0 auto',
        padding: 16,
        fontFamily: 'var(--dsw-font-family)',
      }}
    >
      {!memoryScenario && (
        <label>
          另外阅读的位置 <input aria-label="另外阅读的位置" />
        </label>
      )}
      {mounted && (
        <ChatTranscript
          atBottom
          streamingOutput
          transcriptView="standard"
          collapseTiming="completion"
          messages={[
            user,
            {
              ...user,
              id: 'assistant',
              role: 'assistant',
              runId: run,
              content: {
                text: memoryScenario
                  ? '这次记忆请求已处理。'
                  : '最后结论保留在这里。',
              },
            },
          ]}
          runTraces={{ [run]: { status: 'loaded', events } }}
          runViews={{}}
          tenantHeaders={changed ? { 'x-fixture-content': 'changed' } : headers}
          transcriptColumn={column}
          workspaceId={ids.workspace}
          onLoadRunTrace={() => {}}
          onRecoverRun={() => {}}
          onScrollToBottom={() => {}}
        />
      )}
    </main>
  );
}

// Same callId and question wording in two native Sessions must keep their own answers.
const processLabels = [
  '只读检查（推荐）',
  '已提交范围',
  '未知范围',
  '被拒范围',
  '待答范围',
  '无归属范围',
  '身份不符范围',
  '另一会话范围',
];
const processRequests: UserQuestionRequest[] = [
  'accepted',
  'submitted',
  'unknown',
  'rejected',
  'pending',
  'orphan',
  'invalid',
  'accepted',
].map((callId, index) => {
  const nativeSessionId = `dsh-${index === 7 ? ids.runningRun : ids.session}`;
  return {
    nativeSessionId,
    callId,
    durable: true,
    questionId: `${nativeSessionId}:${callId}`,
    questions: [
      {
        id: 'scope',
        header: '核对范围',
        question: '核对哪些资料？',
        multiSelect: false,
        options: [{ label: processLabels[index]! }],
      },
      ...(index === 0
        ? [{ id: 'notify', question: '是否通知合作方？', multiSelect: false }]
        : []),
    ],
  };
});
const processResult = `最终核对结果。\n\n| 项目 | 数量 |\n| --- | --- |\n| 已核对 | 12 |\n\n[核对结果.csv](/api/v1/files/${ids.artifact}/download)`;
type Terminal = 'failed' | 'completed' | 'canceled';
function processEvents(
  runId: string,
  indices: number[],
  result?: string,
  terminal?: Terminal,
) {
  const events: ChatFlowEventEnvelope[] = [];
  const add = (
    type: ChatFlowEventEnvelope['type'],
    payload: Record<string, unknown>,
    sourceEvent: Pick<
      NonNullable<ChatFlowEventEnvelope['sourceEvent']>,
      'type' | 'payload'
    > | null = null,
  ) => {
    const sequence = events.length + 1;
    const occurredAt = new Date(Date.parse(at) + sequence * 800).toISOString();
    events.push({
      schemaVersion: 3,
      eventId: `20000000-0000-4000-8000-${runId.slice(-6)}${String(sequence).padStart(6, '0')}`,
      organizationId: ids.user,
      workspaceId: ids.workspace,
      conversationId: ids.session,
      runId,
      generation: 0,
      cursor: `${runId}:${sequence}`,
      sequence,
      harness: 'dsh',
      occurredAt,
      type,
      payload,
      sourceEvent: sourceEvent
        ? { id: `${runId}:${sequence}`, occurredAt, ...sourceEvent }
        : null,
    });
  };
  add('turn.started', { turnId: 'process-turn' });
  if (runId === ids.run) {
    for (const [toolCallId, name, activityDetail, end, summary] of [
      [
        'search',
        'web.search',
        `搜索资料：${'核对本周销售与交付记录。'.repeat(8)}`,
        'tool.completed',
        '已找到十二项对应资料',
      ],
      ['failed', 'market.quote', '查询实时行情', 'tool.failed', '服务超时'],
      ['unsettled', 'local.fs.read', '读取核对记录', null, undefined],
    ] as const) {
      add(
        'tool.started',
        { toolCallId, name },
        {
          type: 'tool/call',
          payload: { callId: toolCallId, name, activityDetail },
        },
      );
      if (end) add(end, { toolCallId, name, summary });
    }
  }
  for (const index of indices) {
    const request = processRequests[index]!;
    add('tool.started', {
      toolCallId: request.callId,
      name: 'ask_user_question',
    });
    add(
      'harness.native',
      { turnId: 'process-turn' },
      {
        type: 'session/user-question',
        payload:
          index === 6
            ? { ...request, nativeSessionId: 'different-session' }
            : request,
      },
    );
    if (index !== 4 || terminal)
      add(
        index === 4 ? 'tool.completed' : 'tool.failed',
        { toolCallId: request.callId, name: 'ask_user_question' },
        index === 4
          ? null
          : { type: 'tool/call', payload: { questionWait: true } },
      );
  }
  if (result) {
    add('assistant.text.delta', {
      replyId: `answer-${runId}`,
      text: result,
    });
    add('assistant.text.completed', {
      replyId: `answer-${runId}`,
      text: result,
    });
    add('run.succeeded', {});
  }
  if (terminal)
    add(
      terminal === 'completed'
        ? 'run.succeeded'
        : terminal === 'canceled'
          ? 'run.canceled'
          : 'run.failed',
      {},
    );
  return events;
}
const processTraces = {
  [ids.run]: {
    status: 'loaded' as const,
    events: processEvents(ids.run, [0, 1, 2, 3, 6], processResult),
  },
  [ids.succeededOperation]: {
    status: 'loaded' as const,
    events: processEvents(ids.succeededOperation, [7], '另一会话的最终结果。'),
  },
  [ids.runningRun]: {
    status: 'loaded' as const,
    events: processEvents(ids.runningRun, [4]),
  },
};
function ProcessFixture() {
  const params = new URLSearchParams(location.search);
  const terminal = params.get('terminal') as Terminal | null;
  const [adopted, setAdopted] = useState(false);
  const [traceLoaded, setTraceLoaded] = useState(!params.has('late'));
  const [finished, setFinished] = useState(!params.has('running'));
  const [view, setView] = useState<UserPreferences['transcriptView']>(
    params.has('verbose')
      ? 'verbose'
      : params.has('standard')
        ? 'standard'
        : 'detailed',
  );
  window.processAdopt = () => setAdopted(true);
  window.processTrace = () => setTraceLoaded(true);
  window.processFinish = () => setFinished(true);
  window.processView = setView;
  const full = processTraces[ids.run]!;
  const early = params.has('partial')
    ? full.events.slice(
        0,
        full.events.findIndex((event) => event.type === 'assistant.text.delta'),
      )
    : full.events;
  const events = !traceLoaded
    ? params.has('empty')
      ? []
      : early.filter(
          (event) => event.sourceEvent?.type !== 'session/user-question',
        )
    : finished
      ? full.events
      : full.events.filter(
          (event) =>
            !['assistant.text.completed', 'run.succeeded'].includes(event.type),
        );
  const answers = processRequests.flatMap((request, index): Message[] => {
    if (index === 4) return [];
    const answer = {
      questionId: request.questionId,
      answers: request.questions.map((question, item) => ({
        id: question.id,
        selected: item ? [] : [processLabels[index]!],
      })),
    };
    return [
      {
        ...user,
        id: `answer-${index}`,
        answerStatus: (['adopted', 'pending', 'unknown', 'rejected'][index] ??
          'adopted') as Message['answerStatus'],
        content: {
          text: userQuestionAnswerText(request.questions, answer),
          interaction: { type: 'user_question_answer', answer },
        },
      },
    ];
  });
  const pending = projectPendingUserQuestion(
    processTraces[ids.runningRun]!.events,
  )!;
  return (
    <main
      data-process-fixture
      style={{
        maxWidth: 780,
        width: '100%',
        boxSizing: 'border-box',
        margin: '0 auto',
        padding: 16,
      }}
    >
      <InputStatusContext.Provider
        value={new Map([['answer-1', adopted ? 'adopted' : 'pending']])}
      >
        <ChatTranscript
          atBottom
          streamingOutput
          transcriptView={view}
          collapseTiming={params.has('partial') ? 'completion' : 'next-input'}
          messages={[
            user,
            ...[ids.run, ids.succeededOperation, ids.runningRun].map(
              (runId): Message => ({
                ...user,
                id: runId,
                role: 'assistant',
                runId,
                status:
                  runId === ids.runningRun &&
                  terminal &&
                  terminal !== 'canceled'
                    ? terminal
                    : runId === ids.runningRun ||
                        (runId === ids.run && !finished)
                      ? 'pending'
                      : 'completed',
                content: {
                  text:
                    runId === ids.run
                      ? processResult
                      : runId === ids.runningRun
                        ? terminal
                          ? '本轮已结束。'
                          : ''
                        : '另一会话的最终结果。',
                },
              }),
            ),
            ...answers,
          ]}
          runTraces={{
            ...processTraces,
            [ids.run]: { ...full, events },
            ...(terminal
              ? {
                  [ids.runningRun]: {
                    status: traceLoaded ? 'loaded' : 'loading',
                    events: traceLoaded
                      ? processEvents(ids.runningRun, [4], undefined, terminal)
                      : [],
                  },
                }
              : {}),
          }}
          runViews={
            terminal
              ? {
                  [ids.runningRun]: {
                    runId: ids.runningRun,
                    status: terminal,
                    cursor: null,
                    reconnects: 0,
                    events: processTraces[ids.runningRun]!.events,
                  },
                }
              : {}
          }
          tenantHeaders={headers}
          transcriptColumn={column}
          workspaceId={ids.workspace}
          onLoadRunTrace={() => {}}
          onRecoverRun={() => {}}
          onScrollToBottom={() => {}}
        />
      </InputStatusContext.Provider>
      {!terminal && (
        <UserQuestionComposer
          busy={false}
          error=""
          pending={pending}
          onCancelRun={() => {}}
          onSubmit={() => {}}
        />
      )}
    </main>
  );
}
applyTheme(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
createRoot(document.getElementById('root')!).render(
  processScenario ? <ProcessFixture /> : <Fixture />,
);
