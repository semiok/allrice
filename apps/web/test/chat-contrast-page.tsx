import { useState, type ComponentProps, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PendingUserQuestion } from '../lib/chatflow/user-question-state';
import type { NativeExperienceItem } from '../lib/chatflow/native-experience';
import { applyTheme } from '../lib/theme/theme';
import { ChatComposer } from '../app/chatflow/chat-composer';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import type {
  Message,
  PendingAttachment,
} from '../app/chatflow/chatflow-types';
import { employeeAccentStyle } from '../app/chatflow/employee-navigation';
import { UserQuestionComposer } from '../app/chatflow/user-question-composer';
import { WorkProcess } from '../app/chatflow/work-process';
import archiveCss from '../app/chatflow/session-archive.module.css';
import chatUi from '../app/chatflow/dsh-upstream/ChatView.module.css';
import conversationUi from '../app/chatflow/dsh-upstream/ConversationRoot.module.css';
import frameUi from '../app/chatflow/dsh-upstream/AppFrame.module.css';
import styles from '../app/chatflow/dsh-saas.module.css';

/**
 * Real chat components on static props: no server, database, device or model.
 * The global stylesheets come from the root layout (the test serves them); the
 * page keeps the production frame, so the 57px narrow rail, the 748px content
 * column and the 780px input card bound every case as they do in the app.
 */
const noop = () => {};
const now = '2026-10-27T01:35:00.000Z';

