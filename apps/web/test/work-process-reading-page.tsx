// Real transcript, native projection, receipt polling and approval HTTP path.
import { createRoot } from 'react-dom/client';
import { createRef, useState } from 'react';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import type { Message } from '../app/chatflow/chatflow-types';
import { cloudOperations, ids } from './technical-details-fixtures';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

type Stage = 'initial' | 'prefix' | 'split' | 'merge' | 'append';
const at = new Date().toISOString();
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
  }
}
window.readingWrites = [];
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('/api/v1/runtime/cloud-operations'))
    return Response.json({
      operations: Array.from({ length: appended ? 37 : 36 }, (_, i) =>
        operation(i),
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
  content: { text: '帮我核对这些资料，发送之前先给我看。' },
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
      style={{ maxWidth: 780, margin: '0 auto', padding: 16 }}
    >
      <label>
        另外阅读的位置 <input aria-label="另外阅读的位置" />
      </label>
      {mounted && (
        <ChatTranscript
          atBottom
          streamingOutput
          transcriptView="detailed"
          collapseTiming="completion"
          messages={[
            user,
            {
              ...user,
              id: 'assistant',
              role: 'assistant',
              runId: run,
              content: { text: '最后结论保留在这里。' },
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
createRoot(document.getElementById('root')!).render(<Fixture />);
