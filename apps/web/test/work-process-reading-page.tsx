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
  RuntimeActionApprovalSnapshot,
} from '@allrice/contracts';
import {
  ManagedBrowserTaskSchema,
  RuntimeLocalCommandResultSchema,
  WorkbenchArtifactSchema,
} from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import { ChatTranscript } from '../app/chatflow/chat-transcript';
import { ArtifactWorkbench } from '../app/chatflow/artifact-workbench';
import type { Message } from '../app/chatflow/chatflow-types';
import { InputStatusContext } from '../app/chatflow/transcript-user-message';
import {
  UserQuestionComposer,
  userQuestionAnswerText,
} from '../app/chatflow/user-question-composer';
import { projectPendingUserQuestion } from '../lib/chatflow/user-question-state';
import { applyTheme } from '../lib/theme/theme';
import {
  changesetRuns,
  cloudOperations,
  ids,
} from './technical-details-fixtures';
import {
  id,
  operations,
  mcpOperations,
} from './experience-command-theme-fixtures';

type Stage = 'initial' | 'prefix' | 'split' | 'merge' | 'append';
const at = new Date().toISOString();
const memoryScenario = new URLSearchParams(location.search).has('memory');
const processScenario = new URLSearchParams(location.search).has('process');
const cardsScenario = new URLSearchParams(location.search).has('cards');
const regression = new URLSearchParams(location.search).get('regression');
const reviewCommand = regression === 'review-command';
const reviewCreate = regression === 'review-create';
const timelineCards = regression === 'order' || regression === 'late-open';
const tick = (seconds: number) =>
  new Date(Date.parse(at) + seconds * 1000).toISOString();