// A dark, striped thumbnail: the failed chip must not depend on what is behind it.
const thumbnail = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#7a1d2b"/><stop offset="1" stop-color="#f2e8e9"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>',
)}`;
const attachment = (
  id: string,
  fileName: string,
  status: PendingAttachment['status'],
  previewUrl?: string,
): PendingAttachment => ({
  id,
  fileName,
  mediaType: previewUrl ? 'image/svg+xml' : 'application/pdf',
  sizeBytes: 2048,
  previewUrl,
  persistedId: null,
  status,
  visibility: 'private',
  error:
    status === 'failed' ? '上传没有完成，可以点「重试」再传一次。' : undefined,
});

const composer: ComponentProps<typeof ChatComposer> = {
  employeeName: 'Rice',
  attachmentMenuOpen: false,
  busy: false,
  composerInput: { current: null },
  composing: { current: false },
  draft: '',
  error: '',
  fileInput: { current: null },
  isRunning: false,
  pendingAttachments: [],
  onAttachmentMenuOpenChange: noop,
  onCancelRun: noop,
  onDraftChange: noop,
  onLoadBridgeDevices: noop,
  onOpenAttachment: noop,
  onOpenWorkspaceFiles: noop,
  onRemoveAttachment: noop,
  onRetryAttachment: noop,
  onSendMessage: noop,
  onUploadAttachments: noop,
  bridgeConnectionState: 'offline',
  localWorkspaceOnline: false,
};

const question: PendingUserQuestion = {
  questionId: 'question-1',
  runId: 'run-1',
  generation: 1,
  turnId: 'turn-1',
  occurredAt: now,
  sequence: 4,
  questions: [
    {
      id: 'schedule',
      header: '确认定时任务',
      question: '要创建这个定时任务吗？',
      multiSelect: false,
      options: [
        {
          label: '确认：每天 09:00 提醒（推荐）',
          description: '在本对话里提醒你核对页面',
        },
        { label: '先不创建' },
      ],
    },
  ],
};

const steps: NativeExperienceItem[] = [
  {
    id: 'think',
    sequence: 1,
    kind: 'think',
    status: 'completed',
    title: '思考',
  },
  {
    id: 'search',
    sequence: 2,
    kind: 'tool',
    status: 'completed',
    title: 'web.search',
    toolName: 'web.search',
    activityDetail: '搜索资料：本周销售数据',
  },
  {
    id: 'quote',
    sequence: 3,
    kind: 'tool',
    status: 'failed',
    title: 'market.quote',
    toolName: 'market.quote',
    activityDetail: '查询 NVDA 的实时行情',
    detail: '服务超时',
  },
  {
    id: 'ask',
    sequence: 4,
    kind: 'tool',
    status: 'info',
    title: 'ask_user_question',
    toolName: 'ask_user_question',
    activityDetail: '提问已挂起，等待你的回答',
  },
];

const messages: Message[] = [
  {
    id: 'request',
    role: 'user',
    content: { text: '整理本周销售数据，写一份周报' },
    status: 'completed',
    runId: null,
    createdAt: now,
  },
  {
    id: 'reply',
    role: 'assistant',
    content: {
      text: '周报已整理好，见[项目说明](https://example.com/report)。',
    },
    status: 'completed',
    runId: 'run-1',
    createdAt: now,
  },
  {
    id: 'answer',
    role: 'user',
    content: {
      text: '确认定时任务：确认：每天 09:00 提醒（推荐）\n提醒方式：跳过',
      interaction: {
        type: 'user_question_answer',
        answer: {
          questionId: 'question-1',
          answers: [
            { id: 'schedule', selected: ['确认：每天 09:00 提醒（推荐）'] },
            { id: 'reminder', selected: [] },
          ],
        },
      },
    },
    answerStatus: 'adopted',
    status: 'completed',
    runId: null,
    createdAt: now,
  },
  {
    id: 'steer',
    role: 'user',
    content: { text: '把截止日期改成周五' },
    steering: {
      runId: 'run-2',
      turnId: 'turn-2',
      generation: 1,
      status: 'rejected',
      sequence: null,
    },
    status: 'completed',
    runId: null,
    createdAt: now,
  },
  {
    // A reply kept from a turn that timed out: the note under it is the failure.
    id: 'failed',
    role: 'assistant',
    content: { text: '周报的前两部分已经写好。' },
    status: 'failed',
    errorCode: 'DSH_TIMEOUT',
    runId: 'run-2',
    createdAt: now,
  },
];

type Scene =
  'hero' | 'attachments' | 'draft' | 'busy' | 'question' | 'archived';
const scene = (new URLSearchParams(location.search).get('scene') ??
  'attachments') as Scene;
const busy = scene === 'busy';

const seat: Record<Exclude<Scene, 'hero'>, ReactNode> = {
  attachments: (
    <ChatComposer
      {...composer}
      isRunning
      pendingAttachments={[
        attachment('a1', '销售周报截图.svg', 'failed', thumbnail),
        attachment('a2', '合同扫描件.pdf', 'failed'),
        attachment('a3', '十月报价单.pdf', 'uploading'),
      ]}
    />
  ),
  draft: <ChatComposer {...composer} draft="把本周销售数据整理成周报" />,
  busy: <ChatComposer {...composer} busy />,
  question: (
    <UserQuestionComposer
      busy={false}
      error=""
      pending={question}
      onCancelRun={noop}
      onSubmit={noop}
    />
  ),
  // As chatflow-client renders an archived conversation: no message box.
  archived: (
    <div className={archiveCss.readOnly} role="status">
      <span>已归档 · 可以查看记录和交付成果</span>
      <button type="button">恢复并继续</button>
    </div>
  ),
};

const conversation =
  scene === 'hero' ? (
    <div className={conversationUi.root} data-phase="hero">
      <div className={conversationUi.scrollBody}>
        <section className={styles.emptyStage}>
          <div className={styles.heroStack}>
            <div className={styles.heroHeadline}>
              <span className={styles.heroMark} aria-hidden="true">
                R
              </span>
              <h1>与 Rice 工作</h1>
              <p>
                AllRice 默认通用 AI
                员工，负责理解目标、推进工作并交付可继续协作的结果。
              </p>
            </div>
            <ChatComposer {...composer} hero />
          </div>
        </section>
      </div>
    </div>
  ) : (
    <div className={conversationUi.root} data-phase="active">
      <div
        className={`${conversationUi.scrollBody} ${styles.conversationBody}`}
        data-conversation-scroll
      >
        <div className={conversationUi.viewArea}>
          <ChatTranscript
            atBottom
            employeeName="Rice"
            messages={messages}
            runTraces={{}}
            runViews={{}}
            tenantHeaders={{}}
            transcriptColumn={{ current: null }}
            workspaceId="00000000-0000-4000-8000-000000000002"
            onLoadRunTrace={noop}
            onRecoverRun={noop}
            onScrollToBottom={noop}
          />
          <div className={chatUi.root}>
            <div className={chatUi.scroll}>
              <div className={chatUi.column}>
                <div className={chatUi.flowItem} data-case="process">
                  <WorkProcess
                    items={steps}
                    timing={{
                      activeMs: 206_000,
                      waitingMs: 0,
                      wallMs: 206_000,
                      timeoutMs: 3_600_000,
                      remainingMs: null,
                      phase: 'terminal',
                      sources: [],
                      calls: null,
                    }}
                    running={false}
                    streaming={false}
                    failed
                    canceled={false}
                    onRetry={noop}
                    assistantCount={0}
                    assistantAttention={0}
                    transcriptView="verbose"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div
          className={`${conversationUi.composerSeat} ${conversationUi.composerStack} ${styles.composerDock}`}
          data-composer-seat
        >
          {seat[scene]}
        </div>
      </div>
    </div>
  );

function Frame() {
  // Production's drop overlay, opened the way chatflow-client opens it.
  const [dragging, setDragging] = useState(false);
  return (
    <main
      className={`${frameUi.frame} ${styles.shell}`}
      style={{ gridTemplateColumns: '240px minmax(0, 1fr) 0px' }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
    >
      {dragging ? (
        <div className={styles.imageDropOverlay}>
          <div>
            <strong>
              {busy ? '当前无法添加图片' : '图片拖动到此处即可添加'}
            </strong>
            {!busy ? <span>最多 20 张，每张 20 MB</span> : null}
          </div>
        </div>
      ) : null}
      {/* The sidebar's column: 240px wide, a 57px rail on a narrow screen. */}
      <nav aria-label="员工和工作" />
      <section
        className={`${frameUi.centerCol} ${styles.employeeConversation}`}
        style={employeeAccentStyle('Rice')}
      >
        {conversation}
      </section>
    </main>
  );
}

// The real theme switch: body[data-ds-dark-theme] and html[data-theme].
applyTheme(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
createRoot(document.getElementById('root')!).render(<Frame />);
