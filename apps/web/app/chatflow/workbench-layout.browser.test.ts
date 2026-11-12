import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFailed,
} from 'vitest';
import {
  createFailureCleanup,
  createFailureEvidence,
} from '../../../../scripts/test-failure-evidence.mjs';
import { officePreview } from '@allrice/office-runtime';
import type { CloudOperationView } from '@allrice/database';
import type {
  Browser,
  Page,
  Locator,
  Request,
} from '../../../worker/node_modules/playwright-core/index.js';
import {
  CompanyAssetSchema,
  defaultUserPreferences,
  defaultWorkAutomation,
  UserPreferencesInputSchema,
  type UserPreferences,
  type ExperienceCandidate,
  type ExperienceDraftBatch,
  ExperienceOverviewSchema,
  WorkbenchArtifactSchema,
  type WorkbenchFile,
  type WorkbenchDeliverable,
  ReferenceRevisionSchema,
  type ReferenceRevision,
  EmployeeInstanceSchema,
  EmployeeInstanceProfileSchema,
  EmployeeSkillCatalogSchema,
  EmployeeMemoryPageSchema,
  PersonalSceneSkillCatalogSchema,
  EmployeeSceneSkillCatalogSchema,
  type PersonalSkillItem,
  type EmployeeInstance,
  TaskNextStepsSchema,
  RuntimeTaskRefSchema,
  type MessageFeedbackItem,
  McpConnectionSchema,
  type McpConnection,
  OfficeRenderResponseSchema,
  WorkflowPackageSchema,
  BrandContentBoardSchema,
  brandContentTemplateKeys,
  workspaceCapabilityIds,
  type WorkspaceCapability,
  type InteractionStatus,
  type ChatFlowEventEnvelope,
  type EmployeeAccentColor,
  type AutomationCatalogTask,
  type Appearance,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import { NativeSubagentFixtureFeed } from '../../test/native-subagent-fixture-feed';
import { appearanceScript, themeScript } from '../../lib/theme/theme-script';
import type { ArtifactPreview } from '../../lib/chatflow/workbench-model';
import type {
  BridgeDevice,
  QueuedMessage,
  Message,
  WorkspaceFile,
  Session,
} from './chatflow-types';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';
import { employeeHubErrorResponse } from '../../lib/employeehub/responses';
import { EmployeeInstanceError } from '../../../../packages/database/src/employees/employee-instances.ts';
import { layoutPreferenceKey } from './use-workbench-layout';

const settingsReviewDir = process.env.ALLRICE_SETTINGS_REVIEW_DIR;
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
async function selectSettings(dialog: Locator, label: string) {
  const mobile = dialog.getByRole('combobox', { name: '设置页面' });
  if (await mobile.isVisible()) await mobile.selectOption({ label });
  else
    await dialog
      .locator('nav')
      .getByRole('button', { name: label, exact: true })
      .click();
}

async function selectSessionAction(page: Page, row: Locator, name: string) {
  await row.hover();
  await row.getByRole('button', { name: /^会话.*的操作$/ }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

async function archiveConversations(page: Page) {
  const dialog = page.getByRole('dialog', { name: '已归档', exact: true });
  await dialog.getByRole('tab', { name: '对话', exact: true }).click();
  return dialog;
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1),
  B = id(2),
  org = id(3),
  workspace = id(4),
  user = id(5),
  run = id(6);
const now = '2026-09-20T00:00:00.000Z';
const operationTask = () =>
  RuntimeTaskRefSchema.parse({
    scope: { organizationId: org, workspaceId: workspace, projectId: null },
    chatSessionId: A,
    runId: run,
    rootRunId: run,
    parentRunId: null,
    frozenConfiguration: {
      employeeVersionId: id(8),
      digest: `sha256:${'a'.repeat(64)}`,
    },
  });
const report =
  '# COIN / MSTR / CRCL · 合成研究报告\n\n| 标的 | 说明 |\n| --- | --- |\n| COIN | 测试数据，非投资建议 |\n\n' +
  '多步研究结果与引用说明。'.repeat(100);

function nativeChildSummary(): NativeSubagentSummary {
  return {
    rootId: 'native-root',
    root: { source: 'live', cursor: 8 },
    descendants: ['child-a', 'child-b'].map((childId, index) => ({
      kind: 'child',
      id: childId,
      parentId: 'native-root',
      depth: 1,
      mode: 'continuable',
      label: '同名复核',
      task: `${childId} 自己的任务`,
      lastReply: `${childId} 获授权的回复`,
      running: index === 0,
      activity: index === 0 ? 'running' : 'inactive',
      observation: { source: 'live', cursor: 8 },
      timing: { settledMs: 1000, lastTurnCompleted: true },
      usage: {
        uncachedInputTokens: 1,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        outputTokens: 4,
      },
    })),
  };
}
function nativeChildCalls(): ChatFlowEventEnvelope[] {
  return ['subagent', 'list_agents'].flatMap((name, index) =>
    ['started', 'completed'].map((status, offset): ChatFlowEventEnvelope => {
      const sequence = index * 2 + offset + 1;
      return {
        schemaVersion: 3,
        eventId: id(7100 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 0,
        cursor: `${run}:${sequence}`,
        sequence,
        harness: 'dsh',
        type: status === 'started' ? 'tool.started' : 'tool.completed',
        occurredAt: now,
        sourceEvent: null,
        payload: { name, toolCallId: `native-${index}` },
      };
    }),
  );
}

function brandContentPackage() {
  return WorkflowPackageSchema.parse({
    organizationId: org,
    workspaceId: workspace,
    ownerId: user,
    assignmentId: id(7),
    employeeId: id(9),
    instanceId: id(8100),
    sceneId: null,
    workflow: {
      kind: 'workflow',
      id: id(8200),
      workflowId: id(8201),
      slug: 'brand-topics',
      name: '生成内容选题',
      description: '仅用于组件fixture',
      revision: 1,
      status: 'published',
      checksum: `sha256:${'a'.repeat(64)}`,
      definition: {
        schemaVersion: 1,
        steps: [{ key: 'topics', name: '选题', kind: 'model' }],
      },
      publishedAt: now,
    },
    manifest: {
      schemaVersion: 1,
      templateKey: brandContentTemplateKeys.topics,
      method: {
        sourceKind: 'procedure',
        contentId: id(8202),
        revisionId: id(8203),
        digest: `sha256:${'b'.repeat(64)}`,
      },
      definitionChecksum: `sha256:${'a'.repeat(64)}`,
    },
    checksum: `sha256:${'c'.repeat(64)}`,
    createdAt: now,
  });
}

function brandContentBoard() {
  return BrandContentBoardSchema.parse({
    brand: {
      id: id(8210),
      name: '合成测试品牌',
      revision: 1,
      contextRevisionId: id(8211),
      createdAt: now,
      updatedAt: now,
    },
    contexts: [
      {
        id: id(8211),
        brandName: '合成测试品牌',
        number: 1,
        digest: `sha256:${'d'.repeat(64)}`,
        content: {
          audience: '单测受众',
          tone: '准确',
          requirements: '真实事实',
          visualBrief: '',
          facts: [{ id: 'one', text: '仅用于UI单测的事实' }],
          sourceFiles: [],
          strategies: [],
        },
        createdAt: now,
      },
    ],
    batches: [],
    topics: [],
    articles: [],
    bundles: [],
    reviews: [],
    plans: [],
    receipts: [],
    truncated: false,
  });
}
function session(sessionId: string): Session {
  return {
    id: sessionId,
    title: sessionId === A ? '研究任务 A' : '研究任务 B',
    employeeAssignmentId: id(7),
    employeeVersionId: id(8),
    visibility: 'private',
    updatedAt: now,
    archivedAt: null,
  };
}
function artifact(n: number, sessionId = A) {
  const artifactId = id(n),
    objectId = id(n + 100);
  return WorkbenchArtifactSchema.parse({
    contractVersion: 1,
    id: artifactId,
    kind: 'document',
    version: {
      id: artifactId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      objectId,
      seriesId: artifactId,
      version: 1,
      parentVersionId: null,
      parentObjectId: null,
      sessionId,
      platformTestRunId: null,
      fileName: `report-${n}.md`,
      format: 'markdown',
      changeSummary: null,
      createdAt: `2026-09-20T00:${String(n).padStart(2, '0')}:00.000Z`,
    },
    object: {
      id: objectId,
      organizationId: org,
      workspaceId: workspace,
      ownerId: user,
      key: `organizations/${org}/workspaces/${workspace}/owners/${user}/exports/${objectId}`,
      mediaType: 'text/markdown',
      checksum: `sha256:${'a'.repeat(64)}`,
      sizeBytes: report.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    },
    provenance: {
      kind: 'model_proposal',
      runId: run,
      operationId: null,
      stepId: null,
    },
    execution: null,
    latestVersionId: artifactId,
    stale: false,
  });
}

function catalogFile(
  n: number,
  overrides: Partial<WorkbenchFile> = {},
): WorkbenchFile {
  return {
    objectId: id(n),
    workspaceId: workspace,
    fileName: `资料-${n}.txt`,
    mediaType: 'text/plain',
    checksum: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 64,
    createdAt: now,
    ownedByMe: true,
    canMaintain: true,
    revision: 1,
    sharing: { scope: 'personal', departmentIds: [], departmentNames: [] },
    category: 'upload',
    sessionIds: [A],
    artifact: null,
    isReference: false,
    reference: null,
    ...overrides,
  };
}

function fileReference(n: number, file: WorkbenchFile): ReferenceRevision {
  return ReferenceRevisionSchema.parse({
    sourceId: id(n),
    revisionId: id(n + 1),
    revision: 1,
    ownership: { scope: 'personal', organizationId: org, ownerId: user },
    fileName: file.fileName,
    purpose: '',
    checksum: file.checksum,
    sizeBytes: file.sizeBytes,
    mediaType: file.mediaType,
    status: 'active',
    processing: 'ready',
    failure: null,
    canMaintain: true,
    createdAt: now,
  });
}

function recurringTask(
  n: number,
  sessionId = A,
  status: 'enabled' | 'paused' = 'enabled',
): AutomationCatalogTask {
  return {
    id: id(n),
    name: `定时工作 ${n}`,
    prompt: `检查合成工作 ${n} 的进度`,
    employeeId: id(7),
    employeeName: 'Rice',
    sessionId,
    sessionTitle: session(sessionId).title,
    sourceArchived: false,
    createdAt: now,
    nextRunAt: status === 'enabled' ? '2099-01-01T01:00:00.000Z' : null,
    canStop: true,
    definition: {
      kind: 'recurring',
      task: {
        id: id(n),
        name: `定时工作 ${n}`,
        prompt: `检查合成工作 ${n} 的进度`,
        sessionId,
        clientRequestId: id(n + 100),
        rule: { kind: 'every', seconds: 120 },
        revision: 1,
        status,
        nextRunAt: status === 'enabled' ? '2099-01-01T01:00:00.000Z' : null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        canManage: true,
        latestOccurrence: null,
      },
    },
  };
}

function navigationHistory(count: number, paragraphs = 90): Message[] {
  return Array.from({ length: count }, (_, i) => [
    {
      id: id(2000 + i * 2),
      role: 'user' as const,
      runId: id(3000 + i),
      status: 'completed' as const,
      content: { text: `第 ${i + 1} 项工作：分析文档` },
      createdAt: now,
    },
    {
      id: id(2001 + i * 2),
      role: 'assistant' as const,
      runId: id(3000 + i),
      status: 'completed' as const,
      content: {
        text: `第 ${i + 1} 项答复\n\n${'已有资料的分析结论。'.repeat(paragraphs)}`,
      },
      createdAt: now,
    },
  ]).flat();
}

function deliverablePdf(missingFonts?: string[]): ArtifactPreview {
  const text = 'BT /F1 16 Tf 30 350 Td (Delivery original preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
    .join(
      '\n',
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return {
    kind: 'pdf',
    base64: Buffer.from(pdf).toString('base64'),
    converted: true,
    ...(missingFonts ? { missingFonts } : {}),
  };
}

suite('MET-147 UX01-A full tenant workbench (synthetic HTTP, no model)', () => {
  let browser: Browser, server: Server, origin: string;
  const unreadCleanups = new WeakMap<
    object,
    ReturnType<typeof createFailureCleanup>
  >();
  afterEach(async ({ task }) => {
    const cleanup = unreadCleanups.get(task);
    unreadCleanups.delete(task);
    if (cleanup) await cleanup.finish(task.result);
  });
  const subagentFeed = new NativeSubagentFixtureFeed();
  const nativeDocuments = new Map<string, () => string>();
  const downloadFixtures = new Map<
    string,
    { fileName: string; body: string }
  >();
  beforeAll(async () => {
    const root = process.cwd(),
      require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: root,
      entryPoints: ['apps/web/test/met147-workbench-page.tsx'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/unused-met147',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: {
        'process.env.NODE_ENV': JSON.stringify(
          process.env.ALLRICE_BROWSER_PRODUCTION === '1'
            ? 'production'
            : 'development',
        ),
        'process.env': '{}',
      },
    });
    const js = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.js'),
    ).contents;
    const css = built.outputFiles.find((f: { path: string }) =>
      f.path.endsWith('.css'),
    ).contents;
    server = createServer((request, response) => {
      if (subagentFeed.handle(request, response)) return;
      const download = downloadFixtures.get(request.url!);
      if (download) {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
        });
        response.end(download.body);
        return;
      }
      const path = new URL(request.url!, 'http://localhost').pathname;
      const nativeDocument =
        path === '/'
          ? nativeDocuments.get(
              request.headers.cookie?.match(
                /(?:^|; )native-subagent-fixture=([^;]+)/,
              )?.[1] ?? '',
            )
          : undefined;
      response.writeHead(200, {
        'content-type':
          path === '/app.js'
            ? 'application/javascript'
            : path === '/app.css'
              ? 'text/css'
              : 'text/html',
      });
      response.end(
        path === '/app.js'
          ? js
          : path === '/app.css'
            ? css
            : (nativeDocument?.() ??
              '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>'),
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('No loopback address');
    origin = `http://127.0.0.1:${address.port}`;
    subagentFeed.attach(server);
    const { chromium } = createRequire(
      resolve(root, 'apps/worker/package.json'),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await subagentFeed.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 30_000);

  async function fixture(
    options: {
      settingsEntry?:
        | 'preferences'
        | 'computer'
        | 'work'
        | 'apps'
        | 'account'
        | 'capabilities'
        | 'experience'
        | 'skills';
      personalSkills?: boolean;
      archiveCount?: number;
      archiveActive?: boolean;
      tenantAdmin?: boolean;
      employeeCount?: number;
      employeeHistory?: boolean;
      employeeDetails?: boolean;
      employeeHistoryCount?: number;
      officeHistoryCount?: number;
      touch?: boolean;
      employeeColor?: EmployeeAccentColor;
      width?: number;
      artifacts?: boolean;
      technicalArtifacts?: boolean;
      initialArtifacts?: ReturnType<typeof artifact>[];
      initialFiles?: WorkspaceFile[];
      initialMessages?: Message[];
      nativeSubagents?: NativeSubagentSummary;
      nativeEvents?: ChatFlowEventEnvelope[];
      eventsDelay?: Promise<void>;
      disabled?: boolean;
      taskSuggestions?: boolean;
      localMcp?: boolean;
      noSession?: boolean;
      noStorage?: boolean;
      startup?: 'failed' | 'slow';
      running?: boolean;
      streamingOutput?: boolean;
      controlledStream?: boolean;
      queue?: boolean;
      brandContent?: { kind: 'general' | 'custom'; registered: boolean };
      scheduledTasks?: AutomationCatalogTask[];
      // Serve the page as the server does for a signed-in employee: the
      // theme scripts with the saved appearance, read when the page loads.
      appearance?: Appearance;
      // Another browser of the same account shares these saved preferences.
      preferences?: Record<string, UserPreferences>;
      failureEvidence?: ReturnType<typeof createFailureEvidence>;
      failureCleanup?: ReturnType<typeof createFailureCleanup>;
    } = {},
  ) {
    const serverTheme =
      options.appearance !== undefined || options.preferences !== undefined;
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: 950 },
      colorScheme: settingsReviewDir ? 'light' : undefined,
      hasTouch: options.touch,
      isMobile: options.touch,
    });
    const contextOwner = options.failureCleanup?.own(() => context.close());
    if (contextOwner?.late) await contextOwner.late;
    const page = await context.newPage();
    options.failureCleanup?.check();
    options.failureEvidence?.observePage(page);
    page.setDefaultTimeout(5000);
    // Loading the development bundle can outlast interaction waits under CI load.
    page.setDefaultNavigationTimeout(15_000);
    const employeeHistorySessions = [
      ...Array.from({ length: options.employeeHistoryCount ?? 7 }, (_, n) => ({
        ...session(id(600 + n)),
        title: `历史工作 ${n + 1}`,
      })),
      ...Array.from({ length: options.officeHistoryCount ?? 1 }, (_, n) => ({
        ...session(n === 0 ? B : id(7000 + n)),
        employeeAssignmentId: id(17),
        ...(n ? { title: `Office 工作 ${n + 1}` } : {}),
      })),
      {
        ...session(id(6750)),
        employeeAssignmentId: id(99),
        employeeName: '旧员工',
        title: '已撤回员工的工作',
      },
    ];
    const errors: string[] = [],
      writes: string[] = [],
      unexpected: string[] = [];
    const state = {
      personalSkillWrites: [] as string[],
      personalSkills: options.personalSkills
        ? ([
            {
              id: id(8500),
              name: 'private-checklist',
              description: '交付前核对三项',
              revision: 1,
              state: 'installed',
              versionId: id(8501),
              version: 1,
              source: {
                kind: 'attachment',
                objectId: id(8502),
                fileName: 'SKILL.md',
                originalChecksum: `sha256:${'a'.repeat(64)}`,
                byteLength: 100,
              },
              definitionChecksum: `sha256:${'b'.repeat(64)}`,
              compatibility: 'instruction_format_checked',
              businessVerification: 'not_verified',
              bindings: [
                {
                  id: id(8503),
                  instanceId: id(7),
                  workspaceId: workspace,
                  enabled: true,
                  epoch: 1,
                  label: 'Rice',
                },
              ],
              createdAt: now,
              updatedAt: now,
            },
          ] as PersonalSkillItem[])
        : [],
      createdEmployeeInstances: [] as EmployeeInstance[],
      brandContentKind: options.brandContent?.kind,
      brandContentRegistered: options.brandContent?.registered ?? false,
      brandContentCatalogReads: [] as Array<{
        instanceId: string;
        viewerId: string;
      }>,
      brandContentCatalogDelay: null as Promise<void> | null,
      sceneCatalogReads: [] as Array<{ instanceId: string; viewerId: string }>,
      sceneCatalogDelay: null as Promise<void> | null,
      brandContentBoardReads: 0,
      brandContentLaunches: [] as Array<Record<string, unknown>>,
      historyRunning: options.running ?? false,
      bridgeDevices: [] as BridgeDevice[],
      bridgeError: false,
      bridgeSelections: [] as string[],
      archivedIds: new Set<string>(),
      sessionEdits: new Map<string, Partial<Session>>(),
      archiveActive: options.archiveActive ?? false,
      archiveError: false,
      sessionListError: false,
      sessionListDelay: null as Promise<void> | null,
      historyError: false,
      historyDelay: null as Promise<void> | null,
      sessionListRequests: 0,
      sessionPageError: false,
      sessionPageDelay: null as Promise<void> | null,
      sessionPageRequests: [] as string[],
      archiveRequests: [] as Array<{
        archived: boolean;
        stopActivity?: boolean;
      }>,
      startupFailure: options.startup === 'failed',
      messages: (options.initialMessages ?? null) as Message[] | null,
      workMethods: [] as NonNullable<Message['workMethods']>,
      queue: [] as QueuedMessage[],
      queuedStarted: [] as Message[],
      queueError: false,
      queueDelay: null as Promise<void> | null,
      queueActions: [] as Array<{
        action: string;
        expectedTurnId?: string;
        expectedGeneration?: number;
      }>,
      messageInputs: [] as Array<{
        text: string;
        attachmentIds: string[];
        referenceRevisionIds?: string[];
      }>,
      connections: [] as McpConnection[],
      connectionReads: 0,
      connectionError: false,
      connectionActions: [] as string[],
      readinessError: false,
      readinessWrongScope: false,
      readinessDelay: null as Promise<void> | null,
      readinessRequests: 0,
      canAdminister: false,
      capabilities: workspaceCapabilityIds.map((id): WorkspaceCapability => ({
        id,
        state:
          id === 'report'
            ? 'ready'
            : id === 'local_files'
              ? 'needs_configuration'
              : 'not_released',
        reason:
          id === 'report'
            ? 'ready'
            : id === 'local_files'
              ? 'bridge_missing'
              : 'release_disabled',
        action:
          id === 'report'
            ? 'compose'
            : id === 'local_files'
              ? 'bridge'
              : 'guide',
        target: id === 'local_files' ? 'local' : 'cloud',
        responsibleRole: 'user',
        releaseEnabled: ['report', 'local_files'].includes(id),
        authorization: 'normal_policy',
      })),
      viewer: user,
      preferences:
        options.preferences ??
        ({
          [user]: {
            ...defaultUserPreferences,
            streamingOutput:
              options.streamingOutput ?? defaultUserPreferences.streamingOutput,
            appearance: options.appearance ?? defaultUserPreferences.appearance,
          },
        } as Record<string, UserPreferences>),
      preferenceError: false,
      preferenceDelay: null as Promise<void> | null,
      workspace,
      employeeDetails: employeeDetailsFixture(),
      employeeDetailStatus: 200,
      employeeDetailDelay: null as Promise<void> | null,
      employeeDetailReads: 0,
      employeeInstanceDelay: null as Promise<void> | null,
      employeeInstanceStatus: 200,
      employeeInstanceArchived: false,
      employeeHistoryDelay: null as Promise<void> | null,
      employeeHistoryStatus: 200,
      experienceReads: 0,
      experienceDelay: null as Promise<void> | null,
      experienceStatus: 200,
      experienceCandidates: [] as ExperienceCandidate[],
      experienceBatches: [] as ExperienceDraftBatch[],
      employeeModel: 'configured-model',
      employeeReasoningEffort: 'medium',
      omitSessionA: false,
      deepLinkDenied: false,
      items:
        options.initialArtifacts ?? (options.artifacts ? [artifact(10)] : []),
      listError: false,
      artifactReads: 0,
      detailReads: {} as Record<string, number>,
      detailStatus: 200,
      messageFeedback: [] as MessageFeedbackItem[],
      feedbackError: false,
      feedbackWrites: 0,
      feedbackReview: { status: 'new', note: '' },
      contentError: false,
      officePreview: null as ArtifactPreview | null,
      files: options.initialFiles ?? ([] as WorkspaceFile[]),
      fileReads: 0,
      workspaceReads: 0,
      workbenchReads: 0,
      deliverablesStatus: 200,
      filePreviewStatus: 200,
      deliverableRequests: [] as Record<string, string>[],
      deliverableSettled: new Set<Record<string, string>>(),
      updateReads: 0,
      workbenchFiles: [] as WorkbenchFile[],
      workbenchReferenceUses: [] as string[],
      workbenchPreviewReads: 0,
      workbenchExperienceKeys: [] as string[],
      scheduledTasks: options.scheduledTasks ?? [],
      scheduledReads: [] as Array<{
        sessionId: string | null;
        cursor: string | null;
      }>,
      workbenchMutations: [] as Array<{
        method: string;
        objectId?: string;
        body: Record<string, unknown>;
      }>,
      filePreview: {
        kind: 'text',
        mediaType: 'text/markdown',
        text: '# 上传的文件',
      } as ArtifactPreview,
      fileDelay: null as Promise<void> | null,
      text: report,
      artifactTexts: {} as Record<string, string>,
      textPageLines: null as number | null,
      reply: report,
      messageStatus: options.running ? 'pending' : 'completed',
      streamRequests: 0,
      events: options.nativeEvents ?? ([] as ChatFlowEventEnvelope[]),
      nativeSubagents: options.nativeSubagents ?? null,
      eventsDelay: options.eventsDelay ?? (null as Promise<void> | null),
      streamEvents: null as ChatFlowEventEnvelope[] | null,
      employeeName: 'Rice',
      runTimings: [] as NonNullable<InteractionStatus['runTimings']>,
      timingError: false,
      inputs: [] as InteractionStatus['inputs'],
      delay: null as null | Promise<void>,
    };
    if (options.technicalArtifacts)
      for (const item of state.items) item.provenance.kind = 'project_snapshot';
    const nativeFixture = options.nativeSubagents
      ? subagentFeed.register({
          summary: (sessionId) =>
            sessionId === A
              ? state.nativeSubagents
              : {
                  rootId: sessionId,
                  root: { source: 'live', cursor: -1 },
                  descendants: [],
                },
        })
      : undefined;
    if (nativeFixture) await subagentFeed.bindPage(page, origin, nativeFixture);
    const archivedHistory = Array.from(
      { length: options.archiveCount ?? 0 },
      (_, n) => ({
        ...session(id(1600 + n)),
        title: `归档工作 ${n + 1}`,
        archivedAt: now,
      }),
    );
    const withArchive = (item: Session): Session => ({
      ...item,
      ...(options.brandContent
        ? {
            employeeInstanceId:
              (item.id === A && state.brandContentKind === 'custom') ||
              item.id === id(8300)
                ? id(8100)
                : id(7),
          }
        : {}),
      ...(options.employeeHistory && item.id === id(600)
        ? { running: state.historyRunning }
        : {}),
      archivedAt: state.archivedIds.has(item.id) ? now : item.archivedAt,
      ...state.sessionEdits.get(item.id),
    });
    const sessionList = () =>
      (options.employeeHistory
        ? employeeHistorySessions
        : options.noSession
          ? []
          : state.omitSessionA
            ? [session(B)]
            : [
                ...(state.brandContentLaunches.length
                  ? [{ ...session(id(8300)), title: '内容选题工作' }]
                  : []),
                session(A),
                session(B),
              ]
      ).map(withArchive);
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    if (options.startup === 'slow') await page.clock.install();
    let finishStream!: () => void;
    const streamGate = new Promise<void>((done) => {
      finishStream = done;
    });
    contextOwner?.replace(async () => {
      releaseStartup();
      finishStream();
      await context.close();
    });
    page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
    if (options.controlledStream)
      await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = new URL(String(input), location.origin);
          if (
            !url.pathname.endsWith('/events') ||
            url.searchParams.has('format')
          )
            return originalFetch(input, init);
          let closed = false;
          let cleanup = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const push = (event: Event) =>
                controller.enqueue(
                  new TextEncoder().encode(
                    (event as CustomEvent<string>).detail,
                  ),
                );
              cleanup = () => {
                closed = true;
                window.removeEventListener('allrice-test-stream', push);
              };
              window.addEventListener('allrice-test-stream', push);
              document.documentElement.dataset.streamReady = 'true';
              init?.signal?.addEventListener(
                'abort',
                () => {
                  if (closed) return;
                  cleanup();
                  controller.close();
                },
                { once: true },
              );
            },
            cancel() {
              cleanup();
            },
          });
          return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        };
      });
    if (options.noStorage)
      await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw Error('Storage disabled');
          },
        });
      });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      const answer = (data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      const workbenchFiles = (personal = false) => {
        const latestBySeries = new Map<string, ReturnType<typeof artifact>>();
        for (const item of state.items) {
          const previous = latestBySeries.get(item.version.seriesId);
          if (!previous || previous.version.version < item.version.version)
            latestBySeries.set(item.version.seriesId, item);
        }
        const latest = personal ? state.items : [...latestBySeries.values()];
        const superseded = new Set(
          state.items
            .filter(
              (item) =>
                latestBySeries.get(item.version.seriesId)?.id !== item.id,
            )
            .map((item) => item.object.id),
        );
        return Array.from(
          new Map(
            [
              ...state.files
                .filter((file) => personal || !superseded.has(file.id))
                .map((file): WorkbenchFile => ({
                  objectId: file.id,
                  workspaceId: state.workspace,
                  fileName: file.fileName,
                  mediaType: file.mediaType,
                  checksum: `sha256:${'a'.repeat(64)}`,
                  sizeBytes: file.sizeBytes,
                  createdAt: now,
                  ownedByMe: file.ownedByMe ?? true,
                  canMaintain: true,
                  revision: 0,
                  sharing: {
                    scope:
                      file.visibility === 'private'
                        ? 'personal'
                        : file.visibility === 'organization'
                          ? 'company'
                          : 'workspace',
                    departmentIds: [],
                    departmentNames: [],
                  },
                  category: file.fileName.startsWith('tool-result-')
                    ? 'upload'
                    : file.category === 'exports'
                      ? 'artifact'
                      : 'upload',
                  sessionIds: [A],
                  artifact: null,
                  isReference: false,
                  reference: null,
                })),
              ...latest.map((item): WorkbenchFile => ({
                objectId: item.object.id,
                workspaceId: state.workspace,
                fileName: item.version.fileName,
                mediaType: item.object.mediaType,
                checksum: item.object.checksum,
                sizeBytes: item.object.sizeBytes,
                createdAt: item.version.createdAt,
                ownedByMe: true,
                canMaintain: true,
                revision: 0,
                sharing: {
                  scope: 'personal',
                  departmentIds: [],
                  departmentNames: [],
                },
                category: item.version.changeSummary?.startsWith('Tool result ')
                  ? 'upload'
                  : 'artifact',
                sessionIds: item.version.sessionId
                  ? [item.version.sessionId]
                  : [],
                artifact: item.version.sessionId
                  ? {
                      id: item.id,
                      sessionId: item.version.sessionId,
                      version: item.version.version,
                    }
                  : null,
                isReference: false,
                reference: null,
              })),
              ...state.workbenchFiles,
            ].map((file) => [file.objectId, file]),
          ).values(),
        );
      };

      if (
        path === '/api/v1/scheduled-tasks' &&
        route.request().method() === 'GET'
      ) {
        const sessionId = url.searchParams.get('sessionId');
        state.scheduledReads.push({
          sessionId,
          cursor: url.searchParams.get('cursor'),
        });
        return answer({
          tasks: state.scheduledTasks.filter(
            (task) => !sessionId || task.sessionId === sessionId,
          ),
          nextCursor: null,
        });
      }
      const scheduledTaskDetail = path.match(
        /^\/api\/v1\/scheduled-tasks\/([a-f0-9-]{36})$/,
      );
      if (scheduledTaskDetail && route.request().method() === 'GET') {
        const task = state.scheduledTasks.find(
          (item) => item.id === scheduledTaskDetail[1],
        );
        return task
          ? answer({ task, occurrences: [], nextCursor: null })
          : answer({ error: { message: '任务不存在' } }, 404);
      }
      if (path === '/api/v1/workbench/updates') {
        state.updateReads++;
        const payload = {
          fileIds: workbenchFiles().map((file) => file.objectId),
          experienceIds: state.workbenchExperienceKeys,
        };
        options.failureEvidence?.mark('updates-route-received', {
          updateReads: state.updateReads,
          fileIds: payload.fileIds,
          experienceIds: [...payload.experienceIds],
        });
        return answer(payload);
      }
      if (
        path === '/api/v1/workbench/files' &&
        url.searchParams.get('view') === 'deliverables'
      ) {
        state.workbenchReads++;
        const request = Object.fromEntries(url.searchParams);
        state.deliverableRequests.push(request);
        const reply = async (data: unknown, status = 200) => {
          try {
            return await answer(data, status);
          } finally {
            state.deliverableSettled.add(request);
          }
        };
        const owner = state.viewer,
          scope = state.workspace,
          delay = state.fileDelay;
        if (state.deliverablesStatus !== 200)
          return reply({}, state.deliverablesStatus);
        const files = workbenchFiles(true)
          .filter(
            (file) =>
              file.ownedByMe &&
              file.category !== 'reference' &&
              !state.items.some(
                (item) =>
                  item.object.id === file.objectId &&
                  (item.provenance.kind === 'project_snapshot' ||
                    !['document', 'plan', 'file'].includes(item.kind) ||
                    item.version.changeSummary?.startsWith('Tool result ')),
              ),
          )
          .map((file): WorkbenchDeliverable => ({
            ...file,
            origin:
              file.category === 'artifact'
                ? 'business-deliverable'
                : 'user-upload',
            sources: file.sessionIds.map((sessionId) => {
              const source =
                sessionList().find((session) => session.id === sessionId) ??
                session(sessionId);
              return {
                sessionId,
                sessionTitle: source.title,
                employeeAssignmentId: source.employeeAssignmentId,
                employeeInstanceId:
                  source.employeeInstanceId ?? source.employeeAssignmentId,
                employeeName: source.employeeName ?? state.employeeName,
              };
            }),
          }));
        const filtered = files.filter(
          (file) =>
            (!url.searchParams.get('objectId') ||
              file.objectId === url.searchParams.get('objectId')) &&
            (!url.searchParams.get('employeeInstanceId') ||
              file.sources.some(
                (source) =>
                  source.employeeInstanceId ===
                  url.searchParams.get('employeeInstanceId'),
              )) &&
            (!url.searchParams.get('category') ||
              url.searchParams.get('category') === 'all' ||
              file.category === url.searchParams.get('category')) &&
            (!url.searchParams.get('query') ||
              file.fileName.includes(url.searchParams.get('query')!)),
        );
        if (delay) await delay;
        if (
          url.searchParams.has('objectId') &&
          (!filtered.length || owner !== user || scope !== workspace)
        )
          return reply({}, 404);
        const start = url.searchParams.get('cursor')
          ? filtered.findIndex(
              (file) => file.objectId === url.searchParams.get('cursor'),
            ) + 1
          : 0;
        const page = filtered.slice(start, start + 50);
        // Capture the response under its original authenticated fixture identity.
        return reply({
          files: owner === user && scope === workspace ? page : [],
          employees: [
            ...new Map(
              files.flatMap((file) =>
                file.sources.map(
                  (source) =>
                    [
                      source.employeeInstanceId,
                      {
                        id: source.employeeInstanceId,
                        name: source.employeeName,
                      },
                    ] as const,
                ),
              ),
            ).values(),
          ],
          nextCursor:
            start + 50 < filtered.length ? page.at(-1)!.objectId : null,
          quotableFileIds: page
            .filter(
              (file) =>
                /\.(?:txt|md|markdown|json|csv|html?)$/i.test(file.fileName) &&
                file.reference?.processing !== 'unsupported',
            )
            .map((file) => file.objectId),
        });
      }
      if (path === '/api/v1/workbench/files') {
        state.workbenchReads++;
        if (state.fileDelay) await state.fileDelay;
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          state.workbenchMutations.push({ method: 'POST', body });
          const file: WorkbenchFile = {
            objectId: id(9900 + state.workbenchMutations.length),
            workspaceId: state.workspace,
            fileName: body.fileName,
            mediaType: body.mediaType,
            checksum: `sha256:${'a'.repeat(64)}`,
            sizeBytes: 10,
            createdAt: now,
            ownedByMe: true,
            canMaintain: true,
            revision: 1,
            sharing: { ...body.sharing, departmentNames: [] },
            category: 'upload',
            sessionIds: [],
            artifact: null,
            isReference: false,
            reference: null,
          };
          state.workbenchFiles.push(file);
          return answer({ objectId: file.objectId }, 201);
        }
        const files = workbenchFiles().filter(
          (file) =>
            (url.searchParams.get('scope') !== 'my' || file.ownedByMe) &&
            (!url.searchParams.get('query') ||
              file.fileName.includes(url.searchParams.get('query')!)),
        );
        return answer({
          files,
          // This synthetic catalog explicitly offers text files and fixed company
          // templates; images and unsupported reference revisions stay unquotable.
          quotableFileIds: files
            .filter(
              (file) =>
                file.reference?.companyTemplate ||
                (/\.(?:txt|md|markdown|json|csv|html?)$/i.test(file.fileName) &&
                  file.reference?.processing !== 'unsupported'),
            )
            .map((file) => file.objectId),
          truncated: false,
          options: {
            writable: true,
            maintenanceLevel: 'company',
            departmentId: id(60),
            departments: [
              { id: id(60), name: '内容部' },
              { id: id(61), name: '运营部' },
            ],
          },
        });
      }
      const workbenchReference = path.match(
        /^\/api\/v1\/workbench\/files\/([a-f0-9-]{36})\/reference$/,
      );
      if (workbenchReference && route.request().method() === 'POST') {
        const file = workbenchFiles().find(
          (file) => file.objectId === workbenchReference[1],
        );
        if (!file) return answer({ error: { message: '文件已不存在' } }, 404);
        const body = route.request().postDataJSON();
        expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
        state.workbenchReferenceUses.push(file.objectId);
        return answer({
          reference: fileReference(
            9800 + state.workbenchReferenceUses.length * 2,
            file,
          ),
        });
      }
      const workbenchFile = path.match(
        /^\/api\/v1\/workbench\/files\/([a-f0-9-]{36})(?:\/(preview|versions))?$/,
      );
      if (workbenchFile) {
        if (route.request().method() === 'PATCH') {
          const body = route.request().postDataJSON();
          state.workbenchMutations.push({
            method: 'PATCH',
            objectId: workbenchFile[1],
            body,
          });
          const file = state.workbenchFiles.find(
            (file) => file.objectId === workbenchFile[1],
          );
          if (file) {
            if (body.sharing)
              file.sharing = {
                ...body.sharing,
                departmentNames: body.sharing.departmentIds.map(
                  (departmentId: string) =>
                    departmentId === id(60) ? '内容部' : '运营部',
                ),
              };
            if (body.isReference !== undefined)
              file.isReference = body.isReference;
            file.revision++;
          }
          return answer({
            objectId: workbenchFile[1],
            revision: body.expectedRevision + 1,
          });
        }
        if (workbenchFile[2] === 'versions')
          return answer({ versions: state.items.map((item) => item.version) });
        if (workbenchFile[2] === 'preview') {
          state.workbenchPreviewReads++;
          if (state.filePreviewStatus !== 200)
            return answer({}, state.filePreviewStatus);
          const item = state.items.find(
            (item) => item.object.id === workbenchFile[1],
          );
          if (item)
            return answer(
              state.officePreview ?? {
                kind: 'text',
                mediaType: 'text/markdown',
                text: state.artifactTexts[item.id] ?? state.text,
              },
              state.contentError ? 503 : 200,
            );
        }
        return workbenchFiles().some(
          (file) => file.objectId === workbenchFile[1],
        )
          ? answer(state.filePreview)
          : answer({ error: { message: '文件已不存在' } }, 404);
      }
      const brandContentPath = path.match(
        /^\/api\/v1\/employee-instances\/([a-f0-9-]{36})\/brand-content(?:\/(workflow))?$/,
      );
      if (brandContentPath) {
        const instanceId = brandContentPath[1]!;
        if (brandContentPath[2] === 'workflow') {
          state.brandContentLaunches.push(route.request().postDataJSON());
          return answer({ error: { message: 'Retired Workflow entry' } }, 404);
        }
        const packages = state.brandContentRegistered
          ? [brandContentPackage()]
          : [];
        if (url.searchParams.get('catalogOnly') === '1') {
          state.brandContentCatalogReads.push({
            instanceId,
            viewerId: state.viewer,
          });
          if (state.brandContentCatalogDelay)
            await state.brandContentCatalogDelay;
          return answer({ packages });
        }
        state.brandContentBoardReads++;
        const board = brandContentBoard();
        return answer({ brands: [board.brand], board, packages, files: [] });
      }
      if (path === '/api/v1/personal-skills') {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON(),
            skill = state.personalSkills[0]!;
          expect(body).toMatchObject({
            installationId: skill.id,
            ...(body.operation === 'uninstall' ? {} : { instanceId: id(7) }),
            workspaceId: workspace,
            expectedRevision: skill.revision,
          });
          if (body.operation === 'uninstall')
            expect(body.instanceId).toBeUndefined();
          expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
          state.personalSkillWrites.push(body.operation);
          skill.revision++;
          for (const binding of skill.bindings) {
            binding.epoch++;
            binding.enabled = body.operation === 'enable';
          }
          if (body.operation === 'uninstall') skill.state = 'uninstalled';
          return answer({ skill });
        }
        if (url.searchParams.has('installationId')) {
          const skill = state.personalSkills[0]!;
          return answer({
            skill,
            versions: [
              {
                id: skill.versionId,
                version: skill.version,
                source: skill.source,
                definitionChecksum: skill.definitionChecksum,
                current: true,
                createdAt: skill.createdAt,
              },
              {
                id: id(194),
                version: 2,
                source: skill.source,
                definitionChecksum: skill.definitionChecksum,
                current: false,
                createdAt: skill.createdAt,
              },
            ],
          });
        }
        return answer({ skills: state.personalSkills });
      }
      if (path === '/api/v1/me/work-automation') {
        expect(route.request().method()).toBe('GET');
        return answer({
          workspaceId: state.workspace,
          revision: 0,
          settings: defaultWorkAutomation,
          editable: true,
        });
      }
      if (path === '/api/v1/me/preferences') {
        const viewerId = state.viewer;
        if (state.preferenceDelay) await state.preferenceDelay;
        if (state.preferenceError)
          return answer({ error: { message: '保存失败，请重试' } }, 503);
        if (route.request().method() === 'PATCH') {
          const body = UserPreferencesInputSchema.parse(
            route.request().postDataJSON(),
          );
          state.preferences[viewerId] = {
            ...defaultUserPreferences,
            ...state.preferences[viewerId],
            ...body,
            updatedAt: now,
          };
        }
        return answer({
          viewerId,
          preferences: state.preferences[viewerId] ?? defaultUserPreferences,
        });
      }
      if (path.endsWith('/message-feedback')) {
        if (route.request().method() === 'GET')
          return answer({
            ok: true,
            value: { items: path.includes(A) ? state.messageFeedback : [] },
          });
        if (state.feedbackError) return answer({}, 503);
        state.feedbackWrites++;
        const body = route.request().postDataJSON();
        if (route.request().method() === 'DELETE') {
          state.messageFeedback = [];
          return answer({ ok: true, value: { absent: true } });
        }
        const saved: MessageFeedbackItem = {
          messageId: body.messageId,
          rating: body.rating,
          ...(body.note ? { note: body.note } : {}),
          ...(body.category ? { category: body.category } : {}),
          version: id(950 + state.feedbackWrites),
          createdAt: Date.parse(now),
          updatedAt: Date.parse(now),
        };
        state.messageFeedback = [saved];
        return answer({ ok: true, value: saved });
      }
      if (path.startsWith('/api/v1/admin/tenant-feedback')) {
        const entry = state.messageFeedback[0];
        const row = entry && {
          id: entry.messageId,
          version: entry.version,
          helpful: entry.rating === 'positive',
          reason: entry.note,
          category: entry.category,
          organization_name: '测试租户',
          workspace_name: '工作区',
          actor_name: '测试用户',
          employee_name: 'Office 文档助手',
          employee_version: 1,
          updated_at: now,
          review_status: state.feedbackReview.status,
          review_note: state.feedbackReview.note,
          response_preview: '报告已经完成',
          question: '制作一份报告',
          answer: '报告已经完成',
          model: 'synthetic',
          run_id: run,
          session_id: A,
          run_status: 'succeeded',
        };
        if (route.request().method() === 'PATCH') {
          const body = route.request().postDataJSON();
          state.feedbackReview = { status: body.status, note: body.note };
          return answer({ updated: true });
        }
        if (path.endsWith('/tenant-feedback'))
          return answer({
            items: row ? [row] : [],
            total: row ? 1 : 0,
            pending: state.feedbackReview.status === 'new' ? 1 : 0,
            page: 1,
            organizations: [{ id: org, name: '测试租户' }],
            employees: [{ id: id(7), name: 'Office 文档助手' }],
          });
        return answer({ feedback: row });
      }
      if (
        !options.queue &&
        path.endsWith('/messages') &&
        route.request().method() === 'POST'
      ) {
        const body = route.request().postDataJSON();
        state.messageInputs.push(body);
        return answer({
          run: { id: run },
          delivery: 'immediate',
          fallbackRunId: null,
          created: true,
          userMessage: {
            id: id(300),
            role: 'user',
            content: { text: body.text },
            status: 'completed',
            runId: run,
            createdAt: now,
          },
          assistantMessage: {
            id: id(500),
            role: 'assistant',
            content: { text: '正在处理…' },
            status: 'pending',
            runId: run,
            createdAt: now,
          },
        });
      }
      if (options.queue && route.request().method() === 'POST') {
        if (path.endsWith('/messages')) {
          const body = route.request().postDataJSON();
          state.messageInputs.push(body);
          const messageId = id(300 + state.messageInputs.length);
          const queued: QueuedMessage = {
            id: messageId,
            runId: id(400 + state.messageInputs.length),
            text: body.text,
            attachments: (body.attachmentIds ?? []).map((value: string) => ({
              id: value,
              fileName: 'inputs.txt',
              mediaType: 'text/plain',
              sizeBytes: 10,
            })),
            createdAt: now,
          };
          state.queue.push(queued);
          return answer({
            delivery: 'follow_up',
            fallbackRunId: queued.runId,
            run: { id: queued.runId },
            userMessage: {
              id: messageId,
              role: 'user',
              content: { text: body.text },
              status: 'completed',
              runId: null,
              createdAt: now,
            },
            assistantMessage: {
              id: id(500 + state.messageInputs.length),
              role: 'assistant',
              content: { text: 'Rice 正在处理…' },
              status: 'pending',
              runId: queued.runId,
              createdAt: now,
            },
          });
        }
        if (path.includes('/queued-messages/')) {
          const action = route.request().postDataJSON();
          state.queueActions.push(action);
          if (state.queueDelay) await state.queueDelay;
          if (state.queueError)
            return answer(
              { error: { message: '这条消息已开始处理，不能再从队列修改。' } },
              409,
            );
          state.queue = state.queue.filter(
            (item) => item.id !== path.split('/').at(-1),
          );
          return answer({ ok: true });
        }
      }
      if (path === '/api/v1/connections') {
        if (route.request().method() === 'PATCH') {
          const input = route.request().postDataJSON();
          expect(input.workspaceId).toBe(state.workspace);
          const connection = state.connections.find(
            (c) => c.id === input.connectionId,
          )!;
          state.connectionActions.push(input.action);
          if (input.action === 'disconnect') connection.disconnected = true;
          if (input.action === 'reconnect') connection.disconnected = false;
          if (input.action === 'delete') {
            connection.disconnected = true;
            connection.removed = true;
          }
          return answer({ connection });
        }
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        state.connectionReads++;
        if (state.connectionError)
          return answer({ error: { message: 'connection failed' } }, 503);
        return answer({ connections: state.connections });
      }
      if (
        path.startsWith('/api/v1/sessions/') &&
        route.request().method() === 'PATCH' &&
        !path.includes('/queued-messages/')
      ) {
        const body = route.request().postDataJSON();
        if (body.archived !== undefined) state.archiveRequests.push(body);
        if (state.archiveError)
          return answer({ error: { message: '测试：归档暂时失败' } }, 503);
        if (body.archived && state.archiveActive && !body.stopActivity)
          return answer(
            {
              error: {
                code: 'SESSION_ACTIVE',
                activity: [
                  { kind: 'job', items: [{ id: run, label: '正在分析报表' }] },
                ],
              },
            },
            409,
          );
        const target = path.split('/').at(-1)!;
        if (body.archived !== undefined) {
          if (body.archived) state.archivedIds.add(target);
          else state.archivedIds.delete(target);
        }
        const changes = state.sessionEdits.get(target) ?? {};
        if (body.title !== undefined) changes.title = body.title;
        if (body.pinned !== undefined)
          changes.pinnedAt = body.pinned ? now : null;
        state.sessionEdits.set(target, changes);
        return answer({ session: withArchive(session(target)) });
      }
      if (path.endsWith('/workspace-selection')) {
        state.bridgeSelections.push(path);
        return answer({ ok: true });
      }
      if (
        path.startsWith('/api/v1/bridge/grants/') &&
        route.request().method() === 'DELETE'
      ) {
        const grantId = path.split('/').at(-1);
        for (const device of state.bridgeDevices)
          device.folderGrants = device.folderGrants.filter(
            (grant) => grant.id !== grantId,
          );
        return answer({ ok: true });
      }
      if (path === '/api/v1/bridge/pairings')
        return answer({
          pairing: {
            id: id(908),
            code: 'ABCD-1234',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        });
      if (route.request().method() !== 'GET') {
        writes.push(path);
        return answer({}, 500);
      }
      if (path === '/api/v1/sessions' && route.request().method() === 'GET') {
        const filter = url.searchParams.get('archived');
        const records = [...sessionList(), ...archivedHistory].filter(
          (item) =>
            filter === 'true' ||
            (filter === 'only' ? !!item.archivedAt : !item.archivedAt),
        );
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const employeeId =
          url.searchParams.get('employeeInstanceId') ??
          url.searchParams.get('employeeAssignmentId');
        if (!employeeId) {
          state.sessionListRequests++;
          if (state.sessionListDelay) await state.sessionListDelay;
          if (state.sessionListError)
            return answer(
              { error: { message: 'Unknown synthetic route' } },
              503,
            );
        }
        if (employeeId) {
          state.sessionPageRequests.push(employeeId);
          if (state.sessionPageDelay) await state.sessionPageDelay;
          if (state.sessionPageError)
            return answer({ error: { message: '测试：会话加载失败' } }, 503);
        }
        const eligible = records
          .map((item, index) => ({ item, index }))
          .filter(
            ({ item, index }) =>
              index >= offset &&
              (!employeeId ||
                (item.employeeInstanceId ?? item.employeeAssignmentId) ===
                  employeeId),
          );
        const visible = eligible.slice(0, 30);
        const groups = new Map<
          string,
          {
            employeeAssignmentId: string;
            employeeInstanceId: string;
            employeeName: string;
            count: number;
          }
        >();
        for (const item of records) {
          const key = item.employeeInstanceId ?? item.employeeAssignmentId;
          const group = groups.get(key) ?? {
            employeeAssignmentId: item.employeeAssignmentId,
            employeeInstanceId: key,
            employeeName: item.employeeName ?? 'Rice',
            count: 0,
          };
          group.count++;
          groups.set(key, group);
        }
        return answer({
          sessions: visible.map(({ item }) => item),
          nextCursor:
            eligible.length > 30 ? String(visible.at(-1)!.index + 1) : null,
          employeeGroups: employeeId ? undefined : [...groups.values()],
        });
      }
      if (
        options.employeeDetails &&
        path === '/api/v1/memories/manage' &&
        route.request().method() === 'GET'
      ) {
        expect([...url.searchParams.keys()].sort()).toEqual([
          'instanceId',
          'state',
          'workspaceId',
        ]);
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        expect(url.searchParams.get('instanceId')).toBe(
          state.employeeDetails.profile.instanceId,
        );
        const memoryState = url.searchParams.get('state');
        expect(['all', 'confirmed', 'pending']).toContain(memoryState);
        return answer(
          EmployeeMemoryPageSchema.parse({
            organizationId: org,
            workspaceId: state.workspace,
            ownerId: state.viewer,
            instanceId: state.employeeDetails.profile.instanceId,
            state: memoryState,
            total: 0,
            memories: [],
            nextCursor: null,
            budget: {
              mode: 'capacity_preview',
              maxBytes: 6000,
              maxItems: 20,
              usedBytes: 0,
              eligibleCount: 0,
              omittedCount: 0,
              selectedIds: [],
            },
          }),
        );
      }
      const skillCatalogTarget = path.match(
        /^\/api\/v1\/employee-instances\/([^/]+)\/skills$/,
      );
      if (skillCatalogTarget && route.request().method() === 'GET') {
        const instanceId = skillCatalogTarget[1]!;
        expect([
          id(7),
          id(17),
          id(99),
          ...(options.brandContent ? [id(8100)] : []),
          ...state.createdEmployeeInstances.map((instance) => instance.id),
        ]).toContain(instanceId);
        expect([...url.searchParams.keys()]).toEqual(['workspaceId']);
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        expect(route.request().headers()['x-allrice-workspace-id']).toBe(
          state.workspace,
        );
        if (state.viewer !== user)
          return answer({ error: { message: 'No access' } }, 403);
        if (options.employeeDetails && state.employeeDetailStatus !== 200)
          return answer(
            { error: { message: 'No access' } },
            state.employeeDetailStatus,
          );
        if (instanceId === id(7) && state.employeeInstanceArchived) {
          const response = employeeHubErrorResponse(
            new EmployeeInstanceError('instance_archived'),
          );
          return answer(await response.json(), response.status);
        }
        return answer(
          EmployeeSkillCatalogSchema.parse({
            instanceId,
            canInstall: true,
            platformSkills: [],
            personalSkills: [],
          }),
        );
      }
      const sceneCatalogTarget = path.match(
        /^\/api\/v1\/employee-instances\/([^/]+)\/scene-skills$/,
      );
      if (sceneCatalogTarget && route.request().method() === 'GET') {
        const instanceId = sceneCatalogTarget[1]!;
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        state.sceneCatalogReads.push({ instanceId, viewerId: state.viewer });
        if (state.viewer !== user)
          return answer({ error: { message: 'No access' } }, 403);
        const custom =
          instanceId === id(8100) ||
          state.employeeDetails.profile.kind === 'custom';
        const body = custom
          ? PersonalSceneSkillCatalogSchema.parse({
              instanceId,
              revision: 0,
              skills: [],
            })
          : EmployeeSceneSkillCatalogSchema.parse({
              instanceId,
              employeeId: id(9),
              skills: [],
            });
        if (state.sceneCatalogDelay) await state.sceneCatalogDelay;
        return answer(body);
      }
      if (
        options.brandContent &&
        path === `/api/v1/employee-instances/${id(8100)}/content`
      ) {
        if (state.viewer !== user)
          return answer({ error: { message: 'No access' } }, 403);
        const body = structuredClone(state.employeeDetails);
        body.profile.instanceId = id(8100);
        body.content.instanceId = id(8100);
        body.profile.kind = 'custom';
        body.profile.name = '内容同事';
        body.profile.revision = 1;
        body.profile.source = {
          kind: 'tenant_version',
          employeeVersionId: id(8),
        };
        return answer(body);
      }
      if (
        (options.employeeDetails || options.brandContent) &&
        [
          `/api/v1/employee-instances/${id(7)}`,
          `/api/v1/employee-instances/${id(8100)}`,
        ].includes(path) &&
        route.request().method() === 'GET' &&
        state.employeeDetailStatus === 200
      ) {
        const target = path.split('/').at(-1)!;
        const profile = state.employeeDetails.profile;
        return answer({
          instance: EmployeeInstanceSchema.parse({
            id: target,
            assignmentId: id(7),
            organizationId: org,
            workspaceId: state.workspace,
            ownerId: user,
            kind: target === id(8100) ? 'custom' : profile.kind,
            revision: target === id(8100) ? 1 : profile.revision,
            profile: {
              name: target === id(8100) ? '内容同事' : profile.name,
              appearance: profile.appearance,
              mission: profile.identity.mission,
              workStyle: profile.identity.workStyle,
              expressionStyle: profile.expressionStyle,
            },
            creationSource: profile.source,
            source:
              target === id(8100)
                ? { kind: 'tenant_version', employeeVersionId: id(8) }
                : profile.source,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          }),
        });
      }
      if (
        (options.employeeDetails || options.brandContent) &&
        path === `/api/v1/employee-instances/${id(7)}/content`
      ) {
        state.employeeDetailReads++;
        const body = structuredClone(state.employeeDetails);
        if (state.employeeDetailDelay) await state.employeeDetailDelay;
        return answer(
          state.employeeDetailStatus === 200
            ? body
            : { error: { message: 'No access' } },
          state.employeeDetailStatus,
        );
      }
      if (
        options.employeeDetails &&
        path === `/api/v1/employee-instances/${id(7)}` &&
        state.employeeDetailStatus !== 200
      )
        // The real dialog also checks the existing owner/history endpoint.
        // This fixture models revoked membership, so both read gates deny it.
        return answer(
          { error: { message: 'No access' } },
          state.employeeDetailStatus,
        );
      if (
        route.request().method() === 'GET' &&
        (path === '/api/v1/employee-instances' ||
          /^\/api\/v1\/employee-instances\/[a-f0-9-]{36}$/.test(path))
      ) {
        if (path === '/api/v1/employee-instances') {
          if (state.employeeHistoryDelay) await state.employeeHistoryDelay;
          if (state.employeeHistoryStatus !== 200)
            return answer(
              { error: { message: 'No access' } },
              state.employeeHistoryStatus,
            );
        } else {
          if (state.employeeInstanceDelay) await state.employeeInstanceDelay;
          if (state.employeeInstanceStatus !== 200)
            return answer(
              { error: { message: 'No access' } },
              state.employeeInstanceStatus,
            );
        }
        if (options.employeeDetails && state.employeeDetailStatus !== 200)
          return answer(
            { error: { message: 'No access' } },
            state.employeeDetailStatus,
          );
        const instances = [7, 17, 99].map((n) =>
          EmployeeInstanceSchema.parse({
            id: id(n),
            assignmentId: id(n),
            organizationId: org,
            workspaceId: state.workspace,
            ownerId: state.viewer,
            kind: 'general',
            revision: 1,
            profile: {},
            creationSource: {
              kind: 'tenant_version',
              employeeVersionId: id(n + 1),
            },
            source: { kind: 'tenant_version', employeeVersionId: id(n + 1) },
            createdAt: now,
            updatedAt: now,
            archivedAt: n === 7 && state.employeeInstanceArchived ? now : null,
          }),
        );
        for (const created of state.createdEmployeeInstances) {
          const index = instances.findIndex(
            (instance) => instance.id === created.id,
          );
          if (index < 0) instances.push(created);
          else instances[index] = created;
        }
        if (options.brandContent)
          instances.push(
            EmployeeInstanceSchema.parse({
              ...instances[0]!,
              id: id(8100),
              assignmentId: id(7),
              kind: 'custom',
              profile: { name: '内容同事' },
            }),
          );
        if (path === '/api/v1/employee-instances')
          return answer({ instances, nextBeforeId: null });
        const instance = instances.find(
          (row) => row.id === path.split('/').at(-1),
        );
        return instance
          ? answer({ instance })
          : answer({ error: { message: 'synthetic instance missing' } }, 404);
      }
      if (path === '/api/v1/experiences') {
        state.experienceReads++;
        const body = {
          overview: ExperienceOverviewSchema.parse({
            visibility: 'owner',
            workspaceId: state.workspace,
            instanceId: id(7),
            summary: {
              enabled: true,
              policy: {
                frequency: 'weekly',
                timezone: 'Asia/Shanghai',
                time: '03:00',
                weekday: 1,
                monthDay: 1,
                source: 'platform',
                revision: 2,
                validationMode: 'supported_cases',
                adoptionMode: 'supported_private',
              },
              schedule: {
                state: 'not_scheduled',
                lastCheckedAt: null,
                nextRunAt: null,
                lastOccurrence: null,
              },
              counts: {
                pendingSources: 2,
                awaitingValidation: 0,
                adoptedTotal: 1,
              },
            },
          }),
          candidates: structuredClone(state.experienceCandidates),
          draftBatches: structuredClone(state.experienceBatches),
        };
        const status = state.experienceStatus;
        if (state.experienceDelay) await state.experienceDelay;
        return answer(status === 200 ? body : { code: 'not_found' }, status);
      }
      if (path === '/api/v1/workspace' && state.startupFailure)
        return answer(
          { error: { message: 'Service temporarily unavailable' } },
          503,
        );
      if (path === '/api/v1/workspace' && options.startup === 'slow')
        await startupGate;
      if (path === '/api/v1/workspace') state.workspaceReads++;
      if (path === '/api/v1/workspace')
        return answer({
          workspace: {
            organizationId: org,
            workspaceId: state.workspace,
            viewerId: state.viewer,
            preferences:
              state.preferences[state.viewer] ?? defaultUserPreferences,
            canAdminister: false,
            sessions: sessionList(),
            sessionModels: [],
            employeeProfiles: options.employeeHistory
              ? [
                  {
                    assignmentId: id(7),
                    employeeId: id(9),
                    name: 'Rice',
                    description: '负责研究、分析与文件交付',
                    appearance: { accentColor: options.employeeColor },
                    identity: {
                      role: '研究助理',
                      mission: '帮助完成研究',
                      workStyle: '按步骤交付',
                      behaviorRules: [],
                      safetyBoundaries: [],
                    },
                    skills: [
                      {
                        id: 'office',
                        name: 'Office',
                        description: '阅读和交付文档',
                      },
                    ],
                    model: {
                      harness: 'dsh',
                      provider: 'codex',
                      model: state.employeeModel,
                      reasoningEffort: state.employeeReasoningEffort,
                    },
                  },
                ]
              : [],
            employees:
              options.employeeCount === 0
                ? []
                : [
                    ...(options.employeeCount === 2
                      ? [
                          {
                            id: id(17),
                            employeeId: id(19),
                            isDefault: false,
                            versions: [],
                            currentVersion: {
                              id: id(18),
                              manifest: {
                                name: 'Office 文档助手',
                                description:
                                  '阅读文档并制作报告、表格与演示文稿。',
                                runtimePolicy: {
                                  harness: 'dsh',
                                  provider: 'codex',
                                },
                              },
                            },
                          },
                        ]
                      : []),
                    {
                      id: id(7),
                      ...(options.employeeDetails ? { instanceId: id(7) } : {}),
                      employeeId: id(9),
                      isDefault: true,
                      ...(options.brandContent
                        ? {
                            instances: (['general', 'custom'] as const).map(
                              (kind) =>
                                EmployeeInstanceSchema.parse({
                                  id: kind === 'custom' ? id(8100) : id(7),
                                  assignmentId: id(7),
                                  organizationId: org,
                                  workspaceId: state.workspace,
                                  ownerId: user,
                                  kind,
                                  revision: 1,
                                  profile:
                                    kind === 'custom'
                                      ? { name: '内容同事' }
                                      : {},
                                  creationSource: {
                                    kind: 'tenant_version',
                                    employeeVersionId: id(8),
                                  },
                                  source: {
                                    kind: 'tenant_version',
                                    employeeVersionId: id(8),
                                  },
                                  createdAt: now,
                                  updatedAt: now,
                                  archivedAt: null,
                                }),
                            ),
                          }
                        : state.createdEmployeeInstances.length
                          ? {
                              instances: [
                                ...(state.createdEmployeeInstances[0]!.id ===
                                id(7)
                                  ? []
                                  : [
                                      {
                                        ...state.createdEmployeeInstances[0]!,
                                        id: id(7),
                                        kind: 'general',
                                        profile: {},
                                      },
                                    ]),
                                ...state.createdEmployeeInstances,
                              ],
                            }
                          : {}),
                      versions: [],
                      currentVersion: {
                        id: id(8),
                        manifest: {
                          name: state.employeeName,
                          appearance: { accentColor: options.employeeColor },
                          runtimePolicy: { harness: 'dsh', provider: 'codex' },
                        },
                      },
                    },
                  ],
          },
        });
      if (path === '/api/v1/saas/capabilities')
        return answer({
          capabilities: {
            schemaVersion: 1,
            roles: options.tenantAdmin
              ? ['member', 'tenant_admin']
              : ['member'],
            surfaces: ['chatflow'],
            actions: [],
            features: { chatFlowV3: true, nativeHarnessEvents: true },
          },
        });
      if (
        [
          '/api/v1/admin/mcp',
          '/api/v1/admin/local-mcp',
          '/api/v1/admin/browser-control',
          '/api/v1/admin/local-browser',
        ].includes(path)
      ) {
        expect(options.tenantAdmin).toBe(true);
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        return answer({
          enabled: true,
          connections: [],
          employees: [],
          devices: [],
          targets: [],
          members: [],
          grants: [],
          humanCredentialsConfigured: false,
        });
      }
      const subagentSession = path.match(
        /^\/api\/v1\/sessions\/([a-f0-9-]{36})\/subagents$/,
      )?.[1];
      if (subagentSession && route.request().method() === 'GET') {
        if (nativeFixture && url.searchParams.get('follow') === 'true')
          return route.continue();
        // No native children in this fixture. Explicitly allow this scoped read;
        // unknown routes and every write keep their existing assertions.
        if (url.searchParams.get('workspaceId') !== state.workspace)
          return answer({ error: { code: 'authorization_denied' } }, 403);
        return answer({
          summary:
            nativeFixture && subagentSession === A
              ? state.nativeSubagents
              : {
                  rootId: subagentSession,
                  root: { source: 'live', cursor: -1 },
                  descendants: [],
                },
        });
      }
      const nextStepsSession = path.match(
        /^\/api\/v1\/sessions\/([a-f0-9-]{36})\/next-steps$/,
      )?.[1];
      if (nextStepsSession && route.request().method() === 'GET') {
        // This fixture has no contextual recommendations. Register the new
        // read explicitly; unexpected requests and all writes remain failures.
        if (url.searchParams.get('workspaceId') !== state.workspace)
          return answer({ error: { code: 'authorization_denied' } }, 403);
        return answer(
          TaskNextStepsSchema.parse({
            contractVersion: 1,
            scope: {
              organizationId: org,
              workspaceId: state.workspace,
              viewerId: state.viewer,
              sessionId: nextStepsSession,
              employeeAssignmentId: url.searchParams.get(
                'employeeAssignmentId',
              ),
              employeeVersionId: url.searchParams.get('employeeVersionId'),
              sourceRunId: null,
              contextRevision: `sha256:${'0'.repeat(64)}`,
            },
            state: 'idle',
            readableArtifactCount: 0,
            notice: '',
            suggestions: [],
          }),
        );
      }
      if (path === '/api/v1/bridge/devices')
        return state.bridgeError
          ? answer({ error: { message: '连接状态刷新失败' } }, 503)
          : answer({ devices: state.bridgeDevices });
      if (/^\/api\/v1\/bridge\/devices\/[^/]+\/sandbox-network$/.test(path)) {
        expect(url.searchParams.get('workspaceId')).toBe(state.workspace);
        const device = state.bridgeDevices.find(
          (device) => device.id === path.split('/').at(-2),
        );
        // Register this settings read; writes and unknown devices still fail.
        return device
          ? answer({ version: 0, enabled: false, profile: null })
          : answer({ error: { message: 'synthetic device missing' } }, 404);
      }
      if (
        /^\/api\/v1\/bridge\/devices\/[^/]+\/settings$/.test(path) &&
        route.request().method() === 'GET'
      ) {
        const device = state.bridgeDevices.find(
          (device) => device.id === path.split('/').at(-2),
        );
        return device
          ? answer({
              device,
              settings: {
                localCommand: true,
                localBrowser: true,
                development: true,
              },
              environment: null,
              revision: 1,
              pending: false,
              supported: false,
            })
          : answer({ error: { message: 'synthetic device missing' } }, 404);
      }
      if (path === '/api/v1/bridge/client/releases')
        return answer({
          releases: [
            {
              platform: 'macos-arm64',
              available: true,
              version: '0.6.0-dev.7',
            },
          ],
        });
      if (path === '/api/v1/workspace/monthly-quota') {
        // A completed turn may still have a read in flight for the old scope.
        // Model the server denying it after a workspace switch, rather than
        // throwing inside Playwright's asynchronous route handler.
        if (url.searchParams.get('workspaceId') !== state.workspace)
          return answer({ error: { code: 'authorization_denied' } }, 403);
        return answer({
          organizationId: org,
          workspaceId: state.workspace,
          userId: state.viewer,
          displayName: 'Synthetic member',
          monthlyTokenLimit: 5000000,
          usedTokens: 2824029,
          remainingTokens: 2175971,
          remainingPercent: 43.51942,
          unknownUsageRuns: 0,
          periodStart: now,
          resetsAt: now,
          observedAt: now,
        });
      }
      if (path === '/api/v1/workspace/readiness') {
        state.readinessRequests++;
        const snapshot = {
          schemaVersion: 1,
          organizationId: org,
          workspaceId: state.workspace,
          viewerId: state.readinessWrongScope ? id(99) : state.viewer,
          sessionId: url.searchParams.get('sessionId'),
          employeeVersionId: id(8),
          observedAt: new Date().toISOString(),
          basis: 'next_task',
          canAdminister: state.canAdminister,
          capabilities: structuredClone(state.capabilities),
        };
        if (state.readinessDelay && url.searchParams.get('sessionId') === A)
          await state.readinessDelay;
        return answer(snapshot, state.readinessError ? 503 : 200);
      }
      if (path === '/api/v1/runtime/cloud-operations')
        return answer({ operations: [] });
      if (path.endsWith('/interactions'))
        return answer(
          {
            runtime: options.queue
              ? {
                  state: 'running',
                  runId: run,
                  turnId: 'native-turn:1',
                  generation: 3,
                  configChecksum: 'queue-test',
                  currentVersionId: id(8),
                  nextVersionId: null,
                }
              : null,
            pendingActions: [],
            inputs: state.inputs,
            runTimings: path.includes(A) ? state.runTimings : [],
          },
          state.timingError ? 503 : 200,
        );
      if (path.endsWith('/timings'))
        return answer(
          { runTimings: path.includes(A) ? state.runTimings : [] },
          state.timingError ? 503 : 200,
        );
      if (path.endsWith('/events')) {
        if (url.searchParams.get('format') === 'json' || !options.running) {
          if (state.eventsDelay) await state.eventsDelay;
          return answer({ events: state.events });
        }
        state.streamRequests++;
        await streamGate;
        return route.fulfill({
          contentType: 'text/event-stream',
          body: (
            state.streamEvents ?? [
              { type: 'assistant.text.delta', payload: { text: report } },
              { type: 'run.succeeded', payload: {} },
            ]
          )
            .map(
              (event, i) =>
                `data: ${JSON.stringify({
                  schemaVersion: 3,
                  eventId: id(200 + i),
                  organizationId: org,
                  workspaceId: workspace,
                  conversationId: null,
                  runId: run,
                  generation: 1,
                  cursor: `${run}:${i + 1}`,
                  sequence: i + 1,
                  harness: 'dsh',
                  occurredAt: now,
                  sourceEvent: null,
                  ...event,
                })}\n\n`,
            )
            .join(''),
        });
      }
      if (path === '/api/dsh-ui/pdf') {
        const require = createRequire(resolve('apps/web/package.json'));
        const file = join(
          dirname(
            require.resolve('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/package.json'),
          ),
          'lib/client.pdf.js',
        );
        return route.fulfill({
          contentType: 'text/javascript',
          body: await readFile(file),
        });
      }
      if (path === '/api/v1/files') {
        if (url.searchParams.get('summary') === '1')
          return answer({
            workspaceId: workspace,
            usedBytes: 2147483648,
            limitBytes: null,
          });
        state.fileReads++;
        if (state.fileDelay) await state.fileDelay;
        return answer({ files: state.files });
      }
      if (path.startsWith('/api/v1/files/') && path.endsWith('/versions'))
        return answer({
          versions: state.items
            .filter(
              (a) =>
                a.version.seriesId ===
                state.items.find((item) => path.includes(item.object.id))
                  ?.version.seriesId,
            )
            .map((a) => a.version),
        });
      if (path.startsWith('/api/v1/files/') && path.endsWith('/preview'))
        return state.files.some((file) => path.includes(file.id))
          ? answer(state.filePreview)
          : answer({ error: { message: '文件已不存在' } }, 404);
      if (path.endsWith('/artifacts')) {
        state.artifactReads++;
        const items = path.includes(A) ? [...state.items] : [];
        if (state.delay && path.includes(A)) await state.delay;
        return answer(
          { artifacts: items, nextCursor: null },
          state.listError ? 503 : 200,
        );
      }
      if (path.includes('/artifacts/')) {
        const a = state.items.find((item) => path.includes(item.id));
        if (!a) return answer({}, 404);
        if (path.endsWith('/content')) {
          const offset = Number(
            new URL(route.request().url()).searchParams.get('offset') ?? 1,
          );
          const contentText = state.artifactTexts[a.id] ?? state.text;
          const lines = contentText.split('\n');
          const page =
            state.textPageLines === null
              ? null
              : lines.slice(offset - 1, offset - 1 + state.textPageLines);
          return answer(
            state.officePreview ?? {
              kind: 'text',
              mediaType: 'text/markdown',
              text: page ? page.join('\n') : contentText,
              ...(page
                ? {
                    offset,
                    lines: page.length,
                    eof: offset + page.length > lines.length,
                  }
                : {}),
            },
            state.contentError ? 503 : 200,
          );
        }
        state.detailReads[a.id] = (state.detailReads[a.id] ?? 0) + 1;
        if (state.detailStatus !== 200)
          return answer(
            { error: { code: 'ARTIFACT_UNAVAILABLE' } },
            state.detailStatus,
          );
        return answer({ artifact: a, feedback: [] });
      }
      if (
        path === `/api/v1/sessions/${A}` &&
        route.request().method() === 'GET'
      ) {
        if (state.historyDelay) await state.historyDelay;
        if (state.historyError)
          return answer(
            {
              error: { code: 'INTERNAL_ERROR', message: 'Session read failed' },
            },
            503,
          );
      }
      if (path === `/api/v1/sessions/${A}` && state.deepLinkDenied)
        return answer({ error: { message: 'Not accessible' } }, 403);
      const listedHistory =
        state.brandContentLaunches.length &&
        path === `/api/v1/sessions/${id(8300)}`
          ? { ...session(id(8300)), title: '内容选题工作' }
          : options.employeeHistory
            ? employeeHistorySessions.find(
                (item) => path === `/api/v1/sessions/${item.id}`,
              )
            : undefined;
      if (
        path === `/api/v1/sessions/${A}` ||
        path === `/api/v1/sessions/${B}` ||
        listedHistory
      )
        return answer({
          history: {
            session: withArchive(
              listedHistory ?? session(path.endsWith(A) ? A : B),
            ),
            queuedMessages: path.endsWith(A) ? state.queue : [],
            messages: path.endsWith(A)
              ? (state.messages ?? [
                  {
                    id: id(20),
                    role: 'assistant',
                    runId: run,
                    status: state.messageStatus,
                    workMethods: state.workMethods,
                    content: {
                      text:
                        state.messageStatus === 'pending' ? '' : state.reply,
                    },
                    createdAt: now,
                  },
                  ...state.queuedStarted,
                ])
              : [],
            contextStatus: {
              percentage: 0,
              pressureTokens: 0,
              thresholdTokens: 40000,
              compactionDue: false,
            },
            nativeContextStatus: null,
          },
        });
      unexpected.push(path);
      return answer({}, 404);
    });
    if (serverTheme) {
      const document = () => {
        const saved = state.preferences[state.viewer]?.appearance;
        // What the page looked like right after the theme scripts, before
        // the app loads and hydrates.
        const firstPaint = `window.firstPaint={theme:document.documentElement.getAttribute('data-theme'),dark:document.body.hasAttribute('data-ds-dark-theme')}`;
        return `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><script>${themeScript}</script><script>${appearanceScript({ choice: saved ?? null, viewer: state.viewer })}</script><script>${firstPaint}</script><div id="root"></div><script src="/app.js"></script></body></html>`;
      };
      if (nativeFixture) nativeDocuments.set(nativeFixture, document);
      else
        await page.route(
          (url) => url.origin === origin && url.pathname === '/',
          (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: document(),
            }),
        );
    }
    options.failureCleanup?.check();
    await page.goto(
      `${origin}/?session=${options.noSession ? '' : A}${serverTheme ? '&theme=1' : ''}${options.disabled ? '&disabled=1' : ''}${options.taskSuggestions ? '&task-suggestions=1' : ''}${options.localMcp ? '&local-mcp=1' : ''}${options.settingsEntry ? `&settings=${options.settingsEntry}` : ''}`,
    );
    options.failureCleanup?.check();
    await (
      options.startup
        ? page.getByRole('region', { name: '进入工作区', exact: true })
        : page.getByRole('textbox', { name: /^给 .+ 的消息$/ })
    )
      .waitFor()
      .catch(async (error) => {
        console.error(
          'UI mount',
          errors,
          await page.locator('body').innerText(),
        );
        throw error;
      });
    options.failureCleanup?.check();
    const panel = page.locator('#artifact-workbench:not([aria-hidden="true"])');
    // Dock refresh can hide a retained tab between resolving a role locator
    // and clicking. Resolve the currently visible menu throughout the action.
    const fileMenu = panel
      .locator('button[aria-label="更多文件操作"]:visible')
      .last();
    const entry = page.getByRole('button', { name: /^(?:展开|收起)工作台$/ });
    const result = {
      context,
      page,
      state,
      errors,
      writes,
      unexpected,
      nativeFixture,
      panel,
      entry,
      releaseStream: finishStream,
      releaseStartup,
      finishRun() {
        state.messageStatus = 'completed';
        state.items = [artifact(11)];
        finishStream();
      },
      async fileAction(name: string) {
        const direct = panel.getByRole('button', { name, exact: true }).last();
        if (await direct.count()) {
          await direct.click();
          return;
        }
        await fileMenu.click();
        await page.getByRole('menuitem', { name, exact: true }).click();
      },
      async selectArtifact(n: number) {
        await fileMenu.click();
        await page
          .getByRole('menuitem', { name: '查看所有成果', exact: true })
          .click();
        await panel
          .getByRole('button', { name: `侧栏预览 report-${n}.md`, exact: true })
          .click();
      },
      async reloadList() {
        if ((options.width ?? 1440) <= 760) await entry.click();
        else
          await panel
            .getByRole('button', { name: '刷新文件', exact: true })
            .last()
            .click();
        await panel
          .getByRole('button', { name: '刷新文件', exact: true })
          .last()
          .waitFor();
      },
      async openWorkbench() {
        if ((options.width ?? 1440) <= 760) {
          await entry.click();
          return;
        }
        if ((await panel.count()) === 0) {
          if (state.items.length)
            await page
              .locator('[data-chat-scroll]')
              .getByRole('button', {
                name: `侧栏预览 ${state.items[0]!.version.fileName}`,
                exact: true,
              })
              .click();
          else await entry.click();
        } else if (await fileMenu.count()) {
          return;
        } else if (state.items.length) {
          const name = state.items[0]!.version.fileName;
          const tab = panel.getByRole('tab').filter({ hasText: name }).last();
          if (await tab.count()) await tab.click();
          else
            await panel
              .getByRole('region', { name: '交付成果', exact: true })
              .getByRole('button', {
                name,
                exact: true,
              })
              .click();
        }
      },
      async close() {
        releaseStartup();
        finishStream();
        await context.close();
        if (nativeFixture) nativeDocuments.delete(nativeFixture);
        expect(errors).toEqual([]);
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
      },
    };
    contextOwner?.replace(async () => {
      if (errors.length || writes.length || unexpected.length)
        await options.failureEvidence?.capture({ errors, writes, unexpected });
      await result.close();
    });
    return result;
  }

  async function openNativeChild(
    f: Awaited<ReturnType<typeof fixture>>,
    childId = 'child-a',
  ) {
    await f.page.getByRole('button', { name: /2 个子智能体/ }).click();
    await f.page
      .locator(`[data-child="${childId}"]`)
      .getByRole('button', { name: /在工作台打开/ })
      .click();
    const view = f.panel.locator(`[data-native-subagent-id="${childId}"]`);
    await view.getByLabel('交给子智能体的任务').waitFor();
    return view;
  }

  async function settleWorkbenchMotion(f: Awaited<ReturnType<typeof fixture>>) {
    await f.panel.evaluate(async (panel) => {
      await Promise.all(
        panel.getAnimations().map((animation) => animation.finished),
      );
    });
  }

  it('opens native child tabs from the same directory with no artifacts, isolates same names and stops inactive reads', async () => {
    const f = await fixture({
      disabled: true,
      nativeSubagents: nativeChildSummary(),
      nativeEvents: nativeChildCalls(),
    });
    const connections = () =>
      [...subagentFeed.connections].filter(
        (connection) =>
          connection.fixture === f.nativeFixture && connection.childId,
      );
    try {
      await f.page
        .locator('[data-step-id="tool:native-0"]')
        .waitFor({ state: 'attached' });
      const process = f.page.locator('section[aria-label="工作过程"]').first();
      if ((await process.getAttribute('data-process-open')) === 'false')
        await process.getByRole('button').first().click();
      await f.page
        .getByRole('button', { name: /^查看子智能体 · 2 个智能体/ })
        .click();
      await f.page.getByRole('tree', { name: '子智能体目录' }).waitFor();
      expect(
        await f.page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(1);
      await f.page
        .locator('[data-child="child-a"]')
        .getByRole('button', { name: /在工作台打开/ })
        .click();
      const first = f.panel.locator('[data-native-subagent-id="child-a"]');
      await expect
        .poll(() => first.innerText())
        .toContain('child-a 获授权的回复');
      expect(f.state.items).toEqual([]);
      await expect
        .poll(() => connections().map((connection) => connection.childId))
        .toEqual(['child-a']);
      const childTabs = f.panel.locator(
        '[role="tab"]:has([data-native-subagent-tab])',
      );
      expect(await childTabs.count()).toBe(1);
      await openNativeChild(f);
      expect(await childTabs.count()).toBe(1);
      await openNativeChild(f, 'child-b');
      expect(await childTabs.count()).toBe(2);
      await expect
        .poll(() => connections().map((connection) => connection.childId))
        .toEqual(['child-b']);
      expect(await first.count()).toBe(0);
      await childTabs.first().click();
      await expect
        .poll(() => connections().map((connection) => connection.childId))
        .toEqual(['child-a']);
      await childTabs
        .first()
        .getByRole('button', { name: '关闭标签', exact: true })
        .click();
      await expect
        .poll(() =>
          connections().some((connection) => connection.childId === 'child-a'),
        )
        .toBe(false);
      await childTabs.first().click();
      await expect
        .poll(() => connections().map((connection) => connection.childId))
        .toEqual(['child-b']);
      const guide = f.panel.getByRole('tab').filter({ hasText: '开始' });
      if (await guide.count()) await guide.click();
      else
        await f.panel
          .getByRole('button', { name: '新建标签页', exact: true })
          .click();
      await expect.poll(() => connections().length).toBe(0);
      await childTabs.first().click();
      await expect.poll(() => connections().length).toBe(1);
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await expect.poll(() => connections().length).toBe(0);
      await openNativeChild(f, 'child-b');
      expect(await childTabs.count()).toBe(1);
      const read = f.state.nativeSubagents!;
      read.descendants = read.descendants.map((entry) =>
        entry.id === 'child-b'
          ? {
              kind: 'diagnostic',
              id: entry.id,
              parentId: entry.parentId,
              depth: entry.depth,
              reason: 'identity_mismatch',
            }
          : entry,
      );
      subagentFeed.push(
        f.nativeFixture!,
        { type: 'directory', summary: read },
        null,
        A,
      );
      await expect.poll(() => f.panel.innerText()).toContain('身份校验未通过');
      await expect.poll(() => connections().length).toBe(0);
      expect(await f.panel.innerText()).not.toContain('child-b 自己的任务');
      await f.page.getByText('研究任务 B', { exact: true }).first().click();
      await expect
        .poll(() => f.page.locator('[data-native-subagent-id]').count())
        .toBe(0);
      expect(await f.page.locator('[data-child]').count()).toBe(0);
      expect(f.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'fills a cold history generation without changing Dock placement or background reads, floating=%s',
    async (floating) => {
      let releaseTrace!: () => void;
      const eventsDelay = new Promise<void>((resolve) => {
        releaseTrace = resolve;
      });
      const f = await fixture({
        disabled: true,
        nativeSubagents: nativeChildSummary(),
        nativeEvents: nativeChildCalls(),
        eventsDelay,
      });
      const connections = () =>
        [...subagentFeed.connections].filter(
          (connection) =>
            connection.fixture === f.nativeFixture && connection.childId,
        );
      const tabs = f.panel.locator(
        '[role="tab"]:has([data-native-subagent-tab])',
      );
      try {
        await openNativeChild(f);
        await openNativeChild(f, 'child-b');
        const float = async (tab: Locator, x: number, y: number) => {
          await settleWorkbenchMotion(f);
          const box = (await tab.boundingBox())!;
          await f.page.mouse.move(box.x + 12, box.y + box.height / 2);
          await f.page.mouse.down();
          await f.page.mouse.move(x, y, { steps: 10 });
          await f.page.mouse.up();
        };
        const dockPane = f.panel.locator(
          '[data-dockkit-pane]:not([data-dockkit-float]):has([data-dockkit-strip])',
        );
        const guide = dockPane
          .getByRole('tab')
          .filter({ hasText: /^(开始|交付成果)/ });
        const showGuide = async () => {
          expect(await dockPane.count()).toBe(1);
          if (!(await guide.count()))
            await dockPane.locator('[data-dockkit-add-tab]').click();
          await guide.click();
          return guide;
        };
        if (floating) {
          await float(tabs.last(), 120, 160);
          await expect
            .poll(() => f.panel.locator('[data-dockkit-float-grip]').count())
            .toBe(1);
          await float(await showGuide(), 280, 260);
          await expect
            .poll(() => f.panel.locator('[data-dockkit-float-grip]').count())
            .toBe(2);
          await showGuide();
        } else {
          await f.panel
            .getByRole('button', { name: '全屏查看', exact: true })
            .click();
          await f.panel
            .getByRole('button', { name: '并排查看', exact: true })
            .click();
          await expect
            .poll(() => f.panel.locator('[data-dockkit-strip]').count())
            .toBe(2);
        }
        expect(connections()).toEqual([]);
        expect(
          subagentFeed.calls.filter(
            (call) => call.fixture === f.nativeFixture && call.childId,
          ),
        ).toEqual([]);
        const backgroundReads = subagentFeed.calls.filter(
          (call) =>
            call.fixture === f.nativeFixture && call.childId === 'child-a',
        ).length;
        const placement = () =>
          f.panel.evaluate((panel) => ({
            panes: Object.fromEntries(
              [...panel.querySelectorAll<HTMLElement>('[data-dockkit-pane]')]
                .filter((pane) => pane.querySelector('[data-dockkit-strip]'))
                .map((pane) => {
                  const box = pane.getBoundingClientRect();
                  return [
                    pane.dataset.dockkitPane!,
                    {
                      column: pane.dataset.dockkitColumn,
                      rect: [box.x, box.y, box.width, box.height],
                      active: pane.querySelector(
                        '[role="tab"][aria-selected="true"]',
                      )?.textContent,
                      global: pane.hasAttribute('data-dockkit-pane-active'),
                    },
                  ] as const;
                }),
            ),
            floats: [
              ...panel.querySelectorAll<HTMLElement>('[data-dockkit-float]'),
            ]
              .filter((pane) => pane.querySelector('[data-dockkit-float-grip]'))
              .map((pane) => ({
                title: pane.querySelector('[data-dockkit-float-grip]')
                  ?.textContent,
                rect: [
                  pane.style.left,
                  pane.style.top,
                  pane.style.width,
                  pane.style.height,
                ],
                z: pane.style.zIndex || pane.parentElement?.style.order || '',
                global: pane.hasAttribute('data-dockkit-float-active'),
              }))
              .sort((left, right) => Number(left.z) - Number(right.z)),
          }));
        const before = await placement();
        await f.page.evaluate(() => {
          const panel = document.querySelector('#artifact-workbench')!;
          new MutationObserver(() => {
            if (
              !panel.isConnected ||
              panel.getAttribute('aria-hidden') === 'true'
            )
              document.documentElement.dataset.subagentPanelLost = 'true';
          }).observe(panel.parentElement!, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-hidden'],
          });
        });
        releaseTrace();
        await f.page
          .locator('[data-step-id="tool:native-0"]')
          .waitFor({ state: 'attached' });
        await expect.poll(placement).toEqual(before);
        await expect
          .poll(() =>
            f.panel.locator('[data-native-subagent-id="child-b"]').innerText(),
          )
          .toContain('child-b 获授权的回复');
        expect(
          await f.panel.locator('[data-native-subagent-id="child-a"]').count(),
        ).toBe(0);
        expect(
          await f.page.evaluate(
            () => document.documentElement.dataset.subagentPanelLost,
          ),
        ).toBeUndefined();
        expect(
          subagentFeed.calls.filter(
            (call) =>
              call.fixture === f.nativeFixture && call.childId === 'child-a',
          ),
        ).toHaveLength(backgroundReads);
        expect(await tabs.count()).toBe(floating ? 1 : 2);
        await expect
          .poll(() => connections().map((connection) => connection.childId))
          .toEqual(['child-b']);
        if (!floating)
          await f.panel
            .getByRole('button', { name: '退出全屏', exact: true })
            .click();
        await openNativeChild(f, 'child-b');
        expect(await tabs.count()).toBe(floating ? 1 : 2);
        expect(await f.panel.locator('[data-dockkit-float-grip]').count()).toBe(
          floating ? 2 : 0,
        );
      } finally {
        releaseTrace();
        await f.close();
      }
    },
  );

  it('keeps delayed prepared history summary-only after its identity becomes canonical', async () => {
    let releaseTrace!: () => void;
    const eventsDelay = new Promise<void>((resolve) => {
      releaseTrace = resolve;
    });
    const value = nativeChildSummary();
    value.root.source = 'prepared';
    value.descendants = value.descendants.map((entry) =>
      entry.kind === 'child'
        ? {
            ...entry,
            running: null,
            observation: { source: 'prepared', cursor: 8 },
          }
        : entry,
    );
    const f = await fixture({
      disabled: true,
      nativeSubagents: value,
      nativeEvents: nativeChildCalls(),
      eventsDelay,
    });
    try {
      const view = await openNativeChild(f);
      expect(await view.innerText()).toContain('child-a 获授权的回复');
      expect(await view.getByText('状态未知', { exact: true }).count()).toBe(1);
      releaseTrace();
      await f.page
        .locator('[data-step-id="tool:native-0"]')
        .waitFor({ state: 'attached' });
      await openNativeChild(f);
      expect(await f.panel.locator('[data-native-subagent-tab]').count()).toBe(
        1,
      );
      expect(
        subagentFeed.calls.filter(
          (call) => call.fixture === f.nativeFixture && call.childId,
        ),
      ).toEqual([]);
    } finally {
      releaseTrace();
      await f.close();
    }
  });

  it.each([false, true])(
    'keeps a persisted canonical float when a cold summary merges, background=%s',
    async (background) => {
      const f = await fixture({
        disabled: true,
        nativeSubagents: nativeChildSummary(),
        nativeEvents: nativeChildCalls(),
      });
      const connections = () =>
        [...subagentFeed.connections].filter(
          (connection) =>
            connection.fixture === f.nativeFixture && connection.childId,
        );
      let releaseTrace = () => {};
      const float = async (tab: Locator, x: number, y: number) => {
        await settleWorkbenchMotion(f);
        const box = (await tab.boundingBox())!;
        await f.page.mouse.move(box.x + 12, box.y + box.height / 2);
        await f.page.mouse.down();
        await f.page.mouse.move(x, y, { steps: 10 });
        await f.page.mouse.up();
      };
      try {
        await f.page
          .locator('[data-step-id="tool:native-0"]')
          .waitFor({ state: 'attached' });
        await openNativeChild(f);
        const tab = f.panel.locator(
          '[role="tab"]:has([data-native-subagent-tab])',
        );
        const canonicalId = (await tab.getAttribute('data-dockkit-tab'))!;
        await float(tab, 120, 160);
        const canonical = f.panel.locator(
          `[data-dockkit-content="${canonicalId}"][data-dockkit-float]`,
        );
        await canonical.waitFor();
        const paneId = await canonical.getAttribute('data-dockkit-float');
        const rect = () =>
          canonical.evaluate((node) => [
            node.style.left,
            node.style.top,
            node.style.width,
            node.style.height,
          ]);
        const beforeRect = await rect();
        f.state.eventsDelay = new Promise<void>((resolve) => {
          releaseTrace = resolve;
        });
        await f.page.reload();
        await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
        await expect.poll(() => connections().length).toBe(0);
        const reads = subagentFeed.calls.filter(
          (call) => call.fixture === f.nativeFixture && call.childId,
        ).length;
        await openNativeChild(f);
        await float(
          f.panel.locator('[role="tab"]:has([data-native-subagent-tab])'),
          280,
          260,
        );
        await expect
          .poll(() => f.panel.locator('[data-dockkit-float-grip]').count())
          .toBe(2);
        if (background)
          await f.panel
            .locator('[data-dockkit-pane]:has([data-dockkit-strip])')
            .getByRole('tab')
            .filter({ hasText: /^(开始|交付成果)/ })
            .click();
        const selection = () =>
          f.panel
            .locator(
              '[data-dockkit-pane][data-dockkit-pane-active],[data-dockkit-float][data-dockkit-float-active]',
            )
            .evaluateAll((nodes) =>
              nodes.map(
                (node) =>
                  node.getAttribute('data-dockkit-float') ??
                  node.getAttribute('data-dockkit-pane'),
              ),
            );
        const beforeSelection = await selection();
        expect(connections()).toEqual([]);
        expect(
          subagentFeed.calls.filter(
            (call) => call.fixture === f.nativeFixture && call.childId,
          ),
        ).toHaveLength(reads);
        releaseTrace();
        await f.page
          .locator('[data-step-id="tool:native-0"]')
          .waitFor({ state: 'attached' });
        await expect
          .poll(() => f.panel.locator('[data-native-subagent-tab]').count())
          .toBe(1);
        expect(await canonical.getAttribute('data-dockkit-float')).toBe(paneId);
        expect(await rect()).toEqual(beforeRect);
        expect(await selection()).toEqual(
          background ? beforeSelection : [paneId],
        );
        expect(await f.panel.locator('[data-dockkit-float-grip]').count()).toBe(
          1,
        );
        await expect
          .poll(() => connections().map((connection) => connection.childId))
          .toEqual(['child-a']);
        const connection = connections()[0]!;
        const knownReads = subagentFeed.calls.filter(
          (call) => call.fixture === f.nativeFixture && call.childId,
        ).length;
        const prepared = f.state.nativeSubagents!;
        prepared.descendants = prepared.descendants.map((entry) =>
          entry.kind === 'child'
            ? {
                ...entry,
                running: null,
                observation: { source: 'prepared', cursor: 9 },
                lastReply: '当前canonical摘要',
              }
            : entry,
        );
        subagentFeed.push(
          f.nativeFixture!,
          { type: 'directory', summary: prepared },
          null,
          A,
        );
        await expect
          .poll(() => canonical.innerText())
          .toContain('当前canonical摘要');
        expect(subagentFeed.connections.has(connection)).toBe(true);
        expect(
          subagentFeed.calls.filter(
            (call) => call.fixture === f.nativeFixture && call.childId,
          ),
        ).toHaveLength(knownReads);
        expect(await rect()).toEqual(beforeRect);
        expect(f.writes).toEqual([]);
      } finally {
        releaseTrace();
        await f.close();
      }
    },
  );

  it('invalidates a known generation when the same Run emits a new native generation', async () => {
    const f = await fixture({
      disabled: true,
      running: true,
      controlledStream: true,
      nativeSubagents: nativeChildSummary(),
    });
    const emit = (event: ChatFlowEventEnvelope) =>
      f.page.evaluate(
        (body) =>
          window.dispatchEvent(
            new CustomEvent('allrice-test-stream', { detail: body }),
          ),
        `data: ${JSON.stringify(event)}\n\n`,
      );
    try {
      await f.page.waitForFunction(
        () => document.documentElement.dataset.streamReady === 'true',
      );
      await emit({
        ...nativeChildCalls()[0]!,
        type: 'harness.native',
        payload: {},
        sourceEvent: {
          id: 'native-ready',
          type: 'request/header',
          occurredAt: now,
          payload: {},
        },
      });
      await openNativeChild(f);
      await expect
        .poll(
          () =>
            [...subagentFeed.connections].filter(
              (connection) =>
                connection.fixture === f.nativeFixture && connection.childId,
            ).length,
        )
        .toBe(1);
      await emit({ ...nativeChildCalls()[1]!, generation: 1 });
      await expect
        .poll(() => f.page.locator('[data-native-subagent-id]').count())
        .toBe(0);
      await expect
        .poll(
          () =>
            [...subagentFeed.connections].filter(
              (connection) =>
                connection.fixture === f.nativeFixture && connection.childId,
            ).length,
        )
        .toBe(0);
    } finally {
      await f.close();
    }
  });

  for (const width of [1440, 1160, 1024, 390, 320])
    for (const appearance of ['light', 'dark'] as const)
      it(`shows the real read-only native Dock tab and return target at ${width}px ${appearance}`, async () => {
        const f = await fixture({
          width,
          appearance,
          touch: width <= 760,
          disabled: true,
          nativeSubagents: nativeChildSummary(),
          nativeEvents: nativeChildCalls(),
        });
        try {
          const view = await openNativeChild(f);
          await settleWorkbenchMotion(f);
          expect(await view.locator('input,textarea,footer').count()).toBe(0);
          expect(
            await view
              .getByRole('button', { name: /停止|发送|Queue|Steer|来源/ })
              .count(),
          ).toBe(0);
          expect(await view.innerText()).not.toContain('tokens');
          const back = f.panel.getByRole('button', {
            name: '返回主对话',
            exact: true,
          });
          expect(await back.count()).toBe(width <= 1100 ? 1 : 0);
          const close = f.panel.locator(
            '[role="tab"]:has([data-native-subagent-tab]) [data-dockkit-tab-close]',
          );
          const strip = (await f.panel
            .locator('[data-dockkit-strip]')
            .boundingBox())!;
          expect(strip.height).toBe(56);
          const closeBox = await close.boundingBox();
          expect(closeBox!.width).toBeGreaterThanOrEqual(
            width <= 760 ? 44 : 32,
          );
          expect(closeBox!.height).toBeGreaterThanOrEqual(
            width <= 760 ? 44 : 32,
          );
          expect(
            Math.abs(
              closeBox!.y + closeBox!.height / 2 - (strip.y + strip.height / 2),
            ),
          ).toBeLessThanOrEqual(1);
          if (width <= 1100) {
            const target = await back.boundingBox();
            expect(target!.width).toBe(44);
            expect(target!.height).toBe(44);
            expect(target!.x).toBeGreaterThanOrEqual(strip.x);
            expect(target!.x + target!.width).toBeLessThanOrEqual(strip.x + 56);
            expect(target!.y).toBeGreaterThanOrEqual(strip.y);
            expect(target!.y + target!.height).toBeLessThanOrEqual(
              strip.y + strip.height,
            );
            expect(
              await back.evaluate((button) => {
                const box = button.getBoundingClientRect();
                return [box.y + box.height / 2, box.bottom - 1].every((y) => {
                  const hit = document.elementFromPoint(
                    box.x + box.width / 2,
                    y,
                  );
                  return hit === button || button.contains(hit);
                });
              }),
            ).toBe(true);
          }
          await mkdir(
            '.local/integration-collection/met245-process-b-screenshots',
            { recursive: true },
          );
          await f.page.screenshot({
            path: `.local/integration-collection/met245-process-b-screenshots/host-${width}-${appearance}.png`,
          });
          if (width <= 1100) {
            await expect
              .poll(
                () =>
                  [...subagentFeed.connections].filter(
                    (connection) =>
                      connection.fixture === f.nativeFixture &&
                      connection.childId,
                  ).length,
              )
              .toBe(1);
            const target = (await back.boundingBox())!;
            if (width <= 760)
              await f.page.touchscreen.tap(
                target.x + target.width / 2,
                target.y + target.height - 1,
              );
            else
              await f.page.mouse.click(
                target.x + target.width / 2,
                target.y + target.height - 1,
              );
            await expect
              .poll(
                () =>
                  [...subagentFeed.connections].filter(
                    (connection) =>
                      connection.fixture === f.nativeFixture &&
                      connection.childId,
                  ).length,
              )
              .toBe(0);
            await openNativeChild(f);
            await settleWorkbenchMotion(f);
            expect(
              await f.panel
                .locator('[role="tab"]:has([data-native-subagent-tab])')
                .count(),
            ).toBe(1);
          }
          if (width > 760) await close.hover();
          expect(
            await close.evaluate((button) => {
              const box = button.getBoundingClientRect();
              const target = document.elementFromPoint(
                box.x + box.width / 2,
                box.bottom - 1,
              );
              return target === button || button.contains(target);
            }),
          ).toBe(true);
          const edge = (await close.boundingBox())!;
          if (width <= 760)
            await f.page.touchscreen.tap(
              edge.x + edge.width / 2,
              edge.y + edge.height - 1,
            );
          else
            await f.page.mouse.click(
              edge.x + edge.width / 2,
              edge.y + edge.height - 1,
            );
          expect(await close.count()).toBe(0);
          await expect
            .poll(
              () =>
                [...subagentFeed.connections].filter(
                  (connection) =>
                    connection.fixture === f.nativeFixture &&
                    connection.childId,
                ).length,
            )
            .toBe(0);
          expect(f.writes).toEqual([]);
        } catch (error) {
          const path = `.local/integration-collection/met245-process-b-screenshots/host-failure-${width}-${appearance}`;
          await mkdir(dirname(path), { recursive: true })
            .then(async () => {
              await writeFile(`${path}.html`, await f.page.content());
              await f.page.screenshot({ path: `${path}.png` });
            })
            .catch((captureError) =>
              console.error('NATIVE_HOST_CAPTURE_FAILED', captureError),
            );
          throw error;
        } finally {
          await f.close();
        }
      });

  it('MET198 desktop start replaces itself with a module, plus follows native guide rules, and terminal stays in Start', async () => {
    const f = await fixture({ employeeDetails: true });
    try {
      const header = f.page.locator('main > section header');
      expect(await header.locator('h1').innerText()).toBe('研究任务 A');
      expect(
        await header
          .getByRole('button', { name: '与 Rice 工作', exact: true })
          .count(),
      ).toBe(0);
      await header
        .getByRole('button', { name: '展开工作台', exact: true })
        .click();
      await f.panel
        .getByRole('button', {
          name: /交付成果.*员工交付的文件和你在对话中上传的文件/,
        })
        .waitFor();
      expect(
        await f.panel
          .getByRole('button', { name: '新建标签页', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await f.panel
          .getByRole('button', { name: '新建终端', exact: true })
          .count(),
      ).toBe(1);
      expect(await header.getByRole('button', { name: /终端/ }).count()).toBe(
        0,
      );
      await f.panel
        .getByRole('button', { name: '新建终端', exact: true })
        .click();
      await f.panel
        .getByRole('status')
        .filter({
          hasText: '安装并连接 AllRice 助手，授权文件夹后即可使用终端。',
        })
        .waitFor();
      await f.panel
        .getByRole('button', { name: '连接电脑', exact: true })
        .click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      await settings
        .getByRole('heading', { name: '连接与管理电脑', exact: true })
        .waitFor();
      await settings
        .getByRole('button', { name: '关闭设置', exact: true })
        .click();
      await expect.poll(() => settings.count()).toBe(0);
      await f.panel
        .getByRole('button', {
          name: /交付成果.*员工交付的文件和你在对话中上传的文件/,
        })
        .click();
      await f.panel
        .getByRole('searchbox', { name: '查找文件', exact: true })
        .waitFor();
      expect(await f.panel.getByRole('tab', { name: /开始/ }).count()).toBe(0);
      expect(
        await f.panel
          .locator(
            '[data-dockkit-add-tab], [data-dockkit-split-button], [data-dockkit-strip-chrome] button',
          )
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const glyph = button.querySelector('svg')!;
              return {
                target: [
                  button.getBoundingClientRect().width,
                  button.getBoundingClientRect().height,
                ],
                glyph: [
                  glyph.getBoundingClientRect().width,
                  glyph.getBoundingClientRect().height,
                ],
                strokes: [...glyph.children].map(
                  (path) => getComputedStyle(path).strokeWidth,
                ),
              };
            }),
          ),
      ).toEqual(
        Array.from({ length: 4 }, () => ({
          target: [32, 32],
          glyph: [20, 20],
          strokes: expect.arrayContaining(['1.75px']),
        })),
      );
      await f.panel
        .getByRole('button', { name: '新建标签页', exact: true })
        .click();
      await f.panel.getByRole('tab', { name: /开始/ }).waitFor();
      expect(
        await f.panel
          .getByRole('button', { name: '新建标签页', exact: true })
          .count(),
      ).toBe(0);
      await f.panel.getByRole('tab', { name: /交付成果/ }).click();
      expect(
        await f.panel
          .getByRole('button', { name: '新建标签页', exact: true })
          .count(),
      ).toBe(0);
      await f.panel.getByRole('tab', { name: /交付成果/ }).hover();
      await f.panel
        .getByRole('tab', { name: /交付成果/ })
        .getByRole('button', { name: '关闭标签', exact: true })
        .click();
      await f.panel.getByRole('tab', { name: /开始/ }).waitFor();
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);
  it('personal deliverables removes upload, scope, sharing and reference management from the directory', async () => {
    const f = await fixture({ employeeDetails: true });
    try {
      await f.page
        .locator('header')
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      const directory = f.panel.getByRole('region', {
        name: '交付成果',
        exact: true,
      });
      await directory.getByRole('combobox', { name: '按员工筛选' }).waitFor();
      for (const name of ['上传', '刷新文件列表', '参考资料', '可见范围'])
        expect(
          await directory.getByRole('button', { name, exact: true }).count(),
        ).toBe(0);
      expect(
        await directory.getByRole('combobox', { name: '文件范围' }).count(),
      ).toBe(0);
      expect(
        await directory
          .getByRole('navigation', { name: '文件类型' })
          .getByRole('button')
          .allTextContents(),
      ).toEqual(['全部', '员工交付', '我的上传']);
      expect(f.state.workbenchMutations).toEqual([]);
    } finally {
      await f.close();
    }
  });

  async function openOwnerDetails(f: Awaited<ReturnType<typeof fixture>>) {
    const expand = f.page.getByRole('button', {
      name: '展开侧边栏',
      exact: true,
    });
    if (await expand.count()) await expand.click();
    await f.page
      .getByRole('button', { name: '查看Rice详情', exact: true })
      .click();
    const dialog = f.page.getByRole('dialog', {
      name: 'Rice员工详情',
      exact: true,
    });
    await dialog
      .getByRole('region', { name: '基础与人设', exact: true })
      .waitFor();
    return dialog;
  }
  async function expectRetiredTabs(dialog: Locator) {
    for (const name of ['执行要求', '执行流程', '参考资料', '经验积累'])
      expect(await dialog.getByRole('tab', { name, exact: true }).count()).toBe(
        0,
      );
    for (const name of ['AI新增工作场景', /^AI调整/])
      expect(await dialog.getByRole('button', { name }).count()).toBe(0);
    for (const name of [
      '本人 Workflow · 文件与修改记录',
      '本人 Workflow · 目录与读取记录',
    ])
      expect(await dialog.getByText(name, { exact: true }).count()).toBe(0);
  }
  it('MET198 file unread numbers remain scoped while retired experience keys never become memory badges', async ({
    task,
  }) => {
    const observation: { fixture?: Awaited<ReturnType<typeof fixture>> } = {};
    const evidence: ReturnType<typeof createFailureEvidence> =
      createFailureEvidence({
        file: import.meta.url,
        test: 'MET198 file unread numbers remain scoped while retired experience keys never become memory badges',
        collect: async () => {
          const f = observation.fixture;
          const snapshot = {
            updateReads: f?.state.updateReads,
            workbenchReads: f?.state.workbenchReads,
            files: f?.state.files,
            experienceKeys: f?.state.workbenchExperienceKeys,
            errors: f?.errors,
            writes: f?.writes,
            unexpected: f?.unexpected,
          };
          evidence.mark('failure-fixture-state', snapshot);
          return {
            fixture: snapshot,
            browserBaseline:
              f &&
              (await f.page.evaluate(() => ({
                localStorage: Object.fromEntries(
                  Object.keys(localStorage).map((key) => [
                    key,
                    localStorage.getItem(key),
                  ]),
                ),
                headerButtons: Array.from(
                  document.querySelectorAll('main > section header button'),
                ).map((button) => ({
                  text: button.textContent,
                  label: button.getAttribute('aria-label'),
                  pressed: button.getAttribute('aria-pressed'),
                  visible: button.getClientRects().length > 0,
                })),
              }))),
          };
        },
      });
    const cleanup = createFailureCleanup(evidence);
    unreadCleanups.set(task, cleanup);
    onTestFailed(async ({ task }) => {
      await evidence.capture(task.result?.errors);
    });
    evidence.mark('fixture-started');
    const f = await fixture({
      employeeDetails: true,
      failureEvidence: evidence,
      failureCleanup: cleanup,
    });
    cleanup.check();
    observation.fixture = f;
    evidence.mark('baseline-request-count-wait-started');
    await expect.poll(() => f.state.updateReads).toBe(1);
    evidence.mark('baseline-request-count-observed', {
      updateReads: f.state.updateReads,
    });
    f.state.files.push({
      id: id(9901),
      fileName: '新增文件.txt',
      mediaType: 'text/plain',
      sizeBytes: 12,
      visibility: 'private',
      ownedByMe: true,
      category: 'uploads',
      deliverableVersion: null,
    });
    f.state.workbenchExperienceKeys.push(id(9910) + '/1');
    evidence.mark('fixture-files-mutated', {
      fileId: id(9901),
      experienceKey: id(9910) + '/1',
    });
    await f.page.evaluate(() =>
      window.dispatchEvent(new Event('allrice:workbench-files-changed')),
    );
    evidence.mark('files-changed-dispatched');
    const header = f.page.locator('main > section header');
    evidence.mark('file-unread-badge-wait-started');
    await header
      .getByRole('button', { name: '交付成果，1 项新增', exact: true })
      .waitFor();
    evidence.mark('file-unread-badge-visible');
    expect(
      await header.getByRole('button', { name: /记忆，.*项新增/ }).count(),
    ).toBe(0);
    await header.getByRole('button', { name: '记忆', exact: true }).click();
    await f.page
      .getByRole('region', { name: '个人记忆', exact: true })
      .waitFor();
    evidence.mark('memory-visible');
    expect(
      await header
        .getByRole('button', { name: '交付成果，1 项新增', exact: true })
        .count(),
    ).toBe(1);
    await header
      .getByRole('button', { name: '交付成果，1 项新增', exact: true })
      .click();
    await header
      .getByRole('button', { name: '交付成果', exact: true })
      .waitFor();
    expect(f.state.experienceReads).toBe(0);
    expect(f.writes).toEqual([]);
  }, 30000);

  it('compact workbench opens one session schedule in the existing right detail and tracks actual module selection', async () => {
    const f = await fixture({
      scheduledTasks: [
        recurringTask(9800, B),
        recurringTask(9801, A, 'paused'),
      ],
    });
    try {
      const header = f.page.locator('main > section header');
      await expect.poll(() => f.state.scheduledReads.length).toBeGreaterThan(0);
      expect(
        await header
          .getByRole('button', { name: '当前对话的自动化任务', exact: true })
          .count(),
      ).toBe(0);
      const scheduledRow = f.page.locator(`[data-row-key="session:${B}"]`);
      await scheduledRow
        .getByLabel('有启用中的自动化任务', { exact: true })
        .waitFor();
      await scheduledRow.click();
      const clock = header.getByRole('button', {
        name: '当前对话的自动化任务',
        exact: true,
      });
      await clock.waitFor();
      await clock.click();
      const detail = f.panel.getByRole('region', {
        name: '自动化任务详情：定时工作 9800',
        exact: true,
      });
      await detail
        .getByRole('textbox', { name: '任务名称', exact: true })
        .waitFor();
      expect(await f.panel.getAttribute('role')).toBe('complementary');
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(await clock.getAttribute('aria-pressed')).toBe('true');
      await clock.click();
      expect(
        await f.panel.getByRole('tab', { name: /定时工作 9800/ }).count(),
      ).toBe(1);
      f.state.files = [
        {
          id: id(9810),
          fileName: '会话附件.md',
          mediaType: 'text/markdown',
          sizeBytes: 20,
          visibility: 'private',
          ownedByMe: true,
          category: 'uploads',
          deliverableVersion: null,
        },
      ];
      const files = header.getByRole('button', {
        name: '交付成果',
        exact: true,
      });
      await files.click();
      await expect.poll(() => files.getAttribute('aria-pressed')).toBe('true');
      expect(await clock.getAttribute('aria-pressed')).toBe('false');
      expect(
        await header
          .getByRole('button', { name: '展开工作台', exact: true })
          .count(),
      ).toBe(0);
      await f.panel
        .getByRole('button', { name: '会话附件.md', exact: true })
        .click();
      await f.panel
        .getByRole('heading', { name: '上传的文件', exact: true })
        .waitFor();
      await expect.poll(() => files.getAttribute('aria-pressed')).toBe('false');
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await header
        .getByRole('button', { name: '展开工作台', exact: true })
        .waitFor();
      expect(await clock.getAttribute('aria-pressed')).toBe('false');
      await f.page.locator(`[data-row-key="session:${A}"]`).click();
      await expect.poll(() => clock.count()).toBe(0);
      expect(f.state.workbenchMutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);

  it('compact workbench scopes multiple active schedules to the current session and reuses its right editor', async () => {
    const f = await fixture({
      scheduledTasks: [
        recurringTask(9820),
        recurringTask(9821),
        recurringTask(9822, A, 'paused'),
        recurringTask(9823, B),
      ],
    });
    try {
      const clock = f.page
        .locator('main > section header')
        .getByRole('button', { name: '当前对话的自动化任务', exact: true });
      await clock.click();
      const tasks = f.panel.getByRole('region', {
        name: '当前对话的自动化任务',
        exact: true,
      });
      await tasks.getByRole('button', { name: /定时工作 9820/ }).waitFor();
      expect(
        await tasks.getByRole('button', { name: /定时工作 9821/ }).count(),
      ).toBe(1);
      expect(
        await tasks
          .getByRole('button', { name: /定时工作 9822|定时工作 9823/ })
          .count(),
      ).toBe(0);
      expect(
        await tasks
          .getByRole('combobox', { name: '筛选员工', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await tasks
          .getByRole('button', { name: '已暂停 / 已结束', exact: true })
          .count(),
      ).toBe(0);
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(f.state.scheduledReads.some((r) => r.sessionId === A)).toBe(true);
      await clock.click();
      expect(
        await f.panel
          .getByRole('tab', { name: /^当前对话的自动化任务/ })
          .count(),
      ).toBe(1);
      await tasks.getByRole('button', { name: /定时工作 9821/ }).click();
      await f.panel
        .getByRole('region', {
          name: '自动化任务详情：定时工作 9821',
          exact: true,
        })
        .getByRole('textbox', { name: '工作内容', exact: true })
        .waitFor();
      expect(await f.panel.getAttribute('role')).toBe('complementary');
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(f.state.workbenchMutations).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);

  it('compact workbench preserves native live-activity priority over the scheduled-session clock', async () => {
    const scheduledSession = id(600);
    const f = await fixture({
      employeeHistory: true,
      running: true,
      scheduledTasks: [recurringTask(9830, scheduledSession)],
    });
    try {
      const row = f.page.locator(
        `[data-row-key="session:${scheduledSession}"]`,
      );
      await expect.poll(() => f.state.scheduledReads.length).toBeGreaterThan(0);
      await row.waitFor();
      expect(
        await row.getByLabel('有启用中的自动化任务', { exact: true }).count(),
      ).toBe(0);
      expect(await row.innerText()).toContain('进行中');
      f.state.historyRunning = false;
      await f.page.reload();
      await row.getByLabel('有启用中的自动化任务', { exact: true }).waitFor();
      expect(await row.innerText()).not.toContain('进行中');
    } finally {
      await f.close();
    }
  }, 30000);

  it.each([
    ['general', true, 0],
    ['custom', false, 0],
  ] as const)(
    'MET194 hides the content workspace for %s registered=%s',
    async (kind, registered, catalogReads) => {
      const f = await fixture({ brandContent: { kind, registered } });
      try {
        if (catalogReads)
          await expect
            .poll(() => f.state.brandContentCatalogReads.length)
            .toBe(catalogReads);
        await f.page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        expect(f.state.brandContentCatalogReads).toHaveLength(catalogReads);
        expect(
          await f.page
            .getByRole('button', { name: '内容工作台', exact: true })
            .count(),
        ).toBe(0);
        expect(f.state.brandContentBoardReads).toBe(0);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it('A6 opens the actual scene directory while retired brand UI stays absent and the draft is preserved', async () => {
    const f = await fixture({
      brandContent: { kind: 'custom', registered: true },
    });
    let confirmations = 0;
    try {
      const composer = f.page.getByRole('textbox', {
        name: '给 内容同事 的消息',
        exact: true,
      });
      await composer.fill('尚未发送的真实草稿应保留');
      f.page.on('dialog', async (dialog) => {
        confirmations++;
        await dialog.accept();
      });
      await f.page.getByRole('button', { name: '能力', exact: true }).click();
      const dialog = f.page.getByRole('region', {
        name: '内容同事 · 能力',
        exact: true,
      });
      await dialog
        .getByRole('heading', { name: '还没有场景', exact: true })
        .waitFor();
      expect(
        await f.page
          .getByRole('region', { name: '内容工作台', exact: true })
          .count(),
      ).toBe(0);
      expect(f.state.brandContentCatalogReads).toEqual([]);
      expect(f.state.brandContentBoardReads).toBe(0);
      expect(f.state.brandContentLaunches).toEqual([]);
      expect(confirmations).toBe(0);
      expect(f.state.messageInputs).toEqual([]);
      expect(f.writes).toEqual([]);
      expect(await composer.inputValue()).toBe('尚未发送的真实草稿应保留');
    } finally {
      await f.close();
    }
  }, 30000);

  it('MET194 hides the prior employee capability body on employee switch and ignores its delayed catalog', async () => {
    const f = await fixture({
      brandContent: { kind: 'custom', registered: true },
    });
    let release = () => {};
    try {
      await f.page
        .locator('[data-row-key="workspace:' + id(7) + '"]')
        .press('ArrowRight');
      const entry = f.page.getByRole('button', {
        name: '能力',
        exact: true,
      });
      await entry.click();
      const dialog = f.page.getByRole('region', {
        name: '内容同事 · 能力',
        exact: true,
      });
      await dialog
        .getByRole('heading', { name: '还没有场景', exact: true })
        .waitFor();
      await f.page
        .getByRole('treeitem', { name: /^研究任务 B/ })
        .dispatchEvent('click');
      await expect.poll(() => dialog.count()).toBe(0);
      const before = f.state.sceneCatalogReads.length;
      f.state.sceneCatalogDelay = new Promise((done) => {
        release = done;
      });
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      await entry.click();
      await expect
        .poll(() => f.state.sceneCatalogReads.length)
        .toBe(before + 1);
      await f.page
        .getByRole('treeitem', { name: /^研究任务 B/ })
        .dispatchEvent('click');
      await expect.poll(() => dialog.count()).toBe(0);
      release();
      f.state.sceneCatalogDelay = null;
      await entry.click();
      const current = f.page.getByRole('region', {
        name: 'Rice · 能力',
        exact: true,
      });
      await current
        .getByRole('heading', { name: '还没有场景', exact: true })
        .waitFor();
      expect(await dialog.count()).toBe(0);
      expect(await current.textContent()).not.toContain('内容同事');
      expect(f.state.sceneCatalogReads.at(-1)!.instanceId).toBe(id(7));
      expect(f.state.brandContentCatalogReads).toEqual([]);
      expect(f.state.brandContentBoardReads).toBe(0);
      expect(f.state.messageInputs).toEqual([]);
    } finally {
      release();
      await f.close();
    }
  }, 30000);

  it('MET194 hides the prior viewer scene directory before accepting a newly authorized catalog', async () => {
    const f = await fixture({
      brandContent: { kind: 'custom', registered: true },
      running: true,
    });
    try {
      const entry = f.page.getByRole('button', {
        name: '能力',
        exact: true,
      });
      await entry.click();
      const dialog = f.page.getByRole('region', {
        name: '内容同事 · 能力',
        exact: true,
      });
      await dialog
        .getByRole('heading', { name: '还没有场景', exact: true })
        .waitFor();
      f.state.viewer = id(50);
      f.finishRun();
      await expect
        .poll(() =>
          dialog
            .getByRole('heading', { name: '还没有场景', exact: true })
            .count(),
        )
        .toBe(0);
      await entry.click();
      await dialog
        .getByRole('region', { name: '工作场景 Workflow', exact: true })
        .getByRole('alert')
        .waitFor();
      expect(
        await dialog
          .getByRole('heading', { name: '还没有场景', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await dialog
          .getByRole('button', { name: '添加场景', exact: true })
          .count(),
      ).toBe(0);
      expect(f.state.sceneCatalogReads.some((r) => r.viewerId === id(50))).toBe(
        true,
      );
      expect(f.state.brandContentCatalogReads).toEqual([]);
      expect(f.state.brandContentBoardReads).toBe(0);
    } finally {
      await f.close();
    }
  }, 30000);

  it('keeps typing and upload clicks responsive with a large JSON preview and preserves its page on hide', async () => {
    const f = await fixture({ technicalArtifacts: true, artifacts: true });
    try {
      const text = JSON.stringify(
        Array.from({ length: 12_000 }, (_, index) => ({
          index,
          field: '合成字段',
        })),
        null,
        2,
      );
      f.state.officePreview = {
        kind: 'text',
        text,
        mediaType: 'application/json',
      };
      f.state.items.unshift({
        ...artifact(12),
        provenance: {
          ...artifact(12).provenance,
          kind: 'project_snapshot' as const,
        },
      });
      await f.reloadList();
      const code = f.panel.locator('code');
      await f.panel.getByRole('navigation', { name: '文本分页' }).waitFor();
      expect(await code.locator('*').count()).toBeLessThan(2500);
      expect((await code.textContent())!.length).toBeLessThan(16_001);
      await f.panel
        .getByRole('button', { name: '下一页', exact: true })
        .click();
      const secondPage = await code.textContent();
      // Detect accidental formatting of the large document during unrelated input.
      await f.page.evaluate((text) => {
        const parse = JSON.parse;
        Reflect.set(window, 'previewReformats', 0);
        JSON.parse = (...args) => {
          if (args[0] === text)
            Reflect.set(
              window,
              'previewReformats',
              Number(Reflect.get(window, 'previewReformats')) + 1,
            );
          return parse(...args);
        };
      }, text);
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      const ascii = 'AllRice typing 123, '.repeat(8);
      await input.pressSequentially(ascii);
      expect(await input.inputValue()).toBe(ascii);
      const cdp = await f.context.newCDPSession(f.page);
      await cdp.send('Input.insertText', {
        text: '中文输入测试，继续分析数据。',
      });
      await cdp.detach();
      const draft = ascii + '中文输入测试，继续分析数据。';
      expect(await input.inputValue()).toBe(draft);
      await input.dispatchEvent('compositionstart');
      await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      await input.dispatchEvent('compositionend');
      expect(f.writes).toEqual([]);
      await f.page
        .getByRole('button', { name: '添加文件', exact: true })
        .click();
      await f.page.keyboard.press('Escape');
      expect(await input.inputValue()).toBe(draft);
      expect(await code.textContent()).toBe(secondPage);
      expect(
        await f.page.evaluate(() => Reflect.get(window, 'previewReformats')),
      ).toBe(0);
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      expect(await f.page.locator('#artifact-workbench code').count()).toBe(0);
      await f.openWorkbench();
      await expect.poll(() => code.textContent()).toBe(secondPage);
      expect(await input.inputValue()).toBe(draft);
      expect(
        await f.panel.getByRole('link', { name: '下载', exact: true }).count(),
      ).toBeGreaterThan(0);
      let submitted: { text: string } | undefined;
      await f.page.route('**/api/v1/sessions/*/messages?*', (route) => {
        submitted = route.request().postDataJSON();
        return route.fulfill({
          status: 503,
          json: { error: 'temporary failure' },
        });
      });
      await f.page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => submitted?.text).toBe(draft.trim());
      await expect.poll(() => input.inputValue()).toBe(draft.trim());
      expect(await input.isEnabled()).toBe(true);
    } finally {
      await f.close();
    }
  }, 30_000);

  it.each(['failed', 'slow'] as const)(
    'workspace startup recovers from a %s request without an endless loading screen',
    async (startup) => {
      const f = await fixture({ startup });
      try {
        const retry = f.page.getByRole('button', {
          name: '重新连接',
          exact: true,
        });
        if (startup === 'failed') {
          await f.page
            .getByRole('alert')
            .filter({ hasText: '暂时无法进入工作区' })
            .waitFor();
          f.state.startupFailure = false;
          await retry.click();
        } else {
          expect(await retry.count()).toBe(0);
          await f.page.clock.runFor(15_000);
          await f.page
            .getByRole('status')
            .filter({ hasText: '连接用时较长' })
            .waitFor();
          expect(await retry.isVisible()).toBe(true);
          // A delayed response can still finish without a reload or duplicate task.
          f.releaseStartup();
        }
        await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
        expect(
          await f.page.getByRole('region', { name: '进入工作区' }).count(),
        ).toBe(0);
        expect(f.errors).toEqual([]);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([403, 409])(
    'opens personal Workflow audit from a historical sidebar instance when current details return %s',
    async (currentStatus) => {
      const f = await fixture({ employeeCount: 2, employeeHistory: true });
      const historicalId = id(6799),
        historicalSessionId = id(6750);
      const source = employeeDetailsFixture().profile.source;
      const archivedResponse = employeeHubErrorResponse(
        new EmployeeInstanceError('instance_archived'),
      );
      const archivedError = await archivedResponse.json();
      const historical = EmployeeInstanceSchema.parse({
        id: historicalId,
        assignmentId: id(99),
        organizationId: org,
        workspaceId: workspace,
        ownerId: user,
        kind: 'custom',
        revision: 2,
        profile: { name: '旧员工' },
        creationSource: source,
        source,
        createdAt: now,
        updatedAt: now,
        archivedAt: currentStatus === 409 ? now : null,
      });
      const reads: string[] = [];
      try {
        f.state.sessionEdits.set(historicalSessionId, {
          employeeInstanceId: historicalId,
        });
        await f.page.route(
          `**/api/v1/employee-instances/${historicalId}/content?*`,
          (route) =>
            route.fulfill({
              status: currentStatus,
              json:
                currentStatus === 409
                  ? archivedError
                  : { error: { message: 'Current details unavailable' } },
            }),
        );
        await f.page.route(
          `**/api/v1/employee-instances/${historicalId}?*`,
          (route) => route.fulfill({ json: { instance: historical } }),
        );
        await f.page.route(
          `**/api/v1/employee-instances/${historicalId}/scene-skills?*`,
          (route) =>
            route.fulfill({
              status: currentStatus,
              json:
                currentStatus === 409
                  ? archivedError
                  : { error: { message: 'Current content unavailable' } },
            }),
        );
        await f.page.route(
          `**/api/v1/employee-instances/${historicalId}/skills?*`,
          (route) => {
            const request = route.request();
            if (request.method() !== 'GET') return route.fallback();
            const url = new URL(request.url());
            expect(url.pathname).toBe(
              `/api/v1/employee-instances/${historicalId}/skills`,
            );
            expect([...url.searchParams.keys()]).toEqual(['workspaceId']);
            expect(url.searchParams.get('workspaceId')).toBe(workspace);
            expect(request.headers()['x-allrice-workspace-id']).toBe(workspace);
            expect(historical.ownerId).toBe(f.state.viewer);
            return route.fulfill({
              status: currentStatus,
              json:
                currentStatus === 409
                  ? archivedError
                  : { error: { message: 'Current content unavailable' } },
            });
          },
        );
        await f.page.route(
          `**/api/v1/employee-instances/${historicalId}/scene-skills/reads?*`,
          (route) => {
            reads.push(route.request().url());
            return route.fulfill({
              json: {
                instanceId: historicalId,
                runs: [
                  {
                    runId: id(6798),
                    sessionId: historicalSessionId,
                    messageId: id(6797),
                    createdAt: now,
                    status: 'failed',
                    error: {
                      code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
                      message:
                        '工作要求或其引用资料已失效，请确认当前版本后重新发起任务。',
                    },
                    reads: [],
                  },
                ],
                nextCursor: null,
              },
            });
          },
        );
        await f.page.reload();
        const sidebar = f.page.locator('#chat-sidebar');
        await sidebar.getByText('旧员工（已撤回）', { exact: true }).waitFor();
        await sidebar
          .getByRole('button', {
            name: '查看旧员工（已撤回）详情',
            exact: true,
          })
          .click();
        const dialog = f.page.getByRole('dialog');
        await dialog
          .getByText('本人 Workflow · 目录与读取记录', { exact: true })
          .click();
        await dialog
          .getByText('这次工作没有已提交的 Workflow 读取记录。', {
            exact: true,
          })
          .waitFor();
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain(historicalId);
        expect(
          await dialog
            .getByRole('link', { name: '回到原工作记录', exact: true })
            .getAttribute('href'),
        ).toBe(`/chatflow?session=${historicalSessionId}#message-${id(6797)}`);
        expect(
          await dialog
            .getByText('本人 Workflow · 文件与修改记录', { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('button', { name: '编辑员工', exact: true })
            .count(),
        ).toBe(0);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'expands native work process downward from the clicked header at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 760,
        streamingOutput: true,
      });
      const operations = Array.from({ length: 4 }, (_, index) => ({
        nativeCallId: `lookup-${index}`,
        snapshot: {
          status: 'succeeded',
          binding: {
            action: 'cloud.mcp.call',
            task: operationTask(),
            attempt: { operationId: id(8950 + index), generation: 1 },
          },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: 'mcp',
          endpoint: 'https://example.test/mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: {},
          risk: 'read',
        },
        approval: null,
        result: null,
      }));
      try {
        f.state.preferences[user]!.transcriptView = 'standard';
        f.state.messages = navigationHistory(2);
        f.state.messages.at(-1)!.runId = run;
        f.state.messages.at(-1)!.content.text = '核对完成。';
        f.state.events = operations.map((operation, index) => ({
          schemaVersion: 3,
          eventId: id(8960 + index),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence: index + 1,
          cursor: `${run}:${index + 1}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type: 'tool.completed',
          payload: {
            toolCallId: operation.nativeCallId,
            name: 'cloud.mcp.call',
          },
        }));
        await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
          route.fulfill({
            json: {
              operations:
                new URL(route.request().url()).searchParams.get('runId') === run
                  ? operations
                  : [],
            },
          }),
        );
        await f.page.route('**/api/v1/runs/*/events?**', (route) =>
          route.fulfill({
            json: {
              events:
                new URL(route.request().url()).pathname.split('/').at(-2) ===
                run
                  ? f.state.events
                  : [],
            },
          }),
        );
        await f.page.reload();
        if (width < 760) {
          const hide = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await hide.isVisible()) await hide.click();
        }
        const owner = f.page.locator(`#message-${id(2003)}`);
        const process = owner.getByRole('region', {
          name: '工作过程',
          exact: true,
        });
        const header = process.getByRole('button', {
          name: '工作过程',
          exact: true,
        });
        const processBody = process.locator('..');
        const steps = processBody.locator('[data-step-id^="tool:lookup-"]');
        const tools = processBody.getByRole('button', { name: '已调用工具' });
        const scroll = f.page.locator('[data-conversation-scroll]');
        await header.waitFor();
        expect(await header.getAttribute('aria-expanded')).toBe('false');
        const settle = () =>
          f.page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
        const geometry = async () => ({
          top: (await header.boundingBox())!.y,
          scroll: await scroll.evaluate((node) => node.scrollTop),
        });
        for (const input of ['pointer', 'keyboard'] as const) {
          await scroll.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event('scroll'));
          });
          await settle();
          if (input === 'keyboard')
            await header.evaluate((node) =>
              node.focus({ preventScroll: true }),
            );
          const before = await geometry();
          if (input === 'keyboard') await header.press('Enter');
          else if (width < 760)
            await header.getByText('工作过程', { exact: true }).tap();
          else await header.getByText('工作过程', { exact: true }).click();
          await tools.waitFor();
          await settle();
          const after = await geometry();
          expect(Math.abs(after.top - before.top)).toBeLessThan(2);
          expect(Math.abs(after.scroll - before.scroll)).toBeLessThan(2);
          expect((await tools.boundingBox())!.y).toBeGreaterThan(after.top);
          expect(await process.locator('[data-work-reply]').count()).toBe(0);
          const toolsTop = (await tools.boundingBox())!.y;
          await tools.click();
          await processBody.getByRole('list', { name: '工作步骤' }).waitFor();
          expect(await steps.count()).toBe(4);
          for (const operation of operations) {
            expect(
              await processBody
                .locator(`[data-step-id="tool:${operation.nativeCallId}"]`)
                .count(),
            ).toBe(1);
            expect(
              await processBody
                .locator(
                  `[data-step-id="operation:cloud:${operation.snapshot.binding.attempt.operationId}"]`,
                )
                .count(),
            ).toBe(0);
          }
          expect(
            (await processBody.locator('[data-work-reply]').boundingBox())!.y,
          ).toBeGreaterThan((await steps.last().boundingBox())!.y);
          expect(await processBody.locator('[id^="operation-"]').count()).toBe(
            0,
          );
          await settle();
          expect(
            Math.abs((await tools.boundingBox())!.y - toolsTop),
          ).toBeLessThan(2);
          await tools.click();
          await header.press('Space');
          await settle();
          expect(Math.abs((await geometry()).top - before.top)).toBeLessThan(2);
        }
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'expands tool details downward without moving the clicked header at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 760,
        streamingOutput: false,
      });
      const operations = Array.from({ length: 5 }, (_, index) => ({
        snapshot: {
          status: 'succeeded',
          binding: {
            action: 'cloud.mcp.call',
            task: operationTask(),
            attempt: { operationId: id(8900 + index) },
          },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: 'mcp',
          endpoint: 'https://example.test/mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: { query: 'Existing work' },
          risk: 'read',
        },
        approval: null,
        result: {
          code: 'completed',
          output: 'Existing tool result\n'.repeat(100),
          trusted: false,
        },
      }));
      try {
        f.state.messages = navigationHistory(2);
        f.state.messages.at(-1)!.runId = run;
        f.state.messages.at(-1)!.content.text = '查询完成。';
        await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
          route.fulfill({
            json: {
              operations:
                new URL(route.request().url()).searchParams.get('runId') === run
                  ? operations
                  : [],
            },
          }),
        );
        await f.page.reload();
        if (width < 760) {
          const hide = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await hide.isVisible()) await hide.click();
        }
        const scroll = f.page.locator('[data-conversation-scroll]');
        const process = f.page
          .getByRole('region', { name: '工作过程', exact: true })
          .last();
        await process.locator('[data-disclosure-row]').first().click();
        const card = f.page.locator(
          `[data-step-id="operation:cloud:${id(8900)}"]`,
        );
        const next = f.page.locator(
          `[data-step-id="operation:cloud:${id(8901)}"]`,
        );
        const header = card.locator('[data-disclosure-header]');
        const toggle = header.getByRole('button');
        await toggle.waitFor();
        await scroll.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          node.dispatchEvent(new Event('scroll'));
        });
        const settle = () =>
          f.page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
        const geometry = async () => ({
          top: (await header.boundingBox())!.y,
          next: (await next.boundingBox())!.y,
          height: (await card.boundingBox())!.height,
          scroll: await scroll.evaluate((node) => node.scrollTop),
        });
        await settle();
        // Starting at the bottom reproduces the resize-follow jump in a finished reply.
        await expect
          .poll(() =>
            scroll.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(2);
        for (const input of ['pointer', 'keyboard'] as const) {
          await scroll.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event('scroll'));
          });
          await settle();
          if (input === 'keyboard')
            await toggle.evaluate((node) =>
              node.focus({ preventScroll: true }),
            );
          const before = await geometry();
          if (input === 'keyboard') await toggle.press('Enter');
          else if (width < 760) await toggle.tap();
          else await toggle.click();
          await settle();
          const after = await geometry();
          const detailHeight = await card
            .locator(
              `[data-process-content="step:operation:cloud:${id(8900)}:details"]`,
            )
            .evaluate((node) => {
              const style = getComputedStyle(node);
              return (
                node.getBoundingClientRect().height +
                parseFloat(style.marginTop) +
                parseFloat(style.marginBottom)
              );
            });
          expect(after.height - before.height).toBe(detailHeight);
          expect(detailHeight).toBeGreaterThan(100);
          expect(Math.abs(after.top - before.top)).toBeLessThan(2);
          expect(Math.abs(after.scroll - before.scroll)).toBeLessThan(2);
          expect(
            Math.abs(after.next - before.next - (after.height - before.height)),
          ).toBeLessThan(2);
          await toggle.press('Space');
          await settle();
          expect(Math.abs((await geometry()).top - before.top)).toBeLessThan(2);
        }
        // Reading older content must also keep its position on expansion.
        await scroll.evaluate((node) => {
          node.scrollTop -= 100;
        });
        await settle();
        const before = await geometry();
        await toggle.click();
        await settle();
        expect(Math.abs((await geometry()).top - before.top)).toBeLessThan(2);
        await f.page
          .getByRole('button', { name: '回到底部', exact: true })
          .click();
        await expect
          .poll(() =>
            scroll.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(2);
        // Inline parameters and the complete long result share one disclosure.
        const last = f.page.locator(
          `[data-step-id="operation:cloud:${id(8904)}"]`,
        );
        const result = last.locator('[data-disclosure-row]');
        await result.scrollIntoViewIfNeeded();
        await settle();
        const resultTop = (await result.boundingBox())!.y;
        const lastHeight = (await last.boundingBox())!.height;
        const scrollTop = await scroll.evaluate((node) => node.scrollTop);
        await result.click();
        await settle();
        expect((await last.boundingBox())!.height).toBeGreaterThan(
          lastHeight + 100,
        );
        expect(
          Math.abs((await result.boundingBox())!.y - resultTop),
        ).toBeLessThan(2);
        expect(
          Math.abs(
            (await scroll.evaluate((node) => node.scrollTop)) - scrollTop,
          ),
        ).toBeLessThan(2);
        const material = last.locator(
          `[data-process-material="cloud:${id(8904)}"]`,
        );
        expect(
          await material
            .locator('[data-process-content="result"]')
            .textContent(),
        ).toBe(operations[4]!.result.output);
        expect(
          JSON.parse(
            (await material
              .locator('[data-process-content="input"]')
              .textContent())!,
          ).arguments,
        ).toEqual(operations[4]!.proposal.arguments);
        expect(await material.getByRole('button').count()).toBe(0);
        for (const operation of operations) {
          expect('nativeCallId' in operation).toBe(false);
          expect(
            await f.page
              .locator(
                `[data-step-id="operation:cloud:${operation.snapshot.binding.attempt.operationId}"]`,
              )
              .count(),
          ).toBe(1);
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each(
    [1440, 390].flatMap((width) =>
      [false, true].flatMap((streamingOutput) =>
        ['script', 'python-project', 'node-project', 'mcp'].map((kind) => ({
          width,
          streamingOutput,
          kind,
        })),
      ),
    ),
  )(
    'keeps $kind receipts compact at $width px streaming=$streamingOutput',
    async ({ width, streamingOutput, kind }) => {
      const f = await fixture({ width, streamingOutput, touch: width < 760 });
      const project = kind === 'python-project' || kind === 'node-project';
      const mcp = kind === 'mcp';
      const operations = ['failed', 'succeeded'].map((status, index) => ({
        nativeCallId: `compact-${index}`,
        snapshot: {
          status,
          binding: {
            action: mcp ? 'cloud.mcp.call' : 'cloud.process.execute',
            task: operationTask(),
            attempt: { operationId: id(8870 + index), generation: 1 },
          },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: mcp ? 'mcp' : project ? 'project' : 'cloud',
          endpoint: 'https://example.test/mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: { query: 'existing' },
          risk: 'read',
          language: 'python',
          script: 'print("compact result")',
          inputs: [],
          files: [],
          project: { projectId: 'compact-project', snapshot: { version: '1' } },
          sourceDigest: 'sha256:' + 'a'.repeat(64),
          executable:
            kind === 'python-project'
              ? '/usr/bin/python3'
              : '/usr/local/bin/node',
          args: ['verify'],
          path: '.',
          preparation: { manager: kind === 'python-project' ? 'uv' : 'pnpm' },
          limits: {
            timeoutMs: 30000,
            memoryMiB: 256,
            cpuMillis: 500,
            pids: 64,
          },
          outputs: [
            { path: 'result.json', fileName: 'result.json', format: 'json' },
          ],
        },
        approval: { response: { decision: 'approved' } },
        result: {
          code: index ? 'OK' : 'EXECUTION_FAILED',
          output: 'compact result',
          trusted: false,
        },
      }));
      try {
        f.state.messages = navigationHistory(2);
        f.state.messages.at(-1)!.runId = run;
        f.state.messages.at(-1)!.content.text = '核对完成。';
        f.state.events = operations.map((operation, index) => ({
          schemaVersion: 3,
          eventId: id(8880 + index),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence: index + 1,
          cursor: `${run}:${index + 1}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type: 'tool.completed',
          payload: {
            toolCallId: operation.nativeCallId,
            name: project ? 'cloud.project.run' : 'cloud.compute',
          },
        }));
        await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
          route.fulfill({
            json: {
              operations:
                new URL(route.request().url()).searchParams.get('runId') === run
                  ? operations
                  : [],
            },
          }),
        );
        await f.page.route('**/api/v1/runs/*/events?**', (route) =>
          route.fulfill({
            json: {
              events:
                new URL(route.request().url()).pathname.split('/').at(-2) ===
                run
                  ? f.state.events
                  : [],
            },
          }),
        );
        await f.page.reload();
        if (width < 760) {
          const collapse = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await collapse.isVisible()) await collapse.click();
        }
        const owner = f.page.locator(`#message-${id(2003)}`);
        const previousOwner = f.page.locator(`#message-${id(2001)}`);
        const process = owner.getByRole('region', {
          name: '工作过程',
          exact: true,
        });
        await process
          .getByRole('button', { name: '工作过程', exact: true })
          .click();
        const first = owner.locator('[data-step-id="tool:compact-0"]');
        const second = owner.locator('[data-step-id="tool:compact-1"]');
        await first.waitFor();
        expect(await owner.count()).toBe(1);
        expect(await previousOwner.count()).toBe(1);
        expect(
          await previousOwner
            .getByText('第 1 项答复', { exact: true })
            .isVisible(),
        ).toBe(true);
        const measure = () =>
          owner.evaluate((node) => {
            const one = node
              .querySelector('[data-step-id="tool:compact-0"]')!
              .getBoundingClientRect();
            const two = node
              .querySelector('[data-step-id="tool:compact-1"]')!
              .getBoundingClientRect();
            return {
              height: one.height,
              secondHeight: two.height,
              gap: two.top - one.bottom,
              distance: two.top - one.top,
            };
          });
        const before = await measure();
        expect(before).toMatchObject({ height: 42, secondHeight: 42, gap: 8 });
        expect(
          await first
            .locator('[data-disclosure-row]')
            .getAttribute('aria-expanded'),
        ).toBe('false');
        await first.locator('[data-disclosure-row]').click();
        const material = first.locator(
          `[data-process-material="cloud:${id(8870)}"]`,
        );
        await material.waitFor();
        const after = await measure();
        const detailHeight = await first
          .locator('[data-process-content="step:tool:compact-0:details"]')
          .evaluate((node) => {
            const style = getComputedStyle(node);
            return (
              node.getBoundingClientRect().height +
              parseFloat(style.marginTop) +
              parseFloat(style.marginBottom)
            );
          });
        expect(after.height - before.height).toBe(detailHeight);
        expect(after.secondHeight).toBe(before.secondHeight);
        expect(after.gap).toBe(before.gap);
        expect(after.distance - before.distance).toBe(detailHeight);
        expect(
          await second
            .locator('[data-disclosure-row]')
            .getAttribute('aria-expanded'),
        ).toBe('false');
        expect(
          await material.locator(':scope > dl > dt').allTextContents(),
        ).toEqual(['状态', '位置', '输入', '结果']);
        const { kind: proposalKind, ...input } = operations[0]!.proposal;
        expect(proposalKind).toBe(mcp ? 'mcp' : project ? 'project' : 'cloud');
        expect(
          JSON.parse(
            (await material
              .locator('[data-process-content="input"]')
              .textContent())!,
          ),
        ).toEqual(input);
        expect(
          await material
            .locator('[data-process-content="result"]')
            .textContent(),
        ).toBe(operations[0]!.result.output);
        expect(
          await material
            .getByText('EXECUTION_FAILED', { exact: true })
            .isVisible(),
        ).toBe(true);
        expect(
          await material.getByText('未完成', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await material
            .getByText('你已允许这一步', { exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await material.getByRole('button').count()).toBe(0);
        expect(
          await process
            .locator('..')
            .getByRole('button', {
              name: '技术详情',
              exact: true,
            })
            .count(),
        ).toBe(0);
        expect(await material.locator('[data-process-artifact]').count()).toBe(
          0,
        );
        if (!mcp)
          expect(input.outputs).toEqual([
            { path: 'result.json', fileName: 'result.json', format: 'json' },
          ]);
        await second.locator('[data-disclosure-row]').click();
        const completed = second.locator(
          `[data-process-material="cloud:${id(8871)}"]`,
        );
        expect(
          await completed.getByText('OK', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await completed.getByText('已完成', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await completed
            .locator('[data-process-content="result"]')
            .textContent(),
        ).toBe(operations[1]!.result.output);
        for (const operation of operations) {
          expect(
            await f.page
              .locator(`[data-step-id="tool:${operation.nativeCallId}"]`)
              .count(),
          ).toBe(1);
          expect(
            await previousOwner
              .locator(
                `[data-step-id="tool:${operation.nativeCallId}"], [data-process-material="cloud:${operation.snapshot.binding.attempt.operationId}"]`,
              )
              .count(),
          ).toBe(0);
          expect(
            await f.page
              .locator(
                `[data-process-material="cloud:${operation.snapshot.binding.attempt.operationId}"]`,
              )
              .count(),
          ).toBe(1);
        }
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'MET231 saves and clears subagent preferences without changing other preferences at %ipx',
    async (width) => {
      const saved: UserPreferences = {
        ...defaultUserPreferences,
        appearance: 'dark',
        fontSize: 18,
        streamingOutput: false,
        questionWait: { mode: 'timed', seconds: 300 },
      };
      const f = await fixture({
        width,
        touch: width < 600,
        preferences: { [user]: saved },
        brandContent: { kind: 'custom', registered: true },
      });
      const patches: unknown[] = [];
      f.page.on('request', (request) => {
        if (
          request.url().endsWith('/api/v1/me/preferences') &&
          request.method() === 'PATCH'
        )
          patches.push(request.postDataJSON());
      });
      try {
        const dialog = await openSettings(f);
        const depth = dialog.getByRole('spinbutton', {
          name: '子智能体最大递归深度',
          exact: true,
        });
        const active = dialog.getByRole('spinbutton', {
          name: '子智能体并行数量上限',
          exact: true,
        });
        await expect.poll(() => depth.isEnabled()).toBe(true);
        expect(await depth.inputValue()).toBe('');
        expect(await depth.getAttribute('placeholder')).toBe('默认（1）');
        expect(await active.inputValue()).toBe('');
        expect(await active.getAttribute('placeholder')).toBe('默认（8）');
        expect(await dialog.getByText(/下一次任务生效/).count()).toBe(2);
        await depth.focus();
        await depth.press('Enter');
        expect(patches).toEqual([]);

        const save = async (input: Locator, value: string) => {
          await input.fill(value);
          await input.press('Enter');
          await expect.poll(() => input.isEnabled()).toBe(true);
          await expect.poll(() => input.inputValue()).toBe(value);
        };
        await save(depth, '0');
        expect(f.state.preferences[user]!.subagents).toEqual({
          maxDepth: 0,
          maxActive: null,
        });
        await save(active, '16');
        await save(depth, '');
        expect(patches.at(-1)).toEqual({
          subagents: { maxDepth: null, maxActive: 16 },
        });
        await save(active, '');
        expect(patches.at(-1)).toEqual({
          subagents: { maxDepth: null, maxActive: null },
        });
        expect(f.state.preferences[user]).toEqual({ ...saved, updatedAt: now });

        f.state.preferenceError = true;
        await depth.fill('2');
        await depth.press('Enter');
        await dialog.getByRole('alert').getByText('保存失败，请重试').waitFor();
        await expect.poll(() => depth.inputValue()).toBe('');
        expect(f.state.preferences[user]!.subagents.maxDepth).toBeNull();
        f.state.preferenceError = false;
        await dialog.getByRole('button', { name: '重新读取' }).click();
        await expect.poll(() => depth.isEnabled()).toBe(true);
        await f.page.reload();
        await openSettings(f);
        await expect.poll(() => depth.isEnabled()).toBe(true);
        expect(await depth.inputValue()).toBe('');
        expect(await active.inputValue()).toBe('');
        expect(f.state.preferences[user]).toEqual({ ...saved, updatedAt: now });
        expect(
          await dialog.evaluate(
            (node) => node.scrollWidth <= node.clientWidth + 1,
          ),
        ).toBe(true);
        await active.scrollIntoViewIfNeeded();
        await f.page.screenshot({
          path: `.local/feedback/met231-subagent-preferences-${width}.png`,
        });
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it.each([
    [1440, 'maxDepth', '-'],
    [390, 'maxDepth', '-'],
    [1440, 'maxActive', '1e'],
    [390, 'maxActive', '1e'],
  ] as const)(
    'MET231 preserves saved limits for an incomplete number at %ipx (%s %s)',
    async (width, field, text) => {
      const saved: UserPreferences = {
        ...defaultUserPreferences,
        appearance: 'dark',
        fontSize: 18,
        streamingOutput: false,
        questionWait: { mode: 'timed', seconds: 300 },
        subagents: { maxDepth: 0, maxActive: 1 },
      };
      const f = await fixture({
        width,
        touch: width < 600,
        preferences: { [user]: saved },
        brandContent: { kind: 'custom', registered: true },
      });
      const patches: unknown[] = [];
      f.page.on('request', (request) => {
        if (
          request.url().endsWith('/api/v1/me/preferences') &&
          request.method() === 'PATCH'
        )
          patches.push(request.postDataJSON());
      });
      try {
        const dialog = await openSettings(f);
        const input = dialog.getByRole('spinbutton', {
          name:
            field === 'maxDepth'
              ? '子智能体最大递归深度'
              : '子智能体并行数量上限',
          exact: true,
        });
        await expect.poll(() => input.isEnabled()).toBe(true);
        await input.fill('');
        await input.pressSequentially(text);
        expect(
          await input.evaluate((node: HTMLInputElement) => ({
            value: node.value,
            badInput: node.validity.badInput,
          })),
        ).toEqual({ value: '', badInput: true });
        await input.press('Enter');
        await f.page.waitForLoadState('networkidle');
        expect(patches).toEqual([]);
        expect(f.state.preferences[user]).toEqual(saved);
        await expect
          .poll(() => input.inputValue())
          .toBe(String(saved.subagents[field]));

        await input.fill('');
        expect(
          await input.evaluate(
            (node: HTMLInputElement) => node.validity.badInput,
          ),
        ).toBe(false);
        await input.press('Enter');
        const cleared = { ...saved.subagents, [field]: null };
        await expect
          .poll(() => f.state.preferences[user]!.subagents)
          .toEqual(cleared);
        await expect.poll(() => input.isEnabled()).toBe(true);
        expect(patches).toEqual([{ subagents: cleared }]);
        expect(f.state.preferences[user]).toEqual({
          ...saved,
          subagents: cleared,
          updatedAt: now,
        });

        await input.fill(String(saved.subagents[field]));
        await input.press('Enter');
        await expect
          .poll(() => f.state.preferences[user]!.subagents)
          .toEqual(saved.subagents);
        await expect.poll(() => input.isEnabled()).toBe(true);
        expect(patches).toEqual([
          { subagents: cleared },
          { subagents: saved.subagents },
        ]);
        expect(f.state.preferences[user]).toEqual({ ...saved, updatedAt: now });
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it.each([1440, 390, 320])(
    'keeps compact cloud cancellation run-scoped until acknowledged at %ipx',
    async (width) => {
      const f = await fixture({ width, running: true, touch: width < 760 });
      const operation = {
        snapshot: {
          status: 'running',
          binding: {
            action: 'cloud.mcp.call',
            task: operationTask(),
            attempt: { operationId: id(8801) },
          },
        },
        enabled: true,
        mcpAuthorization: { available: true, reason: 'available' },
        proposal: {
          kind: 'mcp',
          endpoint: 'https://example.test/mcp',
          tool: 'mcp__app__list_pull_requests',
          arguments: {},
          risk: 'read',
        },
        approval: null,
        result: null,
      } as unknown as CloudOperationView;
      const requests: unknown[] = [];
      const selectedRun = run;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await f.page.route(
          '**/api/v1/runtime/cloud-operations?**',
          async (route) => {
            const request = route.request();
            const runId = new URL(request.url()).searchParams.get('runId')!;
            if (request.method() === 'POST') {
              requests.push(request.postDataJSON());
              if (requests.length === 1)
                return route.fulfill({ status: 503, json: {} });
              await pending;
              return route.fulfill({ json: {} });
            }
            return route.fulfill({
              json: { operations: runId === selectedRun ? [operation] : [] },
            });
          },
        );
        await f.page.reload();
        if (width < 760) {
          const collapse = f.page.getByRole('button', {
            name: '收起侧边栏',
            exact: true,
          });
          if (await collapse.isVisible()) await collapse.click();
        }
        const card = f.page.locator(`#operation-${id(8801)}`);
        const stop = card.getByRole('button', {
          name: '请求停止本轮全部操作',
          exact: true,
        });
        const history = f.page.locator(
          `[data-step-id="operation:cloud:${id(8801)}"]`,
        );
        const toggle = history.locator('[data-disclosure-row]');
        const material = history.locator(
          `[data-process-material="cloud:${id(8801)}"]`,
        );
        await toggle.waitFor();
        const runningHeight = (await card.boundingBox())!.height;
        const label = card
          .locator('header')
          .getByText('应用工具', { exact: true });
        const labelBox = (await label.boundingBox())!;
        expect(
          await card.locator('header').getByRole('status').innerText(),
        ).toBe('进行中');
        expect(
          await card
            .locator('header')
            .getByRole('status')
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toBe(width === 1440 ? '12px' : '11px');
        const cardBox = (await card.boundingBox())!;
        const stopBox = (await stop.boundingBox())!;
        expect(stopBox.x + stopBox.width).toBeLessThan(
          cardBox.x + cardBox.width,
        );
        expect(
          await card.getByRole('button', { name: '查看详情' }).count(),
        ).toBe(0);
        // The current control card never toggles historical input or result.
        await label.click();
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        const gapX = cardBox.x + 8;
        const gapY = labelBox.y + labelBox.height / 2;
        await f.page.mouse.move(gapX, gapY);
        expect(
          await f.page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest('button, summary') !==
              null,
            { x: gapX, y: gapY },
          ),
        ).toBe(false);
        await f.page.mouse.click(gapX, gapY);
        expect(await material.count()).toBe(0);
        await toggle.hover();
        expect(
          await toggle.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return node.contains(
              document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              ),
            );
          }),
        ).toBe(true);
        await toggle.focus();
        const headerTop = (await toggle.boundingBox())!.y;
        const scroll = f.page.locator('[data-conversation-scroll]');
        const scrollTop = await scroll.evaluate((node) => node.scrollTop);
        await toggle.press('Enter');
        await f.page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        expect(
          Math.abs((await toggle.boundingBox())!.y - headerTop),
        ).toBeLessThan(2);
        expect(
          Math.abs(
            (await scroll.evaluate((node) => node.scrollTop)) - scrollTop,
          ),
        ).toBeLessThan(2);
        expect(await toggle.getAttribute('aria-expanded')).toBe('true');
        expect(await material.isVisible()).toBe(true);
        const input = JSON.parse(
          (await material
            .locator('[data-process-content="input"]')
            .textContent())!,
        );
        expect(input.tool).toBe('mcp__app__list_pull_requests');
        expect(input.arguments).toEqual({});
        expect(await material.getByRole('button').count()).toBe(0);
        await toggle.press('Space');
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await material.count()).toBe(0);
        expect((await card.boundingBox())!.height).toBe(runningHeight);
        await toggle.click();
        await stop.click();
        await expect.poll(() => requests.length).toBe(1);
        await expect.poll(() => stop.isEnabled()).toBe(true);
        await stop.click();
        const stopping = card.getByRole('button', {
          name: '正在停止本轮全部操作',
          exact: true,
        });
        await stopping.waitFor();
        expect(await stopping.isDisabled()).toBe(true);
        release();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests).toEqual([
          { runId: selectedRun, action: 'cancel' },
          { runId: selectedRun, action: 'cancel' },
        ]);
        // The write acknowledgment alone must not claim that a remote service stopped.
        expect(await stopping.isDisabled()).toBe(true);
        expect(
          await card.locator('header').getByRole('status').innerText(),
        ).toBe('进行中');
        operation.snapshot.status = 'cancel_requested';
        await card
          .locator('header')
          .getByRole('status', {
            name: '正在停止',
            exact: true,
          })
          .waitFor();
        expect(await stopping.isDisabled()).toBe(true);
        // Completion can race with a stop request; display the real result.
        operation.snapshot.status = 'succeeded';
        operation.result = {
          code: 'completed',
          output: 'Done',
          trusted: false,
        };
        await history
          .locator('[data-disclosure-header]')
          .getByText('已完成', { exact: true })
          .waitFor();
        expect(await history.getAttribute('data-status')).toBe('已完成');
        expect(await stopping.count()).toBe(0);
        expect(await card.count()).toBe(0);
        expect(
          await material
            .locator('[data-process-content="result"]')
            .textContent(),
        ).toBe('Done');
        operation.snapshot.status = 'failed';
        operation.result = {
          code: 'MCP_REQUEST_FAILED',
          output: 'network request failed',
          trusted: false,
        };
        await history
          .locator('[data-disclosure-header]')
          .getByText('未完成', { exact: true })
          .waitFor();
        expect(await history.getAttribute('data-status')).toBe('未完成');
        expect(await card.count()).toBe(0);
        expect(
          await material
            .locator('[data-process-content="result"]')
            .textContent(),
        ).toBe('network request failed');
        expect(
          JSON.parse(
            (await material
              .locator('[data-process-content="input"]')
              .textContent())!,
          ).tool,
        ).toBe('mcp__app__list_pull_requests');
        await toggle.press('Space');
        operation.snapshot.status = 'unknown';
        await card
          .locator('header')
          .getByRole('status', {
            name: '结果待确认',
            exact: true,
          })
          .waitFor();
        expect(
          await card
            .locator('header')
            .getByRole('status', {
              name: '未完成',
              exact: true,
            })
            .count(),
        ).toBe(0);
        expect('nativeCallId' in operation).toBe(false);
        expect(requests).toHaveLength(2);
      } finally {
        release();
        await f.close();
      }
    },
  );

  for (const width of [1440, 390]) {
    it(`returns OAuth to the settings modal, keeps the conversation without local MCP setup at ${width}px`, async () => {
      const f = await fixture({
        width,
        settingsEntry: 'apps',
        tenantAdmin: true,
      });
      try {
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await dialog
          .getByRole('heading', { name: '已链接应用', exact: true })
          .waitFor();
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(A);
        expect(new URL(f.page.url()).searchParams.has('settings')).toBe(false);
        const advanced = dialog.locator('details').filter({
          has: f.page.locator('summary', { hasText: '本地应用高级设置' }),
        });
        expect(await advanced.count()).toBe(0);
        expect(
          await dialog.getByRole('region', { name: '本地 MCP 连接' }).count(),
        ).toBe(0);
        await selectSettings(dialog, '我的电脑');
        await dialog
          .getByRole('button', { name: '连接与管理电脑', exact: true })
          .waitFor();
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await dialog.getByRole('button', { name: '关闭设置' }).click();
        expect(await dialog.count()).toBe(0);
        await f.page.reload();
        await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
        expect(await dialog.count()).toBe(0);
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(A);
        expect(f.errors).toEqual([]);
        expect(f.unexpected).toEqual([]);
        expect(f.writes).toEqual([]);
      } finally {
        await f.context.close();
      }
    });
  }

  it('native turn navigation previews, jumps and tracks reading position, and hides when the conversation narrows', async () => {
    const f = await fixture();
    try {
      expect(
        await f.page.getByRole('navigation', { name: '轮次导航' }).count(),
      ).toBe(0);
      f.state.messages = navigationHistory(12);
      await f.page.reload();
      const rail = f.page.getByRole('navigation', { name: '轮次导航' });
      await rail.waitFor();
      const first = rail.getByRole('button', {
        name: '跳转到第 1 轮',
        exact: true,
      });
      const scroller = f.page.locator('[data-conversation-scroll]');
      await expect
        .poll(() =>
          rail.locator('[aria-current="true"]').getAttribute('aria-label'),
        )
        .toBe('跳转到第 12 轮');
      await first.hover();
      const tooltip = rail.getByRole('tooltip');
      await tooltip
        .getByText('第 1 项工作：分析文档', { exact: true })
        .waitFor();
      expect(await tooltip.innerText()).toContain('第 1 项答复');
      expect(
        await tooltip.evaluate((node) => getComputedStyle(node).boxShadow),
      ).not.toBe('none');
      expect(
        await tooltip
          .locator('> div')
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('13px');
      await first.click();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      const targetTop = () =>
        f.page
          .locator(`#message-${id(2000)}`)
          .evaluate(
            (node) =>
              node.getBoundingClientRect().top -
              document
                .querySelector('[data-conversation-scroll]')!
                .getBoundingClientRect().top,
          );
      await expect.poll(targetTop).toBeGreaterThanOrEqual(15);
      expect(await targetTop()).toBeLessThan(18);
      const second = rail.getByRole('button', {
        name: '跳转到第 2 轮',
        exact: true,
      });
      await second.focus();
      await tooltip
        .getByText('第 2 项工作：分析文档', { exact: true })
        .waitFor();
      await second.press('Enter');
      await expect.poll(() => second.getAttribute('aria-current')).toBe('true');
      await scroller.evaluate(
        (scroll, targetId) => {
          scroll.scrollTop +=
            document.getElementById(targetId)!.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top;
        },
        `message-${id(2012)}`,
      );
      await expect
        .poll(() =>
          rail.locator('[aria-current="true"]').getAttribute('aria-label'),
        )
        .toBe('跳转到第 7 轮');
      await f.page
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      await expect.poll(() => rail.isVisible()).toBe(false);
      await f.page.setViewportSize({ width: 2200, height: 950 });
      await rail.waitFor();
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      await first.hover();
      expect(
        await tooltip.evaluate((node) => getComputedStyle(node).animationName),
      ).toBe('none');
      await f.page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => rail.isVisible()).toBe(false);
      expect(
        await f.page
          .locator('body')
          .evaluate((body) => body.scrollWidth <= innerWidth),
      ).toBe(true);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('native turn rail virtualizes long history and clears previews on session change', async () => {
    const f = await fixture();
    try {
      f.state.messages = navigationHistory(100, 2);
      await f.page.reload();
      const rail = f.page.getByRole('navigation', { name: '轮次导航' });
      const last = rail.getByRole('button', {
        name: '跳转到第 100 轮',
        exact: true,
      });
      await last.waitFor({ timeout: 15_000 });
      expect(await rail.getByRole('button').count()).toBeLessThan(55);
      await rail
        .locator('> div')
        .first()
        .evaluate((node) => {
          node.scrollTop = 0;
        });
      const first = rail.getByRole('button', {
        name: '跳转到第 1 轮',
        exact: true,
      });
      await first.hover();
      await rail.getByRole('tooltip').waitFor();
      await first.click();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      await f.page.getByRole('treeitem', { name: /研究任务 B/ }).click();
      await expect.poll(() => rail.count()).toBe(0);
      expect(await f.page.getByRole('tooltip').count()).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('returning to an old turn holds the reading position when an in-flight answer finishes', async () => {
    const f = await fixture({ running: true });
    try {
      f.state.messages = navigationHistory(5);
      const pending = f.state.messages.at(-1)!;
      pending.runId = run;
      pending.status = 'pending';
      pending.content.text = '';
      f.state.messages.at(-2)!.runId = run;
      await f.page.reload();
      const rail = f.page.getByRole('navigation', { name: '轮次导航' });
      const first = rail.getByRole('button', {
        name: '跳转到第 1 轮',
        exact: true,
      });
      await first.click();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      const scroller = f.page.locator('[data-conversation-scroll]');
      const before = await scroller.evaluate((node) => node.scrollTop);
      pending.status = 'completed';
      pending.content.text = report;
      f.finishRun();
      f.state.items = [];
      await f.page.getByRole('heading', { name: /COIN/ }).waitFor();
      await expect.poll(() => first.getAttribute('aria-current')).toBe('true');
      expect(
        Math.abs((await scroller.evaluate((node) => node.scrollTop)) - before),
      ).toBeLessThan(2);
      await f.page
        .getByRole('button', { name: '回到底部', exact: true })
        .click();
      await expect
        .poll(() =>
          rail.locator('[aria-current="true"]').getAttribute('aria-label'),
        )
        .toBe('跳转到第 5 轮');
    } finally {
      await f.close();
    }
  }, 30_000);

  it.each([1440, 390, 320])(
    'shows five ordered settings pages, defaults to personal preferences and keeps merged status groups collapsed at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        personalSkills: true,
      });
      try {
        const dialog = await openSettings(f);
        await dialog
          .getByRole('heading', { name: '个人偏好', exact: true })
          .waitFor();
        const streaming = dialog.getByRole('switch', {
          name: '流式输出',
          exact: true,
        });
        await expect.poll(() => streaming.isEnabled()).toBe(true);
        expect(await streaming.getAttribute('aria-checked')).toBe('true');
        await streaming.click();
        await expect
          .poll(() => streaming.getAttribute('aria-checked'))
          .toBe('false');
        await expect.poll(() => streaming.isEnabled()).toBe(true);
        expect(f.state.preferences[user]!.streamingOutput).toBe(false);
        await f.page.reload();
        await openSettings(f);
        await expect.poll(() => streaming.isEnabled()).toBe(true);
        expect(await streaming.getAttribute('aria-checked')).toBe('false');
        const labels = [
          '个人偏好',
          '我的电脑',
          '工作方式',
          '已链接应用',
          '账号与用量',
        ];
        const mobile = dialog.getByRole('combobox', { name: '设置页面' });
        expect(
          await (
            (await mobile.isVisible())
              ? mobile.locator('option')
              : dialog.locator('nav button')
          ).allTextContents(),
        ).toEqual(labels);
        const assertFits = async () => {
          const box = (await dialog.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(
            await dialog.evaluate(
              (node) => node.scrollWidth <= node.clientWidth + 1,
            ),
          ).toBe(true);
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        };
        await assertFits();
        expect(
          await dialog.getByText('private-checklist', { exact: false }).count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('button', { name: '刷新技能', exact: true })
            .count(),
        ).toBe(0);
        expect(f.state.personalSkillWrites).toEqual([]);

        await selectSettings(dialog, '工作方式');
        for (const label of ['云端自动工作', '电脑自动工作'])
          await expect
            .poll(() =>
              dialog
                .getByRole('switch', { name: label, exact: true })
                .isEnabled(),
            )
            .toBe(true);
        const work = dialog.locator('[data-capability-scope="work"]');
        await work.waitFor();
        expect(
          await work.locator(':scope > details').getAttribute('open'),
        ).toBeNull();
        expect(
          await work
            .locator('[data-capability]')
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute('data-capability')),
            ),
        ).toEqual([
          'report',
          'cloud_command',
          'cloud_browser',
          'boost',
          'teamwork',
        ]);
        expect(
          await dialog
            .getByRole('link', { name: '文件夹自动处理', exact: true })
            .count(),
        ).toBe(0);
        await assertFits();

        if (settingsReviewDir && (width === 1440 || width === 390)) {
          await f.page.evaluate(() => document.fonts.ready);
          await f.page.screenshot({
            path: `${settingsReviewDir}/work-${width}.png`,
          });
        }

        await selectSettings(dialog, '我的电脑');
        const computer = dialog.locator('[data-capability-scope="computer"]');
        await computer.waitFor();
        expect(
          await computer.locator(':scope > details').getAttribute('open'),
        ).toBeNull();
        expect(
          await computer
            .locator('[data-capability]')
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute('data-capability')),
            ),
        ).toEqual([
          'local_files',
          'changeset',
          'local_command',
          'local_browser',
        ]);
        expect(
          await dialog
            .getByRole('textbox', { name: '业务站点地址', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await dialog.getByText('业务站点', { exact: true }).count(),
        ).toBe(0);
        await assertFits();
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
        expect(f.unexpected).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it.each([
    ['capabilities', '工作方式'],
    ['experience', '工作方式'],
    ['skills', '个人偏好'],
  ] as const)(
    'maps legacy settings=%s to %s without exposing personal skill management',
    async (settingsEntry, label) => {
      const f = await fixture({ settingsEntry, personalSkills: true });
      try {
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await dialog
          .getByRole('heading', { name: label, exact: true })
          .waitFor();
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(A);
        expect(new URL(f.page.url()).searchParams.has('settings')).toBe(false);
        expect(
          await dialog.getByText('private-checklist', { exact: false }).count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('button', { name: '卸载个人技能', exact: true })
            .count(),
        ).toBe(0);
        expect(f.state.personalSkillWrites).toEqual([]);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
        expect(f.unexpected).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  async function openSettings(f: Awaited<ReturnType<typeof fixture>>) {
    await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
    const settings = f.page.getByRole('button', { name: '设置', exact: true });
    if (!(await settings.isVisible()))
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
    await settings.click();
    return f.page.getByRole('dialog', { name: '设置', exact: true });
  }

  async function openCapabilities(
    f: Awaited<ReturnType<typeof fixture>>,
    scope: 'work' | 'computer' = 'work',
  ) {
    const dialog = await openSettings(f);
    await selectSettings(dialog, scope === 'work' ? '工作方式' : '我的电脑');
    const panel = dialog.locator(`[data-capability-scope="${scope}"]`);
    // Expand through the same controls as a user before exercising each action.
    const group = panel.locator(':scope > details');
    if ((await group.getAttribute('open')) === null)
      await group.locator(':scope > summary').click();
    for (const card of await panel.locator('[data-capability]').all()) {
      if ((await card.getAttribute('open')) === null)
        await card.locator(':scope > summary').click();
    }
    return panel;
  }

  it('native Markdown receives the global heading, table and code typography tokens', async () => {
    const f = await fixture();
    try {
      f.state.reply =
        '# 样式验收\n\n正文与**加粗正文**。\n\n| 项目 | 金额 |\n| --- | --- |\n| 合成数据 | 123 |\n\n```javascript\nconst total = 123;\n```';
      await f.page.reload();
      const row = f.page.locator(`#message-${id(20)}`);
      const heading = row.getByRole('heading', { name: '样式验收' });
      await heading.waitFor();
      expect(
        await heading.evaluate((node) => ({
          size: getComputedStyle(node).fontSize,
          weight: getComputedStyle(node).fontWeight,
        })),
      ).toEqual({ size: '21px', weight: '700' });
      expect(
        await row
          .locator('td')
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('13px');
      expect(
        await row
          .locator('p')
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('14px');
      expect(
        await row
          .locator('strong')
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('14px');
      expect(
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息' })
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('14px');
      const code = row.locator('pre code').first();
      await code.waitFor();
      expect(
        await code.evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('11px');
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('native feedback hover, copy, rating dialog, retry, withdrawal and platform follow-up work together', async () => {
    const f = await fixture();
    try {
      const row = f.page.locator(`#message-${id(20)}`);
      const copy = row.getByRole('button', { name: '复制', exact: true });
      await f.page.mouse.move(20, 20);
      await expect
        .poll(() =>
          copy.locator('..').evaluate((n) => getComputedStyle(n).opacity),
        )
        .toBe('0');
      await row.hover();
      await copy.click();
      await row.getByRole('button', { name: '已复制', exact: true }).waitFor();
      expect(await row.getByRole('button', { name: /分支/ }).count()).toBe(0);
      await row
        .getByRole('button', { name: '有问题的回答', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog', {
        name: '提交反馈',
        exact: true,
      });
      await dialog.waitFor();
      expect(
        await dialog.evaluate((node) => getComputedStyle(node).borderRadius),
      ).toBe('28px');
      const category = dialog.getByRole('button', {
        name: '任务结果',
        exact: true,
      });
      await f.page.keyboard.press('Tab');
      await category.focus();
      expect(
        await category.evaluate((node) => ({
          radius: getComputedStyle(node).borderRadius,
          outlineWidth: getComputedStyle(node).outlineWidth,
          outlineStyle: getComputedStyle(node).outlineStyle,
        })),
      ).toEqual({ radius: '8px', outlineWidth: '2px', outlineStyle: 'solid' });
      await category.click();
      await dialog
        .getByRole('textbox', { name: '反馈详情' })
        .fill('请补充数据来源');
      if (process.env.ALLRICE_FEEDBACK_SCREENSHOT)
        await f.page.screenshot({
          path: process.env.ALLRICE_FEEDBACK_SCREENSHOT + '-dialog.png',
        });
      f.state.feedbackError = true;
      await dialog
        .getByRole('button', { name: '提交反馈', exact: true })
        .click();
      await f.page.getByText('反馈保存失败', { exact: true }).waitFor();
      expect(
        await dialog.getByRole('textbox', { name: '反馈详情' }).inputValue(),
      ).toBe('请补充数据来源');
      f.state.feedbackError = false;
      await dialog
        .getByRole('button', { name: '提交反馈', exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
      expect(f.state.messageFeedback[0]).toMatchObject({
        rating: 'negative',
        category: 'task-result',
        note: '请补充数据来源',
      });
      await f.page.mouse.move(20, 20);
      await expect
        .poll(() =>
          copy.locator('..').evaluate((n) => getComputedStyle(n).opacity),
        )
        .toBe('1');
      await row.getByRole('button', { name: '取消标记', exact: true }).click();
      await expect.poll(() => f.state.messageFeedback.length).toBe(0);
      await row.getByRole('button', { name: '好的回答', exact: true }).click();
      await dialog
        .getByRole('button', { name: '提交反馈', exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
      await f.page.goto(`${origin}/?feedback-inbox=1`);
      await f.page.getByRole('button', { name: /测试租户 · 测试用户/ }).click();
      await f.page.getByRole('heading', { name: '对应问题' }).waitFor();
      await f.page.getByText('制作一份报告', { exact: true }).waitFor();
      await f.page
        .getByRole('combobox', { name: '反馈处理状态', exact: true })
        .selectOption('resolved');
      await f.page
        .getByRole('textbox', { name: '处理备注' })
        .fill('已补充来源规则');
      await f.page.getByRole('button', { name: '保存处理记录' }).click();
      await expect
        .poll(() => f.state.feedbackReview)
        .toEqual({ status: 'resolved', note: '已补充来源规则' });
      if (process.env.ALLRICE_FEEDBACK_SCREENSHOT)
        await f.page.screenshot({
          path: process.env.ALLRICE_FEEDBACK_SCREENSHOT + '-inbox.png',
        });
      expect(f.state.messageInputs).toHaveLength(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);

  it.each([1440, 390])(
    'file copy toolbar seals the top of the reader while scrolling at width %s',
    async (width) => {
      const f = await fixture({ width });
      try {
        f.state.files = [
          {
            id: id(901),
            fileName: '工具记录.txt',
            mediaType: 'text/plain',
            sizeBytes: 18000,
            visibility: 'private',
            ownedByMe: true,
            category: 'uploads',
            deliverableVersion: null,
          },
        ];
        f.state.filePreview = {
          kind: 'text',
          mediaType: 'text/plain',
          text: Array.from(
            { length: 300 },
            (_, n) =>
              `记录 ${n}: timestamp=1781007600, adjustedClose=4.535999774932861`,
          ).join('\n'),
        };
        await f.page
          .getByRole('button', { name: '交付成果', exact: true })
          .click();
        const tree = f.panel.getByRole('region', {
          name: '交付成果',
          exact: true,
        });
        await tree
          .getByRole('button', { name: '工具记录.txt', exact: true })
          .click();
        const text = f.panel.getByRole('region', {
          name: '文件正文',
          exact: true,
        });
        await text.waitFor();
        const scrollport = text.locator('..');
        await scrollport.evaluate((e) => {
          e.scrollTop = 450;
        });
        const banner = text.locator('.md-code-block > :first-child');
        await expect
          .poll(async () => {
            const [b, s] = await Promise.all([
              banner.boundingBox(),
              scrollport.boundingBox(),
            ]);
            return Math.abs(b!.y - s!.y);
          })
          .toBeLessThanOrEqual(1);
        const toolbar = f.panel.locator('[aria-label="文件操作"]');
        const top = await toolbar.boundingBox(),
          b = await banner.boundingBox();
        expect(b!.y).toBeGreaterThanOrEqual(top!.y + top!.height - 1);
        expect(
          await banner.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return [1, r.width / 2, r.width - 1].every((x) =>
              e.contains(document.elementFromPoint(r.x + x, r.y + 1)),
            );
          }),
        ).toBe(true);
        await f.page.screenshot({
          path: `.local/reader/copy-toolbar-${width}.png`,
          animations: 'disabled',
        });
        await f.page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);
        const displayedPage = await text.locator('code').textContent();
        expect(displayedPage).not.toBe(f.state.filePreview.text);
        await banner
          .getByRole('button', { name: '复制本页', exact: true })
          .click();
        await expect
          .poll(() => f.page.evaluate(() => navigator.clipboard.readText()))
          .toBe(displayedPage);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('personal deliverables lists both objects of a series and business cards open the same exact original', async () => {
    const f = await fixture();
    try {
      const older = artifact(10),
        latest = artifact(11);
      older.version.fileName = latest.version.fileName = '经营简报.md';
      latest.version.seriesId = older.version.seriesId;
      latest.version.version = 2;
      latest.version.parentVersionId = older.id;
      latest.version.parentObjectId = older.object.id;
      older.stale = true;
      older.latestVersionId = latest.id;
      older.provenance.runId = id(9592);
      f.state.items = [latest, older];
      f.state.messages = [
        {
          id: id(9590),
          role: 'assistant',
          runId: older.provenance.runId,
          status: 'completed',
          content: { text: '此前完成的经营简报。' },
          createdAt: older.version.createdAt,
        },
        {
          id: id(20),
          role: 'assistant',
          runId: latest.provenance.runId,
          status: 'completed',
          content: { text: '当前完成的经营简报。' },
          createdAt: latest.version.createdAt,
        },
      ];
      f.state.artifactTexts[older.id] =
        '# 旧稿固定正文\n\n只属于第一份的内容。';
      f.state.artifactTexts[latest.id] =
        '# 新稿固定正文\n\n只属于第二份的内容。';
      await f.page.reload();
      await f.page
        .locator('header')
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      const files = f.panel.getByRole('region', {
        name: '交付成果',
        exact: true,
      });
      await files.locator(`[data-file-id="${older.object.id}"]`).waitFor();
      expect(
        await files
          .getByRole('button', { name: '经营简报.md', exact: true })
          .count(),
      ).toBe(2);
      expect(await files.innerText()).not.toMatch(/·\s*v\d/);
      for (const [item, title] of [
        [latest, '新稿固定正文'],
        [older, '旧稿固定正文'],
      ] as const) {
        await files
          .locator(`[data-file-id="${item.object.id}"]`)
          .getByRole('button', { name: '经营简报.md', exact: true })
          .click();
        await f.panel
          .getByRole('heading', { name: title, exact: true })
          .waitFor();
        expect(
          await f.panel
            .getByRole('link', { name: '下载', exact: true })
            .getAttribute('href'),
        ).toContain(item.object.id);
        for (const name of [
          '历史版本',
          '查看最新版本',
          '刷新文件',
          '可见范围',
          '设为参考资料',
        ])
          expect(
            await f.panel.getByRole('button', { name, exact: true }).count(),
          ).toBe(0);
        await f.panel
          .getByRole('button', { name: '‹ 交付成果', exact: true })
          .click();
      }
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.page
        .locator(`#message-${id(9590)}`)
        .getByRole('button', { name: '侧栏预览 经营简报.md', exact: true })
        .click();
      await f.panel
        .getByRole('heading', { name: '旧稿固定正文', exact: true })
        .waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('href'),
      ).toContain(older.object.id);
      expect(
        await f.panel
          .getByRole('button', { name: '刷新文件', exact: true })
          .count(),
      ).toBe(0);
      expect(await f.panel.locator('dl:visible dt').allTextContents()).toEqual([
        '员工交付',
        '来自对话',
      ]);
      expect(f.state.messageInputs).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20000);

  it('document reader keeps mobile actions visible, uses native menus and preserves exact version downloads', async () => {
    const older = artifact(10),
      latest = artifact(11);
    latest.version.seriesId = older.version.seriesId;
    latest.version.version = 2;
    latest.version.parentVersionId = older.id;
    latest.version.parentObjectId = older.object.id;
    older.stale = true;
    older.latestVersionId = latest.id;
    older.provenance.runId = id(9592);
    const f = await fixture({
      technicalArtifacts: true,
      width: 390,
      initialArtifacts: [latest, older],
      initialMessages: [
        {
          id: id(9590),
          role: 'assistant',
          runId: older.provenance.runId,
          status: 'completed',
          content: { text: '此前完成的报告。' },
          createdAt: older.version.createdAt,
        },
        {
          id: id(20),
          role: 'assistant',
          runId: latest.provenance.runId,
          status: 'completed',
          content: { text: '当前完成的报告。' },
          createdAt: latest.version.createdAt,
        },
      ],
      initialFiles: [latest, older].map((item) => ({
        id: item.object.id,
        fileName: item.version.fileName,
        mediaType: item.object.mediaType,
        sizeBytes: item.object.sizeBytes,
        visibility: 'private',
        ownedByMe: true,
        category: 'exports',
        deliverableVersion: item.version.version,
      })),
    });
    try {
      await f.openWorkbench();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      const download = f.panel.getByRole('link', { name: '下载', exact: true });
      expect(await download.getAttribute('href')).toContain(latest.object.id);
      expect((await download.boundingBox())!.height).toBeGreaterThanOrEqual(32);
      expect(
        await f.panel
          .getByText(/版本与基线标识|历史执行位置|SaaS 文件库|查看原文/)
          .count(),
      ).toBe(0);
      // Dock retains hidden previews; measure the selected version's toolbar.
      // Native Dock adds a 1px divider and a 1px pane border.
      await expect
        .poll(async () => {
          const r = await f.panel
            .locator(
              `[data-document-id="${latest.id}"] [aria-label="文件操作"]`,
            )
            .boundingBox();
          return !!r && r.x >= 0 && r.x <= 2 && r.x + r.width <= 391;
        })
        .toBe(true);
      await f.page.screenshot({
        path: '.local/reader/mobile.png',
        animations: 'disabled',
      });
      await f.panel
        .getByRole('region', { name: '文件正文', exact: true })
        .evaluate((n) => {
          n.parentElement!.scrollTop = 400;
        });
      expect(await download.isVisible()).toBe(true);
      await f.fileAction('查看源文本');
      await f.panel
        .getByRole('region', { name: '源文本', exact: true })
        .waitFor();
      await f.panel
        .getByRole('button', { name: '更多文件操作', exact: true })
        .click();
      await f.page
        .getByRole('menuitem', { name: '查看预览', exact: true })
        .focus();
      await f.page.keyboard.press('Escape');
      expect(await f.panel.isVisible()).toBe(true);
      expect(
        await f.panel
          .getByRole('button', { name: '历史版本', exact: true })
          .count(),
      ).toBe(0);
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      const list = f.panel.getByRole('region', {
        name: '交付成果',
        exact: true,
      });
      await list.getByRole('heading', { name: '还没有交付成果' }).waitFor();
      expect(
        await list
          .getByRole('button', { name: latest.version.fileName, exact: true })
          .count(),
      ).toBe(0);
      expect(
        await list
          .getByRole('button', { name: older.version.fileName, exact: true })
          .count(),
      ).toBe(0);
      expect(await list.innerText()).not.toMatch(/·\s*v\d/);
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.page
        .locator(`#message-${id(9590)}`)
        .getByRole('button', {
          name: `侧栏预览 ${older.version.fileName}`,
          exact: true,
        })
        .click();
      await expect
        .poll(() =>
          f.panel
            .getByRole('link', { name: '下载', exact: true })
            .getAttribute('href'),
        )
        .toContain(older.object.id);
      expect(
        await f.panel
          .getByRole('button', { name: '查看最新版本', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      await f.page.screenshot({
        path: '.local/reader/desktop.png',
        animations: 'disabled',
      });
    } finally {
      await f.close();
    }
  }, 20_000);

  it.each([1440, 390])(
    'tool search intermediate records stay out of all personal delivery categories at %ipx',
    async (width) => {
      const raw = artifact(10);
      raw.version.fileName = `tool-result-web-search-${raw.object.id}.txt`;
      raw.version.changeSummary = `Tool result web.search; Run ${run}; call call-1`;
      raw.provenance.kind = 'legacy_deliverable';
      const f = await fixture({
        width,
        initialArtifacts: [raw],
        initialFiles: [
          {
            id: raw.object.id,
            fileName: raw.version.fileName,
            mediaType: 'text/plain',
            sizeBytes: 120,
            visibility: 'private',
            ownedByMe: true,
            category: 'exports',
            deliverableVersion: 1,
          },
        ],
      });
      try {
        await f.page
          .locator('header')
          .getByRole('button', { name: '交付成果', exact: true })
          .click();
        const directory = f.panel.getByRole('region', {
          name: '交付成果',
          exact: true,
        });
        for (const category of ['全部', '员工交付', '我的上传']) {
          await directory
            .getByRole('button', { name: category, exact: true })
            .click();
          await directory
            .getByText('还没有交付成果', { exact: true })
            .waitFor();
          expect(await directory.locator('article').count()).toBe(0);
          expect(
            await directory
              .getByText(raw.version.fileName, { exact: true })
              .count(),
          ).toBe(0);
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each([390, 1440])(
    'saves the selected artifact through the full workbench and survives parent refresh at %ipx',
    async (width) => {
      const f = await fixture({
        technicalArtifacts: true,
        width,
        artifacts: true,
      });
      try {
        const saved: unknown[] = [];
        await f.page.route('**/api/v1/references/artifacts*', async (route) => {
          const posting = route.request().method() === 'POST';
          if (posting) saved.push(route.request().postDataJSON());
          await route.fulfill({
            contentType: 'application/json',
            status: posting ? 201 : 200,
            body: JSON.stringify(
              posting
                ? { sourceId: id(800), revisionId: id(801) }
                : {
                    workspaceId: workspace,
                    platformMaintainer: false,
                    maintenanceLevel: 'personal',
                    writable: true,
                    departmentId: null,
                    departments: [],
                  },
            ),
          });
        });
        await f.openWorkbench();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        const save = f.panel.getByRole('button', {
          name: '设为参考资料',
          exact: true,
        });
        expect(
          await f.panel
            .getByRole('button', { name: /共享为公司范本|登记采用与投入/ })
            .count(),
        ).toBe(0);
        await save.click();
        const dialog = f.page.getByRole('dialog', {
          name: '保存为参考资料',
          exact: true,
        });
        await expect
          .poll(() =>
            dialog
              .getByRole('button', { name: '保存', exact: true })
              .isEnabled(),
          )
          .toBe(true);
        expect(
          await dialog
            .getByLabel('保存范围')
            .locator('option')
            .allTextContents(),
        ).toEqual(['仅自己']);
        await Promise.all([
          f.page.waitForResponse('**/api/v1/workspace/monthly-quota?*'),
          f.page.evaluate(() => window.dispatchEvent(new Event('focus'))),
        ]);
        expect(await dialog.count()).toBe(1);
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await dialog.getByRole('status').waitFor();
        expect(saved).toEqual([
          expect.objectContaining({
            workspaceId: workspace,
            artifactVersionId: f.state.items[0]!.id,
            scope: 'personal',
            purpose: '',
          }),
        ]);
        await dialog.getByRole('button', { name: '完成', exact: true }).click();
        await expect.poll(() => dialog.count()).toBe(0);
        await save.click();
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect.poll(() => dialog.count()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it.each([
    'active',
    'archived',
    'denied',
    'history-denied',
    'history-unavailable',
  ] as const)(
    'keeps an open reference draft editable during lifecycle refresh until archive or access denial is confirmed: %s',
    async (outcome) => {
      const f = await fixture({ technicalArtifacts: true, artifacts: true });
      let release = () => {};
      try {
        const saved: unknown[] = [];
        await f.page.route('**/api/v1/references/artifacts*', async (route) => {
          const method = route.request().method();
          expect(['GET', 'POST']).toContain(method);
          if (method === 'POST') saved.push(route.request().postDataJSON());
          await route.fulfill({
            contentType: 'application/json',
            status: method === 'POST' ? 201 : 200,
            body: JSON.stringify(
              method === 'POST'
                ? { sourceId: id(800), revisionId: id(801) }
                : {
                    workspaceId: workspace,
                    platformMaintainer: false,
                    maintenanceLevel: 'personal',
                    writable: true,
                    departmentId: null,
                    departments: [],
                  },
            ),
          });
        });
        await f.openWorkbench();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.panel
          .getByRole('button', { name: '设为参考资料', exact: true })
          .click();
        const dialog = f.page.getByRole('dialog', {
          name: '保存为参考资料',
          exact: true,
        });
        const save = dialog.getByRole('button', { name: '保存', exact: true });
        const purpose = dialog.getByLabel('参考资料用途', { exact: true });
        await expect.poll(() => save.isEnabled()).toBe(true);
        const draft = '父刷新期间保留的参考用途';
        await purpose.fill(draft);
        f.state.employeeInstanceDelay = new Promise<void>((done) => {
          release = done;
        });
        const historyOutcome =
          outcome === 'history-denied' || outcome === 'history-unavailable';
        if (historyOutcome)
          f.state.employeeHistoryDelay = f.state.employeeInstanceDelay;
        const selectedPath = `/api/v1/employee-instances/${id(7)}`;
        const isSelected = (url: string) =>
          new URL(url).pathname === selectedPath;
        const began = f.page.waitForRequest(
          (request) => request.method() === 'GET' && isSelected(request.url()),
        );
        await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await began;
        expect(await dialog.count()).toBe(1);
        expect(await purpose.inputValue()).toBe(draft);
        expect(await purpose.isEditable()).toBe(true);
        expect(await save.isEnabled()).toBe(true);
        const editedDraft = `${draft}，继续编辑`;
        await purpose.fill(editedDraft);
        expect(await purpose.inputValue()).toBe(editedDraft);
        expect(saved).toEqual([]);

        f.state.employeeInstanceArchived = outcome === 'archived';
        f.state.employeeInstanceStatus =
          outcome === 'denied' ? 403 : outcome === 'history-denied' ? 503 : 200;
        f.state.employeeHistoryStatus =
          outcome === 'history-denied'
            ? 403
            : outcome === 'history-unavailable'
              ? 503
              : 200;
        const listCompleted = historyOutcome
          ? f.page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                '/api/v1/employee-instances',
            )
          : undefined;
        const completed = f.page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' && isSelected(response.url()),
        );
        release();
        f.state.employeeInstanceDelay = null;
        await completed;
        if (listCompleted) await listCompleted;
        f.state.employeeHistoryDelay = null;
        if (outcome === 'active' || outcome === 'history-unavailable') {
          await expect.poll(() => save.isEnabled()).toBe(true);
          expect(await purpose.inputValue()).toBe(editedDraft);
          await save.click();
          await dialog.getByRole('status').waitFor();
          expect(saved).toEqual([
            expect.objectContaining({
              artifactVersionId: f.state.items[0]!.id,
              purpose: editedDraft,
            }),
          ]);
        } else {
          await f.page
            .getByText(
              outcome === 'archived'
                ? 'AI 员工已归档，可以查看历史；恢复后才能继续工作。'
                : outcome === 'denied'
                  ? '没有权限，如需使用请联系管理员'
                  : '归档列表读取失败，请重试。',
              { exact: true },
            )
            .waitFor();
          expect(await dialog.count()).toBe(1);
          expect(await purpose.inputValue()).toBe(editedDraft);
          expect(await purpose.isDisabled()).toBe(true);
          expect(await save.isDisabled()).toBe(true);
          await save.dispatchEvent('click');
          expect(saved).toEqual([]);
          if (outcome === 'history-denied') {
            f.state.employeeInstanceStatus = 200;
            f.state.employeeHistoryStatus = 200;
            await f.page.evaluate(() =>
              window.dispatchEvent(new Event('focus')),
            );
            await expect.poll(() => save.isEnabled()).toBe(true);
            expect(await purpose.isEditable()).toBe(true);
            expect(await purpose.inputValue()).toBe(editedDraft);
            await save.click();
            await dialog.getByRole('status').waitFor();
            expect(saved).toEqual([
              expect.objectContaining({
                artifactVersionId: f.state.items[0]!.id,
                purpose: editedDraft,
              }),
            ]);
          }
        }
        expect(f.errors).toEqual([]);
      } finally {
        release();
        f.state.employeeInstanceDelay = null;
        f.state.employeeHistoryDelay = null;
        await f.close();
      }
    },
  );

  it('isolates an employee scope denial and aborts its pending reads when workspace identity changes', async () => {
    const f = await fixture({ running: true });
    const startedAt = Date.now();
    const timeline: {
      ms: number;
      event: string;
      url?: string;
      status?: number;
      error?: string;
    }[] = [];
    let dropped = 0;
    const trace = (
      event: string,
      request?: Request,
      status?: number,
      error = request?.failure()?.errorText,
    ) => {
      if (timeline.length < 64)
        timeline.push({
          ms: Date.now() - startedAt,
          event,
          url: request?.url(),
          status,
          error,
        });
      else dropped++;
    };
    const oldWorkspace = f.state.workspace;
    const paths = [
      '/api/v1/employee-instances',
      `/api/v1/employee-instances/${id(7)}`,
    ];
    const held: Request[] = [],
      responses = new Set<Request>(),
      settled = new Map<Request, string>();
    let holdOldReads = false,
      oldRepliesFinished = 0,
      release = () => {};
    const oldReplies = new Promise<void>((done) => {
      release = done;
    });
    const relevant = (request: Request) =>
      request.method() === 'GET' &&
      paths.includes(new URL(request.url()).pathname);
    f.page.on('response', (response) => {
      if (!relevant(response.request())) return;
      responses.add(response.request());
      trace('response', response.request(), response.status());
    });
    f.page.on('requestfailed', (request) => {
      if (!relevant(request)) return;
      settled.set(request, 'failed');
      trace('requestfailed', request);
    });
    f.page.on('requestfinished', (request) => {
      if (!relevant(request)) return;
      settled.set(request, 'finished');
      trace('requestfinished', request);
    });
    try {
      await expect.poll(() => f.state.streamRequests).toBeGreaterThan(0);
      const input = f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ });
      await input.waitFor();
      await f.page.route('**/api/v1/employee-instances**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (
          !relevant(request) ||
          url.searchParams.get('workspaceId') !== oldWorkspace
        )
          return route.fallback();
        const heldOldRead = holdOldReads;
        if (heldOldRead) {
          held.push(request);
          trace('hold-entered', request);
          await oldReplies;
        }
        const status = heldOldRead || url.pathname === paths[0] ? 403 : 503;
        trace('old-reply', request, status);
        try {
          await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'No access' } }),
          });
        } catch (cause) {
          if (!heldOldRead) throw cause;
          trace('cancelled-old-reply', request, status, String(cause));
        } finally {
          if (heldOldRead) oldRepliesFinished++;
        }
      });
      await Promise.all([
        f.page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === paths[1] &&
            url.searchParams.get('workspaceId') === oldWorkspace &&
            response.status() === 503
          );
        }),
        f.page.evaluate(() => window.dispatchEvent(new Event('focus'))),
      ]);
      const denied = f.page.getByText('归档列表读取失败，请重试。', {
        exact: true,
      });
      await denied.waitFor();
      expect(await input.count()).toBe(0);
      holdOldReads = true;
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      // An issued request is not yet proof that its route entered the hold.
      await expect.poll(() => held.length, { timeout: 5000 }).toBe(2);
      expect(
        held.map((request) => new URL(request.url()).pathname).sort(),
      ).toEqual([...paths].sort());
      for (const request of held) {
        expect(request.failure()).toBeNull();
        expect(responses.has(request)).toBe(false);
        expect(settled.has(request)).toBe(false);
        trace('pending-before-scope-change', request);
      }
      const newReads = Promise.all(
        paths.map((path) =>
          f.page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === path &&
              url.searchParams.get('workspaceId') === id(51) &&
              response.status() === 200
            );
          }),
        ),
      );
      f.state.viewer = id(50);
      f.state.workspace = id(51);
      trace('scope-change');
      f.finishRun();
      await Promise.all([
        newReads,
        expect
          .poll(() => held.map((request) => settled.get(request)), {
            timeout: 5000,
          })
          .toEqual(['failed', 'failed']),
      ]);
      for (const request of held) {
        expect(request.failure()?.errorText).toContain('ERR_ABORTED');
        expect(await request.response()).toBeNull();
      }
      await input.waitFor();
      expect(await input.isEditable()).toBe(true);
      trace('new-scope-editable');
      release();
      await expect.poll(() => oldRepliesFinished, { timeout: 5000 }).toBe(2);
      await f.page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      expect(await input.isEditable()).toBe(true);
      expect(await denied.count()).toBe(0);
      expect(f.state.messageInputs).toEqual([]);
      expect(f.errors).toEqual([]);
      trace('late-denials-isolated');
    } finally {
      release();
      trace('finally');
      console.info(
        'MET249_SCOPE_TRACE',
        JSON.stringify({ startedAt, dropped, timeline }),
      );
      await f.close();
    }
  });

  it.each([390, 1440])(
    'keeps one shared reference surface across parent refreshes, closes it and quotes the exact revision at %ipx',
    async (width) => {
      const f = await fixture({ width });
      try {
        const shared = {
          ...fileReference(
            8440,
            catalogFile(8442, { fileName: '公司参考口径.txt' }),
          ),
          ownership: { scope: 'company' as const, organizationId: org },
          canMaintain: false,
        };
        const input = f.page.getByRole('textbox', { name: /给 .* 的消息/ });
        await input.fill('参考资料打开期间保留这段草稿');
        await f.page.route('**/api/v1/references?*', (route) =>
          route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              references: [shared],
              options: {
                workspaceId: workspace,
                platformMaintainer: false,
                maintenanceLevel: 'personal',
                writable: true,
                departmentId: null,
                departments: [],
              },
            }),
          }),
        );
        const dialog = f.page.getByRole('dialog', {
          name: '参考资料',
          exact: true,
        });
        for (let cycle = 0; cycle < 2; cycle++) {
          await f.page
            .getByRole('button', { name: '添加文件', exact: true })
            .click();
          await f.page
            .getByRole('menuitem', { name: '参考资料', exact: true })
            .click();
          await dialog
            .getByRole('textbox', { name: '查找参考资料', exact: true })
            .waitFor();
          await dialog
            .getByRole('button', { name: shared.fileName, exact: true })
            .waitFor();
          // The regular quota refresh rerenders ChatFlowClient while its
          // reference portal and the company-template sibling stay mounted.
          for (let refresh = 0; refresh < 3; refresh++) {
            await Promise.all([
              f.page.waitForResponse('**/api/v1/workspace/monthly-quota?*'),
              f.page.evaluate(() => window.dispatchEvent(new Event('focus'))),
            ]);
            await f.page.evaluate(
              () =>
                new Promise((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(done)),
                ),
            );
            expect(await dialog.count()).toBe(1);
          }
          await dialog
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          await expect.poll(() => dialog.count()).toBe(0);
          expect(
            await f.page.evaluate(() => document.body.style.overflow),
          ).not.toBe('hidden');
        }
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page
          .getByRole('menuitem', { name: '参考资料', exact: true })
          .click();
        await dialog
          .getByRole('button', { name: '引用 v1', exact: true })
          .click();
        await dialog.waitFor({ state: 'hidden' });
        await f.page
          .getByRole('button', {
            name: `移除资料 ${shared.fileName} v1`,
            exact: true,
          })
          .waitFor();
        expect(await input.inputValue()).toBe('参考资料打开期间保留这段草稿');
        expect(f.state.messageInputs).toEqual([]);
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(1);
        expect(f.state.messageInputs[0]!.referenceRevisionIds).toEqual([
          shared.revisionId,
        ]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    { width: 1440, recommended: false },
    { width: 640, recommended: false },
    { width: 1440, recommended: true },
    { width: 640, recommended: true },
  ])(
    'prepares exact company template parameters without submitting, then preserves them in the original send at $width px (recommended=$recommended)',
    async ({ width, recommended }) => {
      const f = await fixture({ width, taskSuggestions: recommended });
      const revisionId = id(8401),
        assetId = id(8402);
      const asset = CompanyAssetSchema.parse({
        id: assetId,
        organizationId: org,
        ownerId: id(8403),
        ownerName: '范本作者',
        kind: 'template',
        state: 'published',
        revision: 2,
        publishedRevisionId: revisionId,
        canEdit: false,
        pinned: true,
        latest: {
          id: revisionId,
          number: 1,
          digest: `sha256:${'c'.repeat(64)}`,
          createdAt: now,
          content: {
            kind: 'template',
            title: '季度经营简报',
            body: '填写本期数据并核对。',
            category: '运营',
            appliesToEmployeeIds: [],
            taskKeywords: [],
            sourceVersionId: id(8404),
            slots: [
              {
                key: 'period',
                label: '本期业务数据',
                required: true,
                multiline: true,
              },
            ],
          },
          file: {
            objectId: id(8405),
            checksum: `sha256:${'d'.repeat(64)}`,
            sizeBytes: 1000,
            fileName: '旧简报.txt',
            mediaType: 'text/plain',
            format: 'text',
          },
        },
      });
      const templateFile = catalogFile(8405, {
        fileName: asset.latest.file!.fileName,
        checksum: asset.latest.file!.checksum,
        sizeBytes: asset.latest.file!.sizeBytes,
        ownedByMe: false,
        canMaintain: false,
        sharing: { scope: 'company', departmentIds: [], departmentNames: [] },
        category: 'reference',
        isReference: true,
      });
      const templateReference = {
        ...fileReference(8406, templateFile),
        ownership: { scope: 'company' as const, organizationId: org },
        canMaintain: false,
        companyTemplate: { assetId, revisionId, digest: asset.latest.digest },
      };
      templateFile.reference = templateReference;
      f.state.workbenchFiles.push(templateFile);
      await f.page.route('**/api/v1/references?*', (route) =>
        route.fulfill({
          json: {
            references: [templateReference],
            options: {
              workspaceId: workspace,
              platformMaintainer: false,
              maintenanceLevel: 'personal',
              writable: true,
              departmentId: null,
              departments: [],
            },
          },
        }),
      );
      const ownDraft = {
        ...asset,
        id: id(8408),
        state: 'draft',
        publishedRevisionId: null,
        pinned: false,
        canEdit: true,
        latest: {
          ...asset.latest,
          id: id(8409),
          content: { ...asset.latest.content, title: '本人未发布范本草稿' },
        },
      };
      const directoryQueries: Record<string, string>[] = [];
      let withdrawn = false,
        deniedWrites = 0;
      await f.page.route('**/api/v1/company-assets*', async (route) => {
        if (route.request().method() !== 'GET') {
          deniedWrites++;
          return route.fulfill({ status: 403 });
        }
        const url = new URL(route.request().url());
        const value = {
          ...asset,
          state: withdrawn ? 'withdrawn' : 'published',
        };
        if (
          !url.searchParams.has('history') &&
          !url.searchParams.has('preview')
        )
          directoryQueries.push(Object.fromEntries(url.searchParams));
        const result = url.searchParams.get('history')
          ? {
              asset: value,
              revisions: [asset.latest],
              publishedRevisionIds: [revisionId],
            }
          : url.searchParams.get('preview')
            ? f.state.filePreview
            : {
                assets: url.searchParams.has('after') ? [ownDraft] : [value],
                nextCursor:
                  !url.searchParams.has('recommendations') &&
                  !url.searchParams.has('after')
                    ? assetId
                    : null,
                ruleBudget: {
                  maximumBytes: 16000,
                  maximumRules: 32,
                  publishedBytes: 0,
                },
              };
        return route.fulfill({ json: result });
      });
      try {
        const input = f.page.getByRole('textbox', { name: /给 .* 的消息/ });
        const openQuickDirectory = async () => {
          await f.page
            .getByRole('button', { name: '常用任务', exact: true })
            .click();
          if (width === 640)
            await f.page
              .getByRole('dialog', { name: '常用任务', exact: true })
              .getByRole('button', { name: '参考资料', exact: true })
              .click();
          else
            await f.page
              .getByRole('menuitem', { name: '参考资料', exact: true })
              .click();
        };
        const finalDraft = recommended
          ? '请汇总这一周的工作回顾'
          : '保留原有草稿';
        await input.fill(recommended ? '请整理本周周报' : finalDraft);
        if (recommended) await openQuickDirectory();
        else {
          await f.page
            .getByRole('button', { name: '添加文件', exact: true })
            .click();
          await f.page
            .getByRole('menuitem', { name: '参考资料', exact: true })
            .click();
        }
        if (!recommended)
          await f.page
            .getByRole('dialog', { name: '参考资料', exact: true })
            .getByRole('button', { name: '历史资料与草稿', exact: true })
            .click();
        const dialog = f.page.getByRole('dialog', {
          name: !recommended ? '历史资料与草稿' : '参考资料',
          exact: true,
        });
        if (recommended) {
          await expect
            .poll(() =>
              dialog.getByText('公司置顶', { exact: true }).isVisible(),
            )
            .toBe(true);
          expect(
            await dialog
              .getByRole('button', { name: '适用范本快览', exact: true })
              .getAttribute('aria-pressed'),
          ).toBe('true');
          expect(await dialog.textContent()).toContain(
            '最多 6 项，公司置顶优先',
          );
          const titles = dialog.locator(
            '[aria-label="公司范本目录"] article > strong',
          );
          const firstOrder = await titles.allTextContents();
          expect(firstOrder).toEqual(['季度经营简报']);
          expect(f.state.messageInputs).toHaveLength(0);
          expect(
            await f.page
              .getByRole('button', { name: '移除范本 季度经营简报' })
              .count(),
          ).toBe(0);
          await dialog
            .getByRole('button', { name: '全部范本与本人草稿', exact: true })
            .click();
          await dialog
            .getByRole('button', { name: '更多公司资料', exact: true })
            .click();
          await dialog
            .getByText('本人未发布范本草稿', { exact: true })
            .waitFor();
          expect(await titles.allTextContents()).toEqual([
            '季度经营简报',
            '本人未发布范本草稿',
          ]);
          expect(directoryQueries.at(-1)).toMatchObject({
            workspaceId: workspace,
            after: assetId,
          });
          await dialog
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          await dialog
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          await expect.poll(() => dialog.count()).toBe(0);
          await input.fill(finalDraft);
          await openQuickDirectory();
          await expect.poll(() => titles.allTextContents()).toEqual(firstOrder);
          const quickQueries = directoryQueries.filter(
            (query) => query.recommendations === '1',
          );
          expect(quickQueries).toHaveLength(2);
          expect(quickQueries[1]).toEqual(quickQueries[0]);
          expect(quickQueries[0]).toMatchObject({
            workspaceId: workspace,
            employeeId: expect.any(String),
          });
          for (const query of directoryQueries) {
            expect(query).not.toHaveProperty('task');
            expect(query).not.toHaveProperty('taskText');
          }
          expect(f.state.messageInputs).toHaveLength(0);
          expect(
            await f.page
              .getByRole('button', { name: '移除范本 季度经营简报' })
              .count(),
          ).toBe(0);
          await dialog
            .getByRole('combobox', { name: '范本分类', exact: true })
            .selectOption('运营');
          await dialog
            .getByRole('textbox', { name: '查找范本', exact: true })
            .fill('不存在的标题');
          await expect
            .poll(() =>
              dialog
                .getByRole('button', { name: '填写使用', exact: true })
                .count(),
            )
            .toBe(0);
          await dialog
            .getByRole('textbox', { name: '查找范本', exact: true })
            .fill('季度经营');
          await dialog
            .getByRole('button', { name: '填写使用', exact: true })
            .click();
        } else {
          await dialog
            .getByRole('button', { name: '查看范本', exact: true })
            .click();
          await dialog
            .getByRole('heading', { name: '上传的文件', exact: true })
            .waitFor();
          expect(
            await dialog
              .getByRole('combobox', { name: '公司资料修订', exact: true })
              .inputValue(),
          ).toBe(revisionId);
          expect(
            await dialog
              .getByRole('button', { name: '编辑范本草稿', exact: true })
              .count(),
          ).toBe(0);
          await dialog
            .getByRole('button', { name: '选用此修订', exact: true })
            .click();
        }
        await dialog
          .getByRole('textbox', { name: '本期业务数据', exact: true })
          .fill('十月：收入 120，成本 45\n实际数据');
        withdrawn = true;
        await dialog
          .getByRole('button', { name: '加入消息草稿', exact: true })
          .click();
        await expect
          .poll(() =>
            dialog
              .getByRole('alert')
              .filter({ hasText: '范本已变化' })
              .isVisible(),
          )
          .toBe(true);
        expect(f.state.messageInputs).toHaveLength(0);
        withdrawn = false;
        await dialog
          .getByRole('button', { name: '加入消息草稿', exact: true })
          .click();
        await expect.poll(() => dialog.count()).toBe(0);
        expect(await input.inputValue()).toContain(finalDraft);
        await expect
          .poll(() =>
            f.page
              .getByRole('button', { name: '移除范本 季度经营简报' })
              .isVisible(),
          )
          .toBe(true);
        expect(f.state.messageInputs).toHaveLength(0);
        expect(deniedWrites).toBe(0);
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(1);
        expect(f.state.messageInputs[0]).toMatchObject({
          deliveryMode: 'follow_up',
          companyTemplates: [
            {
              assetId,
              revisionId,
              digest: asset.latest.digest,
              parameters: { period: '十月：收入 120，成本 45\n实际数据' },
            },
          ],
        });
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it('artifact previews keep file actions and use the chat composer for revision requests', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .isVisible(),
      ).toBe(true);
      expect(await f.panel.getByRole('textbox').count()).toBe(0);
      expect(await f.panel.getByText(/修改记录|让Rice修改/).count()).toBe(0);
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await input.fill('请把 report-10.md 的结论放在开头');
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      expect(await input.inputValue()).toBe('请把 report-10.md 的结论放在开头');
      await input.press('Enter');
      await expect.poll(() => f.state.messageInputs.length).toBe(1);
      expect(f.state.messageInputs[0]?.text).toBe(
        '请把 report-10.md 的结论放在开头',
      );
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390, 320])(
    'compact dialogs preserve selection, connection and folder actions at width %s',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeCount: 2,
        employeeHistory: true,
      });
      try {
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        const picker = f.page.getByRole('dialog', {
          name: '选择 AI 员工',
          exact: true,
        });
        await picker.waitFor();
        const assertFits = async (selector: typeof picker) => {
          const box = await selector.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(
            await selector.evaluate((node) =>
              [...node.querySelectorAll('*')]
                .filter(
                  (child) =>
                    child.checkVisibility() &&
                    child.scrollWidth > child.clientWidth + 1 &&
                    getComputedStyle(child).display !== 'inline',
                )
                .map((child) => ({
                  tag: child.tagName,
                  className: child.className,
                  scrollWidth: child.scrollWidth,
                  clientWidth: child.clientWidth,
                })),
            ),
          ).toEqual([]);
        };
        await assertFits(picker);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-picker-${width}.png`,
          });
        await f.page.keyboard.press('Escape');
        expect(await picker.count()).toBe(0);
        if (width < 600)
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .click();
        f.state.bridgeDevices = [
          {
            id: id(901),
            name: 'M5-Max.local · AllRice 助手',
            platform: 'macos-arm64',
            status: 'online',
            clientVersion: '0.6.0-dev.7',
            lastSeenAt: now,
            folderGrants: [],
            readiness: (
              [
                'local.fs.read',
                'local.fs.write',
                'local.git.status',
                'local.browser',
                'local.process',
                'local.development',
                'local.preview',
                'local.mcp',
                'local.office',
              ] as const
            ).map((capability) => ({
              capability,
              state:
                capability === 'local.mcp' || capability === 'local.office'
                  ? ('unsupported' as const)
                  : ('ready' as const),
              reason:
                capability === 'local.mcp'
                  ? 'local_mcp_disabled'
                  : capability === 'local.office'
                    ? 'office_not_implemented'
                    : 'ready',
              missing: [],
              versions: { bridge: '0.6.0-dev.7' },
              observedAt: now,
            })),
          },
        ];
        await f.page
          .getByRole('button', {
            name: '电脑未连接，点击查看如何连接',
            exact: true,
          })
          .click();
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        const computer = settings.locator('[data-bridge-settings]');
        await computer.getByText('未连接文件夹', { exact: true }).waitFor();
        expect(await f.page.getByRole('dialog').count()).toBe(1);
        await settings
          .getByRole('heading', { name: '连接与管理电脑', exact: true })
          .waitFor();
        const connect = computer.getByRole('button', {
          name: '连接文件夹',
          exact: true,
        });
        expect(
          await connect.evaluate((button) => getComputedStyle(button).fontSize),
        ).toBe('13px');
        expect((await connect.boundingBox())!.height).toBe(
          width < 600 ? 44 : 32,
        );
        expect(
          (await computer
            .getByRole('button', { name: '刷新状态', exact: true })
            .boundingBox())!.y,
        ).toBeLessThan(
          (await computer.locator('[data-bridge-folder]').boundingBox())!.y,
        );
        await settings
          .getByRole('button', { name: '返回我的电脑', exact: true })
          .click();
        const management = settings.getByRole('button', {
          name: '连接与管理电脑',
          exact: true,
        });
        await management.waitFor();
        expect(await management.innerText()).toContain('电脑\n已连接');
        expect(await management.innerText()).toContain('文件夹\n未连接');
        expect(
          await management
            .locator('[data-ready]')
            .evaluateAll((nodes) =>
              nodes.map((node) => getComputedStyle(node).fontSize),
            ),
        ).toEqual(['13px', '13px']);
        await management.click();
        await connect.waitFor();
        expect(
          await computer.getByText('已连接', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await computer
            .getByRole('button', { name: '生成配对码', exact: true })
            .isVisible(),
        ).toBe(false);
        const capabilities = computer.locator('[data-bridge-capabilities]');
        expect(await capabilities.getAttribute('open')).toBeNull();
        expect(
          await capabilities.locator(':scope > summary').innerText(),
        ).toContain('7 项可用 · 1 项未就绪');
        expect(
          await capabilities
            .locator('strong')
            .filter({ hasText: /^文件读取$/ })
            .isVisible(),
        ).toBe(false);
        await capabilities.locator(':scope > summary').click();
        await capabilities
          .locator('strong')
          .filter({ hasText: /^文件读取$/ })
          .waitFor();
        expect(
          await capabilities.getByText('本机应用', { exact: true }).count(),
        ).toBe(0);
        expect(await capabilities.locator('strong').count()).toBe(8);
        expect(f.state.bridgeDevices[0]!.readiness).toHaveLength(9);
        await capabilities.locator(':scope > summary').click();
        await assertFits(computer);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-empty-${width}.png`,
          });
        await computer
          .getByRole('button', { name: '连接文件夹', exact: true })
          .click();
        await expect
          .poll(() => f.state.bridgeSelections)
          .toEqual([`/api/v1/bridge/devices/${id(901)}/workspace-selection`]);
        f.state.bridgeDevices[0]!.folderGrants = [
          { id: id(902), label: 'AI-what' },
        ];
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer.getByText('AI-what', { exact: true }).waitFor();
        await settings
          .getByRole('button', { name: '返回我的电脑', exact: true })
          .click();
        expect(await management.innerText()).toContain('文件夹\n已连接');
        await management.click();
        await computer.getByText('AI-what', { exact: true }).waitFor();
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-connected-${width}.png`,
          });
        if (width === 1440 && process.env.ALLRICE_DIALOG_SCREENSHOT) {
          await f.page.evaluate(() =>
            document.body.setAttribute('data-ds-dark-theme', ''),
          );
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-connected-dark.png`,
          });
          await f.page.evaluate(() =>
            document.body.removeAttribute('data-ds-dark-theme'),
          );
        }
        f.state.bridgeError = true;
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer
          .locator('[data-bridge-connection]')
          .getByText('待确认', { exact: true })
          .waitFor();
        expect(
          await computer.getByText('AI-what', { exact: true }).count(),
        ).toBe(0);
        expect(
          await computer
            .getByRole('button', { name: '连接文件夹', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await computer
            .getByRole('button', { name: '断开连接', exact: true })
            .count(),
        ).toBe(0);
        f.state.bridgeError = false;
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer.getByText('AI-what', { exact: true }).waitFor();
        await computer
          .getByRole('button', { name: '断开连接', exact: true })
          .click();
        expect(f.state.bridgeDevices[0]!.folderGrants).toHaveLength(1);
        await computer
          .getByRole('button', { name: '取消', exact: true })
          .click();
        expect(f.state.bridgeDevices[0]!.folderGrants).toHaveLength(1);
        await computer
          .getByRole('button', { name: '断开连接', exact: true })
          .click();
        await computer
          .getByRole('button', { name: '确认断开', exact: true })
          .click();
        await computer.getByText('未连接文件夹', { exact: true }).waitFor();
        expect(f.state.bridgeDevices[0]!.folderGrants).toEqual([]);
        expect(f.state.bridgeDevices[0]!.status).toBe('online');
        await computer.getByText('下载与安装', { exact: true }).click();
        await computer
          .getByRole('link', {
            name: '下载 AllRice 助手（Apple 芯片） · v0.6.0-dev.7',
            exact: true,
          })
          .waitFor();
        expect(
          await computer.getByRole('link', { name: /Intel/ }).count(),
        ).toBe(0);
        await computer
          .getByRole('button', { name: '生成配对码', exact: true })
          .click();
        await computer.getByText('ABCD1234', { exact: true }).waitFor();
        await assertFits(computer);
        if (width === 1440) {
          await f.context.grantPermissions([
            'clipboard-read',
            'clipboard-write',
          ]);
          await computer
            .getByRole('button', { name: '复制配对码', exact: true })
            .click();
          expect(
            await f.page.evaluate(() => navigator.clipboard.readText()),
          ).toBe('ABCD1234');
        }
        f.state.bridgeDevices[0]!.status = 'offline';
        await computer
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await computer
          .locator('[data-bridge-connection]')
          .getByText('未连接', { exact: true })
          .waitFor();
        expect(
          await computer.getByText('已是最新版', { exact: true }).count(),
        ).toBe(0);
        expect(
          await computer
            .getByRole('button', { name: '连接文件夹', exact: true })
            .count(),
        ).toBe(0);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-offline-${width}.png`,
          });
        await settings
          .getByRole('button', { name: '返回我的电脑', exact: true })
          .click();
        expect(await management.innerText()).toContain('电脑\n未连接');
        expect(await management.innerText()).toContain('文件夹\n未连接');
        await f.page.keyboard.press('Escape');
        expect(await computer.count()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each<[number, number, string]>([
    [1440, 1, '财务助手'],
    [390, 1, '财务助手'],
    [1440, 2, '🤖文案专家'],
  ])(
    'creates a named colored employee with one idempotent request at width %s with %s assigned employees: %s',
    async (width, employeeCount, employeeName) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeCount,
        appearance: 'light',
      });
      const created = EmployeeInstanceSchema.parse({
        id: id(8100),
        assignmentId: id(7),
        organizationId: org,
        workspaceId: workspace,
        ownerId: user,
        kind: 'custom',
        revision: 1,
        profile: {
          name: employeeName,
          mission: '理解目标，推进工作，交付清晰、可用的结果。',
          workStyle:
            '先确认目标和资料，再分步执行；信息不足时及时说明，交付时列出待确认事项。',
          expressionStyle: 'structured',
          appearance: {
            avatarType: 'initials',
            avatarValue: Array.from(employeeName)[0]!,
            accentColor: 'coral',
          },
        },
        creationSource: { kind: 'tenant_version', employeeVersionId: id(8) },
        source: { kind: 'tenant_version', employeeVersionId: id(8) },
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      const requests: Record<string, unknown>[] = [],
        sessions: Record<string, unknown>[] = [];
      try {
        await f.page.route('**/api/v1/employee-instances', async (route) => {
          requests.push(route.request().postDataJSON());
          f.state.createdEmployeeInstances = [created]; // First write succeeds but its response is lost.
          await route.fulfill({
            status: requests.length === 1 ? 503 : 201,
            contentType: 'application/json',
            body: JSON.stringify(
              requests.length === 1
                ? { error: { message: '创建结果暂时无法读取，请重试。' } }
                : { instance: created },
            ),
          });
        });
        await f.page.route('**/api/v1/sessions', async (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          sessions.push(route.request().postDataJSON());
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
              session: { ...session(A), employeeInstanceId: created.id },
            }),
          });
        });
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        expect(
          await f.page
            .getByRole('button', { name: '定制小白', exact: true })
            .count(),
        ).toBe(0);
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        const chooser = f.page.getByRole('dialog', { name: '选择 AI 员工' });
        expect(await chooser.getByRole('button').nth(1).innerText()).toContain(
          '创建自己的 AI 员工',
        );
        await chooser
          .getByRole('button', { name: '创建自己的 AI 员工', exact: true })
          .click();
        const picker = f.page.getByRole('dialog', {
          name: '创建自己的 AI 员工',
        });
        await picker.getByRole('combobox', { name: '表达偏好' }).waitFor();
        expect(
          await picker.getByRole('combobox', { name: '表达偏好' }).count(),
        ).toBe(1);
        expect(
          await picker.getByText('基础员工', { exact: true }).count(),
        ).toBe(0);
        expect(
          await picker.getByRole('radio', { name: '科技蓝' }).isChecked(),
        ).toBe(true);
        expect(await picker.getByRole('radio').count()).toBe(10);
        const nameInput = picker.getByRole('textbox', { name: '员工名字' });
        const createLayout = await picker.evaluate((node) => {
          const header = node.querySelector('h2')!,
            name = node.querySelector('input[data-employee-name]')!,
            identity = name.closest('section')!,
            rect = node.getBoundingClientRect(),
            root = node.parentElement!.getBoundingClientRect();
          return {
            width: rect.width,
            x: rect.x,
            rootX: root.x,
            rootWidth: root.width,
            titleSize: getComputedStyle(header).fontSize,
            titleLineHeight: getComputedStyle(header).lineHeight,
            titleWeight: getComputedStyle(header).fontWeight,
            identityPadding: getComputedStyle(identity).padding,
            identityBackground: getComputedStyle(identity).backgroundColor,
          };
        });
        expect(createLayout.titleSize).toBe('15px');
        expect(createLayout.titleLineHeight).toBe('23px');
        expect(createLayout.titleWeight).toBe('500');
        expect(createLayout.identityPadding).toBe(
          width < 600 ? '12px' : '14px',
        );
        // Existing light --allrice-employee-bg; the edit-only flat variant
        // must not remove or recolor the creation form's identity section.
        expect(createLayout.identityBackground).toBe('rgb(240, 242, 245)');
        expect(createLayout.width).toBe(
          width < 600 ? createLayout.rootWidth - 24 : 640,
        );
        expect(createLayout.x - createLayout.rootX).toBe(
          (createLayout.rootWidth - createLayout.width) / 2,
        );
        for (const field of ['员工名字', '使命', '工作方式'])
          expect(
            await picker
              .getByRole('textbox', { name: field, exact: true })
              .evaluate((node) => getComputedStyle(node).fontSize),
          ).toBe(width < 600 ? '16px' : '14px');
        expect(
          await picker
            .getByRole('textbox', { name: '使命', exact: true })
            .inputValue(),
        ).toBe(created.profile.mission);
        expect(
          await picker
            .getByRole('textbox', { name: '工作方式', exact: true })
            .inputValue(),
        ).toBe(created.profile.workStyle);
        expect(await nameInput.getAttribute('placeholder')).toBe(
          '例如： 文案专家、财务专员、商务分析师',
        );
        await nameInput.fill(employeeName);
        await picker.getByRole('radio', { name: '珊瑚红' }).check();
        await picker.getByRole('button', { name: '创建', exact: true }).click();
        await picker.getByRole('alert').waitFor();
        await picker.getByRole('button', { name: '创建', exact: true }).click();
        await expect.poll(() => picker.count()).toBe(0);
        await expect
          .poll(() =>
            f.page
              .locator('main > section')
              .getAttribute('data-employee-accent'),
          )
          .toBe('coral');
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[0]).toMatchObject({
          assignmentId: id(7),
          workspaceId: workspace,
          profile: created.profile,
        });
        expect(requests[0]).not.toHaveProperty('ownerId');
        const input = f.page.getByRole('textbox', {
          name: `给 ${employeeName} 的消息`,
        });
        await input.fill('请把你的名字改为小禾。以后回答保持简洁。');
        await input.press('Enter');
        await expect.poll(() => sessions.length).toBe(1);
        expect(sessions[0]).toMatchObject({
          employeeAssignmentId: id(7),
          employeeInstanceId: created.id,
        });
        await expect.poll(() => f.state.messageInputs.length).toBe(1);
        expect(f.state.createdEmployeeInstances).toHaveLength(1);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it.each([1440, 390])(
    'employee details use the approved root shell and keep close visible after long persona scrolling at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeCount: 2,
        employeeHistory: true,
        employeeDetails: true,
      });
      let release = () => {};
      try {
        f.state.employeeDetails.profile.identity.mission =
          '完整展示使命和事实依据。'.repeat(50).slice(0, 500);
        f.state.employeeDetails.profile.identity.workStyle =
          '完整展示工作方式及需要确认的事项。'.repeat(80).slice(0, 1000);
        f.state.employeeDetailDelay = new Promise((done) => {
          release = done;
        });
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await f.page
          .getByRole('button', { name: '查看Rice详情', exact: true })
          .click();
        const loading = f.page.getByRole('dialog', {
          name: 'AI 员工详情',
          exact: true,
        });
        await loading
          .getByRole('status', { name: '正在加载员工详情', exact: true })
          .waitFor();
        await loading.evaluate((node) => {
          const sheet = document.createElement('style');
          sheet.textContent =
            '.' +
            CSS.escape(node.classList.item(0)!) +
            ' {width:min(560px,100%);max-height:min(680px,calc(100dvh - 48px));}';
          document.head.append(sheet);
        });
        expect((await loading.boundingBox())!.width).toBe(
          width === 1440 ? 848 : width,
        );
        release();
        const details = f.page.getByRole('dialog', {
          name: 'Rice员工详情',
          exact: true,
        });
        await details
          .getByText(f.state.employeeDetails.profile.identity.workStyle, {
            exact: true,
          })
          .waitFor();
        const rect = (await details.boundingBox())!;
        expect(rect.width).toBe(width === 1440 ? 848 : width);
        expect(rect.height).toBeLessThanOrEqual(
          f.page.viewportSize()!.height - (width < 700 ? 0 : 48),
        );
        const heading = await details
          .getByRole('heading', { name: 'AI 员工详情', exact: true })
          .evaluate((node) => {
            const s = getComputedStyle(node);
            return {
              font: s.fontFamily,
              size: s.fontSize,
              line: s.lineHeight,
              color: s.color,
            };
          });
        expect(heading.size).toBe('20px');
        expect(heading.line).toBe('28px');
        const close = details.getByRole('button', {
          name: '关闭',
          exact: true,
        });
        const initial = await close.boundingBox();
        const body = details.locator(':scope > div').first();
        expect(
          await body.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            return node.scrollTop;
          }),
        ).toBeGreaterThan(100);
        expect(await close.boundingBox()).toEqual(initial);
        expect(await close.isVisible()).toBe(true);
        expect(
          await details.evaluate(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
        ).toBe(true);
        await expectRetiredTabs(details);
        await close.click();
        expect(await details.count()).toBe(0);
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        const original = await settings
          .locator('nav > div:first-child')
          .evaluate((node) => {
            const s = getComputedStyle(node);
            return {
              font: s.fontFamily,
              size: s.fontSize,
              line: s.lineHeight,
              color: s.color,
            };
          });
        expect(original.font).toBe(heading.font);
        expect(original.color).toBe(heading.color);
        expect(original.size).toBe('17px');
        expect(original.line).toBe('24px');
        expect(f.writes).toEqual([]);
        expect(f.state.messageInputs).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        release();
        await f.close();
      }
    },
    30000,
  );

  it('uses the published employee color across sidebar, picker, conversation and profile', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeDetails: true,
      employeeColor: 'violet',
    });
    try {
      const conversation = f.page.locator('[data-employee-accent="violet"]');
      await conversation.waitFor();
      expect(
        await conversation.evaluate((node) =>
          getComputedStyle(node).getPropertyValue('--employee-end').trim(),
        ),
      ).toBe('#8B5CF6');
      expect(await f.page.locator('[data-accent="violet"]').count()).toBe(1);
      expect(
        await f.page
          .locator('[data-accent="violet"]')
          .getByText('R', { exact: true })
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe('rgb(139, 92, 246)');
      await f.page
        .getByRole('button', { name: '查看Rice详情', exact: true })
        .click();
      const details = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await details.locator('[data-employee-accent="violet"]').waitFor();
      expect(
        await details.locator('[data-employee-accent="violet"]').count(),
      ).toBe(1);
      await details
        .getByRole('button', { name: /^关闭(?:员工详情)?$/, exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      const picker = f.page.getByRole('dialog', {
        name: '选择 AI 员工',
        exact: true,
      });
      const rice = picker.getByRole('button', { name: /Rice/ });
      expect(await rice.getAttribute('data-accent')).toBe('violet');
      expect(
        await rice
          .getByText('R', { exact: true })
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe('rgb(139, 92, 246)');
      await rice.click();
      await f.page
        .getByRole('button', { name: '收起侧边栏', exact: true })
        .click();
      expect(
        await f.page
          .getByRole('button', { name: 'Rice', exact: true })
          .getAttribute('data-accent'),
      ).toBe('violet');
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390])(
    'expanded employee sessions scroll in both directions without moving sidebar controls at width %s',
    async (width) => {
      const f = await fixture({
        width,
        touch: width === 390,
        employeeCount: 2,
        employeeHistory: true,
        employeeHistoryCount: 30,
      });
      try {
        await f.page.setViewportSize({ width, height: 620 });
        if (width === 390)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const sidebar = f.page.locator('#chat-sidebar');
        const tree = sidebar.getByRole('tree', {
          name: '员工与工作',
          exact: true,
        });
        const rice = tree.locator('[data-row-key="workspace:' + id(7) + '"]');
        if ((await rice.getAttribute('aria-expanded')) !== 'true')
          await rice.click();
        await sidebar
          .getByRole('region', { name: 'Rice', exact: true })
          .getByRole('button', { name: /展开其余/ })
          .click();
        const office = sidebar.locator(
          '[data-row-key="workspace:' + id(17) + '"]',
        );
        if ((await office.getAttribute('aria-expanded')) !== 'true')
          await office.click();
        await sidebar.getByText('研究任务 B', { exact: true }).waitFor();
        const historical = sidebar.locator(
          '[data-row-key="workspace:' + id(99) + '"]',
        );
        if ((await historical.getAttribute('aria-expanded')) !== 'true')
          await historical.click();
        await sidebar.getByText('已撤回员工的工作', { exact: true }).waitFor();
        const top = sidebar.getByRole('button', {
          name: '新的工作',
          exact: true,
        });
        const settings = sidebar.getByRole('button', {
          name: '设置',
          exact: true,
        });
        const before = {
          top: await top.boundingBox(),
          settings: await settings.boundingBox(),
        };
        // Wait for the mobile drawer to finish entering before choosing touch coordinates.
        await expect
          .poll(() => sidebar.evaluate((n) => n.getBoundingClientRect().left))
          .toBe(0);
        const box = (await tree.boundingBox())!;
        await tree.evaluate((n) => {
          n.scrollTop = 0;
        });
        const initialScroll = await tree.evaluate((n) => n.scrollTop);
        const touchDistance = Math.min(250, box.height * 0.4);
        const x = box.x + box.width / 2,
          y = box.y + box.height * 0.65;
        const cdp =
          width === 390 ? await f.page.context().newCDPSession(f.page) : null;
        const scroll = async (down: boolean) => {
          if (cdp) {
            // Stay inside the tree even when filters shorten a mobile drawer.
            const startY = down ? y : y - touchDistance;
            // Chrome does not turn synthetic touch moves into exactly equal
            // scrolls: the slop is dropped and now and then one move is not
            // scrolled. The way back swipes half again as far, so the list
            // has to reach its top whichever moves were lost.
            const steps = down ? 10 : 15;
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ x, y: startY }],
            });
            for (let step = 1; step <= steps; step++) {
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                  {
                    x,
                    y: startY + ((down ? -1 : 1) * step * touchDistance) / 10,
                  },
                ],
              });
              await f.page.evaluate(() => new Promise(requestAnimationFrame));
            }
            // Pause the finger before lifting so the assertion does not race a fling.
            await f.page.waitForTimeout(150);
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: [],
            });
          } else {
            await f.page.mouse.move(x, y);
            await f.page.mouse.wheel(0, down ? 350 : -350);
          }
        };
        await scroll(true);
        await expect
          .poll(() => tree.evaluate((n) => n.scrollTop))
          .toBeGreaterThan(initialScroll + touchDistance * 0.5);
        await scroll(false);
        await expect
          .poll(() => tree.evaluate((n) => n.scrollTop))
          .toBeLessThan(initialScroll + 5);
        await sidebar
          .getByText('历史工作 30', { exact: true })
          .scrollIntoViewIfNeeded();
        const last = (await sidebar
          .getByText('历史工作 30', { exact: true })
          .boundingBox())!;
        expect(last.y).toBeGreaterThanOrEqual(box.y);
        expect(last.y + last.height).toBeLessThanOrEqual(
          box.y + box.height + 1,
        );
        expect(await top.boundingBox()).toEqual(before.top);
        expect(await settings.boundingBox()).toEqual(before.settings);
        await sidebar
          .getByRole('button', { name: '收起更多会话', exact: true })
          .click();
        expect(
          await sidebar.getByText('历史工作 30', { exact: true }).count(),
        ).toBe(0);
        await cdp?.detach();
      } finally {
        await f.close();
      }
    },
  );

  it('employee card hover preserves initials and position while highlighting the card', async () => {
    const f = await fixture({ employeeCount: 2, employeeHistory: true });
    try {
      const selected = f.page.locator(
        '[data-row-key^="session:"][aria-selected="true"]',
      );
      const other = f.page
        .locator('[data-row-key^="session:"][aria-selected="false"]')
        .first();
      await selected.waitFor();
      await other.hover();
      await expect
        .poll(() =>
          other.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe('rgb(233, 236, 241)');
      expect(
        await selected.evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        ),
      ).toBe('rgb(225, 230, 237)');
      await selected.hover();
      await expect
        .poll(() =>
          selected.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe('rgb(216, 223, 232)');
      await f.page.mouse.move(1000, 900);
      if (process.env.ALLRICE_EMPLOYEE_SCREENSHOT) {
        await f.page.locator('#chat-sidebar').screenshot({
          path: `${process.env.ALLRICE_EMPLOYEE_SCREENSHOT}.png`,
        });
        await f.page.evaluate(() =>
          document.body.setAttribute('data-ds-dark-theme', ''),
        );
        await f.page.locator('#chat-sidebar').screenshot({
          path: `${process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-dark.png`,
        });
        await f.page.evaluate(() =>
          document.body.removeAttribute('data-ds-dark-theme'),
        );
      }
      for (const [employeeId, initial] of [
        [id(7), 'R'],
        [id(17), 'O'],
      ] as const) {
        const row = f.page.locator(`[data-row-key="workspace:${employeeId}"]`);
        const letter = row.getByText(initial, { exact: true });
        const card = row.locator('..').locator('..');
        await f.page.mouse.move(1000, 900);
        await expect.poll(() => letter.isVisible()).toBe(true);
        const before = await letter.boundingBox();
        await expect
          .poll(() => card.evaluate((e) => getComputedStyle(e).backgroundColor))
          .toBe('rgb(240, 242, 245)');
        await row.hover();
        expect(await letter.isVisible()).toBe(true);
        expect(await letter.boundingBox()).toEqual(before);
        await expect
          .poll(() => card.evaluate((e) => getComputedStyle(e).backgroundColor))
          .toBe('rgb(233, 236, 241)');
        expect(await card.evaluate((e) => getComputedStyle(e).boxShadow)).toBe(
          'none',
        );
        const expanded = await row.getAttribute('aria-expanded');
        await row.click();
        await expect
          .poll(() => row.getAttribute('aria-expanded'))
          .toBe(expanded === 'true' ? 'false' : 'true');
        expect(await letter.isVisible()).toBe(true);
      }
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390])(
    'custom scene source replaces retired AI adjustment entries without consuming drafts or writing at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeCount: 2,
        employeeHistory: true,
        employeeDetails: true,
      });
      try {
        f.state.employeeDetails.profile.kind = 'custom';
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
          exact: true,
        });
        await composer.fill('保留这份已有草稿，不要自动发送。');
        let dialog = await openOwnerDetails(f);
        await expectRetiredTabs(dialog);
        await dialog
          .getByRole('button', { name: '添加场景', exact: true })
          .click();
        const form = f.page.getByRole('dialog', {
          name: '添加场景',
          exact: true,
        });
        await form
          .getByRole('heading', { name: '文件要求', exact: true })
          .waitFor();
        expect(
          await form
            .getByRole('textbox', { name: '仓库链接', exact: true })
            .inputValue(),
        ).toBe('');
        await form.getByRole('button', { name: '取消', exact: true }).click();
        await dialog.waitFor();
        expect(await composer.inputValue()).toBe(
          '保留这份已有草稿，不要自动发送。',
        );
        expect(f.state.messageInputs).toEqual([]);
        expect(f.writes).toEqual([]);
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        f.state.employeeDetails.profile.canMaintainPersonal = false;
        dialog = await openOwnerDetails(f);
        for (const name of ['编辑员工', '添加场景'])
          expect(
            await dialog.getByRole('button', { name, exact: true }).count(),
          ).toBe(0);
        await expectRetiredTabs(dialog);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it.each([1440, 390])(
    'custom employee editing preserves unsaved values on failure and reloads saved identity and persona at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeCount: 2,
        employeeHistory: true,
        employeeDetails: true,
      });
      let instance = EmployeeInstanceSchema.parse({
        id: id(7),
        assignmentId: id(7),
        organizationId: org,
        workspaceId: workspace,
        ownerId: user,
        kind: 'custom',
        revision: 2,
        profile: {
          name: 'Rice',
          description: '保留未由表单修改的个人简介',
          role: '保留未由表单修改的个人角色',
          mission: '帮助完成研究',
          workStyle: '按步骤交付',
          expressionStyle: 'concise',
          appearance: {
            avatarType: 'initials',
            avatarValue: 'R',
            accentColor: 'violet',
          },
        },
        creationSource: structuredClone(f.state.employeeDetails.profile.source),
        source: structuredClone(f.state.employeeDetails.profile.source),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      const writes: Array<Record<string, unknown>> = [];
      let failSave = true;
      const openDetails = async (name: string) => {
        const entry = f.page.getByRole('button', {
          name: `查看${name}详情`,
          exact: true,
        });
        if (!(await entry.isVisible()))
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await entry.click();
        const details = f.page.getByRole('dialog', {
          name: `${name}员工详情`,
          exact: true,
        });
        await details
          .getByRole('button', { name: '编辑员工', exact: true })
          .waitFor();
        return details;
      };
      try {
        f.state.createdEmployeeInstances = [instance];
        f.state.employeeDetails.profile.kind = 'custom';
        f.state.employeeDetails.profile.editableFields =
          EmployeeInstanceProfileSchema.keyof().options;
        await f.page.route(
          `**/api/v1/employee-instances/${id(7)}*`,
          async (route) => {
            if (
              new URL(route.request().url()).pathname !==
              `/api/v1/employee-instances/${id(7)}`
            )
              return route.fallback();
            if (route.request().method() === 'GET')
              return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ instance }),
              });
            expect(route.request().method()).toBe('PATCH');
            const body = route.request().postDataJSON();
            writes.push(body);
            if (failSave)
              return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: { message: '保存暂时失败。' } }),
              });
            instance = EmployeeInstanceSchema.parse({
              ...instance,
              revision: instance.revision + 1,
              profile: body.profile,
            });
            f.state.createdEmployeeInstances = [instance];
            const profile = f.state.employeeDetails.profile;
            profile.name = instance.profile.name!;
            profile.revision = instance.revision;
            const appearance = instance.profile.appearance;
            if (
              appearance === undefined ||
              appearance.avatarType === undefined ||
              appearance.avatarValue === undefined
            ) {
              throw Error(
                'This editing fixture requires a complete saved appearance',
              );
            }
            profile.appearance = {
              avatarType: appearance.avatarType,
              avatarValue: appearance.avatarValue,
              ...(appearance.accentColor === undefined
                ? {}
                : { accentColor: appearance.accentColor }),
            };
            profile.identity.mission = instance.profile.mission!;
            profile.identity.workStyle = instance.profile.workStyle!;
            profile.expressionStyle = instance.profile.expressionStyle;
            return route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify({ instance }),
            });
          },
        );
        await f.page.reload();
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
        let details = await openDetails('Rice');
        if (process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-details-${width}.png`,
            fullPage: true,
          });
        await details
          .getByRole('button', { name: '编辑员工', exact: true })
          .click();
        const editor = f.page.getByRole('dialog', {
          name: '编辑人设',
          exact: true,
        });
        const field = (name: string) =>
          editor.getByRole('textbox', { name, exact: true });
        await expect.poll(() => field('名字').inputValue()).toBe('Rice');
        expect(await field('使命').inputValue()).toBe('帮助完成研究');
        expect(await field('工作方式').inputValue()).toBe('按步骤交付');
        expect(
          await editor.getByRole('radio', { name: '鸢尾紫' }).isChecked(),
        ).toBe(true);
        expect(await editor.getByRole('radio').count()).toBe(10);
        await field('名字').fill('财务伙伴');
        await field('使命').fill('核对企业报表，交付可追溯结果。');
        await field('工作方式').fill('先核对凭据，再按月汇总。');
        await editor
          .getByRole('combobox', { name: '表达偏好' })
          .selectOption('structured');
        await editor.getByRole('radio', { name: '活力橙' }).check();
        if (process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-edit-${width}.png`,
            fullPage: true,
          });
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await editor.getByRole('alert').waitFor();
        expect(await field('名字').inputValue()).toBe('财务伙伴');
        expect(await field('使命').inputValue()).toBe(
          '核对企业报表，交付可追溯结果。',
        );
        expect(instance.revision).toBe(2);
        expect(writes).toHaveLength(1);
        failSave = false;
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await expect.poll(() => editor.count()).toBe(0);
        expect(writes).toHaveLength(2);
        for (const write of writes) {
          expect(write).toMatchObject({
            workspaceId: workspace,
            expectedRevision: 2,
            profile: {
              name: '财务伙伴',
              description: '保留未由表单修改的个人简介',
              role: '保留未由表单修改的个人角色',
              mission: '核对企业报表，交付可追溯结果。',
              workStyle: '先核对凭据，再按月汇总。',
              expressionStyle: 'structured',
              appearance: {
                avatarType: 'initials',
                avatarValue: '财',
                accentColor: 'orange',
              },
            },
          });
          expect(write).not.toHaveProperty('ownerId');
        }
        await expect
          .poll(() =>
            f.page
              .locator('main > section')
              .getAttribute('data-employee-accent'),
          )
          .toBe('orange');
        details = f.page.getByRole('dialog', {
          name: '财务伙伴员工详情',
          exact: true,
        });
        await details
          .getByText('核对企业报表，交付可追溯结果。', { exact: true })
          .waitFor();
        await details
          .getByText('先核对凭据，再按月汇总。', { exact: true })
          .waitFor();
        await details
          .getByRole('button', { name: /^关闭(?:员工详情)?$/, exact: true })
          .click();
        details = await openDetails('财务伙伴');
        await details
          .getByRole('button', { name: '编辑员工', exact: true })
          .click();
        await expect.poll(() => field('名字').inputValue()).toBe('财务伙伴');
        expect(await field('使命').inputValue()).toBe(
          '核对企业报表，交付可追溯结果。',
        );
        expect(await field('工作方式').inputValue()).toBe(
          '先核对凭据，再按月汇总。',
        );
        expect(
          await editor.getByRole('radio', { name: '活力橙' }).isChecked(),
        ).toBe(true);
        await field('名字').fill('取消的临时名字');
        await editor.getByRole('button', { name: '取消', exact: true }).click();
        await details
          .getByRole('button', { name: '编辑员工', exact: true })
          .waitFor();
        expect(writes).toHaveLength(2);
        expect(instance.profile.name).toBe('财务伙伴');
        expect(
          await details.getByText('取消的临时名字', { exact: true }).count(),
        ).toBe(0);
        expect(f.state.messageInputs).toEqual([]);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    45_000,
  );

  it.each([403, 404])(
    'custom employee raw editor denial %s clears private details after cancel or Escape',
    async (status) => {
      const f = await fixture({
        employeeCount: 2,
        employeeHistory: true,
        employeeDetails: true,
      });
      let rawReads = 0;
      let denyRaw = false;
      try {
        f.state.employeeDetails.profile.kind = 'custom';
        f.state.employeeDetails.profile.editableFields =
          EmployeeInstanceProfileSchema.keyof().options;
        await f.page.route(
          `**/api/v1/employee-instances/${id(7)}*`,
          async (route) => {
            if (
              new URL(route.request().url()).pathname !==
              `/api/v1/employee-instances/${id(7)}`
            )
              return route.fallback();
            expect(route.request().method()).toBe('GET');
            if (!denyRaw) return route.fallback();
            rawReads++;
            return route.fulfill({
              status,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: 'No access' } }),
            });
          },
        );
        await f.page
          .getByRole('button', { name: '查看Rice详情', exact: true })
          .click();
        const details = f.page.getByRole('dialog', {
          name: 'Rice员工详情',
          exact: true,
        });
        await details.getByText('帮助完成研究', { exact: true }).waitFor();
        denyRaw = true;
        await details
          .getByRole('button', { name: '编辑员工', exact: true })
          .click();
        const editor = f.page.getByRole('dialog', {
          name: '编辑人设',
          exact: true,
        });
        await editor.getByRole('alert').waitFor();
        expect(await editor.getByRole('textbox').count()).toBe(0);
        if (status === 403) await f.page.keyboard.press('Escape');
        else
          await editor
            .getByRole('button', { name: '返回员工详情', exact: true })
            .click();
        const denied = f.page.getByRole('dialog', {
          name: 'AI 员工详情',
          exact: true,
        });
        await denied.getByRole('alert').waitFor();
        for (const text of ['个人输出偏好正文', '帮助完成研究', '按步骤交付'])
          expect(await denied.getByText(text, { exact: true }).count()).toBe(0);
        for (const name of ['编辑员工', 'AI新增工作场景', /^AI调整/])
          expect(await denied.getByRole('button', { name }).count()).toBe(0);
        expect(rawReads).toBe(1);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    20_000,
  );

  it('reopening employee details reads the current persisted preference and hides models', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeDetails: true,
    });
    try {
      const open = f.page.getByRole('button', {
        name: '查看Rice详情',
        exact: true,
      });
      await open.click();
      const dialog = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await dialog.getByText('简洁，结论优先', { exact: true }).waitFor();
      await dialog
        .getByRole('button', { name: /^关闭(?:员工详情)?$/, exact: true })
        .click();
      f.state.employeeDetails.profile.expressionStyle = 'exploratory';
      f.state.employeeDetails.profile.revision++;
      await open.click();
      await dialog.getByText('比较方案与取舍', { exact: true }).waitFor();
      expect(
        await dialog.getByText('简洁，结论优先', { exact: true }).count(),
      ).toBe(0);
      expect(
        await dialog.getByText('configured-model', { exact: true }).count(),
      ).toBe(0);
      expect(f.state.employeeDetailReads).toBe(2);
      expect(f.writes).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390])(
    'MET182 owner detail uses the scoped scene catalog and does not expose retired source or reference controls at %ipx',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeHistory: true,
        employeeDetails: true,
      });
      let referenceReads = 0;
      try {
        await f.page.route('**/api/v1/references/revisions/**', (route) => {
          referenceReads++;
          return route.fulfill({
            status: 403,
            json: { error: { message: 'Denied' } },
          });
        });
        const dialog = await openOwnerDetails(f);
        await expectRetiredTabs(dialog);
        await dialog
          .getByRole('heading', { name: '还没有场景', exact: true })
          .waitFor();
        expect(await dialog.getByRole('combobox').count()).toBe(0);
        expect(
          await dialog
            .getByRole('button', { name: '核对样例.md', exact: true })
            .count(),
        ).toBe(0);
        for (const text of [
          '未启用草稿不能显示',
          '撤权后不应看到的标题',
          'configured-model',
          '公司核对标准正文',
          '每周核对正文',
          '月度审计正文',
        ])
          expect(await dialog.getByText(text, { exact: false }).count()).toBe(
            0,
          );
        expect(
          await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        expect(f.state.sceneCatalogReads).toEqual([
          { instanceId: id(7), viewerId: user },
        ]);
        expect(referenceReads).toBe(0);
        expect(f.state.experienceReads).toBe(0);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it.each([1440, 390])(
    'MET184 retired owner experience entry never requests private provenance at %s',
    async (width) => {
      const f = await fixture({
        width,
        touch: width < 600,
        employeeHistory: true,
        employeeDetails: true,
      });
      let provenanceReads = 0;
      try {
        await f.page.route('**/api/v1/experiences/*/provenance?**', (route) => {
          provenanceReads++;
          return route.fulfill({
            status: 403,
            json: { error: { message: 'Denied' } },
          });
        });
        const dialog = await openOwnerDetails(f);
        await expectRetiredTabs(dialog);
        expect(
          await dialog
            .getByRole('button', {
              name: /查看来源与版本|查看准确记录|收起来源与版本/,
            })
            .count(),
        ).toBe(0);
        expect(
          await dialog
            .getByText('PRIVATE_EXACT_FEEDBACK', { exact: true })
            .count(),
        ).toBe(0);
        expect(provenanceReads).toBe(0);
        expect(f.state.experienceReads).toBe(0);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it('MET183 retired owner experience views cannot revive private feedback after reopen or revoke', async () => {
    const f = await fixture({ employeeHistory: true, employeeDetails: true });
    try {
      let dialog = await openOwnerDetails(f);
      await expectRetiredTabs(dialog);
      expect(f.state.experienceReads).toBe(0);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      f.state.employeeDetails.profile.expressionStyle = 'exploratory';
      dialog = await openOwnerDetails(f);
      await dialog.getByText('比较方案与取舍', { exact: true }).waitFor();
      expect(
        await dialog
          .getByText('PRIVATE_OLD_EXPERIENCE', { exact: true })
          .count(),
      ).toBe(0);
      await expectRetiredTabs(dialog);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      f.state.employeeDetailStatus = 403;
      await f.page
        .getByRole('button', { name: '查看Rice详情', exact: true })
        .click();
      const denied = f.page.getByRole('dialog', {
        name: 'AI 员工详情',
        exact: true,
      });
      await denied.getByRole('alert').waitFor();
      for (const text of [
        'PRIVATE_CURRENT',
        'PRIVATE_OLD_EXPERIENCE',
        '比较方案与取舍',
      ])
        expect(await denied.getByText(text, { exact: true }).count()).toBe(0);
      expect(
        await denied.getByRole('region', { name: '经验整理概况' }).count(),
      ).toBe(0);
      expect(f.state.experienceReads).toBe(0);
      expect(f.writes).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 30000);

  it('MET182 retired owner reference entry exposes no private page, name or download before or after revocation', async () => {
    const f = await fixture({ employeeHistory: true, employeeDetails: true });
    let reads = 0;
    try {
      await f.page.route('**/api/v1/references/revisions/**', (route) => {
        reads++;
        return route.fulfill({
          status: 403,
          json: { error: { message: 'Denied' } },
        });
      });
      const dialog = await openOwnerDetails(f);
      await expectRetiredTabs(dialog);
      expect(
        await dialog.getByText('PRIVATE_FIRST_PAGE', { exact: true }).count(),
      ).toBe(0);
      expect(
        await dialog
          .getByRole('button', { name: '核对样例.md', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await dialog.getByRole('link', { name: '下载', exact: true }).count(),
      ).toBe(0);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      f.state.employeeDetailStatus = 403;
      await f.page
        .getByRole('button', { name: '查看Rice详情', exact: true })
        .click();
      await f.page
        .getByRole('dialog', { name: 'AI 员工详情', exact: true })
        .getByRole('alert')
        .waitFor();
      expect(reads).toBe(0);
      expect(f.writes).toEqual([]);
    } finally {
      await f.close();
    }
  }, 15000);

  it('MET182 late detail responses cannot replace a reopened read and revoked access clears old content', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeDetails: true,
    });
    let release!: () => void;
    try {
      f.state.employeeDetailDelay = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = f.page.getByRole('button', {
        name: '查看Rice详情',
        exact: true,
      });
      await open.click();
      await expect.poll(() => f.state.employeeDetailReads).toBe(1);
      await f.page
        .getByRole('dialog')
        .getByRole('button', { name: /^关闭(?:员工详情)?$/, exact: true })
        .click();
      f.state.employeeDetailDelay = null;
      f.state.employeeDetails.profile.expressionStyle = 'exploratory';
      await open.click();
      const dialog = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await dialog.getByText('比较方案与取舍', { exact: true }).waitFor();
      release();
      await expect.poll(() => f.state.employeeDetailReads).toBe(2);
      expect(
        await dialog.getByText('简洁，结论优先', { exact: true }).count(),
      ).toBe(0);
      await dialog
        .getByRole('button', { name: /^关闭(?:员工详情)?$/, exact: true })
        .click();
      f.state.employeeDetailStatus = 403;
      await open.click();
      const denied = f.page.getByRole('dialog', {
        name: 'AI 员工详情',
        exact: true,
      });
      await denied.getByRole('alert').waitFor();
      expect(
        await denied.getByText('公司核对标准正文', { exact: true }).count(),
      ).toBe(0);
      expect(
        await denied.getByText('比较方案与取舍', { exact: true }).count(),
      ).toBe(0);
    } finally {
      release?.();
      await f.close();
    }
  });

  it('MET160 employee hierarchy keeps historical ownership, supports direct/new picker and employee rail', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeDetails: true,
    });
    try {
      const rice = f.page.locator('[data-row-key="workspace:' + id(7) + '"]');
      await f.page
        .getByRole('button', { name: '查看Rice详情', exact: true })
        .click();
      const intro = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await intro.getByText('帮助完成研究', { exact: true }).waitFor();
      await intro
        .getByRole('heading', { name: '工作场景 Workflow', exact: true })
        .waitFor();
      expect(await intro.getByText('Office', { exact: true }).count()).toBe(0);
      await intro
        .getByRole('button', { name: /^关闭(?:员工详情)?$/, exact: true })
        .click();

      if ((await rice.getAttribute('aria-expanded')) !== 'true')
        await rice.click();
      await f.page.getByRole('button', { name: /展开其余/ }).click();
      expect(
        await f.page.getByText('历史工作 7', { exact: true }).isVisible(),
      ).toBe(true);
      expect(
        await f.page.getByRole('region', { name: '旧员工（已撤回）' }).count(),
      ).toBe(1);
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      const picker = f.page.getByRole('dialog', { name: '选择 AI 员工' });
      await picker.waitFor();
      await expect
        .poll(() =>
          picker
            .locator('[data-create-employee]')
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-picker.png`,
        });
      await f.page.keyboard.press('1');
      await f.page.keyboard.press('2');
      expect(await picker.isVisible()).toBe(true);
      expect(await picker.getByText('快选', { exact: false }).count()).toBe(0);
      await picker.getByRole('button', { name: /Office 文档助手/ }).click();
      expect(await picker.count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '与 Office 文档助手 工作', exact: true })
          .count(),
      ).toBe(0);
      expect(await f.page.locator('header h1').innerText()).toBe('新的工作');
      const officeInput = f.page.getByRole('textbox', {
        name: '给 Office 文档助手 的消息',
      });
      await officeInput.waitFor();
      expect(await officeInput.getAttribute('placeholder')).toBe(
        '告诉 Office 文档助手 你想完成什么工作',
      );
      expect(
        await f.page
          .getByRole('heading', {
            name: '与 Office 文档助手 工作',
            exact: true,
          })
          .count(),
      ).toBe(1);
      expect(
        await f.page
          .getByText('阅读文档并制作报告、表格与演示文稿。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await f.page
          .locator('[data-employee-accent]')
          .getAttribute('data-employee-accent'),
      ).toBe('orange');
      expect(
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).count(),
      ).toBe(0);
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-office-welcome.png`,
        });
      await rice.hover();
      expect(
        await f.page
          .getByRole('button', { name: '与 Rice 新建工作', exact: true })
          .count(),
      ).toBe(0);
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      await picker.getByRole('button', { name: /Rice/ }).click();
      expect(await picker.count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '与 Rice 工作', exact: true })
          .count(),
      ).toBe(0);
      await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
      expect(
        await f.page
          .locator('[data-employee-accent]')
          .getAttribute('data-employee-accent'),
      ).toBe('blue');
      await f.page
        .getByRole('button', { name: '收起侧边栏', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: 'Office 文档助手', exact: true })
        .click();
      expect(
        await f.page
          .getByRole('group', { name: 'Office 文档助手的工作' })
          .isVisible(),
      ).toBe(true);
      expect(
        await f.page
          .getByRole('button', { name: '＋ 新建工作', exact: true })
          .count(),
      ).toBe(0);
      if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
        await f.page.screenshot({
          path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-rail.png`,
        });
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  }, 20_000);
  it('MET160 zero and single employee new-work entry never uses an invalid assignment', async () => {
    for (const employeeCount of [0, 1]) {
      const f = await fixture({ employeeCount, noSession: true });
      try {
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        if (employeeCount)
          await f.page.getByRole('dialog', { name: '选择 AI 员工' }).waitFor();
        expect(
          await f.page.getByRole('dialog', { name: '选择 AI 员工' }).count(),
        ).toBe(employeeCount ? 1 : 0);
        if (!employeeCount)
          expect(
            await f.page
              .getByText('当前没有可用员工，请先派驻员工。', { exact: true })
              .isVisible(),
          ).toBe(true);
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
        expect(
          await f.page
            .getByRole('textbox', {
              name: employeeCount ? '给 Rice 的消息' : '给 AI 员工 的消息',
            })
            .count(),
        ).toBe(1);
      } finally {
        await f.close();
      }
    }
  }, 20_000);

  it.each([390, 1440])(
    'running composer offers queue-send for a draft and stop for empty input at width %i',
    async (width) => {
      const f = await fixture({ running: true, queue: true, width });
      try {
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        const stop = f.page.getByRole('button', {
          name: '停止生成',
          exact: true,
        });
        const send = f.page.getByRole('button', {
          name: '排队发送',
          exact: true,
        });
        await expect.poll(() => f.state.streamRequests).toBe(1);
        expect(await stop.isVisible()).toBe(true);

        await input.fill('新的任务');
        await send.waitFor({ timeout: 5000 });
        expect(await stop.count()).toBe(0);
        expect(await send.getAttribute('title')).toBe('当前任务结束后发送');
        if (process.env.ALLRICE_QUEUE_SEND_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_QUEUE_SEND_SCREENSHOT}-${width}-draft.png`,
          });
        await send.click();
        await expect.poll(() => f.state.messageInputs.length).toBe(1);
        expect(f.state.messageInputs[0]).toMatchObject({
          text: '新的任务',
          deliveryMode: 'follow_up',
        });
        await expect.poll(() => input.isEnabled()).toBe(true);
        await f.page
          .locator('[data-queue-dock]')
          .getByText('新的任务')
          .waitFor();
        expect(await stop.isVisible()).toBe(true);

        await input.fill('   ');
        expect(await stop.isVisible()).toBe(true);
        expect(await send.count()).toBe(0);
        await input.fill('再补充一项');
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(2);
        expect(f.state.queue.map((m) => m.text)).toEqual([
          '新的任务',
          '再补充一项',
        ]);
        expect(f.state.streamRequests).toBe(1);
        expect(
          f.writes.filter((request) => request.includes('/cancel')),
        ).toEqual([]);
        if (process.env.ALLRICE_QUEUE_SEND_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_QUEUE_SEND_SCREENSHOT}-${width}-queued.png`,
          });
        const cancellations: unknown[] = [];
        await f.page.route(
          (url) => url.pathname === `/api/v1/runs/${run}/cancel`,
          async (route) => {
            expect(route.request().method()).toBe('POST');
            cancellations.push(route.request().postDataJSON());
            await route.fulfill({ json: { ok: true }, status: 202 });
          },
        );
        await stop.click();
        await expect.poll(() => cancellations.length).toBe(1);
        expect(cancellations).toEqual([{ reason: 'user_requested' }]);
        expect(
          await f.page.getByRole('button', { name: '正在停止' }).isDisabled(),
        ).toBe(true);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it.each([390, 1440])(
    'QueueDock persists two sends outside transcript, edits with attachments and revokes on the server at width %i',
    async (width) => {
      const f = await fixture({ running: true, queue: true, width });
      try {
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        await expect.poll(() => f.state.streamRequests).toBe(1);
        expect(
          await f.page
            .getByRole('combobox', { name: '运行中输入意图' })
            .count(),
        ).toBe(0);
        for (const text of ['queued one', 'queued two']) {
          await input.fill(text);
          await input.press('Enter');
          await expect.poll(() => input.isEnabled()).toBe(true);
        }
        await f.page.getByRole('button', { name: /排队消息 · 2/ }).click();
        const dock = f.page.locator('[data-queue-dock]');
        expect(await dock.locator('li').count()).toBe(2);
        if (process.env.ALLRICE_QUEUE_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_QUEUE_SCREENSHOT}-${width}.png`,
          });
        const box = await dock.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(
          await f.page
            .locator('[id^="message-"]')
            .filter({ hasText: 'queued one' })
            .count(),
        ).toBe(0);
        expect(f.state.streamRequests).toBe(1); // No SSE for pending queue Runs.
        f.state.queue[0]!.attachments = [
          {
            id: id(800),
            fileName: 'inputs.txt',
            mediaType: 'text/plain',
            sizeBytes: 10,
          },
        ];
        await f.page.reload();
        await f.page.getByRole('button', { name: /排队消息 · 2/ }).click();
        await dock.getByText(/inputs.txt/).waitFor();
        expect(
          await dock
            .getByRole('button', { name: '立即引导' })
            .first()
            .isDisabled(),
        ).toBe(true);
        await dock.getByRole('button', { name: '重新编辑' }).first().click();
        await expect.poll(() => input.inputValue()).toBe('queued one');
        await expect.poll(() => input.isEnabled()).toBe(true);
        expect(f.state.queue.map((m) => m.text)).toEqual(['queued two']);
        expect(
          await dock.getByRole('button', { name: '重新编辑' }).isDisabled(),
        ).toBe(true); // preserve current draft
        await input.fill('edited with attachment');
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(3);
        expect(f.state.messageInputs[2]!.attachmentIds).toEqual([id(800)]);
        await expect.poll(() => input.isEnabled()).toBe(true);
        const header = dock.getByRole('button', { name: /排队消息 · 2/ });
        if ((await header.getAttribute('aria-expanded')) === 'false')
          await header.click();
        await dock.getByRole('button', { name: '撤回消息' }).first().click();
        await expect.poll(() => f.state.queue.length).toBe(1);
        expect(f.state.queue[0]!.text).toBe('edited with attachment');
        expect(f.state.queueActions.map((a) => a.action)).toEqual([
          'edit',
          'remove',
        ]);
      } finally {
        await f.close();
      }
    },
  );
  it('QueueDock preserves rejected actions and steers once at the exact current turn', async () => {
    const f = await fixture({ running: true, queue: true });
    try {
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await input.fill('correct current task');
      await input.press('Enter');
      const dock = f.page.locator('[data-queue-dock]');
      await dock.getByText('correct current task').waitFor();
      f.state.queueError = true;
      await dock.getByRole('button', { name: '撤回消息' }).click();
      await dock.getByRole('alert').waitFor();
      expect(f.state.queue).toHaveLength(1);
      f.state.queueError = false;
      await dock.getByRole('button', { name: '立即引导' }).click();
      await expect.poll(() => f.state.queue.length).toBe(0);
      expect(f.state.queueActions[1]).toEqual({
        action: 'steer',
        expectedTurnId: 'native-turn:1',
        expectedGeneration: 3,
      });
      expect(f.state.messageInputs).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('QueueDock follows worker FIFO without sending again and cannot restore an edited draft into another session', async () => {
    const f = await fixture({ running: true, queue: true });
    try {
      const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await input.fill('next real turn');
      await input.press('Enter');
      await f.page
        .locator('[data-queue-dock]')
        .getByText('next real turn')
        .waitFor();
      // The dock renders optimistically before the server accepts the message.
      // Simulate the worker only after the queued send has been acknowledged.
      await expect
        .poll(() => f.state.queue.map((message) => message.text))
        .toEqual(['next real turn']);
      await expect.poll(() => input.isEnabled()).toBe(true);
      const item = f.state.queue.shift()!;
      f.state.queuedStarted.push({
        id: item.id,
        role: 'user',
        content: { text: item.text },
        status: 'completed',
        runId: null,
        createdAt: now,
      });
      await expect
        .poll(() => f.page.locator('[data-queue-dock]').count(), {
          timeout: 5000,
        })
        .toBe(0);
      expect(f.state.messageInputs).toHaveLength(1);
      await input.fill('edit delayed');
      await input.press('Enter');
      await f.page
        .locator('[data-queue-dock]')
        .getByText('edit delayed')
        .waitFor();
      let finish!: () => void;
      f.state.queueDelay = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await f.page.getByRole('button', { name: '重新编辑' }).click();
      await f.page.getByText('研究任务 B', { exact: true }).click();
      finish();
      await expect.poll(() => f.state.queue.length).toBe(0);
      expect(await input.inputValue()).toBe('');
      expect(await input.isEnabled()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each([320, 390, 1440])(
    'keeps the simplified composer aligned without mode or common tasks at width %i',
    async (width) => {
      const f = await fixture({ width, touch: width < 760 });
      try {
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        const mode = f.page.getByRole('combobox', {
          name: '工作模式',
          exact: true,
        });
        expect(await mode.count()).toBe(0);
        expect(
          await f.page
            .getByRole('button', { name: '常用任务', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await f.page.getByText('本次不使用助手', { exact: true }).count(),
        ).toBe(0);
        expect(await f.page.locator('fieldset').count()).toBe(0);
        expect(
          await input.evaluate((element) => element.previousElementSibling),
        ).toBeNull();
        const add = await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .boundingBox();
        expect(
          await f.page
            .getByRole('combobox', { name: '上传文件可见范围' })
            .count(),
        ).toBe(0);
        const textarea = await input.boundingBox();
        const send = await f.page
          .getByRole('button', { name: '发送', exact: true })
          .boundingBox();
        expect(add!.x + add!.width).toBeLessThan(send!.x);
        expect(
          Math.abs(send!.y + send!.height / 2 - add!.y - add!.height / 2),
        ).toBeLessThan(2);
        expect(add!.y).toBeGreaterThanOrEqual(textarea!.y + textarea!.height);
        await input.fill('保留问题和键盘操作');
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page.keyboard.press('Escape');
        expect(await input.inputValue()).toBe('保留问题和键盘操作');
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    'reuses native rows for chronological Chinese steps, retains failures and uses the employee identity streaming=%s',
    async (streamingOutput) => {
      const f = await fixture({ streamingOutput });
      try {
        f.state.employeeName = 'Office 文档助手';
        f.state.events = Array.from({ length: 10 }, (_, i) => ({
          schemaVersion: 3,
          eventId: id(700 + i),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence: i + 1,
          cursor: `${run}:${i + 1}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type: i === 8 ? 'tool.failed' : 'tool.completed',
          payload: {
            toolCallId: `call-${i}`,
            name: i === 9 ? 'workspace.export.create' : 'market.quote',
            ...(i === 8
              ? { summary: '行情服务超时' }
              : {
                  summary:
                    i === 9
                      ? '已生成财报摘要.docx'
                      : `已查询第 ${i + 1} 个标的的行情`,
                }),
          },
        }));
        await f.page.reload();
        const process = f.page.getByRole('region', {
          name: '工作过程',
          exact: true,
        });
        const processBody = process.locator('..');
        const toggle = process.getByRole('button', { name: /^工作过程/ });
        await expect.poll(() => toggle.innerText()).toContain('1 次未成功');
        expect(await toggle.innerText()).toContain('1 次未成功');
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
        expect(await processBody.getByRole('list').count()).toBe(0);
        await toggle.focus();
        await f.page.keyboard.press('Enter');
        const groups = processBody.getByRole('list', { name: '工作步骤' });
        expect(await groups.getByRole('listitem').count()).toBe(10);
        expect(
          await groups
            .locator('[data-step-id]')
            .evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute('data-step-id')),
            ),
        ).toEqual(Array.from({ length: 10 }, (_, i) => `tool:call-${i}`));
        await groups
          .locator('[data-step-id="tool:call-0"]')
          .getByRole('button', { name: '查询实时行情', exact: true })
          .click();
        await groups
          .locator('[data-step-id="tool:call-9"]')
          .getByRole('button', { name: '生成交付成果', exact: true })
          .click();
        expect(await groups.innerText()).toContain('已查询第 1 个标的的行情');
        expect(await groups.innerText()).toContain('已生成财报摘要.docx');
        expect(await groups.getByRole('button').count()).toBe(10);
        expect(
          await groups.locator('li').evaluateAll((rows) =>
            rows.map((row) => {
              const header = row.querySelector('[data-disclosure-row]')!;
              const leading = header.firstElementChild!;
              return [
                row.getAttribute('data-category'),
                header.querySelectorAll(':scope > [class*="leading"]').length,
                leading.querySelectorAll('[class*="iconIdle"] svg').length,
                leading.querySelectorAll('svg[class*="chevronHover"]').length,
                leading.querySelectorAll(
                  ':scope > svg:not([class*="chevronHover"])',
                ).length,
              ];
            }),
          ),
        ).toEqual(
          Array.from({ length: 10 }, (_, i) => [
            i === 9 ? 'write' : 'market',
            1,
            [0, 8, 9].includes(i) ? 0 : 1,
            [0, 8, 9].includes(i) ? 0 : 1,
            [0, 8, 9].includes(i) ? 1 : 0,
          ]),
        );
        expect(await groups.locator('[data-status="已完成"]').count()).toBe(9);
        expect(await groups.locator('[data-status="未成功"]').count()).toBe(1);
        expect(await groups.innerText()).not.toMatch(/累计|次操作/);
        expect(await groups.innerText()).toContain('行情服务超时');
        expect(
          await groups.evaluate(
            (el) => getComputedStyle(el.parentElement!).maxHeight,
          ),
        ).toBe('360px');
        expect(
          await f.page.getByLabel('子智能体任务', { exact: true }).count(),
        ).toBe(0);
        expect(
          await f.page.locator('[id^="message-"]').last().innerText(),
        ).toContain('Office 文档助手');
        expect(
          await f.page
            .getByRole('textbox', { name: '给 Office 文档助手 的消息' })
            .getAttribute('placeholder'),
        ).toBe('继续和 Office 文档助手 工作…');
        expect(
          await f.page
            .locator('[data-employee-accent]')
            .getAttribute('data-employee-accent'),
        ).toBe('orange');
        if (globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT)
          await f.page.screenshot({
            path: `${globalThis.process.env.ALLRICE_EMPLOYEE_SCREENSHOT}-process.png`,
          });
        await toggle.focus();
        await f.page.keyboard.press(' ');
        expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 1280, 390, 320])(
    'lets an ordinary member control three Bridge capabilities in native settings without flashing the panel at %ipx',
    async (width) => {
      const f = await fixture({ width, touch: width < 600 });
      const device = {
        id: id(950),
        organizationId: org,
        workspaceId: workspace,
        ownerId: user,
        name: 'Synthetic Mac',
        platform: 'macos-arm64',
        protocolVersion: 2,
        capabilities: ['local.fs.list'],
        status: 'online',
        lastSeenAt: now,
        createdAt: now,
        revokedAt: null,
        folderGrants: [],
      };
      let networkRequests = 0;
      const settings = {
        localCommand: true,
        localBrowser: true,
        development: true,
      };
      let revision = 0,
        pending = false,
        reads = 0;
      const writes: string[] = [];
      const login = {
        grantId: id(951),
        deviceId: device.id,
        enabled: true,
        persistLogin: width !== 320,
        profile: { network: 'public_https', origins: [] },
      };
      const loginWrites: boolean[] = [];
      let loginReads = 0;
      let failLoginReadAfterClear = width === 320;
      try {
        await f.page.route('**/api/v1/admin/local-browser**', (route) => {
          if (route.request().method() === 'PATCH') {
            expect(route.request().postDataJSON()).toEqual({
              workspaceId: workspace,
              action: 'login_preferences',
              grantId: login.grantId,
              rememberLogin: true,
            });
            login.persistLogin = route.request().postDataJSON().rememberLogin;
            loginWrites.push(login.persistLogin);
            login.grantId = id(951 + loginWrites.length);
            return route.fulfill({
              json: {
                grantId: login.grantId,
                grantRevision: 1,
                logicalProfileId: id(960 + loginWrites.length),
                deviceId: device.id,
                profile: {
                  version: 1,
                  network: 'public_https',
                  origins: [],
                  allowHumanCredentials: true,
                  allowDownloads: true,
                  allowUploads: false,
                },
                persistLogin: login.persistLogin,
              },
            });
          }
          loginReads++;
          if (loginWrites.length === 1 && failLoginReadAfterClear) {
            failLoginReadAfterClear = false;
            return route.fulfill({ status: 503, json: {} });
          }
          return route.fulfill({ json: { grants: [login] } });
        });
        await f.page.route('**/api/v1/bridge/devices**', async (route) => {
          const request = route.request(),
            url = new URL(request.url());
          if (url.pathname === '/api/v1/bridge/devices')
            return route.fulfill({ json: { devices: [device] } });
          if (url.pathname.endsWith('/sandbox-network')) {
            networkRequests++;
            return route.fulfill({ status: 404, json: {} });
          }
          if (request.method() === 'PATCH') {
            const change = request.postDataJSON() as {
              capability: keyof typeof settings;
              enabled: boolean;
            };
            writes.push(change.capability);
            settings[change.capability] = change.enabled;
            revision++;
            pending = true;
            reads = 0;
          } else if (pending && ++reads >= 1) pending = false;
          return route.fulfill({
            json: {
              device,
              settings,
              revision,
              pending,
              supported: true,
              environment: {
                version: 1,
                clientVersion: '0.6.0-dev.8',
                browserDefaultsVersion: 1,
                paused: false,
                browser: settings.localBrowser ? 'ready' : 'paused',
                sandbox: settings.localCommand ? 'ready' : 'paused',
                preview: 'ready',
                development: settings.development ? 'ready' : 'paused',
                settings,
                settingsRevision: pending ? revision - 1 : revision,
              },
            },
          });
        });
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await selectSettings(dialog, '我的电脑');
        const browserSwitch = dialog.getByRole('switch', {
          name: '本地独立浏览器',
          exact: true,
        });
        await browserSwitch.waitFor();
        await dialog
          .getByRole('button', { name: '连接与管理电脑', exact: true })
          .getByText('已连接', { exact: true })
          .waitFor();
        expect(
          await dialog
            .getByRole('switch', {
              name: '保留浏览器登录',
              exact: true,
            })
            .count(),
        ).toBe(0);
        await dialog
          .getByText(
            width === 320
              ? '当前浏览器使用临时登录资料。'
              : '网站登录保存在这台电脑，供后续任务使用。',
            { exact: true },
          )
          .waitFor();
        expect(
          await dialog.getByText('业务站点', { exact: true }).count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('textbox', {
              name: '业务站点地址',
              exact: true,
            })
            .count(),
        ).toBe(0);
        if (settingsReviewDir && (width === 1440 || width === 390)) {
          await f.page.evaluate(() => document.fonts.ready);
          await f.page.screenshot({
            path: `${settingsReviewDir}/computer-${width}.png`,
          });
        }
        expect(loginWrites).toEqual([]);
        const clearLogin = dialog.getByRole('button', {
          name: '清除登录',
          exact: true,
        });
        expect(
          await clearLogin.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const textNodes = document.createTreeWalker(
              button,
              NodeFilter.SHOW_TEXT,
            );
            const rects: DOMRect[] = [];
            while (textNodes.nextNode()) {
              if (!textNodes.currentNode.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(textNodes.currentNode);
              rects.push(...range.getClientRects());
            }
            return {
              lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
              fits: rects.every(
                (rect) =>
                  rect.left >= bounds.left - 1 &&
                  rect.right <= bounds.right + 1 &&
                  rect.top >= bounds.top - 1 &&
                  rect.bottom <= bounds.bottom + 1,
              ),
            };
          }),
        ).toEqual({ lines: 1, fits: true });
        const confirmation = dialog.getByRole('group', {
          name: '清除浏览器登录确认',
          exact: true,
        });
        await clearLogin.click();
        await confirmation.waitFor();
        expect(loginWrites).toEqual([]);
        await confirmation
          .getByRole('button', { name: '取消', exact: true })
          .click();
        await confirmation.waitFor({ state: 'hidden' });
        expect(loginWrites).toEqual([]);
        const readsBeforeClear = loginReads;
        await clearLogin.click();
        await confirmation
          .getByRole('button', { name: '确认清除', exact: true })
          .click();
        await expect.poll(() => loginWrites).toEqual([true]);
        await expect.poll(() => loginReads).toBeGreaterThan(readsBeforeClear);
        await confirmation.waitFor({ state: 'hidden' });
        await dialog
          .getByText('网站登录保存在这台电脑，供后续任务使用。', {
            exact: true,
          })
          .waitFor();
        if (width === 320) {
          // Rotation succeeded even though the following GET failed. A second
          // explicit clear must use the replacement, never the revoked grant.
          await dialog.getByRole('alert').waitFor();
          await clearLogin.click();
          await confirmation
            .getByRole('button', { name: '确认清除', exact: true })
            .click();
          await expect.poll(() => loginWrites).toEqual([true, true]);
          await confirmation.waitFor({ state: 'hidden' });
          await dialog.getByRole('alert').waitFor({ state: 'hidden' });
        }
        expect(await dialog.getByRole('switch').count()).toBe(3);
        for (const label of ['本地沙箱命令', '本地独立浏览器', '受控开发协作'])
          expect(
            await dialog
              .getByRole('switch', { name: label, exact: true })
              .getAttribute('aria-checked'),
          ).toBe('true');
        await browserSwitch.evaluate((el) =>
          el.setAttribute('data-retained', 'yes'),
        );
        await browserSwitch.click();
        await dialog.getByText('正在同步到电脑…', { exact: true }).waitFor();
        await expect
          .poll(() => browserSwitch.getAttribute('aria-checked'))
          .toBe('false');
        await dialog
          .getByText('正在同步到电脑…', { exact: true })
          .waitFor({ state: 'hidden' });
        expect(await browserSwitch.getAttribute('data-retained')).toBe('yes');
        const development = dialog.getByRole('switch', {
          name: '受控开发协作',
          exact: true,
        });
        await development.click();
        await expect
          .poll(() => development.getAttribute('aria-checked'))
          .toBe('false');
        expect(
          await dialog
            .getByRole('switch', { name: '本地沙箱命令', exact: true })
            .getAttribute('aria-checked'),
        ).toBe('true');
        await dialog
          .getByText('正在同步到电脑…', { exact: true })
          .waitFor({ state: 'hidden' });
        await f.page.screenshot({
          path: '/tmp/allrice-bridge-three-switches.png',
        });
        expect(
          await dialog.getByText('沙箱联网', { exact: true }).count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('textbox', { name: '允许的 HTTPS 地址' })
            .count(),
        ).toBe(0);
        expect(networkRequests).toBe(0);
        expect(writes).toEqual(['localBrowser', 'development']);
        expect(loginWrites).toEqual(width === 320 ? [true, true] : [true]);
      } finally {
        await f.close();
      }
    },
    15000,
  );

  it('shows the current member monthly balance inside native settings', async () => {
    const f = await fixture();
    try {
      const settings = f.page.getByRole('button', {
        name: '设置',
        exact: true,
      });
      expect(
        await f.page.locator('summary[aria-label="账号月额度"]').count(),
      ).toBe(0);
      await settings.click();
      await selectSettings(
        f.page.getByRole('dialog', { name: '设置', exact: true }),
        '账号与用量',
      );
      const quota = f.page.getByRole('region', { name: '账号月额度' });
      await f.page.getByText('Synthetic member', { exact: true }).waitFor();
      await quota.getByText(/43%/).waitFor();
      for (const word of ['Token', 'Codex', 'DSH', '模型服务'])
        expect(await quota.innerText()).not.toContain(word);
      await quota.getByText('2,824,029', { exact: false }).waitFor();
      expect(await quota.innerText()).toContain('5,000,000');
      await f.page
        .getByText('工作区已用 2.00 GiB；未设置额外存储配额。', { exact: true })
        .waitFor();
      await f.page.reload();
      await settings.click();
      await selectSettings(
        f.page.getByRole('dialog', { name: '设置', exact: true }),
        '账号与用量',
      );
      await quota.getByText(/43%/).waitFor();
    } finally {
      await f.close();
    }
  });

  it('signs out from account settings only after the logout request succeeds', async () => {
    const f = await fixture();
    let requests = 0;
    try {
      await f.page.route('**/api/v1/auth/logout', async (route) => {
        expect(route.request().method()).toBe('POST');
        requests++;
        await route.fulfill({ status: requests === 1 ? 503 : 204 });
      });
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      await selectSettings(settings, '账号与用量');
      const logout = settings.getByRole('button', {
        name: '退出登录',
        exact: true,
      });
      const originalUrl = f.page.url();
      await logout.click();
      await settings
        .getByRole('alert')
        .filter({ hasText: '退出登录失败，请重试。' })
        .waitFor();
      expect(f.page.url()).toBe(originalUrl);
      await logout.click();
      await f.page.waitForURL('**/login');
      expect(requests).toBe(2);
    } finally {
      await f.close();
    }
  });

  it.each([
    { width: 390, tenantAdmin: false },
    { width: 1440, tenantAdmin: false },
    { width: 1440, tenantAdmin: true },
  ])(
    'MET159 native settings works without admin configuration, preserves drafts and restores focus (%o)',
    async ({ width, tenantAdmin }) => {
      const f = await fixture({ width, tenantAdmin });
      f.state.connections = [
        McpConnectionSchema.parse({
          id: id(70),
          definitionId: id(71),
          workspaceId: workspace,
          name: '工作资料',
          endpoint: 'https://mcp.example.test/mcp',
          enabled: true,
          revision: 1,
          credentialConfigured: false,
          credentialReference: 'synthetic',
          managed: true,
          shared: false,
          discoveryState: 'error',
          discoveryCode: 'MCP_AUTH_REQUIRED',
          checkedAt: null,
          tools: [],
        }),
      ];
      try {
        const composer = f.page.getByRole('textbox', { name: '消息' });
        await composer.fill('保留聊天草稿');
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const trigger = f.page.getByRole('button', {
          name: '设置',
          exact: true,
        });
        expect(
          await f.page.getByRole('link', { name: 'MCP 连接管理' }).count(),
        ).toBe(0);
        await trigger.click();
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await selectSettings(dialog, '账号与用量');
        await dialog.getByText('Synthetic member', { exact: true }).waitFor();
        expect(
          await dialog.getByText('平台管理', { exact: true }).count(),
        ).toBe(0);
        expect(
          await dialog.getByRole('link', { name: '打开平台管理' }).count(),
        ).toBe(0);
        await f.page.screenshot({
          path: `/tmp/met160-settings-account-${width}.png`,
        });
        await selectSettings(dialog, '已链接应用');
        await dialog.getByText('需要登录', { exact: true }).waitFor();
        await dialog.getByText('管理连接', { exact: true }).click();
        await dialog.getByRole('button', { name: '填写连接凭据' }).click();
        const credential = dialog.getByLabel('应用访问令牌');
        await credential.fill('synthetic-unsaved-token');
        await selectSettings(dialog, '账号与用量');
        await selectSettings(dialog, '我的电脑');
        await dialog.getByRole('button', { name: '连接与管理电脑' }).waitFor();
        expect(
          await dialog
            .getByRole('button', { name: '云端浏览器', exact: true })
            .count(),
        ).toBe(0);
        expect(
          await dialog
            .getByRole('button', { name: '本地浏览器', exact: true })
            .count(),
        ).toBe(0);
        await selectSettings(dialog, '已链接应用');
        expect(await credential.inputValue()).toBe('synthetic-unsaved-token');
        const reads = f.state.connectionReads;
        await f.page.clock.install();
        await f.page.clock.runFor(31_000);
        expect(f.state.connectionReads).toBe(reads);
        await dialog
          .getByRole('button', { name: '断开连接', exact: true })
          .click();
        await dialog.getByText('已断开', { exact: true }).waitFor();
        expect(await credential.count()).toBe(0);
        await dialog
          .getByRole('button', { name: '重新连接', exact: true })
          .click();
        await dialog
          .getByRole('button', { name: '删除连接', exact: true })
          .click();
        await dialog.getByText('还没有连接应用。', { exact: false }).waitFor();
        expect(f.state.connectionActions).toEqual([
          'disconnect',
          'reconnect',
          'delete',
        ]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await f.page.screenshot({
          path: `/tmp/met160-settings-connections-${width}.png`,
        });
        const focusables = dialog.locator(
          'button:not(:disabled):visible,input:not(:disabled):visible',
        );
        await focusables.last().focus();
        await f.page.keyboard.press('Tab');
        expect(
          await dialog.evaluate((e) => e.contains(document.activeElement)),
        ).toBe(true);
        await f.page.keyboard.press('Escape');
        expect(await dialog.count()).toBe(0);
        expect(
          await trigger.evaluate((e) => e === document.activeElement),
        ).toBe(true);
        if (width < 600) {
          expect(
            await f.page.getByRole('dialog', { name: '任务与历史' }).count(),
          ).toBe(1);
          await f.page.keyboard.press('Escape');
        }
        expect(await composer.inputValue()).toBe('保留聊天草稿');
        if (width >= 600)
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .click();
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        await dialog.waitFor();
      } finally {
        await f.close();
      }
    },
  );

  it('MET159 closes personal settings and discards credential drafts when a refreshed workspace changes viewer', async () => {
    const f = await fixture({ running: true });
    try {
      await expect.poll(() => f.state.streamRequests).toBeGreaterThan(0);
      f.state.connections = [
        McpConnectionSchema.parse({
          id: id(70),
          definitionId: id(71),
          workspaceId: workspace,
          name: '上一位用户的应用',
          endpoint: 'https://mcp.example.test/mcp',
          enabled: true,
          revision: 1,
          credentialConfigured: false,
          credentialReference: 'synthetic',
          managed: true,
          shared: false,
          discoveryState: 'error',
          discoveryCode: 'MCP_AUTH_REQUIRED',
          checkedAt: null,
          tools: [],
        }),
      ];
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      await selectSettings(settings, '已链接应用');
      await settings.getByText('管理连接', { exact: true }).click();
      await settings.getByRole('button', { name: '填写连接凭据' }).click();
      await settings.getByLabel('应用访问令牌').fill('synthetic-private-draft');
      f.state.viewer = id(50);
      f.state.workspace = id(51);
      f.state.connections = [];
      f.finishRun();
      await expect.poll(() => settings.count()).toBe(0);
      await f.page.getByRole('button', { name: '设置', exact: true }).click();
      await selectSettings(settings, '已链接应用');
      await settings.getByText('还没有连接应用。', { exact: false }).waitFor();
      expect(await settings.getByLabel('应用访问令牌').count()).toBe(0);
      expect(await settings.getByText('上一位用户的应用').count()).toBe(0);
      expect(f.state.connectionActions).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([
    [1440, true],
    [390, true],
    [1440, false],
    [390, false],
  ] as const)(
    'keeps settled reply and scroll positions while restoring native process at %ipx streaming=%s',
    async (width, streamingOutput) => {
      const f = await fixture({ width, streamingOutput });
      let releaseTrace!: () => void;
      try {
        const reply = '111+222=333，111×222=24642。';
        f.state.reply = reply;
        f.state.events = [
          {
            schemaVersion: 3,
            eventId: id(8901),
            organizationId: org,
            workspaceId: workspace,
            conversationId: A,
            runId: run,
            generation: 1,
            sequence: 1,
            cursor: `${run}:1`,
            harness: 'dsh',
            occurredAt: now,
            sourceEvent: null,
            type: 'tool.completed',
            payload: { toolCallId: 'calculate', name: 'calculate' },
          },
          {
            schemaVersion: 3,
            eventId: id(8902),
            organizationId: org,
            workspaceId: workspace,
            conversationId: A,
            runId: run,
            generation: 1,
            sequence: 2,
            cursor: `${run}:2`,
            harness: 'dsh',
            occurredAt: now,
            sourceEvent: null,
            type: 'assistant.text.completed',
            payload: { replyId: 'final', text: reply },
          },
        ];
        f.state.eventsDelay = new Promise<void>((resolve) => {
          releaseTrace = resolve;
        });
        await f.page.reload();
        const process = f.page.getByRole('region', {
          name: '工作过程',
          exact: true,
        });
        await process.getByText('加载过程…', { exact: true }).waitFor();
        const text = f.page.getByText(reply, { exact: true });
        await text.waitFor();
        await f.page.evaluate(() => document.fonts.ready);
        await f.page.waitForTimeout(100);
        const measure = () =>
          text.evaluate((node) => {
            const scroll = document.querySelector(
              '[data-conversation-scroll]',
            )!;
            const bounds = node.getBoundingClientRect();
            return {
              top: bounds.top,
              height: bounds.height,
              scrollTop: scroll.scrollTop,
              scrollHeight: scroll.scrollHeight,
            };
          });
        const before = await measure();
        const handle = await text.elementHandle();
        releaseTrace();
        await expect
          .poll(() => process.getByText('加载过程…', { exact: true }).count())
          .toBe(0);
        await f.page.waitForTimeout(100);
        expect(await measure()).toEqual(before);
        // Restoring native reply IDs must preserve the displayed Markdown node.
        expect(
          await text.evaluate((node, previous) => node === previous, handle),
        ).toBe(true);
      } finally {
        releaseTrace?.();
        await f.close();
      }
    },
  );

  // The page's theme right now, and what it was before the app loaded.
  const themeState = (page: Page) =>
    page.evaluate(() => ({
      firstPaint: (window as unknown as { firstPaint?: object }).firstPaint,
      theme: document.documentElement.getAttribute('data-theme'),
      dark: document.body.hasAttribute('data-ds-dark-theme'),
    }));
  const appearanceSelect = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const dialog = await openSettings(f);
    await selectSettings(dialog, '个人偏好');
    const select = dialog.getByRole('combobox', { name: '外观', exact: true });
    await expect.poll(() => select.isEnabled()).toBe(true);
    return { dialog, select };
  };

  it.each([
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const)(
    'MET214 paints the saved appearance from the first frame at %ipx (%s)',
    async (width, appearance) => {
      const f = await fixture({ width, touch: width < 760, appearance });
      try {
        const dark = appearance === 'dark';
        expect(await themeState(f.page)).toEqual({
          firstPaint: { theme: appearance, dark },
          theme: appearance,
          dark,
        });
        const { dialog, select } = await appearanceSelect(f);
        expect(await select.inputValue()).toBe(appearance);
        expect(await select.locator('option').allTextContents()).toEqual([
          '浅色',
          '深色',
          '跟随系统',
        ]);
        // The new row reads like its neighbours in either palette.
        const label = dialog.getByText('外观', { exact: true });
        const readable = await label.evaluate((node) => {
          const channel = (value: string) =>
            value
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map((v) => {
                const c = Number(v) / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
          const luminance = (value: string) => {
            const [r, g, b] = channel(value);
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          let painted: Element | null = node;
          while (
            painted &&
            getComputedStyle(painted).backgroundColor === 'rgba(0, 0, 0, 0)'
          )
            painted = painted.parentElement;
          const [x, y] = [
            luminance(getComputedStyle(node).color),
            luminance(getComputedStyle(painted!).backgroundColor),
          ].sort((m, n) => n - m);
          return {
            contrast: (x! + 0.05) / (y! + 0.05),
            overflow:
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
          };
        });
        expect(readable.contrast).toBeGreaterThanOrEqual(4.5);
        expect(readable.overflow).toBe(false);
        await f.page.screenshot({
          path: `.local/feedback/met214-appearance-${width}-${appearance}.png`,
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'MET214 an employee picks dark in personal preferences and gets it after a reload and in another browser at %ipx',
    async (width) => {
      const preferences: Record<string, UserPreferences> = {
        [user]: { ...defaultUserPreferences },
      };
      const f = await fixture({ width, touch: width < 760, preferences });
      try {
        expect(await themeState(f.page)).toMatchObject({
          firstPaint: { theme: 'light', dark: false },
          dark: false,
        });
        const { select } = await appearanceSelect(f);
        // Hold the save: the page switches at once, and the row waits.
        let release!: () => void;
        f.state.preferenceDelay = new Promise<void>((done) => {
          release = done;
        });
        await select.selectOption({ label: '深色' });
        await expect
          .poll(() => themeState(f.page))
          .toMatchObject({ theme: 'dark', dark: true });
        await expect.poll(() => select.isDisabled()).toBe(true);
        release();
        f.state.preferenceDelay = null;
        await expect.poll(() => select.isEnabled()).toBe(true);
        expect(preferences[user]!.appearance).toBe('dark');
        await f.page.reload();
        await f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ }).waitFor();
        expect(await themeState(f.page)).toEqual({
          firstPaint: { theme: 'dark', dark: true },
          theme: 'dark',
          dark: true,
        });
      } finally {
        await f.close();
      }
      // A fresh browser context: nothing kept in this browser, same account.
      const g = await fixture({ width, touch: width < 760, preferences });
      try {
        expect(await themeState(g.page)).toEqual({
          firstPaint: { theme: 'dark', dark: true },
          theme: 'dark',
          dark: true,
        });
        expect(await (await appearanceSelect(g)).select.inputValue()).toBe(
          'dark',
        );
      } finally {
        await g.close();
      }
    },
  );

  it('MET214 follows the system, restores the saved value when a save fails and re-reads it on return to the page', async () => {
    const f = await fixture({ appearance: 'light' });
    try {
      await f.page.emulateMedia({ colorScheme: 'dark' });
      // Media query changes are reported before the next animation frame.
      await f.page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      // A light choice ignores a dark system.
      expect(await themeState(f.page)).toMatchObject({ dark: false });
      const { dialog, select } = await appearanceSelect(f);
      await select.selectOption({ label: '跟随系统' });
      await expect.poll(() => themeState(f.page)).toMatchObject({ dark: true });
      await expect.poll(() => select.isEnabled()).toBe(true);
      expect(f.state.preferences[user]!.appearance).toBe('system');
      await f.page.emulateMedia({ colorScheme: 'light' });
      await expect
        .poll(() => themeState(f.page))
        .toMatchObject({ theme: 'light', dark: false });
      await f.page.emulateMedia({ colorScheme: 'dark' });
      await expect
        .poll(() => themeState(f.page))
        .toMatchObject({ theme: 'dark', dark: true });

      // Another device saved dark; this page's save of light fails. The page
      // ends on what the server holds, not on the value before the click.
      f.state.preferences[user]!.appearance = 'dark';
      await f.page.emulateMedia({ colorScheme: 'light' });
      await expect
        .poll(() => themeState(f.page))
        .toMatchObject({ theme: 'light', dark: false });
      await f.page.route('**/api/v1/me/preferences', (route) =>
        route.request().method() === 'PATCH'
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: '保存失败，请重试' } }),
            })
          : route.fallback(),
      );
      await select.selectOption({ label: '浅色' });
      await dialog.getByRole('alert').getByText('保存失败，请重试').waitFor();
      await expect
        .poll(() => themeState(f.page))
        .toMatchObject({ theme: 'dark', dark: true });
      await expect.poll(() => select.inputValue()).toBe('dark');
      expect(f.state.preferences[user]!.appearance).toBe('dark');
      await f.page.unroute('**/api/v1/me/preferences');

      // Changed on another device; this page re-reads it when it comes back.
      f.state.preferences[user]!.appearance = 'light';
      expect(await themeState(f.page)).toMatchObject({ dark: true });
      await f.page.evaluate(() =>
        document.dispatchEvent(new Event('visibilitychange')),
      );
      await expect
        .poll(() => themeState(f.page))
        .toMatchObject({ theme: 'light', dark: false });
      await expect.poll(() => select.inputValue()).toBe('light');
    } finally {
      await f.close();
    }
  });

  it('MET214 a slow read from before a save cannot undo the saved choice', async () => {
    const f = await fixture({ appearance: 'light' });
    try {
      const { select } = await appearanceSelect(f);
      // Coming back to the page reads light, but the answer is slow.
      let release!: () => void, read!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const readLight = new Promise<void>((done) => {
        read = done;
      });
      await f.page.route('**/api/v1/me/preferences', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const body = JSON.stringify({
          viewerId: user,
          preferences: { ...f.state.preferences[user] },
        });
        read();
        await held;
        return route.fulfill({ contentType: 'application/json', body });
      });
      const slowRead = f.page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/me/preferences') &&
          response.request().method() === 'GET',
      );
      await f.page.evaluate(() =>
        document.dispatchEvent(new Event('visibilitychange')),
      );
      await readLight;
      await select.selectOption({ label: '深色' });
      await expect.poll(() => select.isEnabled()).toBe(true);
      expect(f.state.preferences[user]!.appearance).toBe('dark');
      release();
      await slowRead;
      await f.page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          ),
      );
      expect(await themeState(f.page)).toMatchObject({
        theme: 'dark',
        dark: true,
      });
      expect(await select.inputValue()).toBe('dark');
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390, 320])(
    'MET199 saves the unified personal display list at %ipx, sizes actual body text and keeps code fixed',
    async (width) => {
      const f = await fixture({ width, touch: width < 760 });
      try {
        f.state.messages = navigationHistory(1);
        f.state.messages.at(-1)!.runId = run;
        f.state.messages.at(-1)!.content.text =
          '正文大小样例\n\n```js\nconst fixedCodeSize = 1;\n```';
        await f.page.reload();
        const body = f.page.getByText('正文大小样例', { exact: true });
        const code = f.page.locator('pre code').first();
        await body.waitFor();
        await expect
          .poll(() => code.evaluate((el) => getComputedStyle(el).fontSize))
          .toBe('11px');
        expect(await body.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
          '14px',
        );
        const userBubble = f.page.getByText(f.state.messages[0]!.content.text, {
          exact: true,
        });
        expect(
          await userBubble.evaluate((el) => getComputedStyle(el).fontSize),
        ).toBe('14px');
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        const open = async () => {
          await f.page
            .getByRole('button', { name: '设置', exact: true })
            .click();
          await selectSettings(settings, '个人偏好');
          await expect
            .poll(() =>
              settings
                .getByRole('spinbutton', { name: '字号大小' })
                .isEnabled(),
            )
            .toBe(true);
        };
        await open();
        expect(
          await settings
            .getByRole('button', { name: '经验记录', exact: true })
            .count(),
        ).toBe(0);
        const mobileMenu = settings.getByRole('combobox', { name: '设置页面' });
        if (await mobileMenu.count())
          expect(
            await mobileMenu.locator('option').allTextContents(),
          ).not.toContain('经验记录');
        const font = settings.getByRole('spinbutton', { name: '字号大小' });
        expect(await font.inputValue()).toBe('14');
        await font.fill('18');
        await font.press('Enter');
        await expect.poll(() => font.isEnabled()).toBe(true);
        expect(f.state.preferences[user]!.fontSize).toBe(18);
        const view = settings.getByRole('combobox', {
          name: '工作步骤展示',
          exact: true,
        });
        const timing = settings.getByRole('combobox', {
          name: '工作步骤收起时机',
          exact: true,
        });
        expect(await view.locator('option').allTextContents()).toEqual([
          '简洁',
          '标准',
          '详细',
          '完全展开',
        ]);
        await timing.selectOption('next-input');
        await expect.poll(() => view.isEnabled()).toBe(true);
        await view.selectOption('verbose');
        await expect.poll(() => timing.isDisabled()).toBe(true);
        expect(await timing.inputValue()).toBe('next-input');
        await expect.poll(() => view.isEnabled()).toBe(true);
        await view.selectOption('standard');
        await expect.poll(() => timing.isEnabled()).toBe(true);
        expect(await timing.inputValue()).toBe('next-input');
        await f.page.screenshot({
          path: `.local/feedback/met199-preferences-${width}.png`,
        });
        await settings.getByRole('button', { name: '关闭设置' }).click();
        expect(await body.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
          '18px',
        );
        expect(
          await userBubble.evaluate((el) => getComputedStyle(el).fontSize),
        ).toBe('18px');
        await expect
          .poll(() => code.evaluate((el) => getComputedStyle(el).fontSize))
          .toBe('11px');
        await f.page.reload();
        await body.waitFor();
        expect(await body.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
          '18px',
        );
        await open();
        expect(await font.inputValue()).toBe('18');
        expect(await view.inputValue()).toBe('standard');
        expect(await timing.inputValue()).toBe('next-input');
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await settings.getByRole('button', { name: '关闭设置' }).click();
        f.state.viewer = id(975);
        await f.page.reload();
        await body.waitFor();
        expect(await body.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
          '14px',
        );
        await open();
        expect(await font.inputValue()).toBe('14');
        expect(await view.inputValue()).toBe('detailed');
        expect(await timing.inputValue()).toBe('completion');
      } finally {
        await f.close();
      }
    },
  );

  it('saves the native streaming switch per account, respects an explicit off preference and never reveals live text while off', async () => {
    const f = await fixture({ running: true, streamingOutput: false });
    try {
      const event = (
        sequence: number,
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ): ChatFlowEventEnvelope => ({
        schemaVersion: 3,
        eventId: id(850 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 1,
        sequence,
        cursor: `${run}:${sequence}`,
        harness: 'dsh',
        occurredAt: now,
        sourceEvent: null,
        type,
        payload,
      });
      f.state.events = [
        event(1, 'assistant.text.delta', {
          replyId: 'first',
          text: '正在核对本次数据。',
        }),
        event(2, 'tool.started', {
          toolCallId: 'read',
          name: 'read',
          summary: '读取本次资料',
        }),
        event(3, 'assistant.text.delta', {
          replyId: 'final',
          text: '本次核对结果正确。',
        }),
      ];
      f.state.streamEvents = f.state.events;
      f.releaseStream();
      const process = f.page.getByRole('region', {
        name: '工作过程',
        exact: true,
      });
      await process.waitFor();
      expect(
        await f.page.getByText('正在核对本次数据。', { exact: true }).count(),
      ).toBe(0);
      expect(
        await f.page.getByText('本次核对结果正确。', { exact: true }).count(),
      ).toBe(0);
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      const openPreferences = async () => {
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        await selectSettings(settings, '个人偏好');
        await expect
          .poll(() =>
            settings.getByRole('switch', { name: '流式输出' }).isEnabled(),
          )
          .toBe(true);
      };
      await openPreferences();
      const toggle = settings.getByRole('switch', { name: '流式输出' });
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
      await f.page.screenshot({
        path: '.local/feedback/personal-preferences.png',
      });
      f.state.preferenceError = true;
      await toggle.click();
      await settings.getByRole('alert').waitFor();
      expect(await toggle.getAttribute('aria-checked')).toBe('false');
      f.state.preferenceError = false;
      await toggle.click();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
      await settings.getByRole('button', { name: '关闭设置' }).click();
      await process
        .locator('..')
        .getByText('正在核对本次数据。', { exact: true })
        .waitFor();
      await f.page.reload();
      await process
        .locator('..')
        .getByText('正在核对本次数据。', { exact: true })
        .waitFor();
      await openPreferences();
      expect(await toggle.getAttribute('aria-checked')).toBe('true');
      await toggle.click();
      await expect
        .poll(() => toggle.getAttribute('aria-checked'))
        .toBe('false');
      await settings.getByRole('button', { name: '关闭设置' }).click();
      expect(
        await f.page.getByText('正在核对本次数据。', { exact: true }).count(),
      ).toBe(0);
      f.state.events.push(
        event(4, 'assistant.text.completed', {
          replyId: 'final',
          text: '本次核对结果正确。',
        }),
      );
      f.state.messageStatus = 'completed';
      await f.page.reload();
      await f.page.getByText('本次核对结果正确。', { exact: true }).waitFor();
      await process.getByRole('button').click();
      expect(
        await f.page.getByText('正在核对本次数据。', { exact: true }).count(),
      ).toBe(0);
      await openPreferences();
      await toggle.click();
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
      f.state.viewer = id(975);
      await f.page.reload();
      await openPreferences();
      expect(await toggle.getAttribute('aria-checked')).toBe('true');
    } finally {
      await f.close();
    }
  });

  it.each([
    [1440, false],
    [1440, true],
    [390, false],
    [390, true],
  ] as const)(
    'shows persisted work methods after %ipx streaming=%s completion and reload',
    async (width, streamingOutput) => {
      const f = await fixture({
        width,
        touch: width === 390,
        running: true,
        streamingOutput,
      });
      try {
        const methods = f.page.getByRole('group', {
          name: '工作方式',
          exact: true,
        });
        expect(await methods.count()).toBe(0);
        f.state.workMethods = [
          'cloud_search',
          'bridge_files',
          'cloud_compute',
          'bridge_browser',
          'cloud_search',
        ];
        f.finishRun();
        await methods.waitFor();
        const reply = f.page.locator(`#message-${id(20)}`);
        await reply.hover();
        expect(
          await methods.getByText('云端-检索', { exact: true }).count(),
        ).toBe(1);
        expect(
          await methods.getByText('电脑-文件', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await methods.getByText('云端-计算', { exact: true }).count(),
        ).toBe(0);
        const more = methods.getByRole('button', {
          name: '查看全部 4 种工作方式',
        });
        expect(await more.innerText()).toBe('+2');
        if (width === 1440) {
          await more.hover();
          await f.page
            .getByRole('tooltip')
            .getByText(/电脑-浏览器/)
            .waitFor();
        }
        await more.click();
        expect(
          await methods.getByText('云端-计算', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await methods.getByText('电脑-浏览器', { exact: true }).isVisible(),
        ).toBe(true);
        await reply.locator('[data-message-actions]').screenshot({
          path: `/tmp/allrice-work-methods-${width}-${streamingOutput}.png`,
        });
        await f.page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);
        await reply.getByRole('button', { name: '复制', exact: true }).click();
        expect(
          await f.page.evaluate(() => navigator.clipboard.readText()),
        ).toBe(f.state.reply);
        expect(
          await reply.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        ).toBe(true);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        await methods
          .getByRole('button', { name: '收起工作方式' })
          .press('Escape');
        expect(await more.getAttribute('aria-expanded')).toBe('false');
        await more.focus();
        await more.press('Enter');
        expect(
          await methods.getByText('电脑-浏览器', { exact: true }).isVisible(),
        ).toBe(true);
        await f.page.reload();
        await methods.waitFor();
        expect(
          await methods.getByText('云端-检索', { exact: true }).count(),
        ).toBe(1);
        expect(await more.getAttribute('aria-expanded')).toBe('false');
        f.state.workMethods = [];
        await f.page.reload();
        await reply.locator('[data-message-actions]').waitFor();
        expect(await methods.count()).toBe(0);
        expect(f.errors).toEqual([]);
        expect(f.unexpected).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it('MET199 applies all four native display modes and folds only on the next accepted exchange', async () => {
    const f = await fixture({ running: true, streamingOutput: true });
    try {
      const event = (
        sequence: number,
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ): ChatFlowEventEnvelope => ({
        schemaVersion: 3,
        eventId: id(14000 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 1,
        sequence,
        cursor: `${run}:${sequence}`,
        harness: 'dsh',
        occurredAt: now,
        sourceEvent: null,
        type,
        payload,
      });
      f.state.messages = navigationHistory(1);
      const assistant = f.state.messages.at(-1)!;
      assistant.runId = run;
      assistant.status = 'pending';
      assistant.content.text = '';
      f.state.events = [
        event(1, 'assistant.text.delta', {
          replyId: 'start',
          text: '我先核对本次资料。',
        }),
        event(2, 'tool.started', {
          toolCallId: 'read',
          name: 'read',
          summary: '核对客户名单',
        }),
      ];
      f.state.streamEvents = f.state.events;
      f.releaseStream();
      await f.page.reload();
      const process = f.page
        .locator(`#message-${assistant.id}`)
        .getByRole('region', { name: '工作过程', exact: true });
      const processBody = process.locator('..');
      const read = processBody
        .locator('[data-step-id="tool:read"]')
        .getByRole('button', { name: '读取文件', exact: true });
      const detail = processBody
        .locator('[data-step-id="tool:read"]')
        .getByText('核对客户名单', { exact: true });
      await read.click();
      await detail.waitFor();
      const settings = f.page.getByRole('dialog', {
        name: '设置',
        exact: true,
      });
      const set = async (field: string, value: string) => {
        await f.page.getByRole('button', { name: '设置', exact: true }).click();
        await selectSettings(settings, '个人偏好');
        const input = settings.getByRole('combobox', {
          name: field,
          exact: true,
        });
        await expect.poll(() => input.isEnabled()).toBe(true);
        await input.selectOption(value);
        await expect
          .poll(() =>
            settings
              .getByRole('combobox', { name: '工作步骤展示', exact: true })
              .isEnabled(),
          )
          .toBe(true);
        await settings.getByRole('button', { name: '关闭设置' }).click();
      };
      await set('工作步骤展示', 'compact');
      expect(
        await processBody
          .getByRole('region', { name: '工作步骤', exact: true })
          .count(),
      ).toBe(1);
      expect(await detail.isVisible()).toBe(false);
      await set('工作步骤展示', 'standard');
      const group = processBody.getByRole('button', { name: '正在读取文件' });
      await group.click();
      if ((await read.getAttribute('aria-expanded')) !== 'true')
        await read.click();
      await detail.waitFor();
      expect(
        await processBody
          .getByRole('region', { name: '工作步骤', exact: true })
          .count(),
      ).toBe(1);
      await set('工作步骤展示', 'detailed');
      await detail.waitFor();
      expect(
        await processBody.getByRole('button', { name: '正在读取文件' }).count(),
      ).toBe(0);
      await set('工作步骤展示', 'verbose');
      expect(
        await processBody.getByRole('button', { name: '正在读取文件' }).count(),
      ).toBe(0);
      f.state.events.push(
        event(3, 'tool.completed', {
          toolCallId: 'read',
          name: 'read',
          summary: '核对客户名单',
        }),
        event(4, 'assistant.text.completed', {
          replyId: 'answer',
          text: '本次核对完成。',
        }),
      );
      f.state.messageStatus = 'completed';
      assistant.status = 'completed';
      assistant.content.text = '本次核对完成。';
      await f.page.reload();
      await processBody.getByText('本次核对完成。', { exact: true }).waitFor();
      await processBody
        .getByText('我先核对本次资料。', { exact: true })
        .waitFor();
      await set('工作步骤展示', 'detailed');
      expect(
        await processBody
          .getByText('我先核对本次资料。', { exact: true })
          .isVisible(),
      ).toBe(false);
      await set('工作步骤收起时机', 'next-input');
      await processBody
        .getByText('我先核对本次资料。', { exact: true })
        .waitFor();
      // Queue records have not entered the transcript and must not close it.
      f.state.queue.push({
        id: id(14100),
        runId: id(14101),
        text: '排队补充',
        attachments: [],
        createdAt: now,
      });
      await f.page.reload();
      await processBody
        .getByText('我先核对本次资料。', { exact: true })
        .waitFor();
      f.state.messages.push({
        id: id(14102),
        role: 'user',
        runId: null,
        status: 'completed',
        content: { text: '下一轮正式工作' },
        createdAt: now,
      });
      await f.page.reload();
      await processBody.getByText('本次核对完成。', { exact: true }).waitFor();
      expect(
        await processBody
          .getByText('我先核对本次资料。', { exact: true })
          .isVisible(),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('interleaves live public replies with tool steps and restores the same process after reload', async () => {
    const f = await fixture({ running: true, streamingOutput: true });
    try {
      // This regression exercises grouped steps; native detailed now leaves
      // the current exchange ungrouped, while standard retains these groups.
      f.state.preferences[user]!.transcriptView = 'standard';
      const event = (
        sequence: number,
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ): ChatFlowEventEnvelope => ({
        schemaVersion: 3,
        eventId: id(700 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 1,
        sequence,
        cursor: `${run}:${sequence}`,
        harness: 'dsh',
        occurredAt: now,
        sourceEvent: null,
        type,
        payload,
      });
      f.state.events = [
        event(1, 'assistant.text.delta', {
          replyId: 'first',
          text: '我先检查项目目录。',
        }),
        event(2, 'assistant.text.delta', {
          replyId: 'first',
          text: '我先检查项目目录。',
          textMode: 'replace',
        }),
        event(3, 'tool.started', {
          toolCallId: 'read',
          name: 'read',
          summary: '读取入口文件',
        }),
        event(4, 'tool.completed', {
          toolCallId: 'read',
          name: 'read',
          summary: '已读取入口文件',
        }),
        event(5, 'assistant.text.delta', {
          replyId: 'last',
          text: '入口文件已确认。',
        }),
      ];
      f.state.runTimings = [
        {
          runId: run,
          timing: {
            activeMs: 53000,
            waitingMs: 0,
            wallMs: 53000,
            timeoutMs: 3600000,
            remainingMs: 3547000,
            sources: [],
            calls: null,
            phase: 'active',
          },
        },
      ];
      f.state.streamEvents = f.state.events;
      f.releaseStream();
      await f.page.reload();
      const process = f.page.getByRole('region', {
        name: '工作过程',
        exact: true,
      });
      const processBody = process.locator('..');
      await processBody
        .getByText('入口文件已确认。', { exact: true })
        .waitFor();
      expect(
        await f.page.getByText('我先检查项目目录。', { exact: true }).count(),
      ).toBe(1);
      const steps = processBody.getByRole('region', {
        name: '工作步骤',
        exact: true,
      });
      const group = steps.getByRole('button', {
        name: '已读取文件',
        exact: true,
      });
      await group.click();
      await steps
        .locator('[data-step-id="tool:read"]')
        .getByRole('button', { name: '读取文件', exact: true })
        .click();
      const text = await processBody.innerText();
      expect(text.indexOf('已读取入口文件')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('我先检查项目目录。')).toBeLessThan(
        text.indexOf('已读取入口文件'),
      );
      expect(text.indexOf('已读取入口文件')).toBeLessThan(
        text.indexOf('入口文件已确认。'),
      );
      expect(await group.count()).toBe(1);
      expect(await process.getByText('回复中…', { exact: true }).count()).toBe(
        1,
      );
      const timer = process.getByLabel('本轮运行时间');
      await timer.waitFor();
      const gap = await timer.evaluate((el) => {
        const title = el
          .closest('[data-disclosure-header]')
          ?.querySelector('[data-disclosure-row]');
        return title
          ? el.getBoundingClientRect().left -
              title.getBoundingClientRect().right
          : -1;
      });
      expect(gap).toBeGreaterThanOrEqual(12);
      // Same partial reply followed by native compaction: one status, never a
      // second turn header inside the streamed body or a stale "replying".
      f.state.events.push(
        event(6, 'harness.native', {
          presentation: 'compaction',
          status: 'started',
          label: '正在整理上下文',
        }),
      );
      await f.page.reload();
      await process.getByText('正在整理对话…', { exact: true }).waitFor();
      expect(
        await f.page.getByText('正在整理对话…', { exact: true }).count(),
      ).toBe(1);
      expect(await process.getByText('回复中…', { exact: true }).count()).toBe(
        0,
      );
      await f.page.screenshot({
        path: '/tmp/allrice-native-status-compaction.png',
      });
      f.state.events.pop();
      f.state.events.push(
        event(6, 'assistant.text.completed', {
          replyId: 'last',
          text: '入口文件已确认。',
        }),
      );
      f.state.messageStatus = 'completed';
      f.state.runTimings[0]!.timing.phase = 'terminal';
      await f.page.reload();
      await f.page.getByText('入口文件已确认。', { exact: true }).waitFor();
      expect(
        await processBody
          .getByText('我先检查项目目录。', { exact: true })
          .isVisible(),
      ).toBe(false);
      await process.getByRole('button', { name: /^工作过程/ }).click();
      await processBody
        .getByText('我先检查项目目录。', { exact: true })
        .waitFor();
      await group.click();
      expect(
        await processBody
          .getByText('我先检查项目目录。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await processBody
          .getByText('入口文件已确认。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await f.page.getByText('入口文件已确认。', { exact: true }).count(),
      ).toBe(1);
      expect(
        await processBody.getByRole('list', { name: '工作步骤' }).count(),
      ).toBe(1);
    } finally {
      await f.close();
    }
  }, 30000);

  it('composer status follows native compaction without exposing context usage', async () => {
    const f = await fixture({
      running: true,
      controlledStream: true,
      width: 390,
      touch: true,
    });
    try {
      await f.page.evaluate(() =>
        document.body.setAttribute('data-ds-dark-theme', ''),
      );
      await f.page.waitForFunction(
        () => document.documentElement.dataset.streamReady === 'true',
      );
      const computer = f.page.getByRole('button', {
        name: '电脑未连接，点击查看如何连接',
        exact: true,
      });
      const status = computer.locator('xpath=../..');
      const tidying = status.getByRole('status');
      const draft = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await draft.fill('整理完后，请继续刚才的工作');
      const emit = async (
        sourceType: string,
        payload: ChatFlowEventEnvelope['payload'],
        sourcePayload: Record<string, unknown>,
        type: ChatFlowEventEnvelope['type'] = 'harness.native',
      ) => {
        const sequence = f.state.events.length + 1;
        const event: ChatFlowEventEnvelope = {
          schemaVersion: 3,
          eventId: id(9900 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          cursor: `${run}:${sequence}`,
          sequence,
          harness: 'dsh',
          occurredAt: now,
          type,
          sourceEvent: {
            id: `dsh:${sequence}`,
            type: sourceType,
            occurredAt: now,
            payload: sourcePayload,
          },
          payload,
        };
        f.state.events.push(event);
        await f.page.evaluate(
          (body) =>
            window.dispatchEvent(
              new CustomEvent('allrice-test-stream', { detail: body }),
            ),
          `data: ${JSON.stringify(event)}\n\n`,
        );
      };
      await emit(
        'session/projection',
        { presentation: 'context', status: 'info', label: '上下文占用' },
        { projectedTokens: 164000, contextWindow: 200000, asOfSeq: 1 },
      );
      for (const terminal of ['completed', 'failed'] as const) {
        const compactionId = `compact-${terminal}`;
        await emit(
          'compaction/start',
          {
            presentation: 'compaction',
            status: 'started',
            label: '正在整理上下文',
          },
          { compactionId },
        );
        await expect
          .poll(() => tidying.innerText())
          .toBe('正在整理对话，完成后继续');
        expect(await tidying.locator('svg').getAttribute('aria-hidden')).toBe(
          'true',
        );
        expect(await status.innerText()).not.toMatch(
          /Bridge|上下文占用|DSH|tokens|%/i,
        );
        expect(await draft.inputValue()).toBe('整理完后，请继续刚才的工作');
        expect(await computer.isEnabled()).toBe(true);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await emit(
          'compaction/end',
          {
            presentation: 'compaction',
            status: terminal,
            label: '上下文整理结束',
          },
          { compactionId },
        );
        // The live region stays mounted and empties, so the next notice is read.
        await expect.poll(() => tidying.textContent()).toBe('');
      }
      f.state.messageStatus = 'completed';
      await emit('run/succeeded', {}, {}, 'run.succeeded');
      await f.page.getByRole('button', { name: '发送', exact: true }).waitFor();
      expect(await status.innerText()).toBe('电脑未连接');
      expect(await draft.inputValue()).toBe('整理完后，请继续刚才的工作');
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('native task plan streams, restores, clears and stays scoped without animating stopped work', async () => {
    const f = await fixture({ running: true, controlledStream: true });
    try {
      const ready = () =>
        f.page.waitForFunction(
          () => document.documentElement.dataset.streamReady === 'true',
        );
      const emit = async (event: ChatFlowEventEnvelope) => {
        await ready();
        await f.page.evaluate(
          (body) =>
            window.dispatchEvent(
              new CustomEvent('allrice-test-stream', { detail: body }),
            ),
          `data: ${JSON.stringify(event)}\n\n`,
        );
      };
      const push = async (
        todos: unknown,
        type: ChatFlowEventEnvelope['type'] = 'harness.native',
      ) => {
        const sequence = f.state.events.length + 1;
        const event: ChatFlowEventEnvelope = {
          schemaVersion: 3,
          eventId: id(8800 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          cursor: `${run}:${sequence}`,
          sequence,
          harness: 'dsh',
          occurredAt: now,
          type,
          sourceEvent: {
            id: `dsh:${sequence}`,
            type: 'todo/write',
            occurredAt: now,
            payload: { todos },
          },
          payload: {
            generation: 1,
            attempt: 1,
            presentation: 'todo',
            label: '任务计划已更新',
          },
        };
        f.state.events.push(event);
        await emit(event);
      };
      const panel = f.page.getByTestId('todo-panel');
      expect(await panel.count()).toBe(0);
      const todos = [
        { content: '核对资料', status: 'completed' },
        { content: '生成演示文件', status: 'in_progress' },
        { content: '检查交付文件', status: 'pending' },
      ];
      await push(todos);
      await panel.waitFor();
      expect(await panel.innerText()).toContain('1 已完成');
      expect(await panel.innerText()).toContain('1 进行中');
      expect(
        await panel.getByRole('button').getAttribute('aria-expanded'),
      ).toBe('false');
      await panel.getByRole('button').click();
      expect(await panel.getByRole('listitem').count()).toBe(3);
      expect(await panel.locator('[data-state="ongoing"]').count()).toBe(1);
      const draft = f.page.getByRole('textbox', { name: /^给 .+ 的消息$/ });
      await draft.fill('保留未发送草稿');
      await push([
        ...todos.slice(0, 2),
        { content: '检查新版文件', status: 'pending' },
      ]);
      await panel.getByText('检查新版文件', { exact: true }).waitFor();
      expect(await draft.inputValue()).toBe('保留未发送草稿');
      expect(
        await draft.evaluate((node) => document.activeElement === node),
      ).toBe(true);
      // Replayed snapshots do not collapse the native panel or duplicate its rows.
      await emit(f.state.events[0]!);
      expect(await panel.getByRole('listitem').count()).toBe(3);
      expect(
        await panel.getByRole('button').getAttribute('aria-expanded'),
      ).toBe('true');
      await f.page.setViewportSize({ width: 390, height: 844 });
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await panel.boundingBox())!.width).toBeGreaterThan(200);
      await f.page.screenshot({ path: '.local/task-plan/mobile.png' });
      await f.page.setViewportSize({ width: 1440, height: 950 });
      f.state.runTimings = [
        {
          runId: run,
          timing: {
            activeMs: 2000,
            waitingMs: 1000,
            wallMs: 3000,
            timeoutMs: 3600000,
            remainingMs: 3598000,
            phase: 'waiting',
            sources: [],
            calls: null,
          },
        },
      ];
      await f.page.reload();
      for (const event of f.state.events) await emit(event);
      await panel.getByRole('button').click();
      await expect.poll(() => panel.innerText()).toContain('等待继续');
      expect(await panel.locator('[data-state="ongoing"]').count()).toBe(0);
      // The authoritative clock can settle before the final SSE receipt arrives.
      f.state.runTimings[0]!.timing.phase = 'terminal';
      await expect
        .poll(() => panel.innerText(), { timeout: 10_000 })
        .toContain('未完成');
      f.state.messageStatus = 'failed';
      await push(undefined, 'run.failed');
      await expect.poll(() => panel.innerText()).toContain('未完成');
      expect(await panel.locator('[data-state="ongoing"]').count()).toBe(0);
      await f.page.reload();
      await panel.getByRole('button').click();
      await panel.getByText('检查新版文件', { exact: true }).waitFor();
      expect(await panel.innerText()).toContain('未完成');
      await f.page.screenshot({ path: '.local/task-plan/stopped.png' });
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      await expect.poll(() => panel.count()).toBe(0);
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      await panel.waitFor();
      // Explicit clearing survives a full history read.
      const last = f.state.events[0]!;
      f.state.events.push({
        ...last,
        eventId: id(8999),
        sequence: 999,
        sourceEvent: { ...last.sourceEvent!, payload: { todos: [] } },
      });
      await f.page.reload();
      await expect.poll(() => panel.count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it.each(['compact', 'detailed'] as const)(
    'shows the actual profile receipt beside the settled reply without opening process details in %s mode',
    async (transcriptView) => {
      const f = await fixture({ streamingOutput: true });
      const receipt =
        '已保存默认表达方式：简洁。下个任务起生效，你可以再说一句改回去。';
      try {
        f.state.preferences[user]!.transcriptView = transcriptView;
        f.state.reply = '好的。';
        const event = (
          sequence: number,
          type: ChatFlowEventEnvelope['type'],
          payload: Record<string, unknown>,
          confirmed = false,
        ): ChatFlowEventEnvelope => ({
          schemaVersion: 3,
          eventId: id(9130 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence,
          cursor: `${run}:${sequence}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: confirmed
            ? {
                id: `dsh:${sequence}`,
                type: 'tool/result',
                occurredAt: now,
                payload: { employeeProfileReceipt: true },
              }
            : null,
          type,
          payload,
        });
        f.state.events = [
          event(
            1,
            'tool.completed',
            {
              toolCallId: 'profile-save',
              name: 'workspace.employee.profile.update',
              summary: receipt,
            },
            true,
          ),
          event(2, 'tool.failed', {
            toolCallId: 'profile-unknown',
            name: 'workspace.employee.profile.update',
            summary: '未确认的保存结果',
          }),
          event(3, 'tool.completed', {
            toolCallId: 'other-tool',
            name: 'web.search',
            summary: '别的工具结果',
          }),
          event(4, 'assistant.text.completed', {
            replyId: 'final',
            text: f.state.reply,
          }),
        ];
        await f.page.reload();
        const saved = f.page.getByRole('status', { name: '个人设置保存回执' });
        await saved.waitFor({ state: 'visible' });
        expect(await saved.count()).toBe(1);
        expect(await saved.innerText()).toBe(receipt);
        expect(
          await saved.evaluate(
            (node) => node.closest('[data-process-open]') === null,
          ),
        ).toBe(true);
        expect(
          await f.page
            .getByRole('region', { name: '工作过程', exact: true })
            .getAttribute('data-process-open'),
        ).toBe('false');
        await f.page
          .getByText('好的。', { exact: true })
          .waitFor({ state: 'visible' });
      } finally {
        await f.close();
      }
    },
  );

  it('keeps native tool summaries and receipt details in reply order without duplicate pending text', async () => {
    const f = await fixture({
      running: true,
      streamingOutput: true,
      controlledStream: true,
    });
    f.state.preferences[user]!.transcriptView = 'standard';
    const operations = ['first', 'second'].map((nativeCallId, index) => ({
      nativeCallId,
      createdAt: now,
      snapshot: {
        status: index === 0 ? 'succeeded' : 'running',
        binding: {
          action: 'cloud.mcp.call',
          task: operationTask(),
          attempt: { operationId: id(8990 + index), generation: 1 },
        },
      },
      enabled: true,
      mcpAuthorization: { available: true, reason: 'available' },
      proposal: {
        kind: 'mcp',
        endpoint: 'https://example.test/mcp',
        tool: 'mcp__app__list_pull_requests',
        arguments: { page: index + 1 },
        risk: 'read',
      },
      approval: null,
      result: null,
    }));
    try {
      await f.page.route('**/api/v1/runtime/cloud-operations?**', (route) =>
        route.fulfill({ json: { operations } }),
      );
      await f.page.reload();
      await f.page.waitForFunction(
        () => document.documentElement.dataset.streamReady === 'true',
      );
      const push = async (
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ) => {
        const sequence = f.state.events.length + 1;
        const event: ChatFlowEventEnvelope = {
          schemaVersion: 3,
          eventId: id(9100 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence,
          cursor: `${run}:${sequence}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type,
          payload,
        };
        f.state.events.push(event);
        await f.page.evaluate(
          (body) =>
            window.dispatchEvent(
              new CustomEvent('allrice-test-stream', { detail: body }),
            ),
          `data: ${JSON.stringify(event)}\n\n`,
        );
      };
      await push('assistant.text.delta', {
        replyId: 'intro',
        text: '先核对两页记录。',
      });
      await push('tool.completed', {
        toolCallId: 'first',
        name: 'cloud.mcp.call',
        summary: '第一次读取完成',
      });
      await push('assistant.text.delta', {
        replyId: 'middle',
        text: '第一页已核对，再读取第二页。',
      });
      await push('tool.started', {
        toolCallId: 'second',
        name: 'cloud.mcp.call',
      });
      const first = f.page.locator(
          `[data-process-material="cloud:${id(8990)}"]`,
        ),
        second = f.page.locator(`[data-process-material="cloud:${id(8991)}"]`);
      const groups = f.page.locator('section[aria-label="工作步骤"]');
      const readHistory = async (secondRunning = false) => {
        expect(await groups.count()).toBe(2);
        for (const [index, group] of (await groups.all()).entries()) {
          const title =
            secondRunning && index === 1 ? '正在调用工具' : '已调用工具';
          const summary = group.getByRole('button').filter({
            has: f.page.getByText(title, { exact: true }),
          });
          if ((await summary.getAttribute('aria-expanded')) === 'false')
            await summary.click();
          const steps = group.getByRole('list', { name: '工作步骤' });
          await steps.waitFor();
          expect(await steps.locator('li').count()).toBe(1);
          expect(
            await steps
              .locator('[data-disclosure-header]')
              .getByText('进行中', { exact: true })
              .count(),
          ).toBe(0);
        }
        for (const call of ['first', 'second']) {
          const step = f.page.locator(`[data-step-id="tool:${call}"]`);
          expect(await step.count()).toBe(1);
          const toggle = step.locator('[data-disclosure-row]');
          if ((await toggle.getAttribute('aria-expanded')) === 'false')
            await toggle.click();
        }
      };
      await readHistory(true);
      await second.waitFor();
      await push('assistant.text.delta', {
        replyId: 'final',
        text: '两页记录核对结束，最终结论在这里。',
      });
      const final = f.page.locator('[data-work-reply="reply:final"]');
      await final.waitFor();
      const middle = f.page.locator('[data-work-reply="reply:middle"]');
      expect((await first.boundingBox())!.y).toBeLessThan(
        (await middle.boundingBox())!.y,
      );
      expect((await middle.boundingBox())!.y).toBeLessThan(
        (await second.boundingBox())!.y,
      );
      expect((await second.boundingBox())!.y).toBeLessThan(
        (await final.boundingBox())!.y,
      );
      // One running operation fact; the native title keeps its own status.
      const inProgress = f.page
        .getByRole('region', { name: '工作过程', exact: true })
        .locator('..')
        .getByText('进行中', { exact: true })
        .filter({ visible: true });
      expect(await inProgress.count()).toBe(1);
      expect(
        await f.page
          .locator('[data-step-id="tool:second"]')
          .getAttribute('data-status'),
      ).toBe('运行中');
      expect(await groups.last().innerText()).toContain('使用已连接的服务');
      expect(
        JSON.parse(
          (await first
            .locator('[data-process-content="input"]')
            .textContent())!,
        ).arguments,
      ).toEqual({ page: 1 });
      expect(
        JSON.parse(
          (await second
            .locator('[data-process-content="input"]')
            .textContent())!,
        ).arguments,
      ).toEqual({ page: 2 });
      expect(await second.getByRole('button').count()).toBe(0);
      operations[1]!.snapshot.status = 'succeeded';
      await push('tool.completed', {
        toolCallId: 'second',
        name: 'cloud.mcp.call',
      });
      f.state.messageStatus = 'completed';
      f.state.reply = '两页记录核对结束，最终结论在这里。';
      await push('assistant.text.completed', {
        replyId: 'final',
        text: f.state.reply,
      });
      await push('run.succeeded', {});
      await f.page.getByRole('button', { name: /工作过程/ }).click();
      await readHistory();
      await second.waitFor();
      expect((await second.boundingBox())!.y).toBeLessThan(
        (await final.boundingBox())!.y,
      );
      expect(
        await final.evaluate(
          (node) => node.closest('[aria-label="工作过程"]') === null,
        ),
      ).toBe(true);
      await f.page.screenshot({ path: '/tmp/allrice-timeline-order.png' });
      await f.page.reload();
      await final.waitFor();
      await f.page.getByRole('button', { name: /工作过程/ }).click();
      await readHistory();
      await second.waitFor();
      expect(await first.count()).toBe(1);
      expect(await second.count()).toBe(1);
      expect(await groups.count()).toBe(2);
      expect(
        await groups.last().getByRole('list', { name: '工作步骤' }).isVisible(),
      ).toBe(true);
      expect((await first.boundingBox())!.y).toBeLessThan(
        (await middle.boundingBox())!.y,
      );
      expect((await middle.boundingBox())!.y).toBeLessThan(
        (await second.boundingBox())!.y,
      );
      expect((await second.boundingBox())!.y).toBeLessThan(
        (await final.boundingBox())!.y,
      );
    } finally {
      await f.close();
    }
  });

  it.each([1440, 1024, 390])(
    'keeps the pending reply above the composer immediately after sending at %ipx',
    async (width) => {
      const f = await fixture({ width, controlledStream: true });
      let admit!: () => void;
      const admission = new Promise<void>((resolve) => {
        admit = resolve;
      });
      try {
        if (width === 1024)
          await f.page.setViewportSize({ width, height: 600 });
        f.state.messages = [];
        await f.page.reload();
        await f.page.route(
          '**/api/v1/sessions/*/messages?**',
          async (route) => {
            if (route.request().method() !== 'POST') return route.fallback();
            await admission;
            const body = route.request().postDataJSON();
            f.state.messages = [
              {
                id: id(300),
                role: 'user',
                content: { text: body.text },
                status: 'completed',
                runId: run,
                createdAt: now,
              },
              {
                id: id(500),
                role: 'assistant',
                content: { text: '' },
                status: 'pending',
                runId: run,
                createdAt: now,
              },
            ];
            f.state.historyRunning = true;
            return route.fallback();
          },
        );
        const input = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
        await input.fill(
          '我准备写一个 AllRice 的对外介绍，请给我一个 10 页左右的 PPT 大纲。\n' +
            Array.from(
              { length: 12 },
              (_, n) => `第 ${n + 1} 项：说明产品、使用场景和交付方式。`,
            ).join('\n'),
        );
        await input.press('Enter');
        const pending = f.page.locator('[id^="message-optimistic-assistant:"]');
        await pending.waitFor();
        await f.page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const geometry = await f.page.evaluate(() => {
          const scroll = document.querySelector('[data-conversation-scroll]')!;
          const reply = document.querySelector(
            '[id^="message-optimistic-assistant:"]',
          )!;
          const composer = document.querySelector('[data-composer-seat]')!;
          return {
            distance:
              scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
            replyTop: reply.getBoundingClientRect().top,
            replyBottom: reply.getBoundingClientRect().bottom,
            composerTop: composer.getBoundingClientRect().top,
          };
        });
        const evidence = process.env.ALLRICE_SCROLL_QA_EVIDENCE_DIR;
        if (evidence) {
          await f.page.screenshot({ path: `${evidence}/pending-${width}.png` });
          await writeFile(
            `${evidence}/pending-${width}.json`,
            JSON.stringify(geometry, null, 2),
          );
        }
        expect(geometry.distance).toBeLessThan(2);
        expect(geometry.replyBottom).toBeLessThanOrEqual(
          geometry.composerTop + 1,
        );
        admit();
        const accepted = f.page.locator(`#message-${id(500)}`);
        await accepted.waitFor();
        await f.page.waitForFunction(
          () => document.documentElement.dataset.streamReady === 'true',
        );
        await expect
          .poll(async () => {
            const reply = (await accepted.boundingBox())!;
            const seat = (await f.page
              .locator('[data-composer-seat]')
              .boundingBox())!;
            return reply.y + reply.height - seat.y;
          })
          .toBeLessThanOrEqual(1);
        if (evidence)
          await f.page.screenshot({
            path: `${evidence}/accepted-${width}.png`,
          });
      } finally {
        admit();
        await f.close();
      }
    },
    30_000,
  );

  it('native streaming preserves settled paragraphs and reading position across deltas and completion', async () => {
    const f = await fixture({
      running: true,
      streamingOutput: true,
      controlledStream: true,
    });
    try {
      await f.page.waitForFunction(
        () => document.documentElement.dataset.streamReady === 'true',
      );
      const push = async (
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
      ) => {
        const sequence = f.state.events.length + 1;
        const event: ChatFlowEventEnvelope = {
          schemaVersion: 3,
          eventId: id(800 + sequence),
          organizationId: org,
          workspaceId: workspace,
          conversationId: A,
          runId: run,
          generation: 1,
          sequence,
          cursor: `${run}:${sequence}`,
          harness: 'dsh',
          occurredAt: now,
          sourceEvent: null,
          type,
          payload,
        };
        f.state.events.push(event);
        await f.page.evaluate(
          (body) =>
            window.dispatchEvent(
              new CustomEvent('allrice-test-stream', { detail: body }),
            ),
          `data: ${JSON.stringify(event)}\n\n`,
        );
      };
      await push('assistant.text.delta', {
        replyId: 'first',
        text: '我先读取资料。',
      });
      const preamble = f.page.getByText('我先读取资料。', { exact: true });
      await preamble.waitFor();
      const preambleNode = await preamble.elementHandle();
      await push('tool.completed', {
        toolCallId: 'read',
        name: 'read',
        summary: '已读取报告',
      });
      await f.page.locator('[data-step-id="tool:read"]').waitFor();
      expect(await preambleNode!.evaluate((node) => node.isConnected)).toBe(
        true,
      );
      let text =
        '固定首段。\n\n' +
        Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段分析。`).join(
          '\n\n',
        ) +
        '\n\n正在汇总';
      await push('assistant.text.delta', { replyId: 'last', text });
      const reply = f.page.locator('[data-work-reply="reply:last"]');
      await reply.getByText('固定首段。', { exact: true }).waitFor();
      const firstParagraph = await reply
        .getByText('固定首段。', { exact: true })
        .elementHandle();
      const scroll = f.page.locator('[data-conversation-scroll]');
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      for (let i = 1; i <= 3; i++) {
        const delta = `，追加结果 ${i}`;
        text += delta;
        await push('assistant.text.delta', { replyId: 'last', text: delta });
        await expect.poll(() => reply.innerText()).toContain(delta);
        expect(
          await firstParagraph!.evaluate((element) => element.isConnected),
        ).toBe(true);
        expect(
          await scroll.evaluate((element) => element.scrollTop),
        ).toBeLessThan(20);
      }
      f.state.messageStatus = 'completed';
      f.state.reply = text;
      await push('assistant.text.completed', { replyId: 'last', text });
      await push('run.succeeded', {});
      await expect
        .poll(() =>
          f.page
            .locator(`#message-${id(20)}`)
            .getByRole('button', { name: '复制', exact: true })
            .count(),
        )
        .toBe(1);
      expect(
        await firstParagraph!.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(
        await f.page.getByText('固定首段。', { exact: true }).count(),
      ).toBe(1);
      expect(
        await f.page.getByText('我先读取资料。', { exact: true }).isVisible(),
      ).toBe(false);
      expect(
        await scroll.evaluate((element) => element.scrollTop),
      ).toBeLessThan(20);
    } finally {
      await f.close();
    }
  });

  it('does not query local MCP status or expose technical errors for ordinary and cloud-only replies', async () => {
    for (const width of [1440, 390]) {
      const f = await fixture({ width, localMcp: true });
      let reads = 0;
      try {
        await f.page.route('**/api/v1/runtime/local-mcp?**', (route) => {
          reads++;
          return route.fulfill({ status: 503, json: {} });
        });
        f.state.reply = '付款总额 4286.30 元，剩余预算 4213.70 元。';
        for (const cloudOnly of [false, true]) {
          f.state.events = cloudOnly
            ? [
                {
                  schemaVersion: 3,
                  eventId: id(9400),
                  organizationId: org,
                  workspaceId: workspace,
                  conversationId: A,
                  runId: run,
                  generation: 1,
                  sequence: 1,
                  cursor: `${run}:1`,
                  harness: 'dsh',
                  occurredAt: now,
                  sourceEvent: null,
                  type: 'tool.completed',
                  payload: { name: 'cloud.mcp.call', toolCallId: 'cloud-only' },
                },
              ]
            : [];
          await Promise.all([
            f.page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith('/events'),
            ),
            f.page.reload(),
          ]);
          await f.page.getByText(f.state.reply, { exact: true }).waitFor();
          expect(reads).toBe(0);
          expect(
            await f.page.getByRole('region', { name: '电脑工具操作' }).count(),
          ).toBe(0);
          expect(await f.page.getByText('本地 MCP 状态读取失败').count()).toBe(
            0,
          );
        }
        if (process.env.ALLRICE_LOCAL_MCP_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_LOCAL_MCP_SCREENSHOT}-ordinary-${width}.png`,
          });
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }
  });

  it('keeps real local tool status failures readable and retains approval and stop controls', async () => {
    for (const width of [1440, 390]) {
      const f = await fixture({ width, localMcp: true });
      let failing = true;
      const decisions: string[] = [];
      const operation = {
        snapshot: {
          status: 'waiting_user',
          binding: {
            action: 'local.mcp.discover',
            task: operationTask(),
            attempt: { operationId: id(9401) },
          },
        },
        deviceName: '测试电脑',
        payload: {
          capability: 'local.mcp.discover',
          arguments: {
            connectionId: id(9402),
            connectionRevision: 1,
            deviceId: id(9403),
            path: 'tools',
            credential: null,
            imageDigest: `sha256:${'a'.repeat(64)}`,
            source: {
              name: '资料整理工具',
              version: '1.0.0',
              entrypoint: 'server.js',
              files: [],
            },
            limits: { timeoutMs: 30000 },
          },
        },
        approval: {
          request: {
            approvalId: id(9404),
            requestId: id(9405),
            version: 1,
            requestDigest: `sha256:${'b'.repeat(64)}`,
            task: operationTask(),
            respondentId: user,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          response: null as null | { decision: string },
          revokedAt: null,
        },
        evidence: null,
      };
      try {
        await f.page.route('**/api/v1/runtime/local-mcp?**', async (route) => {
          if (route.request().method() === 'POST') {
            decisions.push('cancel');
            operation.snapshot.status = 'canceled';
            return route.fulfill({ json: {} });
          }
          return failing
            ? route.fulfill({
                status: 503,
                json: { code: 'LOCAL_MCP_UNAVAILABLE' },
              })
            : route.fulfill({ json: { operations: [operation] } });
        });
        await f.page.route(
          `**/api/v1/runtime/approvals/${id(9404)}`,
          async (route) => {
            const { decision } = route.request().postDataJSON();
            decisions.push(decision);
            operation.approval.response = { decision };
            operation.snapshot.status = 'running';
            return route.fulfill({ json: {} });
          },
        );
        f.state.reply = '正在准备电脑上的资料整理工具。';
        f.state.events = [
          {
            schemaVersion: 3,
            eventId: id(9406),
            organizationId: org,
            workspaceId: workspace,
            conversationId: A,
            runId: run,
            generation: 1,
            sequence: 1,
            cursor: `${run}:1`,
            harness: 'dsh',
            occurredAt: now,
            type: width === 1440 ? 'tool.started' : 'harness.native',
            payload:
              width === 1440
                ? { name: 'local.mcp.discover' }
                : { presentation: 'tool' },
            sourceEvent:
              width === 1440
                ? null
                : {
                    id: 'native-local-tool',
                    type: 'tool_execution_start',
                    occurredAt: now,
                    payload: { toolName: 'local_mcp_discover' },
                  },
          },
        ];
        await f.page.reload();
        const panel = f.page.getByRole('region', { name: '电脑工具操作' });
        const feedback = f.page
          .locator(`#message-${id(20)}`)
          .getByRole('alert');
        await feedback.waitFor();
        expect(await feedback.innerText()).toContain(
          '暂时无法更新电脑操作状态，请稍后重试。',
        );
        expect(await f.page.getByText('本地 MCP 状态读取失败').count()).toBe(0);
        expect(await f.page.getByText('LOCAL_MCP_UNAVAILABLE').count()).toBe(0);
        if (process.env.ALLRICE_LOCAL_MCP_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_LOCAL_MCP_SCREENSHOT}-operation-${width}.png`,
          });
        expect(decisions).toEqual([]);
        failing = false;
        await feedback
          .getByRole('button', { name: '刷新', exact: true })
          .click();
        const approve = panel.getByRole('button', {
          name: '批准这一次启动发现',
        });
        await approve.waitFor();
        expect(decisions).toEqual([]);
        await approve.click();
        await panel.getByRole('button', { name: '停止本轮任务' }).click();
        const owner = f.page.locator(`#message-${id(20)}`);
        await owner
          .getByRole('region', { name: '工作过程', exact: true })
          .getByRole('button', { name: '工作过程', exact: true })
          .click();
        const stopped = owner.locator(
          `[data-step-id="operation:mcp:${id(9401)}"]`,
        );
        await stopped
          .locator('[data-disclosure-header]')
          .getByText('已确认停止', { exact: true })
          .waitFor();
        expect(await stopped.getAttribute('data-status')).toBe('已确认停止');
        await stopped.locator('[data-disclosure-row]').click();
        expect(
          await stopped
            .locator(`[data-process-material="mcp:${id(9401)}"]`)
            .isVisible(),
        ).toBe(true);
        expect(await panel.locator(`#operation-${id(9401)}`).count()).toBe(0);
        expect(decisions).toEqual(['approved', 'cancel']);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    }
  });

  it('offers a bounded read retry only after a status read failure and preserves unknown outcomes', async () => {
    const f = await fixture();
    let reads = 0,
      writes = 0,
      failing = true,
      hold = false;
    let finishRead: (() => Promise<void>) | undefined;
    const unknown = {
      nativeCallId: 'missing-result',
      createdAt: now,
      snapshot: {
        status: 'unknown',
        binding: {
          action: 'cloud.mcp.call',
          task: operationTask(),
          attempt: { operationId: id(9890) },
        },
      },
      enabled: true,
      mcpAuthorization: { available: true, reason: 'available' },
      proposal: {
        kind: 'mcp',
        endpoint: 'https://example.test/mcp',
        tool: 'mcp__app__list_pull_requests',
        arguments: {},
        risk: 'read',
      },
      approval: null,
      result: null,
    };
    try {
      await f.page.route(
        '**/api/v1/runtime/cloud-operations?**',
        async (route) => {
          if (route.request().method() !== 'GET') {
            writes++;
            return route.abort();
          }
          reads++;
          if (failing) return route.fulfill({ status: 503, json: {} });
          const finish = () =>
            route.fulfill({ json: { operations: [unknown] } });
          if (hold) {
            await new Promise<void>((resolve) => {
              finishRead = async () => {
                await finish();
                resolve();
              };
            });
          } else await finish();
        },
      );
      await f.page.reload();
      const retry = f.page.getByRole('button', { name: '重试读取操作状态' });
      await retry.waitFor();
      const firstReads = reads;
      expect(
        await retry.evaluate((node) => getComputedStyle(node).fontSize),
      ).toBe('13px');
      await retry.click();
      await expect.poll(() => reads).toBe(firstReads + 1);
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(
        await f.page
          .getByText('暂时读不到操作状态', { exact: true })
          .isVisible(),
      ).toBe(true);
      failing = false;
      hold = true;
      await retry.click();
      await expect.poll(() => Boolean(finishRead)).toBe(true);
      expect(await retry.isDisabled()).toBe(true);
      expect(await retry.innerText()).toBe('读取中…');
      await finishRead!();
      await f.page
        .getByText('已刷新，结果仍待确认。', { exact: true })
        .waitFor();
      expect(await retry.count()).toBe(0);
      expect(
        await f.page.getByRole('button', { name: '刷新操作状态' }).count(),
      ).toBe(0);
      expect(unknown.snapshot.status).toBe('unknown');
      expect(writes).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('ticks elapsed time every second between server samples, including waits, and settles to the final receipt', async () => {
    const f = await fixture({ running: true });
    try {
      f.state.runTimings = [
        {
          runId: run,
          timing: {
            activeMs: 17000,
            waitingMs: 0,
            wallMs: 17000,
            timeoutMs: 3600000,
            remainingMs: 3583000,
            phase: 'active',
            sources: [],
            calls: null,
          },
        },
      ];
      await f.page.clock.install();
      await f.page.reload();
      const timing = f.page.getByLabel('本轮运行时间', { exact: true });
      await timing.waitFor();
      expect(await timing.innerText()).toBe('用时 17秒');
      const motion = () =>
        f.page.evaluate(() => {
          const reply = document.querySelector(
            '[data-actions-reveal="hover"]',
          )!;
          const avatar = reply.querySelector('[class*="assistantIdentity"] i')!;
          const header = reply.querySelector(
            '[aria-label="工作过程"] [data-disclosure-row]',
          )!;
          return [avatar, header].map((element) => ({
            name: getComputedStyle(element).animationName,
            duration: getComputedStyle(element).animationDuration,
            opacity: Number(getComputedStyle(element).opacity),
          }));
        });
      const [avatarMotion, headerMotion] = await motion();
      expect(avatarMotion!.name).not.toBe('none');
      expect(headerMotion!.name).toBe('none');
      expect(headerMotion!.opacity).toBe(1);
      expect(
        await f.page.locator('[aria-label="工作过程"] [data-shimmer]').count(),
      ).toBe(1);
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      expect((await motion()).map((item) => item.name)).toEqual([
        'none',
        'none',
      ]);
      await f.page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const seconds of [18, 19, 20]) {
        await f.page.clock.runFor(1000);
        await expect.poll(() => timing.innerText()).toBe(`用时 ${seconds}秒`);
      }
      // Server updates do not reset the display interval or make it run backwards.
      f.state.runTimings[0]!.timing.phase = 'waiting';
      f.state.runTimings[0]!.timing.wallMs = 19000;
      await f.page.clock.runFor(2000);
      await expect.poll(() => timing.innerText()).toBe('用时 22秒');
      // The local clock can tick before the server phase receipt commits.
      await expect
        .poll(async () => (await motion()).map((item) => item.name))
        .toEqual(['none', 'none']);
      expect(f.state.runTimings[0]!.timing.activeMs).toBe(17000);
      f.state.runTimings[0]!.timing.phase = 'terminal';
      f.state.runTimings[0]!.timing.wallMs = 22500;
      await f.page.clock.runFor(2000);
      await expect.poll(() => timing.innerText()).toBe('用时 22秒');
      await f.page.clock.runFor(5000);
      expect(await timing.innerText()).toBe('用时 22秒');
      f.state.runTimings[0]!.timing.phase = 'queued';
      f.state.runTimings[0]!.timing.wallMs = 0;
      await f.page.reload();
      await timing.waitFor();
      await f.page.clock.runFor(3000);
      expect(await timing.innerText()).toBe('用时 0秒');
    } finally {
      await f.close();
    }
  }, 30000);

  it.each([false, true])(
    'shows ordinary task timing on mobile with workbench disabled=%s, refreshes server waits and recovers from a failed read',
    async (disabled) => {
      const f = await fixture({ width: 390, disabled });
      try {
        f.state.runTimings = [
          {
            runId: run,
            timing: {
              activeMs: 12460,
              waitingMs: 10532,
              wallMs: 22992,
              timeoutMs: 3600000,
              remainingMs: 3587540,
              phase: 'waiting',
              sources: [{ scope: 'user', timeoutMs: 3600000 }],
              calls: { modelRequests: 2, toolCalls: 1, pending: 1 },
            },
          },
        ];
        await f.page.reload();
        const timing = f.page.getByLabel('本轮运行时间', { exact: true });
        const process = f.page.getByRole('region', {
          name: '工作过程',
          exact: true,
        });
        await timing.waitFor();
        expect(await process.getByRole('button').count()).toBe(0);
        expect(await process.locator('[aria-expanded]').count()).toBe(0);
        expect(await timing.innerText()).toContain('用时 22秒');
        expect(await process.innerText()).not.toContain('累计等待');
        expect(await timing.count()).toBe(1);
        expect(await process.innerText()).not.toContain('模型请求');
        f.state.runTimings[0]!.timing.waitingMs = 2400000;
        f.state.runTimings[0]!.timing.wallMs = 2412460;
        await expect
          .poll(() => timing.innerText(), { timeout: 5000 })
          .toContain('用时 40分 12秒');
        expect(await timing.innerText()).toContain('用时 40分 12秒');
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        f.state.timingError = true;
        await expect.poll(() => timing.count(), { timeout: 5000 }).toBe(0);
        await f.page
          .getByText(
            disabled
              ? '运行时间暂不可用'
              : '暂时读不到需要你确认的操作，会自动重试。',
            {
              exact: true,
            },
          )
          .waitFor();
        f.state.timingError = false;
        await timing.waitFor();
        await f.page.reload();
        await timing.waitFor();
        expect(await timing.count()).toBe(1);
        await timing.waitFor();
        expect(await process.getByRole('button').count()).toBe(0);
        expect(await process.locator('[aria-expanded]').count()).toBe(0);
        expect(await timing.innerText()).toContain('用时 40分 12秒');
        f.state.runTimings = [];
        await expect.poll(() => timing.count(), { timeout: 5000 }).toBe(0);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  for (const theme of ['light', 'dark'] as const)
    for (const width of [1440, 390]) {
      it(`MET247 personal directory, actions and recoverable preview at ${width}px ${theme}`, async () => {
        const f = await fixture({ width, appearance: theme, employeeCount: 2 });
        const reviewDir = process.env.ALLRICE_DELIVERABLES_REVIEW_DIR;
        const capture = async (state: string) => {
          if (!reviewDir) return;
          const { mkdir } = await import('node:fs/promises');
          await mkdir(reviewDir, { recursive: true });
          await f.page.screenshot({
            path: join(reviewDir, `${width}-${theme}-${state}.png`),
            animations: 'disabled',
          });
        };
        try {
          await f.page.setViewportSize({
            width,
            height: width === 1440 ? 1000 : 844,
          });
          const business = catalogFile(9500, {
            fileName: '选题说明.md',
            category: 'artifact',
          });
          const upload = catalogFile(9501, { fileName: '我上传的原件.txt' });
          const image = catalogFile(9502, {
            fileName: '示意图.png',
            mediaType: 'image/png',
          });
          f.state.workbenchFiles.push(business, upload, image);
          const input = f.page.getByRole('textbox', { name: /给 .* 的消息/ });
          await input.fill('检查文件期间保留这段草稿');
          await f.page
            .locator('header')
            .getByRole('button', { name: '交付成果', exact: true })
            .click();
          const directory = f.panel.getByRole('region', {
            name: '交付成果',
            exact: true,
          });
          const employee = directory.getByRole('combobox', {
            name: '按员工筛选',
          });
          await expect.poll(() => employee.inputValue()).toBe(id(7));
          await directory
            .getByRole('button', { name: upload.fileName, exact: true })
            .waitFor();
          expect(
            await directory
              .getByRole('navigation', { name: '文件类型' })
              .getByRole('button')
              .allTextContents(),
          ).toEqual(['全部', '员工交付', '我的上传']);
          await employee.selectOption(id(17));
          await directory
            .getByText('还没有交付成果', { exact: true })
            .waitFor();
          await employee.selectOption(id(7));
          await directory
            .getByRole('button', { name: upload.fileName, exact: true })
            .waitFor();
          if (width === 390) {
            const filterBox = (await employee.boundingBox())!;
            const searchBox = (await directory
              .getByRole('searchbox', { name: '查找文件' })
              .locator('..')
              .boundingBox())!;
            expect(Math.abs(filterBox.y - searchBox.y)).toBeLessThan(1);
          }
          await capture('deliverables');
          await directory
            .getByRole('button', { name: '员工交付', exact: true })
            .click();
          await expect.poll(() => directory.locator('article').count()).toBe(1);
          await directory
            .getByRole('button', { name: '我的上传', exact: true })
            .click();
          await expect.poll(() => directory.locator('article').count()).toBe(2);
          await employee.selectOption('');
          await expect
            .poll(() => f.state.deliverableRequests.at(-1)?.employeeInstanceId)
            .toBeUndefined();
          await directory
            .getByRole('button', { name: '全部', exact: true })
            .click();
          const row = directory.locator(`[data-file-id="${upload.objectId}"]`);
          await row
            .getByRole('button', {
              name: `文件选项 ${upload.fileName}`,
              exact: true,
            })
            .click();
          expect(await f.page.getByRole('menuitem').allTextContents()).toEqual([
            '下载',
            '复制链接',
          ]);
          await capture('deliverables-menu');
          const menuDownloadPath = `/api/v1/workbench/files/${upload.objectId}/download?workspaceId=${workspace}`;
          downloadFixtures.set(menuDownloadPath, {
            fileName: upload.fileName,
            body: '本人上传的原始文件字节',
          });
          const menuDownload = f.page.waitForEvent('download');
          await f.page
            .getByRole('menuitem', { name: '下载', exact: true })
            .click();
          const menuDownloaded = await menuDownload;
          expect(menuDownloaded.suggestedFilename()).toBe(upload.fileName);
          expect(await readFile((await menuDownloaded.path())!, 'utf8')).toBe(
            '本人上传的原始文件字节',
          );
          downloadFixtures.delete(menuDownloadPath);
          expect(
            await directory
              .locator(`[data-file-id="${image.objectId}"]`)
              .getByRole('button', {
                name: `引用到对话 ${image.fileName}`,
                exact: true,
              })
              .isDisabled(),
          ).toBe(true);
          await row
            .getByRole('button', { name: upload.fileName, exact: true })
            .click();
          const toolbar = f.panel.locator(
            'header[aria-label="文件操作"]:visible',
          );
          await toolbar
            .getByRole('button', { name: '复制链接', exact: true })
            .waitFor();
          expect(
            await f.panel.locator('dl:visible dt').allTextContents(),
          ).toEqual(['我的上传', '来自对话']);
          await capture('upload-detail');
          const headerDownload = toolbar.getByRole('link', {
            name: '下载',
            exact: true,
          });
          const headerDownloadUrl = new URL(
            (await headerDownload.getAttribute('href'))!,
            f.page.url(),
          );
          const headerDownloadPath =
            headerDownloadUrl.pathname + headerDownloadUrl.search;
          downloadFixtures.set(headerDownloadPath, {
            fileName: upload.fileName,
            body: '本人上传的原始文件字节',
          });
          const actualDownload = f.page.waitForEvent('download');
          await headerDownload.click();
          const downloaded = await actualDownload;
          expect(downloaded.suggestedFilename()).toBe(upload.fileName);
          expect(await readFile((await downloaded.path())!, 'utf8')).toBe(
            '本人上传的原始文件字节',
          );
          downloadFixtures.delete(headerDownloadPath);
          await f.page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: {
                writeText: async (value: string) => {
                  (window as unknown as { copiedFile: string }).copiedFile =
                    value;
                },
              },
            });
          });
          await toolbar
            .getByRole('button', { name: '复制链接', exact: true })
            .click();
          await f.panel
            .getByRole('status')
            .filter({ hasText: '链接已复制，仅你自己可以打开' })
            .waitFor();
          const copied = new URL(
            await f.page.evaluate(
              () => (window as unknown as { copiedFile: string }).copiedFile,
            ),
          );
          expect(copied.origin).toBe(new URL(f.page.url()).origin);
          expect(copied.pathname).toBe('/chatflow');
          expect([...copied.searchParams.keys()].sort()).toEqual([
            'file',
            'workspaceId',
          ]);
          expect(copied.searchParams.get('file')).toBe(upload.objectId);
          await f.panel
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          f.state.filePreviewStatus = 503;
          await directory
            .getByRole('button', { name: business.fileName, exact: true })
            .click();
          await f.panel
            .getByRole('alert')
            .filter({ hasText: '预览加载失败' })
            .waitFor();
          const errorStyle = await f.panel
            .getByRole('alert')
            .evaluate((node) => {
              const reader = node.parentElement!.parentElement!;
              const button = node.querySelector('button')!;
              const box = node.getBoundingClientRect();
              const action = button.getBoundingClientRect();
              return {
                layout: getComputedStyle(node).display,
                align: getComputedStyle(node).textAlign,
                color: getComputedStyle(node).color,
                label: getComputedStyle(reader.querySelector('dl dt')!).color,
                button: getComputedStyle(button).color,
                body: getComputedStyle(reader.querySelector('dl dd')!).color,
                offset: Math.abs(
                  action.x + action.width / 2 - box.x - box.width / 2,
                ),
              };
            });
          expect(errorStyle.layout).toBe('grid');
          expect(errorStyle.align).toBe('center');
          expect(errorStyle.color).toBe(errorStyle.label);
          expect(errorStyle.button).toBe(errorStyle.body);
          expect(errorStyle.offset).toBeLessThan(1);
          await capture('preview-error');
          f.state.filePreviewStatus = 200;
          await f.panel
            .getByRole('button', { name: '重新加载', exact: true })
            .click();
          await f.panel
            .getByRole('heading', { name: '上传的文件', exact: true })
            .waitFor();
          expect(await f.panel.getByRole('alert').count()).toBe(0);
          expect(
            await f.panel.locator('dl:visible dt').allTextContents(),
          ).toEqual(['员工交付', '来自对话']);
          const previewHeight = (await f.panel
            .locator('[class*="deliveryPreview"]:visible')
            .boundingBox())!.height;
          expect(previewHeight).toBeGreaterThanOrEqual(
            width === 1440 ? 190 : 170,
          );
          expect(previewHeight).toBeLessThanOrEqual(width === 1440 ? 260 : 220);
          await capture('artifact-detail');
          expect(
            await toolbar
              .getByRole('button', { name: /缺失 .* 种字体/ })
              .count(),
          ).toBe(0);
          await f.panel
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          const fontFile = catalogFile(9560, {
            fileName: '字体预览.docx',
            category: 'artifact',
          });
          f.state.workbenchFiles.push(fontFile);
          f.state.filePreview = {
            kind: 'download_only',
            reason: '文档转换暂不可用，请重试预览或下载查看。',
            retryable: true,
          };
          await f.page.evaluate(() =>
            window.dispatchEvent(new Event('allrice:workbench-files-changed')),
          );
          await directory
            .getByRole('button', { name: fontFile.fileName, exact: true })
            .click();
          await f.panel
            .getByText('文档转换暂不可用，请重试预览或下载查看。', {
              exact: true,
            })
            .waitFor();
          f.state.filePreview = deliverablePdf([
            'Noto Sans CJK SC',
            'Aptos Display Semibold',
          ]);
          await f.panel
            .getByRole('button', { name: '重新加载', exact: true })
            .click();
          const warning = toolbar.getByRole('button', {
            name: '缺失 2 种字体，点击查看',
            exact: true,
          });
          await warning.waitFor();
          await f.panel
            .locator(`[data-document-id="${fontFile.objectId}"]:visible`)
            .getByText('Delivery original preview', { exact: true })
            .waitFor({ timeout: 15000 });
          await capture('artifact-font-warning');
          const warningColor = await warning.evaluate(
            (node) => getComputedStyle(node).color,
          );
          await warning.hover();
          expect(
            await warning.evaluate((node) => getComputedStyle(node).color),
          ).toBe(warningColor);
          await warning.click();
          expect(
            await warning.evaluate((node) => getComputedStyle(node).color),
          ).toBe(warningColor);
          const fonts = f.page.getByRole('dialog', {
            name: '缺失的字体',
            exact: true,
          });
          await fonts.waitFor();
          expect(await fonts.getByRole('listitem').allTextContents()).toEqual([
            'Noto Sans CJK SC',
            'Aptos Display Semibold',
          ]);
          expect(await fonts.innerText()).toContain(
            '本次预览无法使用以下字体，预览中的文字和排版可能与原文档不同。',
          );
          const box = await fonts.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          await capture('artifact-fonts-open');
          await fonts
            .getByRole('button', { name: '关闭字体详情', exact: true })
            .click();
          expect(
            await warning.evaluate((node) => document.activeElement === node),
          ).toBe(true);
          await warning.click();
          await fonts.waitFor();
          await f.page.keyboard.press('Escape');
          expect(await fonts.count()).toBe(0);
          expect(
            await warning.evaluate((node) => document.activeElement === node),
          ).toBe(true);
          await warning.click();
          await fonts.waitFor();
          await toolbar
            .getByRole('link', { name: '下载', exact: true })
            .focus();
          expect(await fonts.count()).toBe(0);
          await warning.click();
          await fonts.waitFor();
          await toolbar.getByText(fontFile.fileName, { exact: true }).click();
          expect(await fonts.count()).toBe(0);
          await f.panel
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          const singleFontFile = catalogFile(9561, {
            fileName: '单字体上传.docx',
          });
          f.state.workbenchFiles.push(singleFontFile);
          f.state.filePreview = deliverablePdf(['Noto Sans CJK SC']);
          await f.page.evaluate(() =>
            window.dispatchEvent(new Event('allrice:workbench-files-changed')),
          );
          await directory
            .getByRole('button', { name: singleFontFile.fileName, exact: true })
            .click();
          await toolbar
            .getByRole('button', {
              name: '缺失 1 种字体，点击查看',
              exact: true,
            })
            .waitFor();
          await f.panel
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          const noFontsFile = catalogFile(9562, { fileName: '无缺字.pdf' });
          f.state.workbenchFiles.push(noFontsFile);
          f.state.filePreview = deliverablePdf([]);
          await f.page.evaluate(() =>
            window.dispatchEvent(new Event('allrice:workbench-files-changed')),
          );
          await directory
            .getByRole('button', { name: noFontsFile.fileName, exact: true })
            .click();
          await f.panel
            .locator(`[data-document-id="${noFontsFile.objectId}"]:visible`)
            .getByText('Delivery original preview', { exact: true })
            .waitFor();
          expect(
            await toolbar
              .getByRole('button', { name: /缺失 .* 种字体/ })
              .count(),
          ).toBe(0);
          expect(await fonts.count()).toBe(0);
          await f.panel
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          f.state.workbenchFiles.push(
            ...[
              '报告.docx',
              '数据.xlsx',
              '文档.pdf',
              '图片.jpg',
              '附件.bin',
            ].map((fileName, n) => catalogFile(9550 + n, { fileName })),
          );
          await f.page.evaluate(() =>
            window.dispatchEvent(new Event('allrice:workbench-files-changed')),
          );
          for (const name of [
            '报告.docx',
            '数据.xlsx',
            '文档.pdf',
            '图片.jpg',
            '附件.bin',
          ])
            await directory
              .getByRole('button', { name, exact: true })
              .waitFor();
          await capture('file-types');
          f.state.filePreview = {
            kind: 'download_only',
            reason: '此文件格式暂不支持预览，请下载查看。',
          };
          await directory
            .getByRole('button', { name: '附件.bin', exact: true })
            .click();
          await f.panel
            .getByText('此文件格式暂不支持预览，请下载查看。', { exact: true })
            .waitFor();
          expect(
            await f.panel
              .getByRole('button', { name: '重新加载', exact: true })
              .count(),
          ).toBe(0);
          await f.panel
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          f.state.filePreview = {
            kind: 'text',
            mediaType: 'text/markdown',
            text: '# 上传的文件',
          };
          await directory
            .getByRole('button', { name: business.fileName, exact: true })
            .click();
          expect(await input.inputValue()).toBe('检查文件期间保留这段草稿');
          await toolbar
            .getByRole('button', { name: '引用到对话', exact: true })
            .click();
          await expect
            .poll(() => f.state.workbenchReferenceUses)
            .toEqual([business.objectId]);
          expect(f.state.messageInputs).toEqual([]);
          expect(await input.inputValue()).toBe('检查文件期间保留这段草稿');
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        } finally {
          await f.close();
        }
      }, 30000);
    }

  it('MET247 mobile deliverables, personal memory and capabilities icons open their real panels', async () => {
    const f = await fixture({
      width: 390,
      employeeDetails: true,
    });
    try {
      const input = f.page.getByRole('textbox', {
        name: '给 Rice 的消息',
        exact: true,
      });
      await input.fill('手机入口切换期间保留草稿');
      const header = f.page.locator('header');
      await header
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      await f.panel
        .getByRole('region', { name: '交付成果', exact: true })
        .getByRole('heading', { name: '还没有交付成果', exact: true })
        .waitFor();
      await f.panel
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await header.getByRole('button', { name: '记忆', exact: true }).click();
      await f.panel
        .getByRole('region', { name: '个人记忆', exact: true })
        .waitFor();
      await f.panel.getByText('全部 · 共 0 条', { exact: true }).waitFor();
      await f.panel
        .getByRole('button', { name: '返回员工详情', exact: true })
        .click();
      const details = f.page.getByRole('dialog', {
        name: `${f.state.employeeDetails.profile.name}员工详情`,
        exact: true,
      });
      await details.getByRole('button', { name: '关闭', exact: true }).click();
      await details.waitFor({ state: 'hidden' });
      await header.getByRole('button', { name: '能力', exact: true }).click();
      await f.page
        .getByRole('region', { name: 'Rice · 能力', exact: true })
        .getByRole('heading', { name: '还没有场景', exact: true })
        .waitFor();
      expect(await input.inputValue()).toBe('手机入口切换期间保留草稿');
      expect(f.state.messageInputs).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  async function deliverableScopeFixture(
    options: Parameters<typeof fixture>[0],
    test: string,
  ) {
    const observation: { current?: Awaited<ReturnType<typeof fixture>> } = {};
    const evidence = createFailureEvidence({
      file: import.meta.url,
      test,
      collect: () => ({
        viewer: observation.current?.state.viewer,
        workspace: observation.current?.state.workspace,
        workspaceReads: observation.current?.state.workspaceReads,
        deliverableRequests: observation.current?.state.deliverableRequests,
        settled: [...(observation.current?.state.deliverableSettled ?? [])],
      }),
    });
    const f = await fixture({
      ...options,
      employeeDetails: true,
      failureEvidence: evidence,
    });
    observation.current = f;
    const responses = new Set<Request>();
    f.page.on('response', (response) => responses.add(response.request()));
    return { ...f, evidence, responses };
  }
  async function holdWorkspaceRefresh(
    f: Awaited<ReturnType<typeof deliverableScopeFixture>>,
  ) {
    const hold: { request?: Request; release: () => void } = {
      release: () => {},
    };
    const gate = new Promise<void>((done) => {
      hold.release = done;
    });
    await f.page.route(
      (url) => url.pathname === '/api/v1/workspace',
      async (route) => {
        hold.request = route.request();
        f.evidence.mark('workspace-refresh-held');
        await gate;
        await route.fallback();
      },
    );
    return hold;
  }
  it('MET247 keyset pages survive category, employee and search round trips and reject a late old-owner title', async () => {
    const f = await deliverableScopeFixture(
      { employeeCount: 2 },
      'MET247 keyset scope',
    );
    let release = () => {};
    let refresh: Awaited<ReturnType<typeof holdWorkspaceRefresh>> | undefined;
    try {
      for (let n = 0; n < 55; n++)
        f.state.workbenchFiles.push(catalogFile(9600 + n));
      await f.page
        .locator('header')
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      const directory = f.panel.getByRole('region', {
        name: '交付成果',
        exact: true,
      });
      await expect.poll(() => directory.locator('article').count()).toBe(50);
      await directory
        .locator('[aria-busy]')
        .evaluate((node) => (node.scrollTop = node.scrollHeight));
      await expect.poll(() => directory.locator('article').count()).toBe(55);
      expect(
        f.state.deliverableRequests.filter((request) => request.cursor),
      ).toHaveLength(1);
      const employee = directory.getByRole('combobox', { name: '按员工筛选' });
      const search = directory.getByRole('searchbox', { name: '查找文件' });
      const roundTrips = [
        async () => {
          await directory
            .getByRole('button', { name: '员工交付', exact: true })
            .click();
          await directory
            .getByText('还没有交付成果', { exact: true })
            .waitFor();
          await directory
            .getByRole('button', { name: '全部', exact: true })
            .click();
        },
        async () => {
          await employee.selectOption(id(17));
          await directory
            .getByText('还没有交付成果', { exact: true })
            .waitFor();
          await employee.selectOption(id(7));
        },
        async () => {
          await search.fill('资料-9600');
          await expect.poll(() => directory.locator('article').count()).toBe(1);
          await search.fill('');
        },
      ];
      for (const roundTrip of roundTrips) {
        await roundTrip();
        await expect.poll(() => directory.locator('article').count()).toBe(50);
        await directory.locator(`[data-file-id="${id(9600)}"]`).waitFor();
        expect(f.state.deliverableRequests.at(-1)?.cursor).toBeUndefined();
        await directory
          .locator('[aria-busy]')
          .evaluate((node) => (node.scrollTop = node.scrollHeight));
        await expect.poll(() => directory.locator('article').count()).toBe(55);
      }
      f.state.fileDelay = new Promise<void>((done) => {
        release = done;
      });
      const [oldRequest] = await Promise.all([
        f.page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            url.pathname === '/api/v1/workbench/files' &&
            url.searchParams.get('query') === '资料'
          );
        }),
        directory.getByRole('searchbox', { name: '查找文件' }).fill('资料'),
      ]);
      await expect
        .poll(() => f.state.deliverableRequests.at(-1)?.query)
        .toBe('资料');
      const oldRead = f.state.deliverableRequests.at(-1)!;
      const oldNode = (await directory.elementHandle())!;
      refresh = await holdWorkspaceRefresh(f);
      const details = await openOwnerDetails(f);
      await expect.poll(() => !!refresh?.request).toBe(true);
      await details.getByRole('button', { name: '关闭', exact: true }).click();
      expect(await oldNode.evaluate((node) => node.isConnected)).toBe(true);
      expect(oldRequest.failure()).toBeNull();
      expect(f.responses.has(oldRequest)).toBe(false);
      expect(f.state.deliverableSettled.has(oldRead)).toBe(false);
      f.evidence.mark('old-directory-pending-before-identity');
      const workspaceReads = f.state.workspaceReads;
      f.state.viewer = id(999);
      f.state.workspace = id(998);
      f.state.fileDelay = null;
      refresh.release();
      await expect
        .poll(() => f.state.workspaceReads)
        .toBeGreaterThan(workspaceReads);
      await expect
        .poll(() => oldNode.evaluate((node) => node.isConnected))
        .toBe(false);
      expect(
        await f.page.getByText('资料-9600.txt', { exact: true }).count(),
      ).toBe(0);
      await f.page
        .locator('header')
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      await f.panel
        .getByRole('heading', { name: '还没有交付成果', exact: true })
        .waitFor();
      release();
      await expect
        .poll(() => f.state.deliverableSettled.has(oldRead))
        .toBe(true);
      await expect
        .poll(() => f.page.getByText('资料-9600.txt', { exact: true }).count())
        .toBe(0);
      expect(
        await f.page.locator('header[aria-label="文件操作"]').count(),
      ).toBe(0);
    } catch (error) {
      await f.evidence.capture(error);
      throw error;
    } finally {
      refresh?.release();
      release();
      await f.close();
      f.evidence.dispose();
    }
  }, 30000);

  it.each([1440, 390])(
    'MET247 an application file link resolves my object before showing its title and clears a late old-account detail at %ipx',
    async (width) => {
      const f = await deliverableScopeFixture(
        { width },
        `MET247 file link scope ${width}`,
      );
      let release = () => {};
      let refresh: Awaited<ReturnType<typeof holdWorkspaceRefresh>> | undefined;
      try {
        const file = catalogFile(9590, { fileName: '本人链接原件.txt' });
        f.state.workbenchFiles.push(file);
        const link = `${origin}/?session=${A}&file=${file.objectId}&workspaceId=${workspace}`;
        await f.page.goto(link);
        await f.panel
          .locator('header[aria-label="文件操作"]')
          .getByText(file.fileName, { exact: true })
          .waitFor();
        expect(
          f.state.deliverableRequests.some(
            (request) => request.objectId === file.objectId,
          ),
        ).toBe(true);
        await f.panel
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        refresh = await holdWorkspaceRefresh(f);
        const details = await openOwnerDetails(f);
        await expect.poll(() => !!refresh?.request).toBe(true);
        await details
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        if (width === 390)
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .click();
        const objectReads = f.state.deliverableRequests.filter(
          (request) => request.objectId === file.objectId,
        ).length;
        f.state.fileDelay = new Promise<void>((done) => {
          release = done;
        });
        const [oldRequest] = await Promise.all([
          f.page.waitForRequest((request) => {
            const url = new URL(request.url());
            return (
              url.pathname === '/api/v1/workbench/files' &&
              url.searchParams.get('objectId') === file.objectId
            );
          }),
          f.page
            .locator('header')
            .getByRole('button', { name: '交付成果', exact: true })
            .click(),
        ]);
        await expect
          .poll(
            () =>
              f.state.deliverableRequests.filter(
                (request) => request.objectId === file.objectId,
              ).length,
          )
          .toBeGreaterThan(objectReads);
        const oldRead = f.state.deliverableRequests.findLast(
          (request) => request.objectId === file.objectId,
        )!;
        const oldNode = (await f.panel
          .getByRole('region', { name: '交付成果', exact: true })
          .elementHandle())!;
        expect(await oldNode.evaluate((node) => node.isConnected)).toBe(true);
        expect(oldRequest.failure()).toBeNull();
        expect(f.responses.has(oldRequest)).toBe(false);
        expect(f.state.deliverableSettled.has(oldRead)).toBe(false);
        f.evidence.mark('old-file-link-pending-before-identity');
        const workspaceReads = f.state.workspaceReads;
        f.state.viewer = id(999);
        f.state.fileDelay = null;
        refresh.release();
        await expect
          .poll(() => f.state.workspaceReads)
          .toBeGreaterThan(workspaceReads);
        await expect
          .poll(() => oldNode.evaluate((node) => node.isConnected))
          .toBe(false);
        await f.panel.getByText('无权访问', { exact: true }).waitFor();
        release();
        await expect
          .poll(() => f.state.deliverableSettled.has(oldRead))
          .toBe(true);
        expect(
          await f.page.getByText(file.fileName, { exact: true }).count(),
        ).toBe(0);
        expect(
          await f.panel
            .getByRole('link', { name: '下载', exact: true })
            .count(),
        ).toBe(0);
        expect(f.state.workbenchReferenceUses).toEqual([]);
      } catch (error) {
        await f.evidence.capture(error);
        throw error;
      } finally {
        refresh?.release();
        release();
        await f.close();
        f.evidence.dispose();
      }
    },
    30000,
  );

  it('MET160 keeps the chosen files tab when an artifact list arrives late, and honors explicit reopening', async () => {
    const f = await fixture();
    let release!: () => void;
    f.state.delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.items = [artifact(10)];
    try {
      await f.page.reload();
      await f.page
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      const tree = f.panel.getByRole('region', {
        name: '交付成果',
        exact: true,
      });
      await tree.waitFor();
      release();
      await tree
        .getByRole('button', { name: 'report-10.md', exact: true })
        .waitFor();
      expect(await tree.isVisible()).toBe(true);
      await f.openWorkbench();
      await f.panel.getByRole('tab', { name: /^report-10.md/ }).waitFor();
      expect(await tree.isVisible()).toBe(false);
      await f.page
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      await tree.waitFor();
      await f.openWorkbench();
      expect(await tree.isVisible()).toBe(false);
    } finally {
      release();
      await f.close();
    }
  });

  it('switches native dock tabs in place without replaying the panel entrance', async () => {
    const f = await fixture({ artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      await f.page
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      await f.panel
        .getByRole('region', { name: '交付成果', exact: true })
        .waitFor();
      // The initial panel entrance may finish; tab changes below must not animate.
      await f.page.waitForTimeout(400);
      const offsets = await f.panel.evaluate(async (panel) => {
        const samples: number[] = [];
        for (let i = 0; i < 8; i++) {
          const host = panel.querySelector<HTMLElement>(
            '[data-dockkit-host="dock"]:not([hidden])',
          )!;
          const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
          const target = tabs.find((t) =>
            i % 2 === 0
              ? t.textContent?.includes('report-10')
              : t.textContent?.includes('交付成果'),
          )!;
          target.click();
          for (let frame = 0; frame < 3; frame++) {
            await new Promise(requestAnimationFrame);
            const active = panel.querySelector<HTMLElement>(
              '[data-dockkit-host="dock"]:not([hidden])',
            )!;
            samples.push(
              active.getBoundingClientRect().left -
                panel.getBoundingClientRect().left,
            );
          }
        }
        return samples;
      });
      expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(1);
      expect(
        await f.panel
          .getByRole('region', { name: '交付成果', exact: true })
          .isVisible(),
      ).toBe(true);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('honors repeated empty-catalog header switches immediately, including behind a modal and a delayed refresh', async () => {
    const f = await fixture({ employeeDetails: true });
    let release = () => {};
    try {
      const entry = f.page
        .locator('header')
        .getByRole('button', { name: '记忆', exact: true });
      const files = f.page
        .locator('header')
        .getByRole('button', { name: '交付成果', exact: true });
      await files.click();
      await f.panel
        .getByRole('region', { name: '交付成果', exact: true })
        .waitFor();
      await f.page.waitForTimeout(400);
      f.state.delay = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (let i = 0; i < 6; i++) {
        await entry.evaluate((button: HTMLButtonElement) => button.click());
        await expect
          .poll(() =>
            f.panel
              .getByRole('tab', { name: /^记忆/ })
              .getAttribute('aria-selected'),
          )
          .toBe('true');
        expect(
          await f.panel
            .getByRole('region', { name: '交付成果', exact: true })
            .isVisible(),
        ).toBe(false);
        await files.evaluate((button: HTMLButtonElement) => button.click());
        await expect
          .poll(() =>
            f.panel
              .getByRole('tab', { name: /^交付成果/ })
              .getAttribute('aria-selected'),
          )
          .toBe('true');
      }
      await openCapabilities(f);
      await f.page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
      release();
      f.state.delay = null;
      expect(await f.page.locator('#artifact-workbench').count()).toBe(1);
      const offsets = await f.panel.evaluate(async (panel) => {
        const samples: number[] = [];
        const end = performance.now() + 450;
        do {
          await new Promise(requestAnimationFrame);
          const hosts = panel.querySelectorAll<HTMLElement>(
            '[data-dockkit-host="dock"]:not([hidden])',
          );
          if (hosts.length !== 1) throw Error('Unexpected duplicate dock');
          samples.push(
            hosts[0]!.getBoundingClientRect().left -
              panel.getBoundingClientRect().left,
          );
        } while (performance.now() < end);
        return samples;
      });
      expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(1);
      expect(
        await f.panel
          .getByRole('region', { name: '交付成果', exact: true })
          .isVisible(),
      ).toBe(true);
      await f.page
        .getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: '关闭设置', exact: true })
        .click();
      await entry.click();
      expect(
        await f.panel
          .getByRole('tab', { name: /^记忆/ })
          .getAttribute('aria-selected'),
      ).toBe('true');
      await files.click();
      expect(await f.page.locator('#artifact-workbench').count()).toBe(1);
      expect(f.errors).toEqual([]);
      expect(f.writes).toEqual([]);
    } finally {
      release();
      await f.close();
    }
  });

  it('MET160 published official PDF chunk renders actual PDF bytes with its bundled worker', async () => {
    const f = await fixture({ artifacts: true });
    try {
      // A real one-page PDF, with offsets computed from its actual object bytes.
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      const content =
        'BT /F1 16 Tf 30 350 Td (Allrice native PDF preview) Tj ET';
      objects.push(
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      );
      let pdf = '%PDF-1.4\n';
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
        .join(
          '\n',
        )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      f.state.officePreview = {
        kind: 'pdf',
        base64: Buffer.from(pdf).toString('base64'),
      };
      await f.page.reload();
      const canvas = f.panel.getByRole('img', {
        name: 'PDF 第 1 页',
        exact: true,
      });
      await canvas.waitFor({ timeout: 15000 });
      await expect
        .poll(() =>
          canvas.evaluate((element) => (element as HTMLCanvasElement).width),
        )
        .toBeGreaterThan(300);
      await f.panel
        .getByText('Allrice native PDF preview', { exact: true })
        .waitFor();
      expect(
        await f.page.evaluate(() => Object.hasOwn(window, '__ModuleLoader__')),
      ).toBe(false);
      await f.page.screenshot({ path: '/tmp/allrice-met160-native-pdf.png' });
    } finally {
      await f.close();
    }
  }, 25_000);

  it
    .skipIf(!process.env.ALLRICE_OFFICE_PREVIEW_DIR)
    .each(['docx', 'xlsx', 'pptx'])(
    'MET160 real %s renderer output opens in native zoom viewport',
    { tags: ['manual:ALLRICE_OFFICE_PREVIEW_DIR'], timeout: 25_000 },
    async (format) => {
      const rendered = OfficeRenderResponseSchema.parse(
        JSON.parse(
          await readFile(
            join(process.env.ALLRICE_OFFICE_PREVIEW_DIR!, `${format}.json`),
            'utf8',
          ),
        ),
      );
      const f = await fixture({ artifacts: true });
      try {
        f.state.officePreview = officePreview(rendered);
        await f.page.reload();
        await f.openWorkbench();
        const preview = f.panel.getByRole('region', {
          name: 'Office 文档预览',
        });
        const page = preview.getByRole('img', { name: 'Office 文档第 1 页' });
        await page.waitFor();
        await expect
          .poll(() =>
            page.evaluate((element: HTMLImageElement) => element.naturalWidth),
          )
          .toBeGreaterThan(500);
        await preview
          .locator('[data-document-zoom-frame]')
          .scrollIntoViewIfNeeded();
        const frame = await preview
          .locator('[data-document-zoom-mode]')
          .boundingBox();
        expect(frame).not.toBeNull();
        await f.page.mouse.move(
          frame!.x + frame!.width / 2,
          frame!.y + frame!.height - 20,
        );
        await preview.getByRole('button', { name: '选择缩放比例' }).click();
        await f.page
          .getByRole('menuitem', { name: '150%', exact: true })
          .click();
        await expect
          .poll(() =>
            preview.getByRole('button', { name: '选择缩放比例' }).innerText(),
          )
          .toContain('150%');
        await preview.getByRole('button', { name: '选择缩放比例' }).click();
        await f.page
          .getByRole('menuitem', { name: '适应宽度', exact: true })
          .click();
        await preview
          .locator('[data-document-zoom-scrollport]')
          .evaluate((element) => {
            element.scrollTop = 0;
            element.scrollLeft = 0;
          });
        await preview.evaluate((element) =>
          element.scrollIntoView({ block: 'start' }),
        );
        await f.page.screenshot({
          path: `/tmp/allrice-met160-native-${format}.png`,
        });
        if (rendered.pages.length > 1) {
          await preview
            .getByRole('img', { name: 'Office 文档第 2 页' })
            .scrollIntoViewIfNeeded();
        }
      } finally {
        await f.close();
      }
    },
  );

  it('shows Office pages and actual formula errors without confusing rendering with layout approval', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
      f.state.officePreview = {
        kind: 'office',
        checksum: `sha256:${'a'.repeat(64)}`,
        format: 'xlsx',
        pageCount: 3,
        pages: [
          { number: 1, base64: png },
          { number: 2, base64: png },
        ],
        formulaCount: 2,
        formulaErrorCount: 1,
        formulas: [
          { sheet: '明细', cell: 'C2', formula: 'B2*2', type: 'n', value: 60 },
          {
            sheet: '明细',
            cell: 'D2',
            formula: '1/0',
            type: 'e',
            value: '#DIV/0!',
          },
        ],
      };
      await f.page.reload();
      await f.openWorkbench();
      const preview = f.panel.getByRole('region', { name: 'Office 文档预览' });
      await preview.waitFor();
      expect(await preview.innerText()).toContain('发现 1 个公式错误');
      expect(await preview.innerText()).toContain('展示前 2 页');
      await preview.locator('summary').click();
      expect(await preview.innerText()).toContain('#DIV/0!');
      expect(await preview.innerText()).toContain('60');
      await preview.getByRole('img', { name: 'Office 文档第 2 页' }).waitFor();
      expect(
        await preview.getByRole('button', { name: /上一页|下一页/ }).count(),
      ).toBe(0);
      expect(
        await preview.locator('[data-document-zoom-scrollport]').count(),
      ).toBe(1);
      expect(await preview.innerText()).not.toContain('请检查分页');
    } finally {
      await f.close();
    }
  });

  it.each([
    [1440, false],
    [1440, true],
    [390, false],
    [390, true],
  ] as const)(
    'mixed native image and document delivery at %ipx streaming=%s stays compact, previews and downloads after reload',
    async (width, streamingOutput) => {
      const f = await fixture({
        width,
        touch: width === 390,
        running: true,
        streamingOutput,
      });
      try {
        const png = await f.page.evaluate(() => {
          const c = document.createElement('canvas');
          c.width = 1200;
          c.height = 300;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, 1200, 300);
          ctx.fillStyle = '#ff8a00';
          ctx.beginPath();
          ctx.arc(600, 150, 100, 0, Math.PI * 2);
          ctx.fill();
          // Deterministic texture makes this a realistic large PNG rather
          // than a tiny solid-color image that misses the old preview limit.
          const pixels = ctx.getImageData(0, 0, 1200, 300);
          let seed = 163;
          for (let i = 0; i < pixels.data.length; i++) {
            if (i % 4 === 3) continue;
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[i] = (pixels.data[i]! & 0xf0) | (seed >>> 28);
          }
          ctx.putImageData(pixels, 0, 0);
          return c.toDataURL('image/png').split(',')[1]!;
        });
        expect(Buffer.from(png, 'base64').length).toBeGreaterThan(512_000);
        const img = artifact(10);
        img.version.fileName = '圆形海报.png';
        img.version.format = 'png';
        img.object.mediaType = 'image/png';
        img.object.sizeBytes = Buffer.from(png, 'base64').length;
        img.version.version = 2;
        const slides = artifact(11);
        slides.version.fileName = '企业介绍.pptx';
        slides.version.format = 'pptx';
        slides.object.mediaType =
          'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        const otherImage = artifact(12);
        otherImage.version.fileName = '浅色Logo.png';
        otherImage.version.format = 'png';
        otherImage.object.mediaType = 'image/png';
        otherImage.object.sizeBytes = img.object.sizeBytes;
        f.state.officePreview = {
          kind: 'image',
          mediaType: 'image/png',
          base64: png,
        };
        await f.page.route('**/api/v1/files/*/download?*', (route) =>
          route.fulfill({
            contentType: 'image/png',
            headers: {
              'content-disposition':
                "attachment; filename*=UTF-8''" +
                encodeURIComponent(img.version.fileName),
            },
            body: Buffer.from(png, 'base64'),
          }),
        );
        f.state.reply = '已把蓝色圆形修改为橙色，并保留原图版本。';
        f.state.workMethods = ['cloud_images'];
        f.finishRun();
        f.state.items = [slides, img, otherImage];
        const message = f.page.locator('#message-' + id(20));
        const cards = message.locator('[data-presented-file]');
        const picture = f.page
          .getByRole('button', {
            name: '侧栏预览 圆形海报.png',
            exact: true,
          })
          .first();
        await picture.waitFor();
        const closePanel = f.panel.getByRole('button', {
          name: '关闭工作台',
          exact: true,
        });
        if (await closePanel.isVisible()) await closePanel.click();
        await expect.poll(() => cards.count()).toBe(3);
        const checkLayout = async () => {
          // Closing the dock animates the conversation width. Wait for its
          // native container breakpoint before measuring the settled rows.
          await expect
            .poll(async () => {
              const first = await cards.nth(0).boundingBox();
              const second = await cards.nth(1).boundingBox();
              return !!first && !!second && second.x > first.x;
            })
            .toBe(width === 1440);
          const boxes = await cards.evaluateAll((elements) =>
            elements.map((element) => {
              const box = element.getBoundingClientRect();
              return { x: box.x, y: box.y, height: box.height };
            }),
          );
          expect(boxes).toHaveLength(3);
          for (const box of boxes) expect(box.height).toBeCloseTo(60, 0);
          expect(boxes[2]!.x).toBeCloseTo(boxes[0]!.x, 0);
          if (width === 1440) {
            expect(boxes[1]!.y).toBeCloseTo(boxes[0]!.y, 0);
            expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
            expect(boxes[2]!.y - boxes[0]!.y).toBeCloseTo(70, 0);
          } else {
            expect(boxes[1]!.x).toBeCloseTo(boxes[0]!.x, 0);
            expect(boxes[1]!.y - boxes[0]!.y).toBeCloseTo(70, 0);
            expect(boxes[2]!.y - boxes[1]!.y).toBeCloseTo(70, 0);
          }
        };
        await checkLayout();
        expect(
          await message
            .getByRole('button', {
              name: '侧栏预览 圆形海报.png',
              exact: true,
            })
            .count(),
        ).toBe(1);
        await f.page.locator('#message-' + id(20)).hover();
        expect(
          await f.page
            .getByRole('group', { name: '工作方式', exact: true })
            .innerText(),
        ).toContain('云端-图片');
        expect(
          await f.page
            .locator('body')
            .evaluate((el) => el.scrollWidth <= innerWidth),
        ).toBe(true);
        await picture.click();
        const preview = f.panel.locator('[data-image-preview] img:visible');
        await preview.waitFor();
        await expect
          .poll(() =>
            preview.evaluate((element: HTMLImageElement) => ({
              width: element.naturalWidth,
              height: element.naturalHeight,
            })),
          )
          .toEqual({ width: 1200, height: 300 });
        const zoomFrame = f.panel.locator('[data-document-zoom-frame]:visible');
        await zoomFrame.scrollIntoViewIfNeeded();
        const bounds = (await zoomFrame.boundingBox())!;
        await f.page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height - 20,
        );
        await f.panel
          .getByRole('button', { name: '放大', exact: true })
          .click();
        expect(
          await f.panel
            .locator('[data-document-zoom-scrollport]:visible')
            .count(),
        ).toBe(1);
        await f.panel
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.reload();
        await picture.waitFor();
        await checkLayout();
        await picture.scrollIntoViewIfNeeded();
        await f.page.screenshot({
          path: `/tmp/allrice-native-delivery-${width}-${streamingOutput}.png`,
        });
        const card = f.page
          .locator('[data-presented-file]')
          .filter({ hasText: '圆形海报.png' })
          .first();
        await card
          .getByRole('button', { name: '圆形海报.png 文件选项' })
          .click();
        const downloaded = f.page.waitForEvent('download');
        await f.page
          .getByRole('menuitem', { name: '下载文件', exact: true })
          .click();
        const download = await downloaded;
        expect(download.suggestedFilename()).toBe('圆形海报.png');
        expect(new URL(download.url()).pathname).toBe(
          `/api/v1/files/${img.object.id}/download`,
        );
        expect(new URL(download.url()).searchParams.get('name')).toBe(
          img.version.fileName,
        );
        await picture.click();
        await preview.waitFor();
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it.each([1440, 390])(
    'native delivery cards preview and download at width %i',
    async (width) => {
      const f = await fixture({ artifacts: true, width });
      try {
        const card = f.page
          .locator('[data-presented-file]')
          .filter({ hasText: 'report-10.md' })
          .first();
        await card.waitFor();
        expect(await card.locator('svg').count()).toBeGreaterThan(0);
        expect(
          await card
            .getByRole('button', { name: '打开 report-10.md', exact: true })
            .count(),
        ).toBe(0);
        const menu = card.getByRole('button', {
          name: 'report-10.md 文件选项',
        });
        await menu.click();
        await f.page
          .getByRole('menuitem', { name: '侧栏预览', exact: true })
          .waitFor();
        expect(await f.page.getByRole('menuitem').allTextContents()).toEqual([
          '侧栏预览',
          '下载文件',
        ]);
        await f.page.keyboard.press('Escape');
        await expect
          .poll(() =>
            f.page
              .getByRole('menuitem', { name: '侧栏预览', exact: true })
              .count(),
          )
          .toBe(0);
        await menu.click();
        await f.page
          .getByRole('menuitem', { name: '侧栏预览', exact: true })
          .click();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.panel
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.route('**/api/v1/files/*/download?*', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/markdown',
            headers: {
              'content-disposition': 'attachment; filename="report-10.md"',
            },
            body: report,
          }),
        );
        await menu.click();
        const downloadEvent = f.page.waitForEvent('download');
        await f.page
          .getByRole('menuitem', { name: '下载文件', exact: true })
          .click();
        const download = await downloadEvent;
        expect(download.suggestedFilename()).toBe('report-10.md');
        expect(new URL(download.url()).pathname).toBe(
          `/api/v1/files/${artifact(10).object.id}/download`,
        );
        expect(await f.panel.count()).toBe(0);
        expect(
          await f.page
            .locator('body')
            .evaluate((body) => body.scrollWidth <= innerWidth),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'Office paper canvas scrolls continuously in both themes at width %i',
    async (width) => {
      const f = await fixture({ artifacts: true, width });
      try {
        const png = await f.page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 900;
          canvas.height = 1200;
          const c = canvas.getContext('2d')!;
          c.fillStyle = '#fff';
          c.fillRect(0, 0, 900, 1200);
          c.fillStyle = '#163b65';
          c.font = '40px sans-serif';
          c.fillText('Office document preview', 60, 100);
          return canvas.toDataURL('image/png').split(',')[1]!;
        });
        f.state.officePreview = {
          kind: 'office',
          checksum: `sha256:${'a'.repeat(64)}`,
          format: 'xlsx',
          pageCount: 2,
          pages: [
            { number: 1, base64: png },
            { number: 2, base64: png },
          ],
          formulaCount: 0,
          formulaErrorCount: 0,
          formulas: [],
        };
        await f.page.reload();
        await f.openWorkbench();
        const preview = f.panel.getByRole('region', {
          name: 'Office 文档预览',
        });
        const second = preview.getByRole('img', { name: 'Office 文档第 2 页' });
        await second.waitFor();
        expect(await preview.locator('summary').count()).toBe(0);
        const scroll = preview.locator('[data-document-zoom-scrollport]');
        const paper = preview.locator('[data-document-zoom-surface]').first();
        await expect
          .poll(() =>
            scroll.evaluate((el) => el.scrollHeight > el.clientHeight),
          )
          .toBe(true);
        expect(
          await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        expect(
          await paper.evaluate((el) => getComputedStyle(el).backgroundColor),
        ).toBe('rgb(255, 255, 255)');
        const canvasColor = () =>
          scroll.evaluate(
            (el) =>
              getComputedStyle(el.parentElement!.parentElement!)
                .backgroundColor,
          );
        const light = await canvasColor();
        expect(light).not.toBe('rgb(255, 255, 255)');
        expect(light).not.toBe('rgba(0, 0, 0, 0)');
        await f.page.evaluate(() =>
          document.body.setAttribute('data-ds-dark-theme', ''),
        );
        expect(await canvasColor()).not.toBe(light);
        await second.scrollIntoViewIfNeeded();
        expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(
          await f.page
            .locator('body')
            .evaluate((body) => body.scrollWidth <= innerWidth),
        ).toBe(true);
        await f.page.screenshot({
          path: `/tmp/allrice-office-continuous-${width}.png`,
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each([1440, 390])(
    'resolves chat downloads only for this Run’s authenticated artifacts at width %i',
    async (width) => {
      const f = await fixture({ artifacts: true, width });
      try {
        const path = `/api/v1/files/${artifact(10).object.id}/download`;
        f.state.reply = `[下载报告](https://allrice.example${path}?name=wrong)\n\n[下载 report-10.md](/api/v1/files/broken-id?name=wrong)\n\n[原始来源](https://example.org/source)`;
        await f.page.reload();
        const link = f.page.getByRole('link', {
          name: '下载报告',
          exact: true,
        });
        await expect
          .poll(() => link.getAttribute('href'))
          .toBe(`${origin}${path}?name=report-10.md`);
        const repaired = f.page.getByRole('link', {
          name: '下载 report-10.md',
          exact: true,
        });
        expect(await repaired.getAttribute('href')).toBe(
          `${origin}${path}?name=report-10.md`,
        );
        // Native Markdown opens HTTP links without navigating away from the chat.
        expect(await link.getAttribute('target')).toBe('_blank');
        expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
        // The --ar-link design token (MET-214 L04): 500 was 4.23:1 on white.
        expect(
          await link.evaluate((node) => getComputedStyle(node).color),
        ).toBe('rgb(30, 64, 175)');
        await f.page.evaluate(() =>
          document.body.setAttribute('data-ds-dark-theme', ''),
        );
        expect(
          await link.evaluate((node) => getComputedStyle(node).color),
        ).toBe('rgb(183, 200, 254)');
        await f.page.evaluate(() =>
          document.body.removeAttribute('data-ds-dark-theme'),
        );
        const pageCount = f.page.context().pages().length;
        await link.click();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(
          await f.panel
            .locator('header[aria-label="文件操作"]')
            .getByRole('link', { name: '下载', exact: true })
            .getAttribute('href'),
        ).toContain(
          `/api/v1/workbench/files/${artifact(10).object.id}/download`,
        );
        expect(f.page.context().pages()).toHaveLength(pageCount);
        expect(new URL(f.page.url()).pathname).toBe('/');
        expect(
          await f.page
            .getByRole('link', { name: '原始来源', exact: true })
            .getAttribute('href'),
        ).toBe('https://example.org/source');
        // Even a known file in the Session cannot resolve another Run's link.
        f.state.items = [
          {
            ...artifact(10),
            provenance: { ...artifact(10).provenance, runId: id(90) },
          },
        ];
        await f.page.reload();
        await expect
          .poll(() => link.getAttribute('href'))
          .toBe(`https://allrice.example${path}?name=wrong`);
        expect(await repaired.count()).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it(
    'MET-210 keeps cloud work settings and drafts available after retiring assistant controls',
    { timeout: 20_000 },
    async () => {
      const f = await fixture();
      try {
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
        });
        await composer.fill('保留我的原始问题');
        await openCapabilities(f);
        const dialog = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        const glyphs = await dialog
          .locator('nav button svg')
          .evaluateAll((nodes) => nodes.map((node) => node.innerHTML));
        expect(glyphs.length).toBe(5);
        expect(new Set(glyphs).size).toBe(glyphs.length);
        expect(
          await f.page
            .locator('header')
            .getByRole('button', { name: '能力与环境', exact: true })
            .count(),
        ).toBe(0);
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .waitFor();
        expect(
          await dialog
            .locator('[data-capability]')
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute('data-capability')),
            ),
        ).toEqual([
          'report',
          'cloud_command',
          'cloud_browser',
          'boost',
          'teamwork',
        ]);
        expect(
          await dialog.locator('[data-capability="assistants"]').count(),
        ).toBe(0);
        expect(
          await dialog.getByRole('switch', { name: '子智能体' }).count(),
        ).toBe(0);
        expect(
          await dialog
            .locator('[data-capability="boost"]')
            .getByRole('button', { name: /准备/ })
            .count(),
        ).toBe(0);
        expect(await dialog.getByRole('link', { name: /配置/ }).count()).toBe(
          0,
        );
        await f.page.screenshot({
          path: '/tmp/met147-capabilities-desktop.png',
        });
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .click();
        expect(await composer.inputValue()).toContain('保留我的原始问题');
        // The prompt keeps the delivery intent in words, not a tool name.
        expect(await composer.inputValue()).toContain(
          '保存为正式交付的 Markdown 文件',
        );
        expect(await composer.inputValue()).not.toContain('workspace.export');
        await expect
          .poll(() => composer.evaluate((e) => e === document.activeElement))
          .toBe(true);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('UX01-B bridges missing configuration to the real pairing dialog and refreshes on return', async () => {
    const f = await fixture({ width: 390 });
    try {
      await openCapabilities(f, 'computer');
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const card = dialog.locator('[data-capability="local_files"]');
      await card.getByRole('button', { name: '连接与管理电脑' }).click();
      const bridge = f.page
        .getByRole('dialog', {
          name: '设置',
          exact: true,
        })
        .locator('[data-bridge-settings]');
      await bridge.waitFor();
      await bridge
        .getByRole('link', { name: /下载 AllRice 助手（Apple 芯片）/ })
        .waitFor();
      const calls = f.state.readinessRequests;
      await f.page.keyboard.press('Escape');
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await openCapabilities(f);
      await dialog.waitFor();
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await dialog.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      expect(
        await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      await f.page.screenshot({
        path: '/tmp/met147-capabilities-mobile.png',
      });
    } finally {
      await f.close();
    }
  });

  it.each([
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const)(
    'MET-214 offers one Apple silicon AllRice 助手 download in 我的电脑 at width %i in %s theme',
    async (width, theme) => {
      const f = await fixture({ width });
      try {
        await f.page.emulateMedia({ colorScheme: theme });
        await f.page.evaluate((theme) => {
          document.documentElement.style.colorScheme = theme;
          document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
        }, theme);
        await openCapabilities(f, 'computer');
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await settings
          .locator('[data-capability="local_files"]')
          .getByRole('button', { name: '连接与管理电脑' })
          .click();
        const computer = settings.locator('[data-bridge-settings]');
        const downloads = computer.getByRole('region', {
          name: '下载 AllRice 助手',
          exact: true,
        });
        const link = downloads.getByRole('link', {
          name: '下载 AllRice 助手（Apple 芯片） · v0.6.0-dev.7',
          exact: true,
        });
        await link.waitFor();
        expect(await downloads.getByRole('link').count()).toBe(1);
        expect(await link.getAttribute('href')).toBe(
          '/api/v1/bridge/client/macos-arm64',
        );
        expect(await link.getAttribute('download')).toBe(
          'AllRice-Assistant.zip',
        );
        expect(await f.page.locator('a[href*="macos-x64"]').count()).toBe(0);
        const text = await computer.innerText();
        expect(text).toContain('安装 AllRice 助手后，输入配对码就能连接。');
        expect(text).not.toMatch(/Intel|M 芯片|电脑端|Rice Bridge/);
        expect(
          await f.page.evaluate(() =>
            document.body.hasAttribute('data-ds-dark-theme'),
          ),
        ).toBe(theme === 'dark');
        // Readable in both themes: link text against the nearest painted background.
        const colors = await link.evaluate((element) => {
          let node: Element | null = element;
          let background = 'rgba(0, 0, 0, 0)';
          while (node && /rgba\(.*, 0\)$|transparent/.test(background)) {
            background = getComputedStyle(node).backgroundColor;
            node = node.parentElement;
          }
          return { foreground: getComputedStyle(element).color, background };
        });
        const luminance = (color: string) => {
          const [r, g, b] = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map((channel) => {
              const value = Number(channel) / 255;
              return value <= 0.04045
                ? value / 12.92
                : ((value + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const [a, b] = [colors.foreground, colors.background].map(luminance);
        expect(
          (Math.max(a!, b!) + 0.05) / (Math.min(a!, b!) + 0.05),
        ).toBeGreaterThanOrEqual(4.5);
        // No horizontal overflow: page, dialog, and the download entry.
        const box = (await link.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(
          await f.page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
        expect(
          await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        expect(
          await downloads.evaluate((section) =>
            [section, ...section.querySelectorAll('*')]
              .filter(
                (node) =>
                  node.checkVisibility() &&
                  getComputedStyle(node).display !== 'inline' &&
                  node.scrollWidth > node.clientWidth + 1,
              )
              .map((node) => node.tagName),
          ),
        ).toEqual([]);
        if (process.env.ALLRICE_DIALOG_SCREENSHOT)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_DIALOG_SCREENSHOT}-met214-${width}-${theme}.png`,
          });
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(['online', 'offline'] as const)(
    'MET-214 keeps a paired %s Intel Mac on its version: no update prompt and no Apple silicon package to replace it',
    async (status) => {
      const f = await fixture({ width: 1440 });
      try {
        f.state.bridgeDevices = [
          {
            id: id(902),
            name: 'iMac-Intel.local · Rice Bridge',
            platform: 'macos-x64',
            status,
            clientVersion: '0.6.0-dev.40',
            lastSeenAt: now,
            folderGrants: [],
            readiness: [
              {
                capability: 'local.browser',
                state: 'unsupported',
                reason: 'legacy_unavailable',
                missing: [],
                versions: { bridge: '0.6.0-dev.40' },
                observedAt: now,
              },
            ],
          },
        ];
        await f.page.reload();
        await openCapabilities(f, 'computer');
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        const notice = 'Intel 芯片的电脑不再提供新版本，现有版本可以继续使用。';
        // 我的电脑: switches and browser login say why, not "please update".
        const permissions = settings.getByRole('region', {
          name: 'iMac-Intel.local',
          exact: true,
        });
        await permissions
          .getByText(`${notice}这台电脑的版本不支持这些开关。`, {
            exact: true,
          })
          .waitFor();
        await settings
          .locator('[data-capability="local_files"]')
          .getByRole('button', { name: '连接与管理电脑' })
          .click();
        const computer = settings.locator('[data-bridge-settings]');
        await computer.getByText('不再提供新版本', { exact: true }).waitFor();
        if (status === 'online') {
          await computer
            .locator('[data-bridge-capabilities] > summary')
            .click();
          await computer.getByText(notice, { exact: true }).first().waitFor();
        }
        // Offline, the install section opens by itself; it must not offer the
        // Apple silicon package as this Mac's update.
        const install = computer.locator('[data-bridge-install]');
        if ((await install.getAttribute('open')) === null)
          await install.locator(':scope > summary').click();
        await computer.getByText(`· ${notice}`, { exact: true }).waitFor();
        const download = computer.locator(
          'a[href="/api/v1/bridge/client/macos-arm64"]',
        );
        expect(await download.count()).toBe(1);
        expect(await download.isVisible()).toBe(false);
        expect(await computer.getByText(/直接替换/).count()).toBe(0);
        const text = await settings.innerText();
        expect(text).not.toMatch(
          /请更新|可更新至|有新版本|Rice Bridge|下载 AllRice 助手/,
        );
        expect(text).toContain('Intel 芯片');
        // Installing on another, Apple silicon Mac is a separate entry.
        await computer
          .locator('[data-bridge-other-mac] > summary')
          .getByText('给另一台 Apple 芯片的 Mac 安装', { exact: true })
          .click();
        await download.waitFor();
        expect(await download.textContent()).toContain(
          '下载 AllRice 助手（Apple 芯片）',
        );
        await computer
          .getByText(
            '只在 Apple 芯片的 Mac 上安装；Intel 芯片的电脑继续用现有版本，不要替换。',
            { exact: true },
          )
          .waitFor();
        expect(await computer.getByText(/直接替换/).count()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each([390, 1280])(
    'shows downloadable and installed Bridge versions at width %i and refreshes after an upgrade',
    async (width) => {
      const f = await fixture({ width });
      let installed = '0.6.0-dev.6';
      try {
        await f.page.route('**/api/v1/bridge/devices?*', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              devices: [
                {
                  id: id(500),
                  name: 'Synthetic Mac',
                  platform: 'macos-arm64',
                  status: 'online',
                  clientVersion: installed,
                  lastSeenAt: new Date().toISOString(),
                  folderGrants: [],
                },
              ],
            }),
          }),
        );
        await openCapabilities(f, 'computer');
        const settings = f.page.getByRole('dialog', {
          name: '设置',
          exact: true,
        });
        await settings
          .locator('[data-capability="local_files"]')
          .getByRole('button', { name: '连接与管理电脑' })
          .click();
        const dialog = f.page
          .getByRole('dialog', {
            name: '设置',
            exact: true,
          })
          .locator('[data-bridge-settings]');
        const download = dialog.getByRole('link', {
          name: '下载 AllRice 助手（Apple 芯片） · v0.6.0-dev.7',
          exact: true,
        });
        await dialog.getByText('有新版本', { exact: true }).waitFor();
        expect(await download.isVisible()).toBe(false);
        await dialog.locator('[data-bridge-install] > summary').click();
        await dialog.getByText('v0.6.0-dev.6', { exact: true }).waitFor();
        await download.waitFor();
        expect(await download.getAttribute('href')).toBe(
          '/api/v1/bridge/client/macos-arm64',
        );
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await f.page.screenshot({
          path: `/tmp/bridge-release-versions-${width}.png`,
        });
        installed = '0.6.0-dev.7';
        await dialog
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await dialog.getByText('v0.6.0-dev.7', { exact: true }).waitFor();
        await dialog.getByText('已是最新版', { exact: true }).waitFor();
        expect(
          await dialog.getByText('有新版本', { exact: true }).count(),
        ).toBe(0);
        installed = 'legacy';
        await dialog
          .getByRole('button', { name: '刷新状态', exact: true })
          .click();
        await dialog.getByText('vlegacy', { exact: true }).waitFor();
        await dialog
          .locator('[data-bridge-install] > summary')
          .getByText('待确认', { exact: true })
          .waitFor();
        expect(
          await dialog.getByText('已是最新版', { exact: true }).count(),
        ).toBe(0);
        expect(f.writes).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('checks once on opening and preserves cards while manually refreshing, without polling or focus refresh', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await f.page.clock.install();
      const entry = { click: () => openCapabilities(f) };
      await entry.click();
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const refresh = dialog.getByRole('button', { name: '刷新能力状态' });
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      const unavailable = dialog.locator('[data-capability="boost"]');
      await unavailable.getByText('查看处理步骤', { exact: true }).click();
      const before = await dialog
        .locator('[data-capability]')
        .allTextContents();
      const calls = f.state.readinessRequests;
      await f.page.clock.runFor(31_000);
      await f.page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await f.page.waitForTimeout(50);
      expect(f.state.readinessRequests).toBe(calls);
      expect(
        await dialog.locator('[data-capability]').allTextContents(),
      ).toEqual(before);

      f.state.readinessDelay = new Promise<void>((done) => {
        release = done;
      });
      await refresh.click();
      await expect.poll(() => f.state.readinessRequests).toBe(calls + 1);
      expect(
        await dialog.locator('[data-capability]').allTextContents(),
      ).toEqual(before);
      expect(
        await unavailable.locator('details').getAttribute('open'),
      ).not.toBeNull();
      expect(
        await dialog
          .getByRole('button', { name: '准备报告与文件交付任务' })
          .isDisabled(),
      ).toBe(true);
      release();
      f.state.readinessDelay = null;
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(
        await unavailable.locator('details').getAttribute('open'),
      ).not.toBeNull();
      await f.page.keyboard.press('Escape');
      await f.page.waitForTimeout(50);
      expect(f.state.readinessRequests).toBe(calls + 1);
      await entry.click();
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(f.state.readinessRequests).toBe(calls + 2);
      expect(f.writes).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it('shows connection status only in linked apps while keeping four local capabilities in computer settings', async () => {
    const f = await fixture();
    try {
      f.state.connections = ['GitHub', 'Linear'].map((name, index) =>
        McpConnectionSchema.parse({
          id: id(70 + index),
          definitionId: id(80 + index),
          workspaceId: workspace,
          name,
          endpoint: `https://${name.toLowerCase()}.example.test/mcp`,
          enabled: true,
          revision: 1,
          credentialConfigured: true,
          credentialReference: 'synthetic',
          managed: true,
          shared: false,
          discoveryState: 'ready',
          discoveryCode: null,
          checkedAt: now,
          tools: [],
        }),
      );
      f.state.capabilities = f.state.capabilities.map((c) =>
        c.id === 'cloud_mcp' || c.id === 'local_mcp'
          ? {
              ...c,
              state: 'ready',
              reason: 'ready',
              action: 'compose',
              releaseEnabled: true,
            }
          : c,
      );
      await openCapabilities(f);
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const work = dialog.locator('[data-capability-scope="work"]');
      expect(await work.locator('[data-capability="cloud_mcp"]').count()).toBe(
        0,
      );
      expect(
        await work.getByRole('list', { name: '在线应用连接状态' }).count(),
      ).toBe(0);
      expect(await work.getByText('GitHub', { exact: true }).count()).toBe(0);
      expect(await work.getByText('Linear', { exact: true }).count()).toBe(0);
      await selectSettings(dialog, '我的电脑');
      const computer = dialog.locator('[data-capability-scope="computer"]');
      expect(await computer.locator('[data-capability]').count()).toBe(4);
      expect(
        await computer.locator('[data-capability="local_mcp"]').count(),
      ).toBe(0);
      expect(
        await computer.getByRole('list', { name: '在线应用连接状态' }).count(),
      ).toBe(0);
      await selectSettings(dialog, '已链接应用');
      expect(
        await dialog.getByText('本地应用高级设置', { exact: true }).count(),
      ).toBe(0);
      expect(
        await dialog.getByLabel('固定来源与完整文件校验和 JSON').count(),
      ).toBe(0);
      const apps = dialog.getByRole('region', {
        name: '已链接应用',
        exact: true,
      });
      const github = apps.getByRole('article').filter({
        has: f.page.getByRole('heading', { name: 'GitHub', exact: true }),
      });
      await github.getByText('管理连接', { exact: true }).click();
      await github
        .getByRole('button', { name: '断开连接', exact: true })
        .click();
      await github.getByText('已断开', { exact: true }).waitFor();
      await selectSettings(dialog, '工作方式');
      expect(await work.getByText('GitHub', { exact: true }).count()).toBe(0);
      expect(await work.getByText('已断开', { exact: true }).count()).toBe(0);
      await selectSettings(dialog, '已链接应用');
      await github.getByText('已断开', { exact: true }).waitFor();
      f.state.connectionError = true;
      await apps
        .getByRole('button', { name: '刷新连接状态', exact: true })
        .click();
      await apps.getByRole('alert').waitFor();
      expect(f.state.connectionActions).toEqual(['disconnect']);
      expect(f.state.messageInputs).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('UX01-B explicitly refreshes after settings and never treats errors or wrong scope as ready', async () => {
    const f = await fixture();
    try {
      await openCapabilities(f);
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      const work = dialog.locator('[data-capability-scope="work"]');
      const report = work.locator('[data-capability="report"]');
      await report
        .getByRole('button', { name: '准备报告与文件交付任务' })
        .waitFor();
      expect(await report.getByRole('link').count()).toBe(0);
      await selectSettings(dialog, '已链接应用');
      await dialog.getByText('还没有连接应用。', { exact: false }).waitFor();
      expect(await report.isVisible()).toBe(false);
      await selectSettings(dialog, '工作方式');
      await report
        .getByRole('button', { name: '准备报告与文件交付任务' })
        .waitFor();
      f.state.readinessError = true;
      await work.getByRole('button', { name: '刷新能力状态' }).click();
      await work
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      expect(await work.getByRole('button', { name: /^准备/ }).count()).toBe(0);
      expect(await report.getAttribute('data-state')).toBe('unknown');
      f.state.readinessError = false;
      f.state.readinessWrongScope = true;
      await work.getByRole('button', { name: '刷新能力状态' }).click();
      await work
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      expect(await work.getByRole('button', { name: /^准备/ }).count()).toBe(0);
      expect(await report.getAttribute('data-state')).toBe('unknown');
      expect(f.state.messageInputs).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('UX01-B ignores late readiness from a previous session and recovers after a failed check', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await openCapabilities(f);
      const dialog = f.page.getByRole('dialog', { name: '设置', exact: true });
      await dialog
        .getByRole('button', { name: '准备报告与文件交付任务' })
        .waitFor();
      f.state.readinessDelay = new Promise<void>((done) => {
        release = done;
      });
      const calls = f.state.readinessRequests;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await expect.poll(() => f.state.readinessRequests).toBeGreaterThan(calls);
      await f.page.keyboard.press('Escape');
      f.state.capabilities = f.state.capabilities.map((c) => ({
        ...c,
        state: 'not_released',
        reason: 'release_disabled',
        action: 'guide',
        releaseEnabled: false,
      }));
      await f.page.getByRole('treeitem', { name: /研究任务 B/ }).click();
      await openCapabilities(f);
      await dialog.getByText(/更新于/).waitFor();
      release();
      expect(
        await dialog
          .locator('[data-capability="report"]')
          .getAttribute('data-state'),
      ).toBe('not_released');
      expect(await dialog.getByRole('button', { name: /^准备/ }).count()).toBe(
        0,
      );
      f.state.readinessError = true;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog
        .getByText('能力状态未知，请刷新重试或重新登录。', { exact: true })
        .waitFor();
      f.state.readinessError = false;
      await dialog.getByRole('button', { name: '刷新能力状态' }).click();
      await dialog.getByText(/更新于/).waitFor();
      expect(
        await dialog
          .locator('[data-capability="report"]')
          .getAttribute('data-state'),
      ).toBe('not_released');
    } finally {
      release?.();
      await f.close();
    }
  });

  it(
    'restores the selected Session after reload and removes stale links for new work',
    { timeout: 20_000 },
    async () => {
      const f = await fixture({ artifacts: true });
      try {
        await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
        await expect
          .poll(() => new URL(f.page.url()).searchParams.get('session'))
          .toBe(B);
        await f.page.reload();
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
        await expect
          .poll(() => f.page.locator('h1').first().textContent())
          .toBe('研究任务 B');
        expect(
          await f.panel.getByRole('heading', { name: /COIN/ }).count(),
        ).toBe(0);
        await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
        await f.page.reload();
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.page
          .getByRole('button', { name: '新的工作', exact: true })
          .click();
        await f.page
          .getByRole('dialog', { name: '选择 AI 员工' })
          .locator('[data-default-employee="true"]')
          .click();
        await expect
          .poll(() => new URL(f.page.url()).searchParams.has('session'))
          .toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    'resolves a Session outside the sidebar page only through scoped history (denied=%s)',
    async (denied) => {
      const f = await fixture({ artifacts: true });
      try {
        f.state.omitSessionA = true;
        f.state.deepLinkDenied = denied;
        await f.page.reload();
        await expect
          .poll(() => f.page.locator('h1').first().textContent())
          .toBe(denied ? '研究任务 B' : '研究任务 A');
        expect(new URL(f.page.url()).searchParams.get('session')).toBe(
          denied ? B : A,
        );
        if (denied)
          expect(
            await f.panel.getByRole('heading', { name: /COIN/ }).count(),
          ).toBe(0);
        else await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
  it.each([false, true])(
    'automatically presents a newly completed SSE delivery with its full answer, but never reopens a panel the user closed (streaming=%s)',
    { timeout: 20_000 },
    async (streamingOutput) => {
      for (const closed of [false, true]) {
        const f = await fixture({
          running: true,
          artifacts: closed,
          streamingOutput,
        });
        try {
          await expect.poll(() => f.state.streamRequests).toBeGreaterThan(0);
          if (closed) {
            await f.panel.waitFor();
            await f.page
              .getByRole('button', { name: '关闭工作台', exact: true })
              .click();
          } else {
            expect(await f.panel.count()).toBe(0);
            expect(await f.entry.count()).toBe(1);
          }
          const composer = f.page.getByRole('textbox', {
            name: '给 Rice 的消息',
          });
          await composer.fill('我的后续问题');
          f.finishRun();
          const transcript = f.page.locator('[data-chat-scroll]');
          await transcript.getByRole('heading', { name: /COIN/ }).waitFor();
          expect(await transcript.getByRole('table').isVisible()).toBe(true);
          expect(
            await transcript
              .getByText('多步研究结果与引用说明。'.repeat(100), {
                exact: true,
              })
              .isVisible(),
          ).toBe(true);
          expect(
            await transcript.getByText('展开完整回复', { exact: true }).count(),
          ).toBe(0);
          expect(
            await composer.evaluate((e) => e === document.activeElement),
          ).toBe(true);
          if (closed) {
            expect(await f.panel.count()).toBe(0);
            await f.page
              .locator('header')
              .getByRole('button', {
                name: '交付成果，1 项新增',
                exact: true,
              })
              .waitFor();
            await f.openWorkbench();
          }
          await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        } finally {
          await f.close();
        }
      }
    },
  );

  it.each([
    [1440, true],
    [390, true],
    [1440, false],
    [390, false],
  ] as const)(
    'steering timeline places continued work and late PPT delivery below two inputs at %ipx streaming=%s',
    async (width, streamingOutput) => {
      const f = await fixture({
        width,
        streamingOutput,
        running: true,
        controlledStream: true,
      });
      const event = (
        sequence: number,
        type: ChatFlowEventEnvelope['type'],
        payload: Record<string, unknown>,
        native = sequence,
      ): ChatFlowEventEnvelope => ({
        schemaVersion: 3,
        eventId: id(9400 + sequence),
        organizationId: org,
        workspaceId: workspace,
        conversationId: A,
        runId: run,
        generation: 3,
        cursor: `${run}:${sequence}`,
        sequence,
        harness: 'dsh',
        type,
        occurredAt: now,
        sourceEvent: {
          id: `dsh:${native}`,
          type: 'user/message',
          occurredAt: now,
          payload: {},
        },
        payload: { generation: 3, turnId: 'native-turn:1', ...payload },
      });
      const emit = async (events: ChatFlowEventEnvelope[]) => {
        for (const e of events)
          await f.page.evaluate(
            (value) =>
              window.dispatchEvent(
                new CustomEvent('allrice-test-stream', {
                  detail: `data: ${JSON.stringify(value)}\n\n`,
                }),
              ),
            e,
          );
      };
      try {
        const input1: Message = {
          id: id(9501),
          role: 'user',
          runId: null,
          status: 'completed',
          content: { text: '要突出经验沉淀这个点' },
          createdAt: now,
          steering: {
            runId: run,
            turnId: 'native-turn:1',
            generation: 3,
            status: 'pending',
            sequence: null,
          },
        };
        const input2: Message = {
          ...input1,
          id: id(9502),
          content: { text: '在干活了吗' },
          steering: { ...input1.steering! },
        };
        f.state.messages = [
          {
            id: id(9500),
            role: 'assistant',
            runId: run,
            status: 'pending',
            content: { text: '' },
            createdAt: now,
          },
          input1,
          input2,
        ];
        f.state.inputs = [input1, input2].map((m, n) => ({
          inputId: id(9600 + n),
          kind: 'steer_current',
          status: 'pending',
          runId: id(9700 + n),
          messageId: m.id,
          artifactId: null,
          createdAt: now,
          turnId: 'native-turn:1',
          generation: 3,
          evidence: null,
        }));
        await f.page.reload();
        await f.page.getByText('在干活了吗', { exact: true }).waitFor();
        await expect
          .poll(() =>
            f.page.getByText('等待当前任务采纳', { exact: true }).count(),
          )
          .toBe(2);
        await expect
          .poll(() => f.page.locator('html').getAttribute('data-stream-ready'))
          .toBe('true');
        f.state.events = [
          event(1, 'tool.completed', {
            toolCallId: 'before',
            name: 'read',
            summary: '阅读原始资料',
          }),
          event(2, 'harness.native', {}, 132),
          event(3, 'tool.completed', {
            toolCallId: 'middle',
            name: 'read',
            summary: '整理经验沉淀',
          }),
          event(4, 'harness.native', {}, 139),
          event(5, 'tool.started', {
            toolCallId: 'after',
            name: 'write',
            summary: '制作员工版演示稿',
          }),
        ];
        input1.steering = {
          ...input1.steering!,
          status: 'adopted',
          sequence: 132,
        };
        input2.steering = {
          ...input2.steering!,
          status: 'adopted',
          sequence: 139,
        };
        f.state.inputs.forEach((input, n) => {
          input.status = 'adopted';
          input.evidence = {
            sequence: n ? 139 : 132,
            checkpoint: 'step_user_message',
          };
        });
        await emit(f.state.events);
        await expect
          .poll(
            () => f.page.getByText('已补充到当前任务', { exact: true }).count(),
            { timeout: 10000 },
          )
          .toBe(2);
        const segments = f.page.locator('[data-steering-segment]');
        await expect.poll(() => segments.count()).toBe(3);
        expect(await segments.nth(2).getAttribute('data-working')).toBe('true');
        expect(await segments.nth(0).getAttribute('data-working')).toBeNull();
        expect(await segments.nth(1).getAttribute('data-working')).toBeNull();
        expect(
          await f.page
            .getByText('已补充给正在工作的 Rice。', { exact: true })
            .count(),
        ).toBe(0);
        const beforeReads = f.state.artifactReads;
        const ppt = artifact(11);
        ppt.version.fileName = '员工版经验沉淀.pptx';
        ppt.version.format = 'pptx';
        ppt.object.mediaType =
          'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        f.state.items = [ppt];
        f.state.officePreview = {
          kind: 'office',
          format: 'pptx',
          checksum: ppt.object.checksum,
          pageCount: 1,
          pages: [
            {
              number: 1,
              base64:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
            },
          ],
          formulaCount: 0,
          formulaErrorCount: 0,
          formulas: [],
        };
        const text = `员工版已完成。\n\n[下载员工版 PPT](/api/v1/files/${ppt.object.id}/download?name=${encodeURIComponent(ppt.version.fileName)})`;
        f.state.messages[0] = {
          ...f.state.messages[0]!,
          status: 'completed',
          content: { text },
        };
        f.state.events.push(
          event(6, 'tool.completed', { toolCallId: 'after', name: 'write' }),
          event(7, 'assistant.text.completed', { text }),
          event(8, 'run.succeeded', {}),
        );
        await emit(f.state.events.slice(-3));
        const link = f.page
          .locator('[data-chat-scroll]')
          .getByRole('link', { name: '下载员工版 PPT', exact: true });
        await link.waitFor();
        await expect.poll(() => f.state.artifactReads > beforeReads).toBe(true);
        expect(
          await f.page.evaluate(
            ([messageId]) => {
              const user = document.getElementById(`message-${messageId}`)!;
              const link = [
                ...document.querySelectorAll('[data-chat-scroll] a'),
              ].find((el) => el.textContent === '下载员工版 PPT')!;
              return Boolean(
                user.compareDocumentPosition(link) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              );
            },
            [input2.id],
          ),
        ).toBe(true);
        await link.click();
        await f.panel
          .getByRole('img', { name: 'Office 文档第 1 页' })
          .waitFor();
        expect(f.context.pages()).toHaveLength(1);
        await f.page.reload();
        await f.page
          .locator(`[data-steering-segment="${input2.id}"]`)
          .waitFor();
        await link.waitFor();
        expect(
          await f.page.getByText('已补充到当前任务', { exact: true }).count(),
        ).toBe(2);
        expect(
          await f.page
            .getByText('已补充给正在工作的 Rice。', { exact: true })
            .count(),
        ).toBe(0);
        if (process.env.ALLRICE_STEERING_SCREENSHOTS)
          await f.page.screenshot({
            path: `${process.env.ALLRICE_STEERING_SCREENSHOTS}-${width}-${streamingOutput}.png`,
          });
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

  it('reconciles an uncatalogued delivery on click without leaving the current conversation', async () => {
    const f = await fixture();
    try {
      const a = artifact(11);
      f.state.reply = `[下载补发报告](/api/v1/files/${a.object.id}/download)`;
      f.state.files = [
        {
          id: a.object.id,
          fileName: a.version.fileName,
          mediaType: a.object.mediaType,
          sizeBytes: a.object.sizeBytes,
          visibility: 'private',
          ownedByMe: true,
          category: 'exports',
          deliverableVersion: 1,
        },
      ];
      await f.page.reload();
      const link = f.page
        .locator('[data-chat-scroll]')
        .getByRole('link', { name: '下载补发报告', exact: true });
      await link.waitFor();
      f.state.items = [a];
      await link.click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(f.context.pages()).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('slides the native dock with the conversation track, restores cached catalogs and respects reduced motion', async () => {
    const f = await fixture({ artifacts: true });
    let release = () => {};
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      const host = f.panel
        .locator('[data-dockkit-host="dock"]:not([hidden])')
        .first();
      await expect
        .poll(() => host.evaluate((e) => getComputedStyle(e).transform))
        .toBe('none');
      expect(f.state.artifactReads).toBe(1);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      expect(await f.panel.count()).toBe(0);
      await expect
        .poll(() =>
          f.page
            .locator(
              '#artifact-workbench [data-dockkit-host="dock"]:not([hidden])',
            )
            .first()
            .evaluate((e) => getComputedStyle(e).visibility),
        )
        .toBe('hidden');
      // Read every paint, not a screenshot taken after the motion has finished.
      const frames = await f.page.evaluate(async () => {
        const panel = document.querySelector('#artifact-workbench')!;
        const entry = Array.from(
          document.querySelectorAll<HTMLButtonElement>('button'),
        ).find((e) => e.getAttribute('aria-label') === '展开工作台')!;
        const samples: Array<{ x: number; width: number; track: number }> = [];
        const start = performance.now();
        entry.click();
        await new Promise<void>((done) => {
          const tick = () => {
            const rect = panel
              .querySelector<HTMLElement>(
                '[data-dockkit-host="dock"]:not([hidden])',
              )!
              .getBoundingClientRect();
            const columns = getComputedStyle(
              document.querySelector('main')!,
            ).gridTemplateColumns.split(' ');
            samples.push({
              x: rect.x,
              width: rect.width,
              track: parseFloat(columns[2]!),
            });
            if (performance.now() - start > 450) done();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return samples;
      });
      const end = frames.at(-1)!;
      expect(frames.some((f) => f.x > end.x + 20 && f.x < 1440 - 20)).toBe(
        true,
      );
      expect(frames.some((f) => f.track > 20 && f.track < end.track - 20)).toBe(
        true,
      );
      expect(
        Math.max(...frames.map((f) => f.width)) -
          Math.min(...frames.map((f) => f.width)),
      ).toBeLessThan(2);
      f.state.delay = new Promise<void>((done) => {
        release = done;
      });
      const [bCatalog] = await Promise.all([
        f.page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `/api/v1/sessions/${B}/artifacts`,
        ),
        f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click(),
      ]);
      await bCatalog.finished();
      await expect.poll(() => f.panel.count()).toBe(0);
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      // A's refreshed catalog is blocked. The retained catalog still opens now.
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.count()).toBe(1);
      release();
      f.state.delay = null;
      await f.page.emulateMedia({ reducedMotion: 'reduce' });
      expect(
        await host.evaluate((e) => getComputedStyle(e).transitionDuration),
      ).toBe('0s');
    } finally {
      release();
      await f.close();
    }
  });

  it.each([false, true])(
    'shows a real report in a persistent third column, leaves composer focus alone and keeps the full historical answer visible (streaming=%s)',
    async (streamingOutput) => {
      const f = await fixture({
        artifacts: true,
        running: true,
        streamingOutput,
        initialMessages: [
          {
            id: id(9000),
            role: 'assistant',
            runId: null,
            status: 'completed',
            content: { text: report },
            createdAt: now,
          },
          {
            id: id(20),
            role: 'assistant',
            runId: run,
            status: 'pending',
            content: { text: '' },
            createdAt: now,
          },
        ],
      });
      try {
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        expect(await f.panel.getByRole('table').count()).toBe(1);
        expect(
          await f.page.getByText('展开完整回复', { exact: true }).count(),
        ).toBe(0);
        const transcript = f.page.locator('[data-chat-scroll]');
        expect(
          await transcript.getByRole('heading', { name: /COIN/ }).isVisible(),
        ).toBe(true);
        expect(await transcript.getByRole('table').isVisible()).toBe(true);
        expect(
          await transcript
            .getByText('多步研究结果与引用说明。'.repeat(100), { exact: true })
            .isVisible(),
        ).toBe(true);
        expect(
          await f.page.evaluate(
            () =>
              getComputedStyle(
                document.querySelector('main')!,
              ).gridTemplateColumns.split(' ').length,
          ),
        ).toBe(3);
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
        });
        await composer.fill('继续核对来源');
        await f.page.screenshot({ path: '/tmp/met147-desktop.png' });
        // Complete the current synthetic turn through the real stream/history
        // entrance; a successful immutable preview has no refresh action.
        f.state.messages![1] = {
          ...f.state.messages![1]!,
          status: 'completed',
          content: { text: report },
        };
        f.finishRun();
        await composer.focus();
        await expect
          .poll(() =>
            f.panel
              .locator('[data-document-id]:visible')
              .last()
              .getAttribute('data-document-id'),
          )
          .toBe(id(11));
        expect(
          await composer.evaluate((e) => e === document.activeElement),
        ).toBe(true);
        expect(await composer.inputValue()).toBe('继续核对来源');
      } finally {
        await f.close();
      }
    },
  );

  it(
    'remembers explicit closure and sidebar preferences per user/workspace, including blocked storage fallback',
    { timeout: 20_000 },
    async () => {
      const f = await fixture({ artifacts: true });
      try {
        await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
        await f.page
          .getByRole('button', { name: '收起侧边栏', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        await f.page.reload();
        await f.entry.waitFor();
        expect(await f.panel.count()).toBe(0);
        expect(
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .count(),
        ).toBe(1);
        const value = await f.page.evaluate(
          (key) => localStorage.getItem(key),
          layoutPreferenceKey(user, org, workspace)!,
        );
        expect(JSON.parse(value!)).toEqual({
          sidebarCollapsed: true,
          panelOpen: false,
          panelWidth: null,
          sidebarWidth: null,
        });
        f.state.viewer = id(50);
        await f.page.reload();
        await f.panel.waitFor();
        expect(
          await f.page
            .getByRole('button', { name: '收起侧边栏', exact: true })
            .count(),
        ).toBe(1);
        await f.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        f.state.workspace = id(51);
        f.state.items = [];
        await f.page.reload();
        await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
        expect(await f.panel.count()).toBe(0);
      } finally {
        await f.close();
      }
      const fallback = await fixture({ noStorage: true, artifacts: true });
      try {
        await fallback.panel.waitFor();
        await fallback.page
          .getByRole('button', { name: '关闭工作台', exact: true })
          .click();
        expect(await fallback.panel.count()).toBe(0);
      } finally {
        await fallback.close();
      }
    },
  );

  it('resizes the employee sidebar with native capture, preserves scoped width and leaves usable conversation space', async () => {
    const f = await fixture({
      artifacts: true,
      employeeCount: 2,
      employeeHistory: true,
    });
    try {
      const sidebar = f.page.locator('#chat-sidebar');
      const splitter = f.page.getByRole('separator', {
        name: '调整员工侧栏宽度',
      });
      const width = async () =>
        Math.round((await sidebar.boundingBox())!.width);
      await splitter.waitFor();
      const composer = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await composer.fill('侧栏拖动不丢草稿');
      async function dragTo(x: number) {
        const box = (await splitter.boundingBox())!;
        await f.page.mouse.move(box.x + box.width / 2, box.y + 150);
        await f.page.mouse.down();
        await f.page.mouse.move(x, box.y + 150, { steps: 8 });
        expect(await f.page.locator('main').getAttribute('data-dragging')).toBe(
          'true',
        );
        await f.page.mouse.up();
      }
      await dragTo(360);
      await expect.poll(width).toBe(360);
      await f.page
        .getByRole('button', { name: '收起侧边栏', exact: true })
        .click();
      await expect.poll(() => splitter.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await expect.poll(width).toBe(360);
      expect(await composer.inputValue()).toBe('侧栏拖动不丢草稿');
      await f.page.reload();
      await splitter.waitFor();
      await expect.poll(width).toBe(360);
      await dragTo(900);
      await expect.poll(width).toBe(420);
      const right = f.page.getByRole('separator', { name: '调整交付成果宽度' });
      await right.focus();
      await f.page.keyboard.press('Shift+ArrowLeft');
      // Reproduce classic Linux scrollbar/embedded-frame space on every host.
      await f.page.addStyleTag({
        content: 'main { width: calc(100% - 8px) !important; }',
      });
      await f.page.setViewportSize({ width: 1101, height: 950 });
      await expect
        .poll(async () =>
          Math.round(
            (await f.page.locator('main > section').boundingBox())!.width,
          ),
        )
        .toBeGreaterThanOrEqual(340);
      await expect.poll(width).toBeLessThan(420);
      const clampedSidebar = await width();
      await splitter.focus();
      await f.page.keyboard.press('ArrowLeft');
      await expect.poll(width).toBe(clampedSidebar - 20);
      await dragTo(100);
      await expect.poll(width).toBe(240);
      await splitter.focus();
      await f.page.keyboard.press('Shift+ArrowRight');
      await expect.poll(width).toBe(340);
      await splitter.dblclick({ position: { x: 4, y: 150 } });
      await expect.poll(width).toBe(240);
      await splitter.focus();
      await f.page.keyboard.press('Shift+ArrowRight');
      await f.page.setViewportSize({ width: 390, height: 844 });
      // matchMedia delivers its change after the viewport command resolves.
      await expect.poll(() => splitter.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '任务与历史' }).waitFor();
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.screenshot({ path: '/tmp/met160-employee-blue-mobile.png' });
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await expect.poll(width).toBe(340);
      await f.page.screenshot({
        path: '/tmp/met160-employee-blue-desktop.png',
      });
      f.state.viewer = id(50);
      await f.page.reload();
      await splitter.waitFor();
      await expect.poll(width).toBe(240);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 900])(
    'keeps workbench expand and collapse controls under the same pointer at %ipx',
    async (width) => {
      const f = await fixture({ width, artifacts: true });
      try {
        if (width > 1100)
          await f.page.addStyleTag({
            content: 'main { width: calc(100% - 8px) !important; }',
          });
        const expand = f.page.getByRole('button', {
          name: '展开工作台',
          exact: true,
        });
        const collapse = f.panel.getByRole('button', {
          name: '关闭工作台',
          exact: true,
        });
        const geometry = (control: Locator) =>
          control.evaluate((button) => {
            const target = button.getBoundingClientRect();
            const glyph = button.querySelector('svg')!.getBoundingClientRect();
            const frame = document
              .querySelector('main')!
              .getBoundingClientRect();
            return {
              target: [target.width, target.height],
              glyph: [glyph.width, glyph.height],
              center: [
                target.x + target.width / 2,
                target.y + target.height / 2,
              ],
              glyphCenter: [
                glyph.x + glyph.width / 2,
                glyph.y + glyph.height / 2,
              ],
              gap: frame.right - target.right,
            };
          });
        if (await collapse.isVisible()) await collapse.click();
        await expand.waitFor();
        await expect
          .poll(async () => Math.round((await geometry(expand)).gap))
          .toBe(28);
        const folded = await geometry(expand);
        expect(folded.target).toEqual([32, 32]);
        expect(folded.glyph).toEqual([20, 20]);
        expect(folded.glyphCenter).toEqual(folded.center);
        await f.page.mouse.click(folded.center[0]!, folded.center[1]!);
        await collapse.waitFor();
        await expect
          .poll(async () => (await geometry(collapse)).gap)
          .toBeCloseTo(folded.gap, 1);
        const expanded = await geometry(collapse);
        expect(expanded.target).toEqual(folded.target);
        expect(expanded.glyph).toEqual(folded.glyph);
        expect(expanded.glyphCenter).toEqual(expanded.center);
        for (const axis of [0, 1])
          expect(expanded.center[axis]).toBeCloseTo(folded.center[axis]!, 1);
        // The pointer can close and reopen without moving to another header.
        await f.page.mouse.click(folded.center[0]!, folded.center[1]!);
        await expand.waitFor();
        await expect
          .poll(async () => (await geometry(expand)).center)
          .toEqual(folded.center);
        await f.page.mouse.click(folded.center[0]!, folded.center[1]!);
        await collapse.waitFor();
      } finally {
        await f.close();
      }
    },
  );

  it('aligns 56px headers and resizes deliverables with native capture, limits, reset and preserved drafts', async () => {
    const f = await fixture({ artifacts: true });
    try {
      // Classic scrollbars / embedded frames can make the frame narrower than
      // the viewport. Reset uses 38% of that frame; cap leaves usable chat width.
      await f.page.addStyleTag({
        content: 'main { width: calc(100% - 8px) !important; }',
      });
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      const defaultWidth = Math.round(
        (await f.page.locator('main').boundingBox())!.width * 0.38,
      );
      const splitter = f.page.getByRole('separator', {
        name: '调整交付成果宽度',
      });
      const composer = f.page.getByRole('textbox', { name: '给 Rice 的消息' });
      await composer.fill('保留我的聊天草稿');
      const headerGeometry = () =>
        f.page.evaluate(() => {
          const left = document
            .querySelector('main > section header')!
            .getBoundingClientRect();
          const right = document
            .querySelector('#artifact-workbench [data-dockkit-strip]')!
            .getBoundingClientRect();
          return {
            left: left.height,
            right: right.height,
            delta: left.bottom - right.bottom,
          };
        });
      expect(await headerGeometry()).toEqual({ left: 56, right: 56, delta: 0 });
      expect(await f.panel.getByRole('tab', { name: /^开始/ }).count()).toBe(1);
      expect(
        await f.page
          .locator('header')
          .getByRole('button', { name: '交付成果', exact: true })
          .count(),
      ).toBe(1);
      const panelWidth = async () =>
        Math.round((await f.panel.boundingBox())!.width);
      await expect.poll(panelWidth).toBe(defaultWidth);
      async function dragTo(x: number) {
        const box = (await splitter.boundingBox())!;
        await f.page.mouse.move(box.x + box.width / 2, box.y + 100);
        await f.page.mouse.down();
        await f.page.mouse.move(x, box.y + 100, { steps: 8 });
        expect(await f.page.locator('main').getAttribute('data-dragging')).toBe(
          'true',
        );
        await f.page.mouse.up();
        expect(
          await f.page.locator('main').getAttribute('data-dragging'),
        ).toBeNull();
      }
      await dragTo(1400);
      await expect.poll(panelWidth).toBe(340);
      await dragTo(30);
      await expect
        .poll(panelWidth)
        .toBe(
          Math.round((await f.page.locator('main').boundingBox())!.width) -
            240 -
            340,
        );
      expect(await splitter.getAttribute('aria-valuenow')).toBe(
        String(
          Math.round((await f.page.locator('main').boundingBox())!.width) -
            240 -
            340,
        ),
      );
      const center = (await f.page.locator('main > section').boundingBox())!;
      for (const control of [
        f.page.getByRole('button', { name: '添加文件', exact: true }),
        f.page.getByRole('button', { name: '发送', exact: true }),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(center.x);
        expect(box.x + box.width).toBeLessThanOrEqual(center.x + center.width);
      }
      expect(await headerGeometry()).toEqual({ left: 56, right: 56, delta: 0 });
      await splitter.dblclick({ position: { x: 4, y: 100 } });
      await expect.poll(panelWidth).toBe(defaultWidth);
      await splitter.focus();
      await f.page.keyboard.press('ArrowLeft');
      await expect.poll(panelWidth).toBe(defaultWidth + 20);
      await f.page.keyboard.press('Home');
      await expect.poll(panelWidth).toBe(defaultWidth);
      // A canceled gesture must release capture and restore grid transitions.
      const box = (await splitter.boundingBox())!;
      await f.page.mouse.move(box.x + 4, box.y + 100);
      await f.page.mouse.down();
      await f.page.mouse.move(box.x - 50, box.y + 100);
      await splitter.dispatchEvent('pointercancel');
      await f.page.mouse.up();
      expect(
        await f.page.locator('main').getAttribute('data-dragging'),
      ).toBeNull();
      expect(await composer.inputValue()).toBe('保留我的聊天草稿');
      await f.page.screenshot({
        path: '/tmp/allrice-deliverables-desktop.png',
      });
    } finally {
      await f.close();
    }
  });

  it('remembers resized width per viewer, clamps on viewport resize and retains the narrow drawer', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const splitter = f.page.getByRole('separator', {
        name: '调整交付成果宽度',
      });
      await splitter.waitFor();
      const defaultWidth = Math.round(
        (await f.page.locator('main').boundingBox())!.width * 0.38,
      );
      const resizedWidth = String(defaultWidth + 100);
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(String(defaultWidth));
      await splitter.focus();
      await f.page.keyboard.press('Shift+ArrowLeft');
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(resizedWidth);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      await f.openWorkbench();
      expect(await splitter.getAttribute('aria-valuenow')).toBe(resizedWidth);
      await f.page.reload();
      await splitter.waitFor();
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(resizedWidth);
      const box = (await splitter.boundingBox())!;
      await f.page.mouse.move(box.x + 4, box.y + 100);
      await f.page.mouse.down();
      await f.page.mouse.move(10, box.y + 100, { steps: 6 });
      await f.page.mouse.up();
      await f.page.setViewportSize({ width: 1200, height: 950 });
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(
          String(
            Math.round((await f.page.locator('main').boundingBox())!.width) -
              240 -
              340,
          ),
        );
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(
          String(
            Math.round((await f.page.locator('main').boundingBox())!.width) -
              240 -
              340,
          ),
        );
      await f.page.setViewportSize({ width: 390, height: 950 });
      await expect.poll(() => splitter.count()).toBe(0);
      expect(await f.panel.getAttribute('role')).toBe('dialog');
      await f.page.screenshot({ path: '/tmp/allrice-deliverables-mobile.png' });
      f.state.viewer = id(50);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.page.reload();
      await splitter.waitFor();
      await expect
        .poll(() => splitter.getAttribute('aria-valuenow'))
        .toBe(String(defaultWidth));
    } finally {
      await f.close();
    }
  });

  it('uses a narrow drawer, traps/restores focus, preserves preview state across resize, and has no horizontal overflow', async () => {
    const f = await fixture({ width: 390, artifacts: true });
    try {
      expect(await f.panel.count()).toBe(0);
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '任务与历史' }).waitFor();
      const quota = f.page.getByRole('button', { name: '设置', exact: true });
      await quota.focus();
      await f.page.keyboard.press('Tab');
      expect(
        await f.page
          .getByRole('dialog', { name: '任务与历史' })
          .evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      await f.page.keyboard.press('Shift+Tab');
      expect(await quota.evaluate((e) => e === document.activeElement)).toBe(
        true,
      );
      await f.page.keyboard.press('Escape');
      expect(
        await f.page.getByRole('dialog', { name: '任务与历史' }).count(),
      ).toBe(0);
      await f.openWorkbench();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getAttribute('role')).toBe('dialog');
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await f.panel.evaluate((e) => e.contains(document.activeElement)),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      await expect
        .poll(() => f.entry.evaluate((e) => e === document.activeElement))
        .toBe(true);
      expect(await f.panel.count()).toBe(0);
      await f.page.setViewportSize({ width: 1440, height: 950 });
      await f.panel.waitFor();
      await expect
        .poll(() => f.panel.getAttribute('role'))
        .toBe('complementary');
      await f.fileAction('查看源文本');
      const metadata = f.panel.getByRole('region', {
        name: '源文本',
        exact: true,
      });
      await f.page.setViewportSize({ width: 390, height: 844 });
      // Viewport acknowledgement precedes the matchMedia event/React commit.
      // Await the rendered drawer, rather than racing its previous wide role.
      await expect.poll(() => f.panel.getAttribute('role')).toBe('dialog');
      expect(await metadata.isVisible()).toBe(true);
      await f.page.screenshot({ path: '/tmp/met147-mobile.png' });
      expect(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await f.panel.count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('MET160 native Dock preserves previews across tabs, split, fullscreen, close and restored layout', async () => {
    const f = await fixture({ technicalArtifacts: true, artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      // Selecting a version pins it while newer artifacts arrive.
      await f.selectArtifact(10);
      await f.fileAction('查看源文本');
      const metadata = f.panel.getByRole('region', {
        name: '源文本',
        exact: true,
      });
      f.state.items.push(artifact(11));
      await f.reloadList();
      await f.panel
        .getByRole('button', { name: '全屏查看', exact: true })
        .click();
      await f.panel
        .getByRole('button', { name: '并排查看', exact: true })
        .click();
      await expect
        .poll(() => f.panel.locator('[data-dockkit-pane]').count())
        .toBe(2);
      await f.panel
        .getByRole('button', {
          name: /交付成果.*员工交付的文件和你在对话中上传的文件/,
        })
        .click();
      await f.panel
        .getByRole('region', { name: '交付成果', exact: true })
        .getByRole('button', { name: 'report-11.md', exact: true })
        .click();
      await expect
        .poll(() => f.panel.locator('[data-document-id]:visible').count())
        .toBe(2);
      // The pane shell mounts before its authenticated preview has returned.
      await f.panel
        .getByRole('region', { name: '文件正文', exact: true })
        .waitFor();
      expect(await metadata.count()).toBe(1);
      expect(
        await f.panel
          .getByRole('region', { name: '文件正文', exact: true })
          .count(),
      ).toBe(1);
      const divider = f.panel.locator('[data-dockkit-divider]');
      const box = (await divider.boundingBox())!;
      await f.page.mouse.move(box.x, box.y + 120);
      await f.page.mouse.down();
      await f.page.mouse.move(box.x + 100, box.y + 120, { steps: 6 });
      await f.page.mouse.up();
      const panes = await f.panel.locator('[data-dockkit-pane]').all();
      expect((await panes[0]!.boundingBox())!.width).toBeGreaterThan(
        (await panes[1]!.boundingBox())!.width,
      );
      await f.panel
        .getByRole('button', { name: '退出全屏', exact: true })
        .click();
      expect(await metadata.count()).toBe(1);
      expect(
        await f.panel
          .getByRole('region', { name: '文件正文', exact: true })
          .count(),
      ).toBe(1);
      await f.panel
        .getByRole('button', { name: '全屏查看', exact: true })
        .click();
      await f.page.screenshot({ path: '/tmp/allrice-met160-dock-split.png' });
      await f.page.reload();
      await expect
        .poll(() => f.panel.locator('[data-dockkit-pane]').count())
        .toBe(2);
      expect(await f.panel.getAttribute('data-fullscreen')).toBe('true');
      await expect
        .poll(() => f.panel.getByRole('heading', { name: /COIN/ }).count())
        .toBe(2);
      await f.panel
        .getByRole('tab', { name: /^report-11.md/ })
        .getByRole('button', { name: '关闭标签', exact: true })
        .click();
      expect(
        await f.panel.getByRole('tab', { name: /^report-11.md/ }).count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);

  it('does not poll immutable or hidden document tabs and retries genuine load errors', async () => {
    const f = await fixture({ technicalArtifacts: true, artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      f.state.items.push({
        ...artifact(11),
        provenance: {
          ...artifact(11).provenance,
          kind: 'project_snapshot' as const,
        },
      });
      await f.reloadList();
      await f.panel
        .locator(`[data-document-id="${id(11)}"]`)
        .getByRole('heading', { name: /COIN/ })
        .waitFor();
      const before = { ...f.state.detailReads };
      // Longer than the previous five-second timer; both visible and hidden reads stay quiet.
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(f.state.detailReads).toEqual(before);
      f.state.detailStatus = 503;
      await f.fileAction('刷新文件');
      await f.panel
        .getByRole('button', { name: '重试加载文件', exact: true })
        .waitFor();
      f.state.detailStatus = 200;
      await f.panel
        .getByRole('button', { name: '重试加载文件', exact: true })
        .click();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.panel.getByRole('alert').count()).toBe(0);
      f.state.detailStatus = 403;
      await f.fileAction('刷新文件');
      await f.panel.getByRole('alert').waitFor();
      expect(await f.panel.getByRole('heading', { name: /COIN/ }).count()).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  }, 30_000);

  it('keeps model-proposal plan review, recovers refresh errors and sends the exact plan confirmation', async () => {
    const f = await fixture({ artifacts: true });
    try {
      f.state.items[0]!.kind = 'plan';
      await f.page.reload();
      await f.page
        .locator('[data-chat-scroll]')
        .getByRole('button', { name: '侧栏预览 report-10.md', exact: true })
        .click();
      const heading = f.panel.getByRole('heading', { name: /COIN/ });
      await heading.waitFor();
      const plan = f.state.items[0]!;
      expect(plan.provenance.kind).toBe('model_proposal');
      const approve = f.panel.getByRole('button', {
        name: '认可本版计划，继续',
        exact: true,
      });
      await approve.waitFor();
      expect(await approve.isEnabled()).toBe(true);
      f.state.detailStatus = 503;
      await f.panel.getByRole('alert').waitFor({ timeout: 10000 });
      expect(await heading.isVisible()).toBe(true);
      expect(await approve.isEnabled()).toBe(false);
      f.state.detailStatus = 200;
      await expect
        .poll(() => f.panel.getByRole('alert').count(), { timeout: 10000 })
        .toBe(0);
      expect(await heading.isVisible()).toBe(true);
      await f.page
        .locator('header')
        .getByRole('button', { name: '交付成果', exact: true })
        .click();
      await f.panel
        .getByRole('region', { name: '交付成果', exact: true })
        .getByRole('button', { name: plan.version.fileName, exact: true })
        .click();
      await approve.click();
      await expect.poll(() => f.state.messageInputs.length).toBe(1);
      expect(f.state.messageInputs[0]).toMatchObject({
        text: '认可本版计划并继续',
        deliveryMode: 'follow_up',
        attachmentIds: [],
        reviewContinuation: {
          kind: 'plan_review',
          artifactId: plan.id,
          checksum: plan.object.checksum,
        },
      });
      await f.panel
        .getByRole('button', { name: '计划确认已发送', exact: true })
        .waitFor();
    } finally {
      await f.close();
    }
  }, 30_000);

  it('protects explicit version selection on new artifacts, including list failure/retry', async () => {
    const f = await fixture({ technicalArtifacts: true, artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      await f.selectArtifact(10);
      f.state.items.unshift({
        ...artifact(11),
        provenance: {
          ...artifact(11).provenance,
          kind: 'project_snapshot' as const,
        },
      });
      await f.reloadList();
      expect(
        await f.panel
          .locator('[data-document-id]:visible')
          .last()
          .getAttribute('data-document-id'),
      ).toBe(id(10));
      await f.panel.getByRole('button', { name: '查看新成果' }).waitFor();
      expect(
        await f.panel.getByRole('heading', { name: /COIN/ }).isVisible(),
      ).toBe(true);
      f.state.listError = true;
      await f.reloadList();
      // A catalog refresh failure is not a failure of the loaded document.
      await f.fileAction('查看所有成果');
      await f.panel.getByRole('alert').waitFor();
      await f.panel
        .getByRole('button', { name: '侧栏预览 report-10.md', exact: true })
        .click();
      expect(await f.panel.getByRole('alert').count()).toBe(0);
      expect(
        await f.panel.getByRole('heading', { name: /COIN/ }).isVisible(),
      ).toBe(true);
      f.state.listError = false;
      await f.reloadList();
      await f.panel.getByRole('button', { name: '查看新成果' }).click();
      await expect
        .poll(() =>
          f.panel
            .locator('[data-document-id]:visible')
            .last()
            .getAttribute('data-document-id'),
        )
        .toBe(id(11));
      f.state.items.unshift({
        ...artifact(12),
        provenance: {
          ...artifact(12).provenance,
          kind: 'project_snapshot' as const,
        },
      });
      await f.reloadList();
      expect(
        await f.panel
          .locator('[data-document-id]:visible')
          .last()
          .getAttribute('data-document-id'),
      ).toBe(id(11));
      await f.panel.getByRole('button', { name: '查看新成果' }).waitFor();
    } finally {
      await f.close();
    }
  });

  for (const width of [1440, 390])
    it(`selects, removes and sends authorized session references at ${width}px`, async () => {
      const f = await fixture({ width });
      try {
        const sources = [
          session(A),
          { ...session(B), title: '历史财报' },
          { ...session(id(801)), title: '市场研究' },
          { ...session(id(802)), title: '上次汇报' },
          { ...session(id(803)), title: '竞争对手' },
        ];
        await f.page.route('**/api/v1/sessions?**', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ sessions: sources, nextCursor: null }),
          }),
        );
        await f.page
          .getByRole('button', { name: '添加文件', exact: true })
          .click();
        await f.page.getByRole('menuitem', { name: '引用会话' }).click();
        const picker = f.page.getByRole('dialog', { name: '引用会话' });
        await picker.getByRole('button', { name: /历史财报/ }).click();
        await picker.getByRole('button', { name: /市场研究/ }).click();
        await picker.getByRole('button', { name: /上次汇报/ }).click();
        expect(
          await picker.getByRole('button', { name: /竞争对手/ }).isDisabled(),
        ).toBe(true);
        expect(
          await picker.getByRole('button', { name: /研究任务 A/ }).count(),
        ).toBe(0);
        if (process.env.ALLRICE_SESSION_REFERENCE_SCREENSHOT) {
          await f.page.screenshot({
            path: `${process.env.ALLRICE_SESSION_REFERENCE_SCREENSHOT}-${width}.png`,
          });
        }
        await picker.getByRole('button', { name: '完成', exact: true }).click();
        await f.page
          .getByRole('button', { name: '移除引用：市场研究' })
          .click();
        await f.page
          .getByRole('button', { name: '移除引用：上次汇报' })
          .click();
        const input = f.page.getByRole('textbox', { name: /给 .* 的消息/ });
        await input.fill('请根据引用整理汇报');
        await input.press('Enter');
        await expect.poll(() => f.state.messageInputs.length).toBe(1);
        expect(f.state.messageInputs[0]).toMatchObject({
          text: '请根据引用整理汇报',
          sessionReferenceIds: [B],
          deliveryMode: 'follow_up',
        });
        await expect
          .poll(() =>
            f.page.getByRole('button', { name: '移除引用：历史财报' }).count(),
          )
          .toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });

  it('keeps long replies entirely in the transcript and hides the workbench for conversations without artifacts', async () => {
    const f = await fixture();
    try {
      await f.page.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(await f.page.getByRole('table').count()).toBe(1);
      expect(
        await f.page
          .getByText('多步研究结果与引用说明。'.repeat(100), { exact: true })
          .count(),
      ).toBe(1);
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
      expect(await f.panel.count()).toBe(0);
      expect(await f.entry.count()).toBe(1);
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      expect(await f.panel.count()).toBe(0);
      expect(await f.entry.count()).toBe(1);
      await f.page
        .getByRole('button', { name: '新的工作', exact: true })
        .click();
      expect(await f.panel.count()).toBe(0);
      expect(await f.entry.count()).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('rejects late cross-session responses, isolates unsafe Markdown and reads native text pages', async () => {
    const f = await fixture({ technicalArtifacts: true, artifacts: true });
    try {
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      let release!: () => void;
      f.state.delay = new Promise<void>((done) => {
        release = done;
      });
      await f.openWorkbench();
      await f.page.getByRole('treeitem', { name: /^研究任务 B/ }).click();
      await expect.poll(() => f.panel.count()).toBe(0);
      release();
      f.state.delay = null;
      expect(await f.panel.getByRole('heading', { name: /COIN/ }).count()).toBe(
        0,
      );
      f.state.contentError = true;
      await f.page.getByRole('treeitem', { name: /^研究任务 A/ }).click();
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .waitFor();
      f.state.contentError = false;
      let imageRequested = false;
      await f.page.route('https://example.com/tracker.png', async (route) => {
        imageRequested = true;
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            'base64',
          ),
        });
      });
      f.state.text =
        '# Safe report\n<script>window.BAD = true</script>\n\n![tracking](https://example.com/tracker.png)\n\n[bad](javascript:alert(1))';
      await f.panel
        .getByRole('button', { name: '重试预览', exact: true })
        .click();
      await f.panel.getByRole('heading', { name: 'Safe report' }).waitFor();
      expect(
        await f.panel.locator('iframe,script,a[href^="javascript:"]').count(),
      ).toBe(0);
      expect(
        await f.page.evaluate(() => Reflect.get(window, 'BAD')),
      ).toBeUndefined();
      await expect.poll(() => imageRequested).toBe(true);
      await expect
        .poll(() =>
          f.panel
            .locator('img[src="https://example.com/tracker.png"]')
            .evaluateAll((images) =>
              images.some(
                (image) => (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      f.state.text = Array.from(
        { length: 601 },
        (_, i) => `较长的安全原文 ${i}`,
      ).join('\n');
      f.state.textPageLines = 400;
      const paged = artifact(12);
      paged.provenance.kind = 'project_snapshot';
      f.state.items.unshift(paged);
      await f.reloadList();
      const body = f.panel.getByRole('region', {
        name: '文件正文',
        exact: true,
      });
      await body.waitFor();
      const firstLength = (await body.innerText()).length;
      expect(firstLength).toBeLessThan(f.state.text.length);
      for (let i = 0; i < 3; i++) {
        await f.panel.getByRole('button', { name: '下一页' }).click();
      }
      await expect
        .poll(() => body.innerText(), { timeout: 10_000 })
        .toContain('较长的安全原文 600');
      expect(
        await f.panel.getByRole('button', { name: '下一页' }).isDisabled(),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('keeps the existing feature gate and does not invent artifacts from streaming / failed messages', async () => {
    const off = await fixture({ disabled: true });
    try {
      expect(await off.panel.count()).toBe(0);
      expect(await off.entry.count()).toBe(0);
    } finally {
      await off.close();
    }
    const f = await fixture();
    try {
      f.state.messageStatus = 'pending';
      await f.page.reload();
      await f.page.getByRole('textbox', { name: '给 Rice 的消息' }).waitFor();
      expect(await f.entry.count()).toBe(1);
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
      expect(
        await f.page.getByText('展开完整回复', { exact: true }).count(),
      ).toBe(0);
      f.state.messageStatus = 'failed';
      await f.page.reload();
      await f.page
        .getByText(
          '这次未完成。已有的内容都保留了，请稍后再试；一直这样请联系管理员。',
          {
            exact: true,
          },
        )
        .waitFor();
      expect(
        await f.page
          .getByRole('button', { name: '在工作台预览回复（非工件）' })
          .count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it.each([1440, 390])(
    'persists native session menu pins and rename without double-click editing at %i',
    async (width) => {
      const f = await fixture({ width, touch: width < 600 });
      try {
        await f.page.evaluate(() =>
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (value: string) =>
                sessionStorage.setItem('copied-session', value),
            },
          }),
        );
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const row = f.page.locator(`[data-row-key="session:${B}"]`);
        await row.hover();
        expect(
          await row
            .getByRole('button', { name: '归档会话', exact: true })
            .count(),
        ).toBe(0);
        await row.dblclick();
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await row.hover();
        expect(
          await f.page.getByRole('dialog', { name: '重命名会话' }).count(),
        ).toBe(0);
        await row.getByRole('button', { name: /^会话.*的操作$/ }).click();
        expect(await f.page.getByRole('menuitem').allTextContents()).toEqual([
          '置顶对话',
          '重命名',
          '归档会话',
          '复制对话编号',
        ]);
        await f.page
          .getByRole('menuitem', { name: '置顶对话', exact: true })
          .click();
        await expect
          .poll(() => f.state.sessionEdits.get(B)?.pinnedAt)
          .toBe(now);
        await row.getByRole('img', { name: '已置顶' }).waitFor();
        expect(
          await f.page
            .locator('[data-row-key^="session:"]')
            .first()
            .getAttribute('data-row-key'),
        ).toBe(`session:${B}`);
        await selectSessionAction(f.page, row, '重命名');
        const rename = f.page.getByRole('dialog', { name: '重命名会话' });
        await rename
          .getByRole('textbox', { name: '会话名称' })
          .fill('新的会话名称');
        await rename.getByRole('button', { name: '保存', exact: true }).click();
        await expect.poll(() => rename.count()).toBe(0);
        await selectSessionAction(f.page, row, '复制对话编号');
        expect(
          await f.page.evaluate(() => sessionStorage.getItem('copied-session')),
        ).toBe(B);
        await f.page.reload();
        if (width < 600)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        await row.getByText('新的会话名称', { exact: true }).waitFor();
        await row.getByRole('img', { name: '已置顶' }).waitFor();
        await selectSessionAction(f.page, row, '取消置顶');
        await expect
          .poll(() => f.state.sessionEdits.get(B)?.pinnedAt)
          .toBeNull();
        await expect
          .poll(() => row.getByRole('img', { name: '已置顶' }).count())
          .toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it('archives with native Undo and restores an archived read-only transcript', async () => {
    const f = await fixture({ artifacts: true });
    try {
      const archiveEntry = f.page.getByRole('button', {
        name: '查看归档',
        exact: true,
      });
      const newWork = f.page.getByRole('button', {
        name: '新的工作',
        exact: true,
      });
      const archiveBox = await archiveEntry.boundingBox();
      const newWorkBox = await newWork.boundingBox();
      expect(archiveBox!.x).toBeGreaterThan(newWorkBox!.x);
      expect(Math.abs(archiveBox!.y - newWorkBox!.y)).toBeLessThan(1);
      expect(await f.page.getByLabel('工作记录筛选').count()).toBe(0);
      expect(
        await f.page.getByRole('button', { name: '返回当前工作' }).count(),
      ).toBe(0);
      if (process.env.ALLRICE_ARCHIVE_SCREENSHOTS === '1')
        await f.page.screenshot({ path: '.local/archive-entry-desktop.png' });
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      await row.hover();
      await selectSessionAction(f.page, row, '归档会话');
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(await row.count()).toBe(0);
      expect(
        await f.page
          .getByRole('heading', { name: 'COIN / MSTR / CRCL · 合成研究报告' })
          .count(),
      ).toBeGreaterThan(0);
      await f.page.getByRole('button', { name: '撤销', exact: true }).click();
      await row.waitFor();
      expect(
        await f.page.getByRole('button', { name: '恢复并继续' }).count(),
      ).toBe(0);
      await row.hover();
      await selectSessionAction(f.page, row, '归档会话');
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      await f.openWorkbench();
      await f.panel.getByRole('heading', { name: /COIN/ }).waitFor();
      expect(
        await f.panel
          .getByRole('link', { name: '下载', exact: true })
          .getAttribute('href'),
      ).toContain(artifact(10).object.id);
      await archiveEntry.click();
      const archives = await archiveConversations(f.page);
      await archives.locator(`[data-row-key="session:${A}"]`).waitFor();
      expect(await archiveEntry.getAttribute('aria-pressed')).toBe('true');
      await archives
        .getByRole('button', { name: '关闭归档', exact: true })
        .click();
      await row.waitFor({ state: 'detached' });
      expect(await archiveEntry.getAttribute('aria-pressed')).toBe('false');
      await archiveEntry.click();
      await archiveConversations(f.page);
      await f.page
        .getByRole('dialog', { name: '已归档', exact: true })
        .locator(`[data-row-key="session:${A}"]`)
        .waitFor();
      if (process.env.ALLRICE_ARCHIVE_SCREENSHOTS === '1')
        await f.page.screenshot({ path: '.local/archive-desktop.png' });
      await f.page.reload();
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      await f.page.getByRole('button', { name: '恢复并继续' }).click();
      await row.waitFor();
      expect(f.state.archiveRequests.map((r) => r.archived)).toEqual([
        true,
        false,
        true,
        false,
      ]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  it('uses the native stop-and-archive confirmation, cancel leaves the work running', async () => {
    const f = await fixture({ archiveActive: true });
    try {
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      await row.hover();
      await selectSessionAction(f.page, row, '归档会话');
      const dialog = f.page.getByRole('dialog');
      await dialog.getByText('正在分析报表', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      expect(f.state.archivedIds.size).toBe(0);
      await row.hover();
      await selectSessionAction(f.page, row, '归档会话');
      await dialog
        .getByRole('button', { name: '停止并归档', exact: true })
        .click();
      await f.page.getByRole('button', { name: '恢复并继续' }).waitFor();
      expect(f.state.archiveRequests.at(-1)).toEqual({
        archived: true,
        stopActivity: true,
      });
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  it.each([0, 3, 5, 7])(
    'automatically shows up to five employee sessions before offering the rest (%i total)',
    async (total) => {
      const f = await fixture({
        employeeCount: 2,
        employeeHistory: true,
        employeeHistoryCount: 35,
        officeHistoryCount: total,
        running: true,
      });
      try {
        const sidebar = f.page.locator('#chat-sidebar');
        const rice = sidebar.getByRole('region', { name: 'Rice', exact: true });
        const riceRows = rice.locator('[data-row-key^="session:"]');
        await expect.poll(() => riceRows.count()).toBe(5);
        expect(
          await rice.locator(`[data-row-key="session:${id(600)}"]`).count(),
        ).toBe(1);
        f.state.historyRunning = false;
        await f.page.reload();
        await expect.poll(() => riceRows.count()).toBe(5);
        const office = sidebar.getByRole('region', {
          name: 'Office 文档助手',
          exact: true,
        });
        // A first-page failure remains local and must not turn into auto-retry.
        if (total === 7) f.state.sessionPageError = true;
        await office.getByRole('treeitem').first().click();
        if (total === 7) {
          await office.getByRole('alert').waitFor();
          expect(
            f.state.sessionPageRequests.filter((id_) => id_ === id(17)),
          ).toHaveLength(1);
          f.state.sessionPageError = false;
          await office
            .getByRole('button', { name: '加载失败，点击重试' })
            .click();
        }
        const rows = office.locator('[data-row-key^="session:"]');
        await expect.poll(() => rows.count()).toBe(Math.min(5, total));
        if (total > 0)
          await expect
            .poll(() => f.state.sessionPageRequests.includes(id(17)))
            .toBe(true);
        if (total > 5) {
          await office
            .getByRole('button', { name: '展开其余 2 个会话', exact: true })
            .click();
          await expect.poll(() => rows.count()).toBe(7);
          await office
            .getByRole('button', { name: '收起更多会话', exact: true })
            .click();
          await expect.poll(() => rows.count()).toBe(5);
        } else {
          expect(
            await office
              .getByRole('button', { name: /展开其余|展开更多/ })
              .count(),
          ).toBe(0);
        }
      } finally {
        await f.close();
      }
    },
  );

  it('expands older work within its employee, retries locally, and ignores a late page after switching to archives', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeHistoryCount: 65,
    });
    let release!: () => void;
    try {
      const sidebar = f.page.locator('#chat-sidebar');
      const rice = sidebar.getByRole('region', { name: 'Rice', exact: true });
      await rice.getByText('65 个工作', { exact: true }).waitFor();
      expect(
        await sidebar.getByRole('button', { name: '加载更早的工作' }).count(),
      ).toBe(0);
      expect(
        await sidebar.getByText('旧员工（已撤回）', { exact: true }).count(),
      ).toBe(1);
      f.state.sessionPageError = true;
      await rice.getByRole('button', { name: /展开其余/ }).click();
      await rice.getByRole('alert').waitFor();
      expect(
        await rice.getByText('历史工作 1', { exact: true }).isVisible(),
      ).toBe(true);
      f.state.sessionPageError = false;
      await rice.getByRole('button', { name: '加载失败，点击重试' }).click();
      await rice.getByText('历史工作 60', { exact: true }).waitFor();
      await rice.getByRole('button', { name: /展开其余/ }).click();
      await rice.getByText('历史工作 65', { exact: true }).waitFor();
      expect(await rice.getByRole('button', { name: /展开其余/ }).count()).toBe(
        0,
      );
      expect(f.state.sessionPageRequests).toEqual([id(7), id(7), id(7)]);
      const office = sidebar.getByRole('region', {
        name: 'Office 文档助手',
        exact: true,
      });
      f.state.sessionPageDelay = new Promise<void>((done) => {
        release = done;
      });
      await office.getByRole('treeitem').first().click();
      await expect.poll(() => f.state.sessionPageRequests.at(-1)).toBe(id(17));
      await sidebar
        .getByRole('button', { name: '查看归档', exact: true })
        .click();
      const archives = await archiveConversations(f.page);
      await expect
        .poll(() => archives.getByText('65 个工作', { exact: true }).count())
        .toBe(0);
      release();
      f.state.sessionPageDelay = null;
      await f.page.waitForTimeout(100);
      expect(
        await archives.getByRole('treeitem', { name: /研究任务 B/ }).count(),
      ).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it('keeps loaded employee rows visible through background refresh, failure and archive changes', async () => {
    const f = await fixture({
      employeeCount: 2,
      employeeHistory: true,
      employeeHistoryCount: 35,
      officeHistoryCount: 7,
    });
    let release!: () => void;
    try {
      const sidebar = f.page.locator('#chat-sidebar');
      const office = sidebar.getByRole('region', {
        name: 'Office 文档助手',
        exact: true,
      });
      await office.getByRole('treeitem').first().click();
      const rows = office.locator('[data-row-key^="session:"]');
      await expect.poll(() => rows.count()).toBe(5);
      await office.getByRole('button', { name: '展开其余 2 个会话' }).click();
      await expect.poll(() => rows.count()).toBe(7);
      for (let i = 0; i < 3; i++) {
        f.state.sessionPageDelay = new Promise<void>((done) => {
          release = done;
        });
        const requests = f.state.sessionPageRequests.length;
        await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
          .poll(() => f.state.sessionPageRequests.length)
          .toBeGreaterThan(requests);
        // The global first page contains only Rice. Office must stay mounted
        // while its slower background request is still pending.
        expect(await rows.count()).toBe(7);
        expect(
          await office.getByText('正在加载会话…', { exact: true }).count(),
        ).toBe(0);
        release();
        f.state.sessionPageDelay = null;
        await f.page.waitForTimeout(100);
        expect(await rows.count()).toBe(7);
      }
      f.state.sessionPageError = true;
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sidebar.getByRole('alert').waitFor();
      expect(await rows.count()).toBe(7);
      f.state.sessionPageError = false;
      // Simulate an archive made in another tab. A stable list must still
      // replace stale data and clear it when the employee has no active work.
      f.state.archivedIds.add(B);
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => rows.count()).toBe(6);
      for (let n = 1; n < 7; n++) f.state.archivedIds.add(id(7000 + n));
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => rows.count()).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  });

  it.each([1440, 390, 320])(
    'keeps a readable retry notice and cached sessions through failed and successful list refreshes at %ipx',
    async (width) => {
      const f = await fixture({ width, touch: width < 760 });
      let release: (() => void) | undefined;
      try {
        if (width < 760)
          await f.page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
        const sidebar = f.page.locator('#chat-sidebar');
        const rows = sidebar.locator('[data-row-key^="session:"]');
        await expect.poll(() => rows.count()).toBeGreaterThan(0);
        const ids = await rows.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-row-key')),
        );
        f.state.sessionListError = true;
        await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const notice = sidebar.getByRole('alert', { name: '会话列表状态' });
        await notice.getByText('会话暂未更新', { exact: true }).waitFor();
        expect(await sidebar.getByText('Unknown synthetic route').count()).toBe(
          0,
        );
        expect(await notice.getByText('已保留最近会话').isVisible()).toBe(true);
        const box = await notice.boundingBox();
        const sidebarBox = await sidebar.locator('> div').last().boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(sidebarBox!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          sidebarBox!.x + sidebarBox!.width,
        );
        for (const succeeds of [false, true]) {
          f.state.sessionListError = !succeeds;
          f.state.sessionListDelay = new Promise<void>((done) => {
            release = done;
          });
          const before = await rows.first().boundingBox();
          const requests = f.state.sessionListRequests;
          const retry = notice.getByRole('button', {
            name: '重新加载会话列表',
          });
          if (width < 760)
            expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(
              44,
            );
          await retry.focus();
          await f.page.keyboard.press('Enter');
          await expect
            .poll(() => f.state.sessionListRequests)
            .toBe(requests + 1);
          await notice.getByText('正在更新会话…', { exact: true }).waitFor();
          expect(await retry.isDisabled()).toBe(true);
          expect(
            Math.abs((await rows.first().boundingBox())!.y - before!.y),
          ).toBeLessThan(1);
          expect(
            await rows.evaluateAll((items) =>
              items.map((item) => item.getAttribute('data-row-key')),
            ),
          ).toEqual(ids);
          release!();
          f.state.sessionListDelay = null;
          if (succeeds) await notice.waitFor({ state: 'detached' });
          else {
            await notice.getByText('会话暂未更新', { exact: true }).waitFor();
            expect(await retry.isEnabled()).toBe(true);
          }
        }
        expect(f.writes).toEqual([]);
        expect(f.errors).toEqual([]);
      } finally {
        release?.();
        await f.close();
      }
    },
    30_000,
  );

  it('finds archives beyond the first page and keeps a failed archive visible', async () => {
    const f = await fixture({ archiveCount: 35 });
    try {
      f.state.archiveError = true;
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      await row.hover();
      await selectSessionAction(f.page, row, '归档会话');
      await f.page
        .getByRole('alert')
        .filter({ hasText: '测试：归档暂时失败' })
        .waitFor();
      expect(await row.count()).toBe(1);
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .click();
      const archives = await archiveConversations(f.page);
      const more = archives.getByRole('button', {
        name: /展开其余.*个会话/,
      });
      // The archive request completes after the filter click; wait for its
      // pagination control instead of skipping expansion during loading.
      await more.first().waitFor();
      await more.first().click();
      await archives.getByText('归档工作 35', { exact: true }).waitFor();
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  it('exposes native archive actions on touch screens without hover', async () => {
    const f = await fixture({ width: 390, touch: true });
    try {
      await f.page
        .getByRole('button', { name: '展开侧边栏', exact: true })
        .click();
      const row = f.page.locator(`[data-row-key="session:${A}"]`);
      expect(
        await row.evaluate((node) => getComputedStyle(node).borderRadius),
      ).toBe('12px');
      const menu = row.getByRole('button', { name: /会话.*的操作/ });
      await menu.click();
      expect(
        await f.page
          .getByRole('menu')
          .evaluate((node) => getComputedStyle(node).borderRadius),
      ).toBe('16px');
      const colors = [];
      for (const dark of [false, true]) {
        await f.page.evaluate((enabled) => {
          document.body.toggleAttribute('data-ds-dark-theme', enabled);
        }, dark);
        const appearance = await f.page.getByRole('menu').evaluate((node) => {
          const material = node.querySelector('[class*="material"]');
          return {
            portal: !node.closest('#root'),
            shadow: getComputedStyle(node).boxShadow,
            background: material
              ? getComputedStyle(material).backgroundColor
              : null,
          };
        });
        expect(appearance.portal).toBe(true);
        expect(appearance.shadow).not.toBe('none');
        expect(appearance.background).not.toBeNull();
        expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)');
        colors.push(appearance.background);
      }
      expect(colors[0]).not.toBe(colors[1]);
      await f.page.evaluate(() =>
        document.body.removeAttribute('data-ds-dark-theme'),
      );
      await f.page
        .getByRole('menuitem', { name: '归档会话', exact: true })
        .click();
      await expect.poll(() => f.state.archivedIds.has(A)).toBe(true);
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .click();
      const archives = await archiveConversations(f.page);
      const archivedRow = archives.locator(`[data-row-key="session:${A}"]`);
      await archivedRow.waitFor();
      if (process.env.ALLRICE_ARCHIVE_SCREENSHOTS === '1')
        await f.page.screenshot({ path: '.local/archive-mobile.png' });
      await selectSessionAction(f.page, archivedRow, '取消归档');
      await expect.poll(() => f.state.archivedIds.has(A)).toBe(false);
      expect(f.errors).toEqual([]);
    } finally {
      await f.context.close();
    }
  }, 30_000);
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`MET-214 says the conversation may be behind after a failed refresh at ${width}px in the ${theme} theme`, async () => {
        const f = await fixture({
          running: true,
          controlledStream: true,
          width,
        });
        try {
          if (theme === 'dark')
            await f.page.evaluate(() =>
              document.body.setAttribute('data-ds-dark-theme', ''),
            );
          await f.page.waitForFunction(
            () => document.documentElement.dataset.streamReady === 'true',
          );
          // The run finishes, but every read of the conversation fails.
          f.state.historyError = true;
          f.state.messageStatus = 'completed';
          const finished: ChatFlowEventEnvelope = {
            schemaVersion: 3,
            eventId: id(9950),
            organizationId: org,
            workspaceId: workspace,
            conversationId: A,
            runId: run,
            generation: 1,
            cursor: `${run}:1`,
            sequence: 1,
            harness: 'dsh',
            occurredAt: now,
            type: 'run.succeeded',
            sourceEvent: null,
            payload: {},
          };
          await f.page.evaluate(
            (body) =>
              window.dispatchEvent(
                new CustomEvent('allrice-test-stream', { detail: body }),
              ),
            `data: ${JSON.stringify(finished)}\n\n`,
          );
          const notice = f.page
            .getByRole('status')
            .filter({ hasText: /对话内容可能不是最新的|刷新未完成/ });
          await notice.getByText('对话内容可能不是最新的').waitFor();
          const look = await notice.evaluate((node) => {
            const text = node.querySelector('span')!;
            let element: Element | null = node;
            let ground = 'rgba(0, 0, 0, 0)';
            while (element && /rgba\(0, 0, 0, 0\)/.test(ground)) {
              ground = getComputedStyle(element).backgroundColor;
              element = element.parentElement;
            }
            const channel = (value: string) =>
              value
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map((v) => {
                  const c = Number(v) / 255;
                  return c <= 0.04045
                    ? c / 12.92
                    : ((c + 0.055) / 1.055) ** 2.4;
                })
                .reduce(
                  (sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!,
                  0,
                );
            const [light, dark] = [
              channel(getComputedStyle(text).color),
              channel(ground),
            ].sort((a, b) => b - a);
            const box = node.getBoundingClientRect();
            return {
              contrast: (light! + 0.05) / (dark! + 0.05),
              inside: box.left >= 0 && box.right <= window.innerWidth,
              overflow:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            };
          });
          expect(look.contrast).toBeGreaterThanOrEqual(4.5);
          expect(look.inside).toBe(true);
          expect(look.overflow).toBe(false);
          const text = await notice.innerText();
          for (const word of ['History', 'Session', '503', 'failed'])
            expect(text).not.toContain(word);
          // A refresh that fails again says so and stays available.
          await notice
            .getByRole('button', { name: '刷新', exact: true })
            .click();
          await notice.getByText('刷新未完成，请检查网络后再试').waitFor();
          // While the next refresh is on its way the button cannot be pressed twice.
          let release!: () => void;
          f.state.historyDelay = new Promise<void>((done) => (release = done));
          f.state.historyError = false;
          await notice
            .getByRole('button', { name: '刷新', exact: true })
            .click();
          const busy = notice.getByRole('button', {
            name: '正在刷新…',
            exact: true,
          });
          await busy.waitFor();
          expect(await busy.isDisabled()).toBe(true);
          f.state.historyDelay = null;
          release();
          await notice.waitFor({ state: 'detached' });
          // The answer the server stored is on screen now.
          await f.page.getByText('多步研究结果与引用说明').first().waitFor();
        } finally {
          await f.close();
        }
      }, 30_000);
});
