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
      { callId: request.callId, name: 'ask_user_question' },
    );
    add(
      attempt,
      'harness.native',
      { presentation: 'context', status: 'started', turnId: 'turn' },
      'session/user-question',
      { ...request },
    );
  };
  const answered = (index: number) =>
    add(
      2,
      'harness.native',
      { presentation: 'context', status: 'completed', turnId: 'turn' },
      'session/user-question-answered',
      { questionId: requests[index]!.questionId },
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
  add(
    1,
    'tool.failed',
    { toolCallId: 'ask-1', name: 'ask_user_question' },
    'tool/result',
    { callId: 'ask-1', questionWait: true, error: { code: 'ASK_ABORTED' } },
  );
  add(2, 'run.started', {}, 'run/start');
  answered(0);
  add(
    2,
    'assistant.text.delta',
    { replyId: 'current', text: '本轮答题已记录。' },
    'assistant/message',
  );
  for (const index of [1, 2]) {
    start(index, 2);
    answered(index);
    add(
      2,
      'tool.completed',
      { toolCallId: requests[index]!.callId, name: 'ask_user_question' },
      'tool/result',
      { callId: requests[index]!.callId },
    );
  }
  add(
    2,
    'assistant.text.completed',
    { replyId: 'current', text: '本轮答题已记录。' },
    'assistant/message',
  );
  add(2, 'run.succeeded', {}, 'run/end');
  const answers: WorkProcessAnswer[] = requests.map((request, index) => ({
    id: `attempt-answer-${index + 1}`,
    answer: {
      questionId: request.questionId,
      answers: [
        {
          id: request.questions[0]!.id,
          selected: [request.questions[0]!.options![0]!.label],
        },
      ],
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
  return { events, messages, requests, answers };
}
