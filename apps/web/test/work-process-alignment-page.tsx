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
import { cloudOperations, ids } from './technical-details-fixtures';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'complete';
const live = scene === 'running';
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
  }
}
const root = createRef<HTMLDivElement>();
function Fixture() {
  const [traceReady, setTraceReady] = useState(!params.has('material-first'));
  const [revision, setRevision] = useState(0);
  const [timingReady, setTimingReady] = useState(!params.has('preparing'));
  window.alignTiming = () => setTimingReady(true);
  window.alignTrace = () => setTraceReady(true);
  window.alignMaterial = () => {
    materialReady = true;
    setRevision((n) => n + 1);
  };
  const events =
    timingReady && !params.has('timing-only') ? eventsFor(traceReady) : [];
  const wallMs = live ? 18000 : failed ? 21000 : 34000;
  const timing: TaskRuntimeTiming = {
    activeMs: wallMs,
    waitingMs: 0,
    wallMs,
    timeoutMs: 900000,
    remainingMs: live ? 882000 : null,
    phase: live ? 'active' : 'terminal',
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
        messages={[
          {
            id: 'assistant',
            role: 'assistant',
            status: live ? 'pending' : failed ? 'failed' : 'completed',
            runId: timingReady ? ids.run : null,
            createdAt: at,
            content: {
              text: live
                ? ''
                : failed
                  ? '缺少“销售金额”列。补齐后就可以继续汇总。'
                  : '月度汇总已整理完成，异常订单已单独列出。',
            },
          },
          ...(rows.some(([id]) => id === 'question') ? [answer] : []),
        ]}
        runTraces={{ [ids.run]: { status: 'loaded', events } }}
        runViews={
          params.has('live-tail')
            ? {
                [ids.run]: {
                  runId: ids.run,
                  status: 'running',
                  cursor: null,
                  reconnects: 0,
                  events: events.slice(-1),
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
createRoot(document.getElementById('root')!).render(<Fixture />);
