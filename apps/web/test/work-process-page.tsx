// Real transcript and receipt components; window.fetch is stubbed below.
import { createRoot } from 'react-dom/client';
import { createRef, useEffect, useState } from 'react';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import { revealOperation } from '../lib/chatflow/reveal-operation';
import type { Message } from '../app/chatflow/chatflow-types';
import { cloudOperations, ids } from './technical-details-fixtures';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

const params = new URLSearchParams(location.search);
const attention = params.has('attention');
const unified = params.has('unified');
const samples = cloudOperations([]);
const at = new Date().toISOString();
const events: ChatFlowEventEnvelope[] = [];
const operations: CloudOperationView[] = [];
let sequence = 0;
function event(
  type: ChatFlowEventEnvelope['type'],
  payload: Record<string, unknown>,
) {
  const seq = ++sequence;
  events.push({
    schemaVersion: 3,
    eventId: `event-${seq}`,
    organizationId: ids.user,
    workspaceId: ids.workspace,
    conversationId: ids.session,
    runId: ids.run,
    generation: 0,
    cursor: `${ids.run}:${seq}`,
    sequence: seq,
    harness: 'dsh',
    occurredAt: at,
    type,
    payload,
    sourceEvent: {
      id: `native-${seq}`,
      type: 'session.event',
      occurredAt: at,
      payload: { callId: payload.toolCallId, activityDetail: payload.summary },
    },
  });
}
event('assistant.text.delta', {
  replyId: 'progress',
  text: '先检查已有资料。',
});
for (let i = 0; i < 34; i++) {
  if (i === 17)
    event('assistant.text.delta', {
      replyId: 'progress-2',
      text: '已定位入口，继续核对依赖。',
    });
  const toolCallId = `call-${i}`;
  const name =
    i < 30
      ? 'cloud_mcp_call'
      : i < 32
        ? 'python_execute'
        : i === 32
          ? 'skill'
          : 'web_fetch';
  const status =
    attention && i === 28
      ? 'waiting_user'
      : attention && i === 29
        ? 'failed'
        : 'succeeded';
  const payload = { toolCallId, name, summary: `检查第 ${i + 1} 项公开资料` };
  event('tool.started', payload);
  if (status !== 'waiting_user')
    event(status === 'failed' ? 'tool.failed' : 'tool.completed', payload);
  if (i >= 32) continue;
  const base = samples[i < 30 ? 0 : 5]!;
  operations.push({
    ...base,
    nativeCallId: toolCallId,
    createdAt: at,
    snapshot: {
      ...base.snapshot,
      status,
      binding: {
        ...base.snapshot.binding,
        action: i < 30 ? 'cloud.mcp.call' : 'cloud.process.execute',
        attempt: { operationId: `receipt-${i}` },
      },
      result: null,
    },
    proposal:
      i < 30
        ? {
            ...samples[0]!.proposal,
            tool: i < 2 ? 'tools' : 'get_file_contents',
            risk: 'write',
            arguments: {
              path: `src/file-${i}.ts`,
              ...(attention && i === 28
                ? { body: 'review-target-'.repeat(100) }
                : {}),
            },
          }
        : base.proposal,
    approval: status === 'waiting_user' ? samples[0]!.approval : null,
    result:
      status === 'waiting_user'
        ? null
        : {
            code:
              status === 'failed' ? 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN' : 'OK',
            output:
              status === 'failed'
                ? '远端服务拒绝了这次读取'
                : `synthetic-result-${i}`,
            trusted: true,
          },
  } as CloudOperationView);
}
event('assistant.text.delta', {
  replyId: 'answer',
  text: '已核对，最终结论保留在这里。',
});
const completion = {
  ...events.at(-1)!,
  eventId: 'completion',
  sequence: ++sequence,
  type: 'assistant.text.completed' as const,
  payload: { replyId: 'answer', text: '已核对，最终结论保留在这里。' },
};
const restoredEvents: ChatFlowEventEnvelope[] = [
  {
    ...events[0]!,
    eventId: 'restored-think',
    sequence: 0.1,
    type: 'harness.native',
    payload: { presentation: 'think', status: 'completed' },
    sourceEvent: {
      ...events[0]!.sourceEvent!,
      payload: { turn: 1, step: 1, chunk: { index: 0 } },
    },
  },
  ...events.filter(
    (event) => params.has('split-trace') || event.type.startsWith('tool.'),
  ),
  completion,
];

