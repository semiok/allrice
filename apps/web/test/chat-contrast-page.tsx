import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PendingUserQuestion } from '../lib/chatflow/user-question-state';
import type { NativeExperienceItem } from '../lib/chatflow/native-experience';
import { AssistantMarkdown } from '../app/chatflow/assistant-markdown';
import { ChatComposer } from '../app/chatflow/chat-composer';
import type {
  Message,
  PendingAttachment,
} from '../app/chatflow/chatflow-types';
import { employeeAccentStyle } from '../app/chatflow/employee-navigation';
import { TranscriptUserMessage } from '../app/chatflow/transcript-user-message';
import { UserQuestionComposer } from '../app/chatflow/user-question-composer';
import { UserQuestionReceipt } from '../app/chatflow/user-question-receipt';
import { WorkProcess } from '../app/chatflow/work-process';
import styles from '../app/chatflow/dsh-saas.module.css';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';

/** Real chat components on static props: no server, database, device or model. */
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
    id: 'ask',
    sequence: 3,
    kind: 'tool',
    status: 'info',
    title: 'ask_user_question',
    toolName: 'ask_user_question',
    activityDetail: '提问已挂起，等待你的回答',
  },
];

const steered: Message = {
  id: 'message-1',
  role: 'user',
  content: { text: '把截止日期改成周五' },
  status: 'completed',
  runId: null,
  createdAt: now,
  steering: {
    runId: 'run-1',
    turnId: 'turn-1',
    generation: 1,
    status: 'rejected',
    sequence: null,
  },
};

// The conversation column scopes the employee accent, as chatflow-client does.
const conversation = (content: ReactNode) => (
  <div className={styles.employeeConversation}>{content}</div>
);

const cases: [string, ReactNode][] = [
  // First, so the first Tab from the page lands in its message box.
  [
    'hero',
    conversation(
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
      </section>,
    ),
  ],
  [
    'attachments',
    conversation(
      <ChatComposer
        {...composer}
        isRunning
        pendingAttachments={[
          attachment('a1', '销售周报截图.svg', 'failed', thumbnail),
          attachment('a2', '合同扫描件.pdf', 'failed'),
          attachment('a3', '十月报价单.pdf', 'uploading'),
        ]}
      />,
    ),
  ],
  [
    'question',
    conversation(
      <UserQuestionComposer
        busy={false}
        error=""
        pending={question}
        onCancelRun={noop}
        onSubmit={noop}
      />,
    ),
  ],
  [
    'receipt',
    conversation(
      <UserQuestionReceipt
        answer={{
          questionId: 'question-1',
          answers: [
            { id: 'schedule', selected: ['确认：每天 09:00 提醒（推荐）'] },
            { id: 'reminder', selected: [] },
          ],
        }}
        createdAt={now}
        status="adopted"
        text={'确认定时任务：确认：每天 09:00 提醒（推荐）\n提醒方式：跳过'}
      />,
    ),
  ],
  [
    'process',
    conversation(
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
        failed={false}
        canceled={false}
        onRetry={noop}
        assistantCount={0}
        assistantAttention={0}
        transcriptView="verbose"
      />,
    ),
  ],
  ['steering', conversation(<TranscriptUserMessage message={steered} />)],
  [
    'reply',
    conversation(
      <AssistantMarkdown text="周报已整理好，见[项目说明](https://example.com/report)。" />,
    ),
  ],
];

const theme = new URLSearchParams(location.search).get('theme');
// The theme runtime sets both, and the dark root uses the dark color scheme.
if (theme === 'dark') {
  document.body.setAttribute('data-ds-dark-theme', '');
  document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.style.colorScheme = 'dark';
}
createRoot(document.getElementById('root')!).render(
  // main.shell supplies the link alias; the fixture lets it scroll normally.
  // The cases get their own grid: the shell's narrow two-column template is
  // for the sidebar and the conversation, not for these cases.
  <main
    className={styles.shell}
    style={
      {
        ...employeeAccentStyle('Rice'),
        position: 'static',
        display: 'block',
        height: 'auto',
        maxHeight: 'none',
        overflow: 'visible',
        '--dsh-chat-content-width': '760px',
        '--dsh-composer-card-max-width': '792px',
        '--dsh-composer-side-clearance': '16px',
      } as CSSProperties
    }
  >
    <div style={{ display: 'grid', gap: 24, paddingBlock: 16 }}>
      {cases.map(([name, content]) => (
        <section key={name} data-case={name} style={{ minWidth: 0 }}>
          {content}
        </section>
      ))}
    </div>
  </main>,
);
