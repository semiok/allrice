import type {
  ChatFlowEventEnvelope,
  UserQuestionRequest,
} from '@allrice/contracts';
import type { Message } from '../app/chatflow/chatflow-types';
import type { WorkProcessAnswer } from '../lib/chatflow/work-process-questions';
import { ids } from './technical-details-fixtures';

/** Invented content/IDs; only the observed generation/attempt event shape is reused. */
export function questionAttemptFixture(durable = false) {
  const at = '2026-11-17T00:00:00.000Z';
  const nativeSessionId = `dsh-${ids.session}`;
  const requests: UserQuestionRequest[] = [
    ['priority', '优先安排什么？', '整理资料', '校对内容'],
    ['audience', '内容面向谁？', '通勤读者', '周末读者'],
    ['next', '先完成哪一步？', '拟定提纲', '核对标题'],
  ].map(([id, question, first, second], index) => ({
    questionId: durable
      ? `${nativeSessionId}:ask-${index + 1}`
      : `blocking-${index + 1}`,
    nativeSessionId,
    callId: `ask-${index + 1}`,
    durable,
    questions: [
      {
        id: id!,
        question: question!,
        options: [{ label: first! }, { label: second! }],
        multiSelect: false,
      },
    ],
  }));
  const answerItems = (index: number) => [
    {
      id: requests[index]!.questions[0]!.id,
      selected: [requests[index]!.questions[0]!.options![0]!.label],
    },
  ];
  const events: ChatFlowEventEnvelope[] = [];
  const add = (
    attempt: number,
    type: ChatFlowEventEnvelope['type'],
    payload: Record<string, unknown>,
    sourceType: string,
    source: Record<string, unknown> = {},
  ) => {
    const sequence = events.length + 1;
    events.push({
      schemaVersion: 3,
      eventId: `question-attempt-${sequence}`,
      organizationId: ids.user,
      workspaceId: ids.workspace,
      conversationId: ids.session,
      runId: ids.run,
      generation: type === 'run.started' ? null : 7,
      cursor: `${ids.run}:${sequence}`,
      sequence,
      type,
      harness: 'dsh',
      occurredAt: new Date(Date.parse(at) + sequence * 1000).toISOString(),
      payload: {
        attempt,
        ...(type === 'run.started' ? {} : { generation: 7 }),
        ...payload,
      },
      sourceEvent: {
        id: `native-question-attempt-${sequence}`,
        type: sourceType,
        occurredAt: at,
        payload: source,
      },
    });
  };
  const start = (index: number, attempt: number) => {
    const request = requests[index]!;
    add(
      attempt,
      'tool.started',
      { toolCallId: request.callId, name: 'ask_user_question' },
      'tool/call',
      {
        turn: attempt,
        step: index,
        callId: request.callId,
        name: 'ask_user_question',
      },
    );
    add(
      attempt,
      'harness.native',
      { presentation: 'context', status: 'started', turnId: 'turn' },
      'session/user-question',
      { ...request },
    );
  };
  const answered = (index: number, attempt = 2) =>
    add(
      attempt,
      'harness.native',
      { presentation: 'context', status: 'completed', turnId: 'turn' },
      durable ? 'session/user-questions' : 'session/user-question-answered',
      durable
        ? {
            sessionId: nativeSessionId,
            questions: {
              active: [],
              settled: requests.slice(0, index + 1).map((request, i) => ({
                callId: request.callId,
                answers: answerItems(i),
              })),
            },
          }
        : { questionId: requests[index]!.questionId },
    );
  const result = (index: number, attempt: number, pending = false) =>
    add(
      attempt,
      'tool.completed',
      { toolCallId: requests[index]!.callId, name: 'ask_user_question' },
      'tool/result',
      {
        turn: attempt,
        step: index,
        message: {
          toolCallId: requests[index]!.callId,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                pending ? { pending: true } : { answers: answerItems(index) },
              ),
            },
          ],
        },
      },
    );
  add(1, 'run.started', {}, 'run/start');
  add(
    1,
    'assistant.text.delta',
    { replyId: 'abandoned', text: 'OLD_ATTEMPT_BODY' },
    'assistant/message',
  );
  add(
    1,
    'tool.started',
    { toolCallId: 'old-read', name: 'read' },
    'tool/call',
    { callId: 'old-read', name: 'read' },
  );
  start(0, 1);
  if (durable) {
    // A is answered in the foreground; B returns pending before the next attempt.
    result(0, 1);
    answered(0, 1);
    start(1, 1);
    result(1, 1, true);
  } else
    add(
      1,
      'tool.failed',
      { toolCallId: 'ask-1', name: 'ask_user_question' },
      'tool/result',
      { callId: 'ask-1', questionWait: true, error: { code: 'ASK_ABORTED' } },
    );
  add(2, 'run.started', {}, 'run/start');
  answered(durable ? 1 : 0);
  for (const index of durable ? [2] : [1, 2]) {
    start(index, 2);
    if (durable) result(index, 2);
    answered(index);
    if (!durable) result(index, 2);
  }
  const replyId = `${nativeSessionId}:2:3`;
  add(
    2,
    'assistant.text.delta',
    { replyId, text: '本轮答题已记录。' },
    'assistant/live-chunk',
    {
      turn: 2,
      step: 3,
      chunk: { type: 'text-delta', index: 0, text: '本轮答题已记录。' },
    },
  );
  add(
    2,
    'assistant.text.completed',
    { replyId, text: '本轮答题已记录。' },
    'assistant/message',
    { turn: 2, step: 3 },
  );
  add(2, 'run.succeeded', {}, 'run/end');
  const answers: WorkProcessAnswer[] = requests.map((request, index) => ({
    id: `attempt-answer-${index + 1}`,
    answer: {
      questionId: request.questionId,
      answers: answerItems(index),
    },
    text: `合成问题${index + 1}：${request.questions[0]!.options![0]!.label}`,
    status: 'adopted',
    createdAt: at,
  }));
  const messages: Message[] = [
    {
      id: 'attempt-input',
      role: 'user',
      runId: null,
      status: 'completed',
      createdAt: at,
      content: { text: '用答题卡问我' },
    },
    {
      id: 'attempt-assistant',
      role: 'assistant',
      runId: ids.run,
      status: 'completed',
      createdAt: at,
      content: { text: '本轮答题已记录。' },
    },
    ...answers.map((answer): Message => ({
      id: answer.id,
      role: 'user',
      runId: null,
      status: 'completed',
      createdAt: at,
      answerStatus: 'adopted',
      content: {
        text: answer.text,
        interaction: { type: 'user_question_answer', answer: answer.answer },
      },
    })),
  ];
  const liveTail = events.slice(
    events.findIndex(
      (event) =>
        event.sourceEvent?.type === 'session/user-question' &&
        event.sourceEvent.payload.callId === requests[2]!.callId,
    ),
  );
  return { events, liveTail, messages, requests, answers };
}