declare global {
  interface Window {
    processWrites: unknown[];
    processReads: number;
    processDeliverTrace: () => void;
    processAppendOperation: () => void;
  }
}
window.processWrites = [];
window.processReads = 0;
let failRead = params.has('load-error');
let answered = false;
let appended = !params.has('append-operation');
window.fetch = async (input, init) => {
  const url = String(input);
  if (url === '/fixture/late-trace')
    return new Promise<Response>((resolve) => {
      window.processDeliverTrace = () =>
        resolve(Response.json({ events: restoredEvents }));
    });
  if (url.startsWith('/api/v1/runtime/cloud-operations')) {
    window.processReads++;
    if (failRead) {
      failRead = false;
      return Response.json({}, { status: 503 });
    }
    return Response.json({
      operations: operations
        .filter((_, i) =>
          params.has('append-operation')
            ? i === 1 || (appended && i === 0)
            : true,
        )
        .map((op) =>
          answered && op.snapshot.status === 'waiting_user'
            ? {
                ...op,
                snapshot: { ...op.snapshot, status: 'dispatched' },
                approval: {
                  ...op.approval,
                  response: { decision: 'approved' },
                },
              }
            : op,
        ),
    });
  }
  if (url.startsWith('/api/v1/runtime/approvals/')) {
    window.processWrites.push(JSON.parse(String(init?.body)));
    answered = true;
    return Response.json({});
  }
  return Response.json({ operations: [] });
};
const user: Message = {
  id: 'user',
  role: 'user',
  content: { text: '帮我检查这个仓库最近的改动。' },
  status: 'completed',
  runId: null,
  createdAt: at,
};
const assistant: Message = {
  ...user,
  id: 'assistant',
  role: 'assistant',
  runId: ids.run,
  content: { text: '已核对，最终结论保留在这里。' },
};
const headers = {};
const column = createRef<HTMLDivElement>();
function Fixture() {
  const delayed = params.has('delayed-trace');
  const [restored, setRestored] = useState<ChatFlowEventEnvelope[]>();
  useEffect(() => {
    if (delayed)
      void fetch('/fixture/late-trace')
        .then((response) => response.json())
        .then((data) => setRestored(data.events));
  }, [delayed]);
  const [running, setRunning] = useState(params.has('live'));
  const [hasAppend, setHasAppend] = useState(false);
  window.processAppendOperation = () => {
    appended = true;
    setHasAppend(true);
  };
  const [next, setNext] = useState(false);
  const [traceFailed, setTraceFailed] = useState(params.has('trace-error'));
  const current = delayed
    ? (restored ?? [])
    : params.has('append-operation')
      ? events
          .filter(
            (event) =>
              event.payload.toolCallId === 'call-1' ||
              (hasAppend && event.payload.toolCallId === 'call-0'),
          )
          .sort((a, b) =>
            a.payload.toolCallId === b.payload.toolCallId
              ? a.sequence - b.sequence
              : a.payload.toolCallId === 'call-1'
                ? -1
                : 1,
          )
          .map((event, i) => ({ ...event, sequence: i + 1 }))
      : running
        ? events
        : [...events, completion];
  return (
    <main
      data-delayed-trace={
        delayed ? (restored ? 'loaded' : 'waiting') : undefined
      }
      style={{ maxWidth: 780, margin: '0 auto', padding: 16 }}
    >
      <nav>
        <button onClick={() => setRunning(false)}>完成本轮</button>
        <button onClick={() => setNext(true)}>下一轮输入</button>
        <button onClick={() => revealOperation('receipt-0')}>
          定位已有调用
        </button>
      </nav>
      <ChatTranscript
        atBottom
        streamingOutput={!unified}
        transcriptView={
          params.has('verbose')
            ? 'verbose'
            : params.has('compact')
              ? 'compact'
              : 'detailed'
        }
        collapseTiming={params.has('next-input') ? 'next-input' : 'completion'}
        messages={[
          user,
          { ...assistant, status: running ? 'pending' : 'completed' },
          ...(next
            ? [{ ...user, id: 'next', content: { text: '再看看测试。' } }]
            : []),
        ]}
        runTraces={{
          [ids.run]: {
            status: traceFailed
              ? 'failed'
              : delayed && !restored
                ? 'loading'
                : 'loaded',
            events: current,
          },
        }}
        runViews={
          running
            ? {
                [ids.run]: {
                  runId: ids.run,
                  status: 'running',
                  cursor: null,
                  reconnects: 0,
                  events: current,
                },
              }
            : {}
        }
        tenantHeaders={headers}
        transcriptColumn={column}
        workspaceId={ids.workspace}
        onLoadRunTrace={() => setTraceFailed(false)}
        onRecoverRun={() => {}}
        onScrollToBottom={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