const longField = '核对这次对外发送的内容及附件。'.repeat(60);
const longOutput = Array.from(
  { length: 160 },
  (_, i) =>
    `结果第 ${String(i).padStart(3, '0')} 行：核对记录的原文与对应动作。`,
).join('\n');
const samples = cloudOperations([]);
const task = samples[1]!.approval!.request.task;
const binding = (operationId: string, runId = ids.run) => ({
  ...samples[1]!.snapshot.binding,
  task: { ...task, runId, rootRunId: runId },
  attempt: { operationId, generation: 0, attemptNumber: 1 },
});
let stage: Stage = 'initial';
let changed = false;
let answered = false;
let appended = false;
const operation = (i: number, runId = ids.run): CloudOperationView => {
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
      binding: binding(`reading-${i}`, runId),
    },
    approval:
      i === 0
        ? {
            ...sample.approval,
            request: {
              ...sample.approval!.request,
              task: binding(`reading-${i}`, runId).task,
            },
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
const cardsCloud = [
  samples[0]!,
  samples[1]!,
  samples[5]!,
  samples[6]!,
  samples[7]!,
].map((sample, index) => ({
  ...sample,
  nativeCallId: [
    'cards-sales',
    'cards-partner',
    'cards-pair',
    'cards-pair',
    null,
  ][index],
  snapshot: {
    ...sample.snapshot,
    binding: binding(sample.snapshot.binding.attempt.operationId),
  },
  ...((regression === 'order' && index === 4) ||
  (regression === 'late-open' && [2, 3].includes(index))
    ? { createdAt: tick(15) }
    : {}),
  ...(index === 2
    ? {
        result: {
          code: 'OK',
          trusted: true,
          output: JSON.stringify({
            rows: 12,
            artifactId: ids.artifact,
            version: 1,
            objectId: id(350),
            checksum: `sha256:${'9'.repeat(64)}`,
            ...(regression === 'late-open' ? { detail: longOutput } : {}),
          }),
        },
        projectService: {
          version: 1,
          id: id(301),
          runId: ids.run,
          sessionId: ids.session,
          backend: 'cloud',
          state: 'unknown',
          project: {
            projectId: id(51),
            snapshot: { kind: 'artifact', id: id(52), version: '1' },
          },
          sourceDigest: `sha256:${'d'.repeat(64)}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          hardDeadlineAt: '2099-01-01T00:00:00.000Z',
          lastSeenAt: at,
          stopRequested: false,
          stopped: false,
          canRenew: false,
          updatePending: false,
        },
      }
    : {}),
}));
const retryCloud =
  regression === 'retry'
    ? (['failed', 'succeeded'] as const).map((status, index) => {
        const source = samples[4]!;
        return {
          ...source,
          nativeCallId: `cards-retry-${index}`,
          createdAt: tick(index + 1),
          snapshot: {
            ...source.snapshot,
            status,
            binding: binding(id(370 + index)),
            result: {
              ...source.snapshot.result!,
              status,
              effects: index ? 'applied' : 'none',
              evidence: {
                ...source.snapshot.result!.evidence,
                id: id(372 + index),
                recordedAt: tick(index + 1),
              },
            },
          },
          result: index
            ? {
                code: 'OK',
                trusted: false,
                output: '{"delivered":true,"messageId":"retry-371"}',
              }
            : {
                code: 'MCP_UNAVAILABLE',
                trusted: false,
                output: 'MCP connection unavailable before dispatch',
              },
        };
      })
    : [];
const scopedLocal = <
  T extends {
    snapshot: { binding: { attempt: { operationId: string } } };
    approval: unknown;
  },
>(
  value: T,
  nativeCallId: string,
) => {
  const current = binding(value.snapshot.binding.attempt.operationId);
  const approval = value.approval as RuntimeActionApprovalSnapshot | null;
  return {
    ...value,
    nativeCallId,
    snapshot: { ...value.snapshot, binding: current },
    approval: approval
      ? { ...approval, request: { ...approval.request, task: current.task } }
      : null,
  };
};
const cardsCommands = operations.slice(0, 1).map((value) =>
  scopedLocal(
    reviewCommand || reviewCreate
      ? {
          ...value,
          snapshot: { ...value.snapshot, status: 'succeeded' },
          approval: null,
          evidence: {
            summary: '命令已运行完毕，退出码 0。',
            output: RuntimeLocalCommandResultSchema.parse({
              backend: 'local-vm-container-v1',
              containerId: 'c'.repeat(64),
              imageDigest: `sha256:${'5'.repeat(64)}`,
              stopped: true,
              exitCode: 0,
              reason: 'exited',
              stdout: reviewCommand
                ? Array.from(
                    { length: 160 },
                    (_, i) =>
                      `stdout ${String(i).padStart(3, '0')}: output text`,
                  ).join('\n')
                : '命令的真实材料',
              stderr: reviewCommand
                ? Array.from(
                    { length: 160 },
                    (_, i) =>
                      `stderr ${String(i).padStart(3, '0')}: output text`,
                  ).join('\n')
                : '',
              truncated: false,
              workCopy: 'local_isolated_copy',
              sourceDirectoryModified: false,
            }),
          },
        }
      : value,
    'cards-command',
  ),
);
const cardsMcp = mcpOperations
  .slice(0, 1)
  .map((value) => scopedLocal(value, 'cards-local-mcp'));
const browserOperationId = id(310);
const cardsBrowser = [
  {
    id: id(311),
    runId: ids.run,
    profileId: id(312),
    transport: 'local',
    localDeviceName: '组合测试电脑',
    persistLogin: false,
    preview: null,
    state: 'agent',
    fence: 2,
    acknowledgedFence: 2,
    available: true,
    profile: {
      origins: ['https://example.com'],
      allowUploads: false,
      allowDownloads: true,
      allowHumanCredentials: false,
      maximumFileBytes: 1_000_000,
    },
    observation: null,
    operations: [
      {
        snapshot: { status: 'succeeded', binding: binding(browserOperationId) },
        nativeCallId: 'cards-browser',
        command: {
          actor: 'agent',
          fence: 2,
          observationId: null,
          action: { type: 'navigate', url: 'https://example.com' },
        },
        approval: null,
        result: { title: '组合网页' },
        available: true,
      },
      ...['agent', 'human'].map((actor, index) => ({
        snapshot: { status: 'succeeded', binding: binding(id(313 + index)) },
        nativeCallId: null,
        command: {
          actor,
          fence: 2,
          observationId: null,
          action:
            index === 0
              ? {
                  type: 'request',
                  method: 'POST',
                  url: 'https://example.com/submit',
                  parentOperationId: browserOperationId,
                }
              : { type: 'observe' },
        },
        approval: null,
        result: { title: index === 0 ? '原动作的网络请求' : '人工复核' },
        available: true,
      })),
    ],
  },
];
const currentBrowser = () =>
  cardsBrowser.map((workspace) => ({
    ...workspace,
    profile:
      regression === 'browser'
        ? {
            ...workspace.profile,
            origins: [
              'https://example.com',
              'https://current.example',
              'https://newer.example',
            ],
          }
        : workspace.profile,
    observation:
      regression === 'browser'
        ? {
            version: 1,
            id: id(stage === 'initial' ? 360 : 361),
            profileId: workspace.profileId,
            fence: 2,
            revision: 1,
            capturedAt: at,
            expiresAt: '2099-01-01T00:00:00.000Z',
            url: `https://${stage === 'initial' ? 'current' : 'newer'}.example/page`,
            title: stage === 'initial' ? '当前观察甲' : '当前观察乙',
            text: '当前授权页面。',
            pageDigest: `sha256:${'a'.repeat(64)}`,
            elements: [],
            screenshotObjectId: null,
          }
        : workspace.observation,
  }));
const cardsManaged = [2, 1].map((jobAttempt) =>
  ManagedBrowserTaskSchema.parse({
    id: id(320 + jobAttempt),
    organizationId: task.scope.organizationId,
    workspaceId: ids.workspace,
    runId: ids.run,
    nativeCallId: 'cards-managed',
    jobAttempt,
    targetId: id(330),
    status: 'succeeded',
    startUrl: 'https://managed.example/path?private=query',
    allowedDomains: ['managed.example'],
    steps: [],
    evidence: [
      {
        url: 'https://managed.example/path?private=query',
        title: '公开网页',
        capturedAt: at,
        contentChecksum: `sha256:${'f'.repeat(64)}`,
        contentObjectId: id(336),
        screenshotObjectId: null,
        downloadObjectIds: [],
        events: [
          {
            sequence: 1,
            kind: 'navigation',
            status: 'succeeded',
            label: '访问页面',
            summary: `授权证据 attempt ${jobAttempt}`,
            occurredAt: at,
            url: 'https://managed.example/path?private=query',
          },
        ],
      },
    ],
    artifacts:
      jobAttempt === 2
        ? [
            {
              id: id(335),
              objectId: id(336),
              kind: 'content',
              name: '页面证据.txt',
              checksum: `sha256:${'f'.repeat(64)}`,
              mediaType: 'text/plain',
              sizeBytes: 21,
              createdAt: at,
            },
          ]
        : [],
    createdAt: at,
    startedAt: at,
    completedAt: new Date(Date.parse(at) + 800).toISOString(),
    cancelRequestedAt: null,
    errorCode: null,
  }),
);
const savedChange = changesetRuns(ids.artifact)[0]!;
const cardsArtifacts = [ids.artifact, ids.doneArtifact, id(340)].map(
  (artifactId, index) =>
    WorkbenchArtifactSchema.parse({
      contractVersion: 1,
      id: artifactId,
      kind: index === 1 ? 'changeset' : 'document',
      version: {
        id: artifactId,
        organizationId: task.scope.organizationId,
        workspaceId: ids.workspace,
        ownerId: ids.user,
        objectId: id(350 + index),
        seriesId: artifactId,
        version: 1,
        parentVersionId: null,
        parentObjectId: null,
        sessionId: ids.session,
        platformTestRunId: null,
        fileName: index === 1 ? '文件修改建议.json' : '核对结果.csv',
        format: index === 1 ? 'json' : 'text',
        changeSummary: null,
        createdAt: at,
      },
      object: {
        id: id(350 + index),
        organizationId: task.scope.organizationId,
        workspaceId: ids.workspace,
        ownerId: ids.user,
        key: `organizations/${task.scope.organizationId}/workspaces/${ids.workspace}/owners/${ids.user}/exports/${id(350 + index)}`,
        mediaType: index === 1 ? 'application/json' : 'text/csv',
        checksum: `sha256:${'9'.repeat(64)}`,
        sizeBytes: index === 1 ? 32 : 22,
        retentionUntil: null,
        deletedAt: null,
        immutable: true,
      },
      provenance: {
        kind: 'model_proposal',
        runId: ids.run,
        operationId:
          index === 1 ? ids.projectOperation : ids.succeededOperation,
        stepId: null,
      },
      execution: index === 1 ? savedChange.snapshot.binding.execution : null,
      latestVersionId: artifactId,
      stale: false,
    }),
);
function eventsFor(runId: string): ChatFlowEventEnvelope[] {
  const events: ChatFlowEventEnvelope[] = [];
  const add = (
    type: ChatFlowEventEnvelope['type'],
    payload: Record<string, unknown>,
    occurredAt = at,
  ) => {
    const seq = events.length + 1;
    events.push({
      schemaVersion: 3,
      eventId: `event-${seq}`,
      organizationId: task.scope.organizationId,
      workspaceId: ids.workspace,
      conversationId: ids.session,
      runId,
      generation: 0,
      cursor: `${runId}:${seq}`,
      sequence: seq,
      harness: 'dsh',
      sourceEvent: null,
      occurredAt,
      type,
      payload: { generation: 0, attempt: 2, ...payload },
    });
  };
  if (cardsScenario) {
    if (timelineCards)
      add(
        'assistant.text.delta',
        {
          replyId: 'cards-before',
          text: '采用补充前的说明。',
        },
        tick(10),
      );
    const calls = [
      ['cards-sales', 'cloud_mcp_call'],
      ['cards-partner', 'cloud_mcp_call'],
      ['cards-pair', 'cloud_compute'],
      ['cards-managed', 'browser.run'],
      ['cards-browser', 'local.browser.workspace'],
      ['cards-command', 'local.process.execute'],
      ['cards-local-mcp', 'local.mcp.call'],
      ...(reviewCreate
        ? [
            ['review-create-empty', 'subagent'],
            ['review-create-failed', 'subagent_fork'],
          ]
        : []),
      ...retryCloud.map((op) => [op.nativeCallId, 'cloud_mcp_call']),
    ];
    for (const [index, [toolCallId, name]] of calls.entries()) {
      if (
        stage === 'initial' &&
        ((regression?.startsWith('late-') && toolCallId === 'cards-pair') ||
          (reviewCommand && toolCallId === 'cards-command'))
      )
        continue;
      const start = timelineCards
        ? tick(index === 0 ? 20 : 50 + index * 2)
        : at;
      add('tool.started', { toolCallId, name }, start);
      const failed =
        (regression === 'late-closed' && toolCallId === 'cards-pair') ||
        toolCallId === 'review-create-failed' ||
        toolCallId === 'cards-retry-0';
      add(
        failed ? 'tool.failed' : 'tool.completed',
        {
          toolCallId,
          name,
          ...(toolCallId === 'review-create-failed'
            ? { summary: '授权读取被拒绝' }
            : {}),
        },
        start,
      );
      if (timelineCards && index === 0) {
        add('harness.native', { turnId: 'cards-turn' }, tick(30));
        events.at(-1)!.sourceEvent = {
          id: 'dsh:4242',
          type: 'user/message',
          occurredAt: tick(30),
          payload: {},
        };
        add(
          'assistant.text.delta',
          {
            replyId: 'cards-after',
            text: '采用补充后的说明。',
          },
          tick(40),
        );
      }
    }
    if (timelineCards && stage !== 'initial')
      add(
        'assistant.text.delta',
        {
          replyId: 'cards-later',
          text: '补充后追加的说明。',
        },
        tick(90),
      );
    add(
      'assistant.text.completed',
      {
        replyId: 'answer',
        text: '最终核对结果。\n\n| 项目 | 数量 |\n| --- | --- |\n| 已核对 | 12 |',
      },
      timelineCards ? tick(100) : at,
    );
    return events;
  }
  if (panelsEnabled)
    for (const name of [
      'browser.run',
      'local.browser.workspace',
      'local.mcp.call',
    ]) {
      add('tool.started', { toolCallId: `gate-${name}`, name });
      add('tool.completed', { toolCallId: `gate-${name}`, name });
    }
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
    readingEnablePanels: () => void;
    readingReads: Record<string, number>;
  }
}
window.readingWrites = [];
window.readingReads = {};
let panelsEnabled = false;
window.fetch = async (input, init) => {
  const url = String(input);
  const path = new URL(url, location.origin).pathname;
  if (init?.method === 'POST')
    window.readingWrites.push({ url, body: JSON.parse(String(init.body)) });
  else window.readingReads[path] = (window.readingReads[path] ?? 0) + 1;
  if (path === '/api/v1/runtime/project-services') {
    const service = cardsCloud[2]!.projectService!;
    service.stopRequested = true;
    return Response.json({ service });
  }
  if (path === `/api/v1/files/${id(336)}/sign`)
    return Response.json({ url: `/api/v1/files/${id(336)}/download` });
  if (url.startsWith('/api/v1/managed-browser-tasks'))
    return Response.json({ tasks: cardsScenario ? cardsManaged : [] });
  if (url.startsWith('/api/v1/runtime/browser-workspaces'))
    return Response.json({ workspaces: cardsScenario ? currentBrowser() : [] });
  if (url.startsWith('/api/v1/runtime/local-commands'))
    return Response.json({ operations: cardsScenario ? cardsCommands : [] });
  if (url.startsWith('/api/v1/runtime/local-mcp'))
    return Response.json({ operations: cardsScenario ? cardsMcp : [] });
  const artifact = cardsArtifacts.find((item) =>
    path.endsWith(`/artifacts/${item.id}`),
  );
  if (artifact) return Response.json({ artifact, feedback: [] });
  if (path.includes('/artifacts/') && path.endsWith('/executions'))
    return Response.json({
      executions: changesetRuns(ids.artifact).map((run) => ({
        ...run,
        payload: {
          ...run.payload,
          arguments: { ...run.payload.arguments, artifactId: ids.doneArtifact },
        },
      })),
    });
  if (path.endsWith('/content'))
    return Response.json(
      path.includes(ids.doneArtifact)
        ? {
            kind: 'changeset',
            changeset: {
              contractVersion: 1,
              comparisonScope: 'changeset',
              execution: savedChange.snapshot.binding.execution,
              files: savedChange.payload.arguments.files,
            },
          }
        : {
            kind: 'text',
            text: 'item,count\nchecked,12\n',
            mediaType: 'text/csv',
          },
    );
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
      operations: cardsScenario
        ? [...cardsCloud, ...retryCloud]
        : Array.from(
            {
              length:
                memoryScenario || processScenario ? 0 : appended ? 37 : 36,
            },
            (_, i) =>
              operation(
                i,
                new URL(url, location.origin).searchParams.get('runId') ??
                  ids.run,
              ),
          ),
    });
  if (url.startsWith('/api/v1/runtime/approvals/')) {
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
  const [enabled, setEnabled] = useState(cardsScenario);
  const [selected, setSelected] = useState<string | null>(null);
  window.readingEnablePanels = () => {
    panelsEnabled = true;
    setEnabled(true);
  };
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
          transcriptView={
            reviewCreate && new URLSearchParams(location.search).has('verbose')
              ? 'verbose'
              : cardsScenario
                ? 'detailed'
                : 'standard'
          }
          localCommandsEnabled={enabled}
          localMcpEnabled={enabled}
          artifacts={cardsScenario ? cardsArtifacts : []}
          onOpenArtifact={cardsScenario ? setSelected : undefined}
          collapseTiming="completion"
          messages={[
            user,
            ...(timelineCards
              ? [
                  {
                    ...user,
                    id: 'cards-steering',
                    content: { text: '按补充继续核对。' },
                    steering: {
                      runId: run,
                      turnId: 'cards-turn',
                      generation: 0,
                      status: 'adopted' as const,
                      sequence: 4242,
                    },
                  },
                ]
              : []),
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
      {(reviewCommand || reviewCreate) && (
        <label>
          后方编辑位置 <input aria-label="后方编辑位置" />
        </label>
      )}
      {selected && (
        <ArtifactWorkbench
          open
          width={600}
          narrow={innerWidth < 800}
          dockScope="cards-fixture"
          sessionId={ids.session}
          workspaceId={ids.workspace}
          tenantHeaders={headers}
          artifacts={cardsArtifacts}
          selectedId={selected}
          nextCursor={null}
          listError=""
          listLoading={false}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
          onReload={async () => {}}
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
