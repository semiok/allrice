// Real transcript and polling/projection paths; only transport fixtures are fake.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '@allrice/ui/styles.css';
import { createRoot } from 'react-dom/client';
import { createRef, useState } from 'react';
import type {
  ChatFlowEventEnvelope,
  TaskRuntimeTiming,
} from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import type { Message } from '../app/chatflow/chatflow-types';
import { employeeAccentStyle } from '../app/chatflow/employee-navigation';
import { applyTheme } from '../lib/theme/theme';
import { projectWorkProgress } from '../lib/chatflow/work-progress';
import { cloudOperations, ids } from './technical-details-fixtures';
import { questionAttemptFixture } from './work-process-question-attempt-fixture';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'complete';
const live = scene === 'running';
const progressive = params.has('progressive');
const questionAttempts = params.has('question-attempts')
  ? questionAttemptFixture(params.has('durable'))
  : null;
const approval = params.has('approval');
const failed = scene === 'failed';
const at = '2026-11-15T03:00:00.000Z';
const nativeSessionId = `dsh-${ids.session}`;
const questionId = `${nativeSessionId}:question`;
const request = {
  questionId,
  nativeSessionId,
  callId: 'question',
  durable: !params.has('blocking'),
  questions: [
    {
      id: 'scope',
      question: '按什么口径统计销售额？',
      multiSelect: false,
      options: [{ label: '按自然月' }],
    },
  ],
};
const answer: Message = {
  id: 'answer',
  role: 'user',
  status: 'completed',
  runId: null,
  createdAt: at,
  answerStatus: 'adopted',
  content: {
    text: '统计口径：按自然月',
    interaction: {
      type: 'user_question_answer',
      answer: {
        questionId,
        answers: [{ id: 'scope', selected: ['按自然月'] }],
      },
    },
  },
};
const definitions = [
  ['skill-1', 'skill', '数据分析', 300],
  ['skill-2', 'skill', '电子表格', 400],
  ['skill-3', 'skill', '演示文稿', 300],
  ['read', 'read', '华东区销售明细.xlsx', 2400],
  ['question', 'ask_user_question', '', 5000],
  ['cloud', 'python.execute', '按月份汇总销售额与毛利率', 9600],
  ['agent', 'subagent', '独立核对异常订单', 6400],
  ['write', 'write', '销售分析报告.xlsx', 1800],
] as const;
const rows = definitions.filter(([id]) =>
  scene === 'skills'
    ? id.startsWith('skill')
    : ['cloud', 'details'].includes(scene)
      ? ['read', 'cloud', 'write'].includes(id)
      : scene === 'answered'
        ? ['read', 'question', 'cloud'].includes(id)
        : scene === 'subagent'
          ? ['read', 'agent', 'write'].includes(id)
          : live || failed
            ? !['agent', 'write'].includes(id)
            : true,
);
function eventsFor(withTrace: boolean) {
  const events: ChatFlowEventEnvelope[] = [];
  const add = (
    type: ChatFlowEventEnvelope['type'],
    payload: Record<string, unknown>,
    sourceType: string,
    source: Record<string, unknown>,
    ms = 0,
  ) => {
    const sequence = events.length + 1;
    events.push({
      schemaVersion: 3,
      eventId: `align-${sequence}`,
      organizationId: ids.user,
      workspaceId: ids.workspace,
      conversationId: ids.session,
      runId: ids.run,
      generation: 0,
      cursor: `${ids.run}:${sequence}`,
      sequence,
      harness: 'dsh',
      type,
      payload: { generation: 0, ...payload },
      occurredAt: new Date(Date.parse(at) + ms).toISOString(),
      sourceEvent: {
        id: `align-native-${sequence}`,
        type: sourceType,
        payload: source,
        occurredAt: at,
      },
    });
  };
  add('turn.started', { turnId: 'turn' }, 'request/header', {});
  for (const [id, name, detail, ms] of rows) {
    if (id === 'cloud' && !withTrace) continue;
    if (!(id === 'question' && params.has('request-first'))) {
      add('tool.started', { toolCallId: id, name }, 'tool/call', {
        callId: id,
        name,
        ...(name === 'skill'
          ? { skillName: detail }
          : { activityDetail: detail }),
      });
    }
    if (id === 'question')
      add(
        'harness.native',
        { presentation: 'context', turnId: 'turn' },
        'session/user-question',
        request,
      );
    if (!(live && id === 'cloud'))
      add(
        failed && id === 'cloud' ? 'tool.failed' : 'tool.completed',
        {
          toolCallId: id,
          name,
          ...(failed && id === 'cloud'
            ? { summary: '缺少“销售金额”列，请检查文件后继续。' }
            : {}),
        },
        'tool/result',
        { callId: id },
        ms,
      );
  }
  if (!live) {
    add(
      'assistant.text.completed',
      {
        replyId: 'result',
        text: failed
          ? '缺少“销售金额”列。补齐后就可以继续汇总。'
          : '月度汇总已整理完成，异常订单已单独列出。',
      },
      'assistant/message',
      {},
    );
    add(failed ? 'run.failed' : 'run.succeeded', {}, 'run/end', {});
  }
  return events;
}
function progressiveEvents(phase: number) {
  if (!phase) return [];
  const events = eventsFor(true).filter(
    (event) =>
      event.type === 'turn.started' || event.payload.toolCallId === 'read',
  );
  const add = (
    type: ChatFlowEventEnvelope['type'],
    payload: Record<string, unknown>,
    sourceType: string,
    source: Record<string, unknown> = {},
  ) => {
    const sequence = events.at(-1)!.sequence + 1;
    events.push({
      ...events[0]!,
      type,
      eventId: `progressive-${sequence}`,
      sequence,
      cursor: `${ids.run}:${sequence}`,
      payload: { generation: 0, ...payload },
      sourceEvent: {
        id: `progressive-native-${sequence}`,
        type: sourceType,
        payload: source,
        occurredAt: at,
      },
    });
  };
  add(
    'harness.native',
    { presentation: 'think', status: 'started', turnId: 'turn' },
    'assistant/chunk',
    {
      turn: 1,
      step: 0,
      chunk: { type: 'block-start', blockType: 'reasoning', index: 0 },
    },
  );
  if (phase >= 3) {
    add(
      'harness.native',
      { presentation: 'think', status: 'completed', turnId: 'turn' },
      'assistant/chunk',
      { turn: 1, step: 0, chunk: { type: 'block-end', index: 0 } },
    );
    add(
      'assistant.text.delta',
      { replyId: 'answer', text: '先核对现有资料。' },
      'assistant/message',
    );
  }
  if (phase >= 4)
    add(
      'harness.native',
      { presentation: 'think', status: 'started', turnId: 'turn' },
      'assistant/chunk',
      {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', blockType: 'reasoning', index: 0 },
      },
    );
  if (phase >= 5) {
    add(
      'harness.native',
      { presentation: 'think', status: 'completed', turnId: 'turn' },
      'assistant/chunk',
      { turn: 1, step: 1, chunk: { type: 'block-end', index: 0 } },
    );
    add(
      'assistant.text.completed',
      { replyId: 'answer', text: '资料已核对完成。' },
      'assistant/message',
    );
    add('run.succeeded', {}, 'run/end');
  }
  return events;
}
const sample = cloudOperations([]).find(
  (op) => op.proposal.kind === 'cloud' && op.snapshot.status === 'succeeded',
)!;
let materialReady = !params.has('tool-first');
const operation = {
  ...sample,
  nativeCallId: 'cloud',
  createdAt: at,
  snapshot: {
    ...sample.snapshot,
    status: approval
      ? 'waiting_user'
      : live
        ? 'running'
        : failed
          ? 'failed'
          : 'succeeded',
    binding: {
      ...sample.snapshot.binding,
      action: 'cloud.process.execute',
      task: {
        runId: ids.run,
        rootRunId: ids.run,
        scope: { organizationId: ids.user, workspaceId: ids.workspace },
      },
      attempt: {
        operationId: ids.succeededOperation,
        generation: 0,
        attemptNumber: 1,
      },
    },
  },
  approval: approval
    ? {
        ...cloudOperations([])[0]!.approval,
        request: {
          ...cloudOperations([])[0]!.approval!.request,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
        response: null,
      }
    : null,
  result: failed
    ? {
        code: 'EXECUTION_FAILED',
        output: '缺少“销售金额”列，请检查文件后继续。',
        trusted: false,
      }
    : sample.result,
} as CloudOperationView;
window.fetch = async (input) =>
  Response.json(
    String(input).startsWith('/api/v1/runtime/cloud-operations')
      ? {
          operations:
            !params.has('tool-only') &&
            !params.has('timing-only') &&
            !progressive &&
            !questionAttempts &&
            materialReady &&
            rows.some(([id]) => id === 'cloud')
              ? [operation]
              : [],
        }
      : { operations: [] },
  );
declare global {
  interface Window {
    alignTrace: () => void;
    alignMaterial: () => void;
    alignTiming: () => void;
    alignPhase: (phase: number) => void;
    alignQuestionTrace: () => void;
    alignProgress: () => ReturnType<typeof projectWorkProgress>;
  }
}
const root = createRef<HTMLDivElement>();
function Fixture() {
  const [phase, setPhase] = useState(0);
  const [questionTrace, setQuestionTrace] = useState(!params.has('late-trace'));
  window.alignQuestionTrace = () => setQuestionTrace(true);
  const [traceReady, setTraceReady] = useState(!params.has('material-first'));
  const [revision, setRevision] = useState(0);
  const [hasTiming, setTimingReady] = useState(!params.has('preparing'));
  const timingReady = progressive ? phase >= 2 : hasTiming;
  const running = progressive ? phase < 5 : live;
  window.alignPhase = setPhase;
  window.alignTiming = () => setTimingReady(true);
  window.alignTrace = () => setTraceReady(true);
  window.alignMaterial = () => {
    materialReady = true;
    setRevision((n) => n + 1);
  };
  const events = progressive
    ? progressiveEvents(phase)
    : timingReady && !params.has('timing-only')
      ? eventsFor(traceReady)
      : [];
  window.alignProgress = () => projectWorkProgress(events, '', running);
  const wallMs =
    progressive && !running ? 67000 : live ? 18000 : failed ? 21000 : 34000;
  const timing: TaskRuntimeTiming = {
    activeMs: wallMs,
    waitingMs: 0,
    wallMs,
    timeoutMs: 900000,
    remainingMs: running ? 882000 : null,
    phase: running ? 'active' : 'terminal',
    sources: [],
    calls: null,
  };
  return (
    <main
      style={{
        ...employeeAccentStyle(
          params.get('employee') ?? 'Rice',
          params.has('amber') ? 'amber' : 'blue',
        ),
        maxWidth: 820,
        margin: '32px auto',
        padding: 20,
      }}
      data-alignment-scene={scene}
      data-alignment-phase={progressive ? phase : undefined}
    >
      <ChatTranscript
        key={revision}
        localCommandsEnabled
        atBottom
        streamingOutput={!params.has('unified')}
        transcriptView={
          params.get('mode') === 'compact'
            ? 'compact'
            : params.get('mode') === 'standard'
              ? 'standard'
              : 'detailed'
        }
        collapseTiming="next-input"
        employeeName={params.get('employee') ?? 'Rice'}
        runTimings={timingReady ? [{ runId: ids.run, timing }] : []}
        messages={
          questionAttempts?.messages ?? [
            {
              id: 'assistant',
              role: 'assistant',
              status: running ? 'pending' : failed ? 'failed' : 'completed',
              runId: progressive || timingReady ? ids.run : null,
              createdAt: at,
              content: {
                text: progressive
                  ? phase >= 5
                    ? '资料已核对完成。'
                    : ''
                  : live
                    ? ''
                    : failed
                      ? '缺少“销售金额”列。补齐后就可以继续汇总。'
                      : '月度汇总已整理完成，异常订单已单独列出。',
              },
            },
            ...(!progressive && rows.some(([id]) => id === 'question')
              ? [answer]
              : []),
          ]
        }
        runTraces={{
          [ids.run]: {
            status: 'loaded',
            events: questionAttempts
              ? questionTrace
                ? questionAttempts.events
                : []
              : events,
          },
        }}
        runViews={
          params.has('live-tail') || questionAttempts
            ? {
                [ids.run]: {
                  runId: ids.run,
                  status: 'running',
                  cursor: null,
                  reconnects: 0,
                  events: questionAttempts
                    ? questionAttempts.liveTail
                    : events.slice(-1),
                },
              }
            : {}
        }
        tenantHeaders={{}}
        transcriptColumn={root}
        workspaceId={ids.workspace}
        onLoadRunTrace={() => {}}
        onRecoverRun={() => {}}
        onScrollToBottom={() => {}}
      />
    </main>
  );
}
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
if (progressive || questionAttempts) {
  document.body.style.background = 'var(--dsw-alias-bg-base)';
  document.body.style.color = 'var(--dsw-alias-label-primary)';
}
createRoot(document.getElementById('root')!).render(<Fixture />);
