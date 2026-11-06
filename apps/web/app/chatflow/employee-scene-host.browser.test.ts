/** Real ChatFlowClient/DSH host; synthetic HTTP, no database or model. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AutomationCatalogQuerySchema,
  AutomationCatalogSchema,
  UuidSchema,
  InteractionStatusSchema,
  TaskNextStepsSchema,
  WorkbenchArtifactSchema,
  WorkspaceReadinessSchema,
  workspaceCapabilityIds,
  defaultUserPreferences,
  defaultWorkAutomation,
  EmployeeInstanceSchema,
  EmployeeMemoryPageSchema,
  EmployeeSceneSkillCatalogSchema,
  EmployeeSceneSkillSummarySchema,
  EmployeePublishedSceneSkillSchema,
  PersonalSceneSkillSchema,
  PersonalSceneSkillCatalogSchema,
  PersonalScenePreviewRequestSchema,
  PersonalScenePreviewResponseSchema,
  PersonalSceneConfirmRequestSchema,
  PersonalSceneConfirmResponseSchema,
  PersonalSceneRemoveRequestSchema,
  PersonalSceneRemoveResponseSchema,
  SkillPackageSourceSchema,
  skillSourceErrorHeader,
  type PersonalScenePreviewResponse,
  type PersonalSceneConfirmReceipt,
  type PersonalSceneRemoveReceipt,
  type SkillSourceErrorReason,
} from '@allrice/contracts';
import type {
  Browser,
  Locator,
} from '../../../worker/node_modules/playwright-core/index.js';
import type { Session, Workspace } from './chatflow-types';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (letter = 'a') => `sha256:${letter.repeat(64)}`;
const now = '2026-11-05T00:00:00.000Z';
const json = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
  headers,
});
const problem = (
  status = 503,
  code = 'DEPENDENCY_UNAVAILABLE',
  message = 'Request failed',
) =>
  json(
    ApiErrorSchema.parse({
      error: { code, message, requestId: id(99), retryable: false },
    }),
    status,
  );
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function github(url = 'https://github.com/example/weekly-brief') {
  return SkillPackageSourceSchema.parse({
    kind: 'github',
    requestedUrl: url,
    owner: 'example',
    repository: 'weekly-brief',
    resolvedRef: 'main',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    sourcePath: '',
    fileName: 'weekly-brief.zip',
    originalChecksum: sha(),
    byteLength: 512,
    license: { status: 'unknown' },
  });
}
function scene(instanceId: string, n = 50, revision = 1, next = false) {
  const weekly = n === 50;
  return PersonalSceneSkillSchema.parse({
    sceneId: id(n),
    name: weekly ? '写周报' : '客户回访',
    description: weekly ? '汇总本周进展、风险和下一步' : '整理客户反馈与下一步',
    nativeName: weekly ? 'weekly-brief' : 'customer-followup',
    version: next ? '1.3.0' : '1.2.0',
    contentRef: `personal-scene:${instanceId}:${id(n)}:${revision}`,
    revision,
    content: next ? '新版真实预览正文' : '当前真实包正文',
    contentChecksum: sha(next ? 'b' : 'a'),
    bundleVersion: '1.0.0',
    bundleChecksum: sha(next ? 'c' : 'b'),
    resources: [
      {
        path: 'references/example.txt',
        mediaType: 'text/plain',
        byteLength: 3,
        checksum: sha('c'),
      },
    ],
    sources: [],
    source: github(),
    whenToUse: '每周五写周报，或者要汇总项目进展时。',
    stepsMarkdown:
      '1. 读取本周资料和输出约定\n2. 逐条列出事实、每条写明来源\n3. 日期没定的标为待确认，计划不写成已完成',
    deliverablesMarkdown: '一份周报草稿：已知事实、待确认、下一步。',
    frontmatter: {
      name: weekly ? 'weekly-brief' : 'customer-followup',
      description: weekly
        ? '汇总本周进展、风险和下一步'
        : '整理客户反馈与下一步',
      whenToUse: '每周五写周报，或者要汇总项目进展时。',
      invocation: { modelInvocable: true, userInvocable: true },
      metadata: {
        displayName: weekly ? '写周报' : '客户回访',
        version: next ? '1.3.0' : '1.2.0',
      },
    },
    invocation: { modelInvocable: true, userInvocable: true },
  });
}

suite('U1 mounted employee Workflow host', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-scene-host');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      entryPoints: ['apps/web/test/employee-scene-host-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      jsx: 'automatic',
      outdir: '/scene-host-fixture',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      built.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://localhost').pathname;
      const asset = assets.get(path);
      res.setHeader(
        'Content-Type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-scene-host-page.css"><div id="root"></div><script type="module" src="/employee-scene-host-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(
      new URL('../../../worker/package.json', import.meta.url),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    await mkdir(evidence, { recursive: true });
    console.info(`U1 mounted Workflow evidence: ${evidence}`);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  async function fixture(
    options: {
      width?: number;
      dark?: boolean;
      empty?: boolean;
      frozen?: boolean;
      session?: boolean;
      disabled?: boolean;
      coarse?: boolean;
    } = {},
  ) {
    const width = options.width ?? 1440;
    const page = await browser.newPage({
      viewport: { width, height: 950 },
      isMobile: width < 600,
      hasTouch: options.coarse ?? width < 600,
      colorScheme: options.dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(8000);
    const preferences = {
      ...defaultUserPreferences,
      appearance: options.dark ? ('dark' as const) : ('light' as const),
    };
    const collections = new Map(
      [7, 17, 107, 117].map((n) => [
        id(n),
        {
          revision: 1,
          skills: options.empty ? [] : [scene(id(n)), scene(id(n), 51)],
        },
      ]),
    );
    const previews = new Map<string, PersonalScenePreviewResponse>();
    const confirmReceipts = new Map<string, PersonalSceneConfirmReceipt>();
    const removeReceipts = new Map<string, PersonalSceneRemoveReceipt>();
    const state = {
      reads: [] as string[],
      requests: [] as Array<{
        path: string;
        url: string;
        method: string;
        input: unknown;
      }>,
      scope: { workspaceId: id(4), viewerId: id(5), offset: 0 },
      workspaceGate: null as Promise<void> | null,
      workspaceReplies: [] as string[],
      unexpected: [] as string[],
      errors: [] as string[],
      writes: [] as Array<{ path: string; method: string; input: unknown }>,
      failDirectory: false,
      deny: false,
      archived: false,
      previewReason: undefined as SkillSourceErrorReason | undefined,
      previewMessage: '',
      same: false,
      previewReplies: 0,
      previewGate: null as Promise<void> | null,
      directoryGate: null as Promise<void> | null,
      writeGate: null as Promise<void> | null,
      loseConfirm: false,
      loseRemove: false,
      failConfirm: false,
      collections,
      previews,
      confirmReceipts,
      removeReceipts,
    };
    function employeeScope(instanceId: string) {
      return [id(7), id(17)].includes(instanceId)
        ? { workspaceId: id(4), viewerId: id(5) }
        : { workspaceId: id(104), viewerId: id(105) };
    }
    function details(instanceId: string) {
      const rice = [id(7), id(107)].includes(instanceId);
      const offset = [id(107), id(117)].includes(instanceId) ? 100 : 0;
      const data = employeeDetailsFixture();
      data.profile.instanceId = instanceId;
      data.content.instanceId = instanceId;
      data.profile.name = options.frozen
        ? '配发员工'
        : rice
          ? 'Rice'
          : '流程哥';
      data.profile.kind = options.frozen || rice ? 'general' : 'custom';
      data.profile.source.employeeVersionId = rice
        ? id(8 + offset)
        : id(18 + offset);
      data.profile.editableFields = options.frozen
        ? ['expressionStyle']
        : ['name', 'appearance', 'mission', 'workStyle', 'expressionStyle'];
      data.profile.isDefaultRice = !options.frozen && rice;
      data.content.employeeId = rice ? id(9 + offset) : id(19 + offset);
      return data;
    }
    function instance(instanceId: string) {
      const profile = details(instanceId).profile;
      return EmployeeInstanceSchema.parse({
        id: instanceId,
        assignmentId: instanceId,
        organizationId: id(3),
        workspaceId: employeeScope(instanceId).workspaceId,
        ownerId: employeeScope(instanceId).viewerId,
        kind: profile.kind,
        revision: profile.revision,
        profile: { name: profile.name },
        creationSource: profile.source,
        source: profile.source,
        createdAt: now,
        updatedAt: now,
        archivedAt: state.archived ? now : null,
      });
    }
    function sharedScene() {
      const reference = {
        sourceKind: 'procedure',
        contentId: id(90),
        revisionId: id(91),
        digest: sha(),
      };
      return EmployeePublishedSceneSkillSchema.parse({
        pin: {
          setId: id(80),
          revisionId: id(81),
          sceneId: id(50),
          sourceRevisionId: id(91),
        },
        ownership: { scope: 'company', organizationId: id(3) },
        publication: { number: 1, digest: sha(), publishedAt: now },
        scene: {
          id: id(50),
          name: '写周报',
          appliesWhen: '公司每周汇总',
          references: [reference],
        },
        common: [],
        source: { reference, number: 1, createdBy: id(5), createdAt: now },
        bundleVersion: '1.0.0',
        bundleChecksum: sha('b'),
        contentChecksum: sha(),
        resources: [],
        content: '只读旧包正文',
        // Existing shared packages may have no native frontmatter. No command is invented.
        skillPackage: {
          bundle: {
            schemaVersion: 1,
            version: '1.0.0',
            checksum: sha('b'),
            contentChecksum: sha(),
            sourceRef: 'https://github.com/example/weekly-brief',
            license: 'MIT',
            reviewedBy: 'Synthetic fixture',
            resources: [],
            dependencies: [],
          },
          resourceSources: [],
        },
      });
    }
    const existing: Session = {
      id: id(30),
      title: '保留的旧工作',
      ownerId: id(5),
      employeeAssignmentId: id(7),
      employeeInstanceId: id(7),
      employeeVersionId: id(8),
      visibility: 'private',
      updatedAt: now,
      archivedAt: null,
    };
    function workspace(): Workspace {
      return {
        organizationId: id(3),
        workspaceId: state.scope.workspaceId,
        viewerId: state.scope.viewerId,
        preferences,
        canAdminister: false,
        sessions: options.session ? [existing] : [],
        sessionModels: [],
        employees: [7 + state.scope.offset, 17 + state.scope.offset].map(
          (n) => ({
            id: id(n),
            instanceId: id(n),
            employeeId: id(n + 2),
            employeeKey:
              n % 100 === 7 && !options.frozen
                ? 'default-assistant'
                : 'synthetic-professional',
            isDefault: n % 100 === 7,
            instances: [instance(id(n))],
            versions: [],
            currentVersion: {
              id: id(n + 1),
              manifest: {
                name: details(id(n)).profile.name,
                schemaVersion: 2,
                key:
                  n % 100 === 7 && !options.frozen
                    ? 'default-assistant'
                    : 'synthetic-professional',
                isDefaultRice: n % 100 === 7 && !options.frozen,
                runtimePolicy: { harness: 'dsh', provider: 'codex' },
              },
            },
          }),
        ),
        employeeProfiles: [7 + state.scope.offset, 17 + state.scope.offset].map(
          (n) => {
            const profile = details(id(n)).profile;
            return {
              assignmentId: id(n),
              employeeId: id(n + 2),
              name: profile.name,
              description: profile.description,
              appearance: profile.appearance,
              identity: profile.identity,
              skills: [],
              model: {
                harness: 'dsh',
                provider: 'codex',
                model: 'gpt-6.1-sol',
                reasoningEffort: 'max',
              },
            };
          },
        ),
      };
    }
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      const method = request.method();
      if (method === 'GET') state.reads.push(path);
      let attemptedInput: unknown = request.postData();
      if (request.headers()['content-type']?.includes('application/json'))
        attemptedInput = request.postDataJSON();
      const attempt = {
        path,
        url: request.url(),
        method,
        input: attemptedInput,
      };
      state.requests.push(attempt);
      if (
        method !== 'GET' &&
        !(method === 'POST' && path.endsWith('/scene-skills/preview'))
      )
        state.writes.push(attempt);
      const match = path.match(
        /^\/api\/v1\/employee-instances\/([^/]+)(?:\/(.*))?$/,
      );
      if (match) {
        const target = match[1]!,
          resource = match[2] ?? '';
        expect([id(7), id(17), id(107), id(117)]).toContain(target);
        const supported =
          (method === 'GET' &&
            ['', 'content', 'scene-skills'].includes(resource)) ||
          (method === 'POST' &&
            ['scene-skills/preview', 'scene-skills/confirm'].includes(
              resource,
            )) ||
          (method === 'DELETE' &&
            resource.startsWith('scene-skills/') &&
            UuidSchema.safeParse(resource.slice('scene-skills/'.length))
              .success);
        if (!supported) {
          state.unexpected.push(`${method} ${path}`);
          return route.fulfill(problem(405, 'VALIDATION_FAILED'));
        }
        const targetScope = employeeScope(target);
        if (
          request.headers()['x-allrice-workspace-id'] !==
            targetScope.workspaceId ||
          (method === 'GET' &&
            url.searchParams.get('workspaceId') !== targetScope.workspaceId) ||
          targetScope.viewerId !== state.scope.viewerId
        )
          return route.fulfill(problem(403, 'AUTHORIZATION_DENIED'));
        if (state.deny)
          return route.fulfill(
            problem(403, 'AUTHORIZATION_DENIED', 'Access denied'),
          );
        if (resource === 'content' && method === 'GET')
          return route.fulfill(json(details(target)));
        if (!resource && method === 'GET')
          return route.fulfill(json({ instance: instance(target) }));
        const collection = collections.get(target)!;
        if (resource === 'scene-skills' && method === 'GET') {
          const selected = url.searchParams.get('sceneId');
          if (state.failDirectory && !selected) return route.fulfill(problem());
          const value = selected
            ? collection.skills.find((item) => item.sceneId === selected)
            : undefined;
          const frozen = options.frozen ? sharedScene() : undefined;
          const raw = selected
            ? (frozen ?? value)
            : options.frozen
              ? EmployeeSceneSkillCatalogSchema.parse({
                  instanceId: target,
                  employeeId: id(9),
                  skills: options.empty
                    ? []
                    : [EmployeeSceneSkillSummarySchema.strip().parse(frozen)],
                })
              : PersonalSceneSkillCatalogSchema.parse({
                  instanceId: target,
                  revision: collection.revision,
                  skills: collection.skills.map(
                    ({
                      sceneId,
                      name,
                      description,
                      nativeName,
                      version,
                      contentRef,
                      revision,
                      whenToUse,
                      invocation,
                      frontmatter,
                    }) => ({
                      sceneId,
                      name,
                      description,
                      nativeName,
                      version,
                      contentRef,
                      revision,
                      whenToUse,
                      invocation,
                      metadata: frontmatter?.metadata,
                    }),
                  ),
                });
          if (state.directoryGate && !selected) await state.directoryGate;
          return route.fulfill(
            raw ? json(raw) : problem(404, 'RESOURCE_NOT_FOUND'),
          );
        }
        if (resource === 'scene-skills/preview' && method === 'POST') {
          let raw: unknown;
          if (
            request.headers()['content-type']?.includes('multipart/form-data')
          ) {
            const form = await new Request('http://fixture/', {
              method: 'POST',
              headers: request.headers(),
              body: new Uint8Array(request.postDataBuffer()!),
            }).formData();
            const upload = form.get('file');
            expect(upload).toBeInstanceOf(File);
            if (!(upload instanceof File)) throw Error('fixture_missing_file');
            raw = {
              ...JSON.parse(String(form.get('input'))),
              source: { kind: 'zip', fileName: upload.name },
            };
            expect(await upload.text()).toBe('synthetic ZIP bytes');
          } else raw = request.postDataJSON();
          const input = PersonalScenePreviewRequestSchema.parse(raw);
          attempt.input = input;
          expect(input.workspaceId).toBe(targetScope.workspaceId);
          if (state.previewReason) {
            const response = problem(
              state.previewReason === 'name_mismatch' ||
                state.previewReason === 'version_conflict'
                ? 409
                : 422,
              state.previewReason === 'name_mismatch' ||
                state.previewReason === 'version_conflict'
                ? 'VERSION_CONFLICT'
                : 'VALIDATION_FAILED',
              state.previewMessage || 'Request validation failed',
            );
            return route.fulfill({
              ...response,
              headers: { [skillSourceErrorHeader]: state.previewReason },
            });
          }
          const previewTarget = input.target;
          const current =
            previewTarget.operation === 'update'
              ? collection.skills.find(
                  (item) => item.sceneId === previewTarget.sceneId,
                )!
              : null;
          const proposed =
            input.target.operation === 'update'
              ? state.same
                ? current!
                : scene(target, 50, collection.revision + 1, true)
              : scene(target, 52, collection.revision + 1);
          const source =
            input.source.kind === 'github'
              ? github(input.source.url)
              : SkillPackageSourceSchema.parse({
                  kind: 'zip',
                  fileName: input.source.fileName,
                  originalChecksum: sha(),
                  byteLength: 19,
                });
          const preview = PersonalScenePreviewResponseSchema.parse({
            instanceId: target,
            instanceName: details(target).profile.name,
            operation: input.target.operation,
            previewId: `fixture-signed-${previews.size + 1}`,
            digest: sha('d'),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            target: {
              operation: input.target.operation,
              sceneId: current?.sceneId ?? id(52),
              expectedRevision: collection.revision,
              expectedContentRef: current?.contentRef ?? null,
            },
            item: {
              frontmatter: proposed.frontmatter,
              content: proposed.content,
              stepsMarkdown: proposed.stepsMarkdown,
              deliverablesMarkdown: proposed.deliverablesMarkdown,
            },
            current,
            source,
            files: [
              { path: 'SKILL.md', checksum: sha('d'), byteLength: 512 },
              ...proposed.resources.map(({ path, byteLength, checksum }) => ({
                path,
                byteLength,
                checksum,
              })),
            ],
            effectiveFrom: 'next_load',
            installed: false,
            scriptsExecuted: false,
          });
          previews.set(preview.previewId, preview);
          if (state.previewGate) await state.previewGate;
          await route.fulfill(json(preview)).catch(() => {});
          state.previewReplies += 1;
          return;
        }
        if (resource === 'scene-skills/confirm' && method === 'POST') {
          const input = PersonalSceneConfirmRequestSchema.parse(
            request.postDataJSON(),
          );
          attempt.input = input;
          const preview = previews.get(input.previewId)!;
          expect(preview).toBeDefined();
          expect(input.workspaceId).toBe(targetScope.workspaceId);
          expect(input.digest).toBe(preview.digest);
          if (state.writeGate) await state.writeGate;
          if (state.failConfirm)
            return route.fulfill(problem(409, 'VERSION_CONFLICT'));
          let receipt = confirmReceipts.get(input.requestId);
          if (!receipt) {
            collection.revision += 1;
            const updated = PersonalSceneSkillSchema.parse({
              ...scene(
                target,
                preview.target.sceneId === id(50) ? 50 : 52,
                collection.revision,
                preview.operation === 'update',
              ),
              name: preview.item.frontmatter.metadata.displayName,
              nativeName: preview.item.frontmatter.name,
              description: preview.item.frontmatter.description,
              version: preview.item.frontmatter.metadata.version,
              content: preview.item.content,
              frontmatter: preview.item.frontmatter,
              source: preview.source,
              resources: preview.files
                .filter((item) => item.path !== 'SKILL.md')
                .map(({ path, byteLength, checksum }) => ({
                  path,
                  byteLength,
                  checksum,
                  mediaType: 'text/plain',
                })),
            });
            collection.skills = [
              ...collection.skills.filter(
                (item) => item.sceneId !== updated.sceneId,
              ),
              updated,
            ];
            receipt = PersonalSceneConfirmResponseSchema.parse({
              receipt: {
                operation: preview.operation,
                requestId: input.requestId,
                instanceId: target,
                sceneId: updated.sceneId,
                revision: collection.revision,
                contentRef: updated.contentRef,
                contentChecksum: updated.contentChecksum,
                bundleChecksum: updated.bundleChecksum,
                source: preview.source,
                effectiveFrom: 'next_load',
              },
            }).receipt;
            confirmReceipts.set(input.requestId, receipt);
          }
          if (state.loseConfirm) {
            state.loseConfirm = false;
            return route.abort('failed');
          }
          return route.fulfill(json({ receipt }));
        }
        if (resource.startsWith('scene-skills/') && method === 'DELETE') {
          const sceneId = resource.split('/')[1]!;
          const input = PersonalSceneRemoveRequestSchema.parse(
            request.postDataJSON(),
          );
          attempt.input = input;
          expect(input.workspaceId).toBe(targetScope.workspaceId);
          let receipt = removeReceipts.get(input.requestId);
          if (state.writeGate) await state.writeGate;
          if (!receipt) {
            const current = collection.skills.find(
              (item) => item.sceneId === sceneId,
            )!;
            expect(input.expectedRevision).toBe(collection.revision);
            expect(input.expectedContentRef).toBe(current.contentRef);
            collection.revision += 1;
            collection.skills = collection.skills.filter(
              (item) => item.sceneId !== sceneId,
            );
            receipt = PersonalSceneRemoveResponseSchema.parse({
              receipt: {
                operation: 'remove',
                scope: 'scene_all_history',
                instanceId: target,
                sceneId,
                requestId: input.requestId,
                revision: collection.revision,
                removed: true,
              },
            }).receipt;
            removeReceipts.set(input.requestId, receipt);
          }
          if (state.loseRemove) {
            state.loseRemove = false;
            return route.abort('failed');
          }
          return route.fulfill(json({ receipt }));
        }
      }
      if (path === '/api/v1/memories/manage' && method === 'GET') {
        const target = url.searchParams.get('instanceId');
        expect([id(7), id(17), id(107), id(117)]).toContain(target);
        const targetScope = employeeScope(target!);
        if (
          url.searchParams.get('workspaceId') !== targetScope.workspaceId ||
          request.headers()['x-allrice-workspace-id'] !==
            targetScope.workspaceId ||
          state.scope.viewerId !== targetScope.viewerId
        )
          return route.fulfill(problem(403, 'AUTHORIZATION_DENIED'));
        return route.fulfill(
          json(
            EmployeeMemoryPageSchema.parse({
              organizationId: id(3),
              workspaceId: employeeScope(target!).workspaceId,
              ownerId: employeeScope(target!).viewerId,
              instanceId: target,
              state: url.searchParams.get('state'),
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
          ),
        );
      }
      if (path === '/api/v1/workspace' && method === 'GET') {
        if (state.workspaceGate) await state.workspaceGate;
        const current = workspace();
        state.workspaceReplies.push(
          `${current.workspaceId}/${current.viewerId}`,
        );
        return route.fulfill(json({ workspace: current }));
      }
      if (path === '/api/v1/workspace/readiness' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (
          url.searchParams.get('workspaceId') !== state.scope.workspaceId ||
          request.headers()['x-allrice-workspace-id'] !==
            state.scope.workspaceId ||
          (sessionId !== null &&
            (sessionId !== existing.id || state.scope.workspaceId !== id(4)))
        )
          return route.fulfill(problem(403, 'AUTHORIZATION_DENIED'));
        return route.fulfill(
          json(
            WorkspaceReadinessSchema.parse({
              schemaVersion: 1,
              organizationId: id(3),
              workspaceId: state.scope.workspaceId,
              viewerId: state.scope.viewerId,
              sessionId,
              employeeVersionId: id(8 + state.scope.offset),
              observedAt: now,
              basis: 'next_task',
              canAdminister: false,
              capabilities: workspaceCapabilityIds.map((capability) => ({
                id: capability,
                state:
                  capability === 'report'
                    ? 'ready'
                    : capability === 'local_files'
                      ? 'needs_configuration'
                      : 'not_released',
                reason:
                  capability === 'report'
                    ? 'ready'
                    : capability === 'local_files'
                      ? 'bridge_missing'
                      : 'release_disabled',
                action:
                  capability === 'report'
                    ? 'compose'
                    : capability === 'local_files'
                      ? 'bridge'
                      : 'guide',
                target: capability === 'local_files' ? 'local' : 'cloud',
                responsibleRole: 'user',
                releaseEnabled: ['report', 'local_files'].includes(capability),
                authorization: 'normal_policy',
              })),
            }),
          ),
        );
      }
      if (path === '/api/v1/scheduled-tasks' && method === 'GET') {
        const query = AutomationCatalogQuerySchema.parse(
          Object.fromEntries(url.searchParams),
        );
        if (
          query.workspaceId !== state.scope.workspaceId ||
          request.headers()['x-allrice-workspace-id'] !==
            state.scope.workspaceId
        )
          return route.fulfill(problem(403, 'AUTHORIZATION_DENIED'));
        return route.fulfill(
          json(AutomationCatalogSchema.parse({ tasks: [], nextCursor: null })),
        );
      }
      if (path === '/api/v1/saas/capabilities' && method === 'GET')
        return route.fulfill(
          json({
            capabilities: {
              schemaVersion: 1,
              roles: ['member'],
              surfaces: ['chatflow'],
              actions: [],
              features: { chatFlowV3: true, nativeHarnessEvents: true },
            },
          }),
        );
      if (path === '/api/v1/me/preferences' && method === 'GET')
        return route.fulfill(
          json({ viewerId: state.scope.viewerId, preferences }),
        );
      if (path === '/api/v1/me/work-automation' && method === 'GET')
        return route.fulfill(
          json({
            workspaceId: state.scope.workspaceId,
            revision: 0,
            settings: defaultWorkAutomation,
            editable: true,
          }),
        );
      if (path === '/api/v1/bridge/devices' && method === 'GET')
        return route.fulfill(json({ devices: [] }));
      if (path === '/api/v1/connections' && method === 'GET')
        return route.fulfill(json({ connections: [] }));
      if (path === '/api/v1/workspace/monthly-quota' && method === 'GET')
        return route.fulfill(problem(404, 'RESOURCE_NOT_FOUND'));
      if (path === '/api/v1/workbench/updates' && method === 'GET')
        return route.fulfill(json({ fileIds: [], experienceIds: [] }));
      if (path === '/api/v1/workbench/files' && method === 'GET')
        return route.fulfill(
          json({
            files: [],
            quotableFileIds: [],
            truncated: false,
            options: { writable: false },
          }),
        );
      if (path === '/api/v1/sessions' && method === 'GET')
        return route.fulfill(
          json({
            sessions: options.session ? [existing] : [],
            nextCursor: null,
            ...(!url.searchParams.has('employeeAssignmentId') &&
            !url.searchParams.has('employeeInstanceId')
              ? { employeeGroups: [] }
              : {}),
          }),
        );
      if (path === `/api/v1/sessions/${existing.id}` && method === 'GET')
        return route.fulfill(
          json({
            history: {
              session: existing,
              messages: [],
              queuedMessages: [],
              contextStatus: {
                percentage: 0,
                pressureTokens: 0,
                thresholdTokens: 40000,
                compactionDue: false,
              },
              nativeContextStatus: null,
            },
          }),
        );
      if (
        path === `/api/v1/sessions/${existing.id}/artifacts` &&
        method === 'GET'
      ) {
        if (
          url.searchParams.get('workspaceId') !== id(4) ||
          request.headers()['x-allrice-workspace-id'] !== id(4) ||
          state.scope.workspaceId !== id(4)
        )
          return route.fulfill(problem(403, 'AUTHORIZATION_DENIED'));
        return route.fulfill(
          json({
            artifacts: WorkbenchArtifactSchema.array().parse([]),
            nextCursor: null,
          }),
        );
      }
      if (
        path === `/api/v1/sessions/${existing.id}/interactions` &&
        method === 'GET'
      )
        return route.fulfill(
          json(
            InteractionStatusSchema.parse({
              runtime: null,
              pendingActions: [],
              inputs: [],
              runTimings: [],
            }),
          ),
        );
      if (
        path === `/api/v1/sessions/${existing.id}/next-steps` &&
        method === 'GET'
      )
        return route.fulfill(
          json(
            TaskNextStepsSchema.parse({
              contractVersion: 1,
              scope: {
                organizationId: id(3),
                workspaceId: id(4),
                viewerId: id(5),
                sessionId: existing.id,
                employeeAssignmentId: id(7),
                employeeVersionId: id(8),
                sourceRunId: null,
                contextRevision: sha(),
              },
              state: 'idle',
              notice: '',
              suggestions: [],
              readableArtifactCount: 0,
            }),
          ),
        );
      if (path.endsWith('/subagents') && method === 'GET')
        return route.fulfill(problem(404, 'RESOURCE_NOT_FOUND'));
      state.unexpected.push(`${method} ${path}`);
      return route.fulfill(problem(404, 'RESOURCE_NOT_FOUND'));
    });
    const query = new URLSearchParams();
    if (options.dark) query.set('theme', 'dark');
    if (options.session) query.set('session', existing.id);
    if (options.disabled) query.set('disabled', '1');
    await page.goto(`${origin}/?${query}`);
    await page
      .getByRole('textbox', {
        name: options.frozen ? '给 配发员工 的消息' : '给 Rice 的消息',
        exact: true,
      })
      .waitFor();
    if (options.session)
      await expect
        .poll(() => state.reads.includes(`/api/v1/sessions/${existing.id}`))
        .toBe(true);
    const directory = () =>
      page.getByRole('dialog', { name: '工作场景 Workflow', exact: true });
    const openDirectory = async () => {
      await page.getByRole('button', { name: '工作场景', exact: true }).click();
      await directory().waitFor();
      await expect
        .poll(() =>
          directory().locator('[role="status"][aria-busy="true"]').count(),
        )
        .toBe(0);
      return directory();
    };
    const openDetail = async () => {
      const root = await openDirectory();
      await root.getByRole('button', { name: /写周报/ }).click();
      const detail = page.getByRole('dialog', { name: '写周报', exact: true });
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      return detail;
    };
    const sourceForm = async (update = false) => {
      if (update)
        await (
          await openDetail()
        )
          .getByRole('button', { name: '更新', exact: true })
          .click();
      else
        await (
          await openDirectory()
        )
          .getByRole('button', { name: '新建场景', exact: true })
          .click();
      const form = page.getByRole('dialog', {
        name: update ? '更新“写周报”' : '新建工作场景',
        exact: true,
      });
      await form
        .getByRole('heading', { name: '文件要求', exact: true })
        .waitFor();
      return form;
    };
    let sidebarOpened = false;
    const openEmployeeDetails = async (name = 'Rice') => {
      if (width < 760 && !sidebarOpened) {
        await page
          .getByRole('button', { name: '展开侧边栏', exact: true })
          .click();
        sidebarOpened = true;
      }
      await page
        .getByRole('button', { name: `查看${name}详情`, exact: true })
        .click();
      const details = page.getByRole('dialog', {
        name: `${name}员工详情`,
        exact: true,
      });
      await details
        .getByRole('heading', { name: '工作场景 Workflow', exact: true })
        .waitFor();
      return details;
    };
    const check = () => {
      expect(state.errors).toEqual([]);
      expect(state.unexpected).toEqual([]);
      expect(
        state.writes.filter((item) =>
          /\/runs|\/messages|\/sessions$/.test(item.path),
        ),
      ).toEqual([]);
      expect(
        state.reads.filter((path) =>
          /brand-content|\/experiences|accumulation/.test(path),
        ),
      ).toEqual([]);
    };
    return {
      page,
      state,
      directory,
      openDirectory,
      openDetail,
      sourceForm,
      openEmployeeDetails,
      check,
      close: () => page.close(),
    };
  }

  async function contains(locator: Locator, value: string) {
    await expect.poll(() => locator.textContent()).toContain(value);
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function inFixture(
    options: Parameters<typeof fixture>[0],
    body: (f: Fixture) => Promise<void>,
  ) {
    const f = await fixture(options);
    try {
      await body(f);
      f.check();
    } finally {
      await f.close();
    }
  }
  async function readGithub(form: Locator) {
    await form
      .getByRole('textbox', { name: '仓库链接', exact: true })
      .fill('https://github.com/example/weekly-brief');
    await form.getByRole('button', { name: '读取', exact: true }).click();
  }
  async function chooseZip(
    f: Fixture,
    form: Locator,
    name: string,
    action: '选择文件' | '重新选择' = '选择文件',
  ) {
    const chooser = f.page.waitForEvent('filechooser');
    await form.getByRole('button', { name: action, exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name,
      mimeType: 'application/zip',
      buffer: Buffer.from('synthetic ZIP bytes'),
    });
  }
  function confirmation(f: Fixture, update = false) {
    return f.page.getByRole('dialog', {
      name: update ? '确认更新' : '确认安装',
      exact: true,
    });
  }
  const previewWrites = (f: Fixture) =>
    f.state.requests.filter(
      (item) => item.method === 'POST' && item.path.endsWith('/preview'),
    );
  const confirmWrites = (f: Fixture) =>
    f.state.writes.filter((item) => item.path.endsWith('/confirm'));
  async function deleteConfirmation(f: Fixture, detail: Locator) {
    await detail.getByRole('button', { name: '删除场景', exact: true }).click();
    const dialog = f.page.getByRole('dialog', {
      name: '删除“写周报”？',
      exact: true,
    });
    await dialog.waitFor();
    return dialog;
  }

  for (const width of [1440, 390])
    for (const dark of [false, true]) {
      it(`mounted Workflow list/detail uses approved layout at ${width} ${dark ? 'dark' : 'light'}`, async () => {
        await inFixture({ width, dark }, async (f) => {
          const root = await f.openDirectory();
          expect(
            await root
              .getByRole('button', { name: '关闭工作场景', exact: true })
              .count(),
          ).toBe(1);
          expect(
            await root
              .getByRole('button', { name: '返回工作场景列表', exact: true })
              .count(),
          ).toBe(0);
          expect(await root.locator('footer').count()).toBe(0);
          const closeBox = await root
            .getByRole('button', { name: '关闭工作场景', exact: true })
            .boundingBox();
          expect(closeBox?.width).toBe(width < 700 ? 40 : 36);
          expect(closeBox?.height).toBe(width < 700 ? 40 : 36);
          await root.getByRole('button', { name: /写周报/ }).click();
          const detail = f.page.getByRole('dialog', {
            name: '写周报',
            exact: true,
          });
          await detail
            .getByRole('heading', { name: '什么时候用', exact: true })
            .waitFor();
          await contains(detail, '/weekly-brief');
          expect(
            await detail
              .getByRole('button', { name: '关闭工作场景', exact: true })
              .count(),
          ).toBe(0);
          expect(await detail.locator('footer').count()).toBe(0);
          const backBox = await detail
            .getByRole('button', { name: '返回工作场景列表', exact: true })
            .boundingBox();
          expect(backBox?.width).toBe(width < 700 ? 40 : 36);
          expect(backBox?.height).toBe(width < 700 ? 40 : 36);
          const measure = async () =>
            detail.evaluate((node) => {
              const rect = node.getBoundingClientRect(),
                style = getComputedStyle(node);
              const heading = node.querySelector('h2')!;
              const title = getComputedStyle(heading);
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                clientWidth: document.documentElement.clientWidth,
                clientHeight: document.documentElement.clientHeight,
                radius: style.borderRadius,
                background: style.backgroundColor,
                titleSize: title.fontSize,
                titleLine: title.lineHeight,
                fits:
                  node.scrollWidth <= node.clientWidth &&
                  document.documentElement.scrollWidth <=
                    document.documentElement.clientWidth,
                focused: node.contains(document.activeElement),
              };
            });
          await expect.poll(async () => (await measure()).focused).toBe(true);
          const geometry = await measure();
          const deliveryAppearance = await detail
            .getByRole('button', { name: '查看交付结果 →', exact: true })
            .evaluate((node) => {
              const style = getComputedStyle(node);
              return {
                color: style.color,
                linkToken: style.getPropertyValue('--ar-link').trim(),
              };
            });
          expect(deliveryAppearance.linkToken).not.toBe('');
          expect(geometry.titleSize).toBe('20px');
          expect(geometry.titleLine).toBe('28px');
          expect(geometry.fits).toBe(true);
          if (width < 700) {
            expect(geometry.x).toBe(0);
            expect(geometry.y).toBe(0);
            expect(geometry.width).toBe(geometry.clientWidth);
            expect(geometry.height).toBe(geometry.clientHeight);
            expect(geometry.radius).toBe('0px');
          } else expect(geometry.width).toBe(848);
          const channels = geometry.background.match(/\d+/g)?.map(Number);
          expect(channels?.length).toBe(3);
          if (dark) expect(Math.max(...channels!)).toBeLessThan(90);
          else expect(Math.min(...channels!)).toBeGreaterThan(230);
          await f.page.screenshot({
            path: resolve(
              evidence,
              `workflow-${width}-${dark ? 'dark' : 'light'}.png`,
            ),
            fullPage: true,
          });
          await writeFile(
            resolve(
              evidence,
              `workflow-${width}-${dark ? 'dark' : 'light'}.json`,
            ),
            JSON.stringify({ ...geometry, deliveryAppearance }, null, 2),
          );
          await detail
            .getByRole('button', { name: '返回工作场景列表', exact: true })
            .click();
          await root.waitFor();
          await root
            .getByRole('button', { name: '关闭工作场景', exact: true })
            .click();
          await root.waitFor({ state: 'detached' });
          const employee = await f.openEmployeeDetails();
          const employeeGeometry = await employee.evaluate((node) => {
            const rect = node.getBoundingClientRect(),
              style = getComputedStyle(node),
              title = getComputedStyle(node.querySelector('h2')!);
            return {
              width: rect.width,
              height: rect.height,
              x: rect.x,
              y: rect.y,
              clientWidth: document.documentElement.clientWidth,
              clientHeight: document.documentElement.clientHeight,
              radius: style.borderRadius,
              background: style.backgroundColor,
              titleSize: title.fontSize,
              titleLine: title.lineHeight,
              fits:
                node.scrollWidth <= node.clientWidth &&
                document.documentElement.scrollWidth <=
                  document.documentElement.clientWidth,
            };
          });
          expect(employeeGeometry.titleSize).toBe('20px');
          expect(employeeGeometry.titleLine).toBe('28px');
          expect(employeeGeometry.fits).toBe(true);
          if (width < 700) {
            expect(employeeGeometry.x).toBe(0);
            expect(employeeGeometry.y).toBe(0);
            expect(employeeGeometry.width).toBe(employeeGeometry.clientWidth);
            expect(employeeGeometry.height).toBe(employeeGeometry.clientHeight);
            expect(employeeGeometry.radius).toBe('0px');
          } else expect(employeeGeometry.width).toBe(848);
          expect(employeeGeometry.background).toBe(geometry.background);
          const memoryAppearance = await employee
            .getByRole('region', { name: '记忆', exact: true })
            .getByRole('button', { name: '查看', exact: true })
            .evaluate((node) => {
              const style = getComputedStyle(node);
              return {
                color: style.color,
                linkToken: style.getPropertyValue('--ar-link').trim(),
              };
            });
          expect(deliveryAppearance.linkToken).toBe(memoryAppearance.linkToken);
          expect(deliveryAppearance.color).toBe(memoryAppearance.color);
          for (const name of ['执行要求', '执行流程', '经验积累', '参考资料'])
            expect(
              await employee.getByRole('tab', { name, exact: true }).count(),
            ).toBe(0);
          expect(
            await employee
              .getByRole('region', { name: '记忆', exact: true })
              .count(),
          ).toBe(1);
          expect(await employee.locator('footer').count()).toBe(0);
          if (!dark)
            await f.page.screenshot({
              path: resolve(evidence, `employee-root-${width}-light.png`),
              fullPage: true,
            });
          await writeFile(
            resolve(
              evidence,
              `employee-root-${width}-${dark ? 'dark' : 'light'}.json`,
            ),
            JSON.stringify({ ...employeeGeometry, memoryAppearance }, null, 2),
          );
          expect(f.state.writes).toEqual([]);
        });
      });
    }

  it('directory failure retries into a genuine empty directory without showing a false empty state', async () => {
    await inFixture({ empty: true }, async (f) => {
      f.state.failDirectory = true;
      const employee = await f.openEmployeeDetails();
      await employee
        .getByRole('region', { name: '基础与人设', exact: true })
        .waitFor();
      await employee
        .getByRole('region', { name: '记忆', exact: true })
        .waitFor();
      await contains(employee.getByRole('alert'), '工作场景读取失败，请重试。');
      expect(
        await employee
          .getByRole('heading', { name: '还没有工作场景', exact: true })
          .count(),
      ).toBe(0);
      await employee.getByRole('button', { name: '关闭', exact: true }).click();
      const root = await f.openDirectory();
      await contains(root.getByRole('alert'), '工作场景读取失败，请重试。');
      expect(
        await root
          .getByRole('heading', { name: '还没有工作场景', exact: true })
          .count(),
      ).toBe(0);
      f.state.failDirectory = false;
      const pending = gate();
      f.state.directoryGate = pending.promise;
      await root.getByRole('button', { name: '重试', exact: true }).click();
      await root.getByRole('status').waitFor();
      expect(
        await root
          .getByRole('heading', { name: '还没有工作场景', exact: true })
          .count(),
      ).toBe(0);
      pending.release();
      await root
        .getByRole('heading', { name: '还没有工作场景', exact: true })
        .waitFor();
      expect(await root.getByRole('alert').count()).toBe(0);
      expect(
        await root
          .getByRole('button', { name: '新建场景', exact: true })
          .isEnabled(),
      ).toBe(true);
    });
  });

  it('compact host without the side workbench opens the same actual directory from its green Workflow entry', async () => {
    await inFixture({ width: 390, disabled: true }, async (f) => {
      const root = await f.openDirectory();
      await root.getByRole('button', { name: /写周报/ }).waitFor();
      await contains(root, 'Rice');
      expect(
        f.state.reads.filter(
          (path) => path === `/api/v1/employee-instances/${id(7)}/scene-skills`,
        ),
      ).toHaveLength(1);
      expect(f.state.writes).toEqual([]);
    });
  });

  it('start creates only a new targeted draft and preserves unsent text, attachment and the old session', async () => {
    await inFixture({ session: true }, async (f) => {
      const input = f.page.getByRole('textbox', {
        name: '给 Rice 的消息',
        exact: true,
      });
      const draft = '[原文] {{保留}}\n\n已有草稿 🚀';
      await input.fill(draft);
      await f.page.locator('input[type=file][multiple]').setInputFiles({
        name: 'research.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic input'),
      });
      await f.page.getByText('research.txt', { exact: true }).waitFor();
      const detail = await f.openDetail();
      await detail
        .getByRole('button', { name: '开始工作', exact: true })
        .click();
      await detail.waitFor({ state: 'detached' });
      await expect
        .poll(() => input.inputValue())
        .toBe(`/weekly-brief\n\n${draft}`);
      expect(new URL(f.page.url()).searchParams.get('session')).toBeNull();
      expect(
        await f.page
          .getByRole('group', { name: '待发送附件', exact: true })
          .getByText('research.txt', { exact: true })
          .count(),
      ).toBe(1);
      expect(
        f.state.reads.filter(
          (path) => path === `/api/v1/employee-instances/${id(7)}`,
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(f.state.writes).toEqual([]);
      const group = f.page.locator(
        `[role="treeitem"][data-row-key="workspace:${id(7)}"]`,
      );
      if ((await group.getAttribute('aria-expanded')) === 'false')
        await group.click();
      await f.page.getByText('保留的旧工作', { exact: true }).waitFor();
    });
  });

  it('company shared packages remain read-only and a missing native name never becomes a UUID command', async () => {
    await inFixture({ frozen: true }, async (f) => {
      const root = await f.openDirectory();
      expect(
        await root
          .getByRole('button', { name: '新建场景', exact: true })
          .count(),
      ).toBe(0);
      await root.getByRole('button', { name: /写周报/ }).click();
      const detail = f.page.getByRole('dialog', {
        name: '写周报',
        exact: true,
      });
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      for (const name of ['开始工作', '更新', '删除场景'])
        expect(
          await detail.getByRole('button', { name, exact: true }).count(),
        ).toBe(0);
      expect(await detail.locator('code').count()).toBe(0);
      expect(f.state.writes).toEqual([]);
    });
  });

  it('employee details and top directory share one catalog, return to the viewed employee, and prepare that exact employee draft', async () => {
    await inFixture({ session: true }, async (f) => {
      const input = f.page.getByRole('textbox', {
        name: '给 Rice 的消息',
        exact: true,
      });
      await input.fill('Rice对话中尚未发送的草稿');
      await f.page.locator('input[type=file][multiple]').setInputFiles({
        name: 'carry.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic input'),
      });
      await f.page.getByText('carry.txt', { exact: true }).waitFor();
      const employee = await f.openEmployeeDetails('流程哥');
      const directoryPath = `/api/v1/employee-instances/${id(17)}/scene-skills`;
      const catalogReads = () =>
        f.state.requests.filter(
          (request) =>
            request.method === 'GET' &&
            request.path === directoryPath &&
            !new URL(request.url).searchParams.has('sceneId'),
        );
      const detailReads = () =>
        f.state.requests.filter(
          (request) =>
            request.method === 'GET' &&
            request.path === directoryPath &&
            new URL(request.url).searchParams.get('sceneId') === id(50),
        );
      const before = catalogReads().length;
      expect(before).toBe(1);
      await employee.getByRole('button', { name: /写周报/ }).click();
      const detail = f.page.getByRole('dialog', {
        name: '写周报',
        exact: true,
      });
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      await contains(detail, '流程哥会自己判断');
      expect(detailReads()).toHaveLength(1);
      expect(
        await f.page
          .getByRole('textbox', { name: '给 Rice 的消息', exact: true })
          .inputValue(),
      ).toBe('Rice对话中尚未发送的草稿');
      await f.page.keyboard.press('Escape');
      await employee.waitFor();
      await expect
        .poll(() =>
          employee.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
      expect(catalogReads()).toHaveLength(before);
      await employee
        .getByRole('button', { name: '新建场景', exact: true })
        .click();
      const source = f.page.getByRole('dialog', {
        name: '新建工作场景',
        exact: true,
      });
      await source.waitFor();
      await source.getByRole('button', { name: '取消', exact: true }).click();
      await employee.waitFor();
      expect(catalogReads()).toHaveLength(before);
      await employee.getByRole('button', { name: /写周报/ }).click();
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      await detail
        .getByRole('button', { name: '开始工作', exact: true })
        .click();
      await detail.waitFor({ state: 'detached' });
      const target = f.page.getByRole('textbox', {
        name: '给 流程哥 的消息',
        exact: true,
      });
      await expect
        .poll(() => target.inputValue())
        .toBe('/weekly-brief\n\nRice对话中尚未发送的草稿');
      expect(
        await f.page
          .getByRole('group', { name: '待发送附件', exact: true })
          .getByText('carry.txt', { exact: true })
          .count(),
      ).toBe(1);
      expect(new URL(f.page.url()).searchParams.get('session')).toBeNull();
      expect(f.state.writes).toEqual([]);
      expect(
        f.state.reads.filter(
          (path) => path === `/api/v1/employee-instances/${id(17)}`,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it('deleting from employee details returns to that same employee and refreshes only its shared catalog', async () => {
    await inFixture({}, async (f) => {
      const employee = await f.openEmployeeDetails('流程哥');
      await employee.getByRole('button', { name: /写周报/ }).click();
      const detail = f.page.getByRole('dialog', {
        name: '写周报',
        exact: true,
      });
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      const remove = await deleteConfirmation(f, detail);
      await contains(remove, '流程哥以后不会再用这个');
      await remove.getByRole('button', { name: '删除', exact: true }).click();
      await employee.waitFor();
      await employee.getByRole('button', { name: /客户回访/ }).waitFor();
      expect(
        await employee.getByRole('button', { name: /写周报/ }).count(),
      ).toBe(0);
      expect(f.state.collections.get(id(7))!.skills).toHaveLength(2);
      expect(
        f.state.collections.get(id(17))!.skills.map((item) => item.sceneId),
      ).toEqual([id(51)]);
      expect([...f.state.removeReceipts.values()][0]!.instanceId).toBe(id(17));
      await expect
        .poll(() =>
          employee.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
    });
  });

  it('GitHub source is read before explicit confirmation and cancel retains the source without installing', async () => {
    await inFixture({}, async (f) => {
      const form = await f.sourceForm();
      await readGithub(form);
      const confirm = confirmation(f);
      await confirm.waitFor();
      await contains(confirm, '客户回访');
      expect(confirmWrites(f)).toHaveLength(0);
      await confirm.getByRole('button', { name: '取消', exact: true }).click();
      await form.waitFor();
      expect(
        await form
          .getByRole('textbox', { name: '仓库链接', exact: true })
          .inputValue(),
      ).toBe('https://github.com/example/weekly-brief');
      expect(
        await form
          .getByRole('heading', { name: '文件要求', exact: true })
          .isVisible(),
      ).toBe(true);
      await form.getByRole('button', { name: '读取', exact: true }).click();
      await confirm.waitFor();
      const frozen = [...f.state.previews.values()].at(-1)!;
      await confirm
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      const success = f.page.getByRole('dialog', {
        name: '安装完成',
        exact: true,
      });
      await success.waitFor();
      expect(confirmWrites(f)).toHaveLength(1);
      const request = PersonalSceneConfirmRequestSchema.parse(
        confirmWrites(f)[0]!.input,
      );
      expect(request.previewId).toBe(frozen.previewId);
      expect(request.digest).toBe(frozen.digest);
      expect(f.state.confirmReceipts.get(request.requestId)?.sceneId).toBe(
        frozen.target.sceneId,
      );
      await success.getByRole('button', { name: '完成', exact: true }).click();
      await f
        .directory()
        .getByRole('button', { name: /写周报/ })
        .waitFor();
      expect(
        f.state.collections.get(id(7))!.skills.map((item) => item.sceneId),
      ).toEqual([id(50), id(51), id(52)]);
    });
  });

  it('ZIP upload auto-reads real multipart bytes and changing source discards a late preview', async () => {
    await inFixture({}, async (f) => {
      const form = await f.sourceForm();
      await form.getByRole('tab', { name: '压缩包', exact: true }).click();
      expect(
        await form
          .getByRole('heading', { name: '文件要求', exact: true })
          .isVisible(),
      ).toBe(true);
      const delayed = gate();
      f.state.previewGate = delayed.promise;
      await chooseZip(f, form, 'weekly-brief.zip', '选择文件');
      await expect.poll(() => previewWrites(f).length).toBe(1);
      expect(
        PersonalScenePreviewRequestSchema.parse(previewWrites(f)[0]!.input)
          .source,
      ).toEqual({ kind: 'zip', fileName: 'weekly-brief.zip' });
      await form.getByRole('tab', { name: 'GitHub 链接', exact: true }).click();
      delayed.release();
      await expect.poll(() => f.state.previewReplies).toBe(1);
      expect(await confirmation(f).count()).toBe(0);
      expect(confirmWrites(f)).toHaveLength(0);
      f.state.previewGate = null;
      await form.getByRole('tab', { name: '压缩包', exact: true }).click();
      await chooseZip(f, form, 'fresh.zip', '重新选择');
      const confirm = confirmation(f);
      await confirm.waitFor();
      await contains(confirm, 'fresh.zip');
      await confirm
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      await f.page
        .getByRole('dialog', { name: '安装完成', exact: true })
        .waitFor();
      expect(confirmWrites(f)).toHaveLength(1);
      expect([...f.state.confirmReceipts.values()][0]!.source.kind).toBe('zip');
    });
  });

  it('update keeps the real target CAS and refreshes only that scene after the verified receipt', async () => {
    await inFixture({}, async (f) => {
      const form = await f.sourceForm(true);
      expect(
        await form
          .getByRole('textbox', { name: '仓库链接', exact: true })
          .inputValue(),
      ).toBe('https://github.com/example/weekly-brief');
      await form.getByRole('button', { name: '读取', exact: true }).click();
      const confirm = confirmation(f, true);
      await confirm.waitFor();
      await contains(confirm, '1.2.0');
      await contains(confirm, '1.3.0');
      const request = PersonalScenePreviewRequestSchema.parse(
        previewWrites(f)[0]!.input,
      );
      expect(request.target).toEqual({
        operation: 'update',
        sceneId: id(50),
        expectedRevision: 1,
        expectedContentRef: scene(id(7)).contentRef,
      });
      await confirm
        .getByRole('button', { name: '确认更新', exact: true })
        .click();
      const success = f.page.getByRole('dialog', {
        name: '更新完成',
        exact: true,
      });
      await success.waitFor();
      await expect.poll(() => f.state.collections.get(id(7))!.revision).toBe(2);
      await success.getByRole('button', { name: '完成', exact: true }).click();
      const detail = f.page.getByRole('dialog', {
        name: '写周报',
        exact: true,
      });
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      await contains(detail, '1.3.0');
      expect(
        f.state.collections
          .get(id(7))!
          .skills.find((item) => item.sceneId === id(51)),
      ).toEqual(scene(id(7), 51));
    });
  });

  it('identical authorized content and resources do not produce a confirm request', async () => {
    await inFixture({}, async (f) => {
      f.state.same = true;
      const form = await f.sourceForm(true);
      await form.getByRole('button', { name: '读取', exact: true }).click();
      await contains(form.getByRole('alert'), '和当前内容完全一样，不用更新。');
      expect(await confirmation(f, true).count()).toBe(0);
      expect(confirmWrites(f)).toHaveLength(0);
      expect(f.state.collections.get(id(7))!.revision).toBe(1);
    });
  });

  it('name mismatch uses the structured reason and complete safe text while CAS conflict stays generic', async () => {
    await inFixture({}, async (f) => {
      const form = await f.sourceForm(true);
      const message =
        '这是另一个 Workflow（other-work），不能更新到“写周报<img src=x>”。要安装它，请新建场景。';
      f.state.previewReason = 'name_mismatch';
      f.state.previewMessage = message;
      await form.getByRole('button', { name: '读取', exact: true }).click();
      await contains(form.getByRole('alert'), message);
      expect(await form.getByRole('alert').locator('img').count()).toBe(0);
      f.state.previewReason = 'version_conflict';
      await form.getByRole('button', { name: '重试', exact: true }).click();
      await contains(
        form.getByRole('alert'),
        '内容或请求已有变化。请重新预览当前目标，再核对差异。',
      );
      expect(await form.getByRole('alert').textContent()).not.toContain(
        '另一个 Workflow',
      );
      expect(confirmWrites(f)).toHaveLength(0);
    });
  });

  for (const entry of [
    {
      reason: 'skill_missing',
      zip: false,
      copy: '没找到 SKILL.md。请确认它在根目录。',
    },
    {
      reason: 'skill_missing',
      zip: true,
      copy: '没找到 SKILL.md。请确认它在压缩包根目录，不要多包一层文件夹。',
    },
    {
      reason: 'workflow_invalid',
      zip: false,
      copy: '该技能不符合 workflow 规范。',
    },
    {
      reason: 'source_unavailable',
      zip: false,
      copy: '读不到这个仓库。目前只支持公开仓库，请检查链接。',
    },
  ] satisfies Array<{
    reason: SkillSourceErrorReason;
    zip: boolean;
    copy: string;
  }>) {
    it(`source ${entry.reason} ${entry.zip ? 'ZIP' : 'GitHub'} uses approved error and never confirms`, async () => {
      await inFixture({}, async (f) => {
        f.state.previewReason = entry.reason;
        const form = await f.sourceForm();
        if (entry.zip) {
          await form.getByRole('tab', { name: '压缩包', exact: true }).click();
          await chooseZip(f, form, 'weekly-brief.zip');
        } else await readGithub(form);
        await contains(form.getByRole('alert'), entry.copy);
        expect(
          await form
            .getByRole('heading', { name: '文件要求', exact: true })
            .isVisible(),
        ).toBe(true);
        expect(confirmWrites(f)).toHaveLength(0);
        expect(await confirmation(f).count()).toBe(0);
      });
    });
  }

  it('delete confirmation keeps native focus and cancellation returns to the same detail', async () => {
    await inFixture({}, async (f) => {
      const detail = await f.openDetail();
      const confirm = await deleteConfirmation(f, detail);
      expect(await confirm.locator('button').count()).toBe(2);
      for (let i = 0; i < 4; i += 1) {
        await f.page.keyboard.press('Tab');
        expect(
          await confirm.evaluate((node) =>
            node.contains(document.activeElement),
          ),
        ).toBe(true);
      }
      await f.page.keyboard.press('Escape');
      await confirm.waitFor({ state: 'detached' });
      await expect
        .poll(() =>
          detail.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      const again = await deleteConfirmation(f, detail);
      await again.getByRole('button', { name: '取消', exact: true }).click();
      await again.waitFor({ state: 'detached' });
      expect(f.state.writes).toEqual([]);
    });
  });

  it('delete locks exits in flight and changes the directory only after the exact all-history receipt', async () => {
    await inFixture({}, async (f) => {
      const detail = await f.openDetail();
      const confirm = await deleteConfirmation(f, detail);
      const pending = gate();
      f.state.writeGate = pending.promise;
      await confirm.getByRole('button', { name: '删除', exact: true }).click();
      await expect
        .poll(
          () =>
            f.state.writes.filter((item) => item.method === 'DELETE').length,
        )
        .toBe(1);
      expect(
        await confirm
          .getByRole('button', { name: '取消', exact: true })
          .isDisabled(),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await confirm.count()).toBe(1);
      expect(f.state.collections.get(id(7))!.skills).toHaveLength(2);
      pending.release();
      const root = f.directory();
      await root.waitFor();
      await contains(
        root.getByRole('status').filter({ hasText: '已删除“写周报”' }),
        '已删除“写周报”',
      );
      await root.getByRole('button', { name: /客户回访/ }).waitFor();
      expect(await root.getByRole('button', { name: /写周报/ }).count()).toBe(
        0,
      );
      expect(await root.getByRole('button', { name: /客户回访/ }).count()).toBe(
        1,
      );
      const receipt = [...f.state.removeReceipts.values()][0]!;
      expect(receipt.scope).toBe('scene_all_history');
      expect(receipt.sceneId).toBe(id(50));
    });
  });

  it('late source reply cannot cross a real employee selection or reuse the old target', async () => {
    await inFixture({}, async (f) => {
      const form = await f.sourceForm();
      const pending = gate();
      f.state.previewGate = pending.promise;
      await readGithub(form);
      await expect.poll(() => previewWrites(f).length).toBe(1);
      await form
        .getByRole('button', { name: '返回上一层', exact: true })
        .click();
      await f
        .directory()
        .getByRole('button', { name: '关闭工作场景', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '开始新的工作', exact: true })
        .click();
      const picker = f.page.getByRole('dialog', {
        name: '选择 AI 员工',
        exact: true,
      });
      await picker.getByRole('button', { name: /流程哥/ }).click();
      await f.page
        .getByRole('textbox', { name: '给 流程哥 的消息', exact: true })
        .waitFor();
      const root = await f.openDirectory();
      pending.release();
      await expect.poll(() => f.state.previewReplies).toBe(1);
      await contains(root, '流程哥');
      expect(await confirmation(f).count()).toBe(0);
      expect(confirmWrites(f)).toHaveLength(0);
      expect(
        f.state.reads.some(
          (path) =>
            path === `/api/v1/employee-instances/${id(17)}/scene-skills`,
        ),
      ).toBe(true);
      await root.getByRole('button', { name: /写周报/ }).click();
      const detail = f.page.getByRole('dialog', {
        name: '写周报',
        exact: true,
      });
      await detail
        .getByRole('heading', { name: '什么时候用', exact: true })
        .waitFor();
      await detail
        .getByRole('button', { name: '开始工作', exact: true })
        .click();
      await detail.waitFor({ state: 'detached' });
      await expect
        .poll(() =>
          f.page
            .getByRole('textbox', { name: '给 流程哥 的消息', exact: true })
            .inputValue(),
        )
        .toBe('/weekly-brief');
      expect(
        f.state.reads.filter(
          (path) => path === `/api/v1/employee-instances/${id(17)}`,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it('authorization loss during confirm clears private preview and disables private actions immediately', async () => {
    await inFixture({}, async (f) => {
      await readGithub(await f.sourceForm());
      const confirm = confirmation(f);
      await confirm.waitFor();
      f.state.deny = true;
      await confirm
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      const root = f.directory();
      await root.waitFor();
      await contains(
        root.getByRole('alert'),
        '当前内容不可访问，可能已撤销或权限已变更。',
      );
      expect(await confirmation(f).count()).toBe(0);
      expect(
        await root
          .getByRole('button', { name: '新建场景', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await root
          .getByRole('heading', { name: '还没有工作场景', exact: true })
          .count(),
      ).toBe(0);
      expect(await root.getByText('客户回访', { exact: true }).count()).toBe(0);
      expect(f.state.confirmReceipts.size).toBe(0);
    });
  });

  it('confirmed failure preserves signed preview and retries the original request while saving guards exits', async () => {
    await inFixture({}, async (f) => {
      await readGithub(await f.sourceForm());
      const confirm = confirmation(f);
      await confirm.waitFor();
      const pending = gate();
      f.state.writeGate = pending.promise;
      f.state.failConfirm = true;
      await confirm
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      await expect.poll(() => confirmWrites(f).length).toBe(1);
      for (const name of ['取消', '返回上一层'])
        expect(
          await confirm.getByRole('button', { name, exact: true }).isDisabled(),
        ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await confirm.count()).toBe(1);
      pending.release();
      await contains(
        confirm.getByRole('alert'),
        '内容或请求已有变化。请重新预览当前目标，再核对差异。',
      );
      expect(f.state.confirmReceipts.size).toBe(0);
      f.state.failConfirm = false;
      f.state.writeGate = null;
      await confirm.getByRole('button', { name: '重试', exact: true }).click();
      await f.page
        .getByRole('dialog', { name: '安装完成', exact: true })
        .waitFor();
      expect(confirmWrites(f)).toHaveLength(2);
      expect(confirmWrites(f)[1]!.input).toEqual(confirmWrites(f)[0]!.input);
    });
  });

  for (const operation of ['confirm', 'remove'] as const) {
    it(`lost ${operation} reply retains original request and never invents a receipt (copy still gated)`, async () => {
      await inFixture({}, async (f) => {
        let dialog: Locator;
        if (operation === 'confirm') {
          await readGithub(await f.sourceForm());
          dialog = confirmation(f);
          await dialog.waitFor();
          f.state.loseConfirm = true;
          await dialog
            .getByRole('button', { name: '确认安装', exact: true })
            .click();
        } else {
          dialog = await deleteConfirmation(f, await f.openDetail());
          f.state.loseRemove = true;
          await dialog
            .getByRole('button', { name: '删除', exact: true })
            .click();
        }
        const retry = dialog.getByRole('button', { name: '重试', exact: true });
        await retry.waitFor();
        await expect.poll(() => retry.isEnabled()).toBe(true);
        expect(
          await f.page
            .getByRole('dialog', { name: '安装完成', exact: true })
            .count(),
        ).toBe(0);
        expect(await dialog.getByRole('alert').count()).toBe(0);
        const first = f.state.writes.find((item) =>
          operation === 'confirm'
            ? item.path.endsWith('/confirm')
            : item.method === 'DELETE',
        )!;
        await retry.click();
        if (operation === 'confirm')
          await f.page
            .getByRole('dialog', { name: '安装完成', exact: true })
            .waitFor();
        else
          await contains(
            f
              .directory()
              .getByRole('status')
              .filter({ hasText: '已删除“写周报”' }),
            '已删除“写周报”',
          );
        const writes = f.state.writes.filter((item) =>
          operation === 'confirm'
            ? item.path.endsWith('/confirm')
            : item.method === 'DELETE',
        );
        expect(writes).toHaveLength(2);
        expect(writes[1]!.input).toEqual(first.input);
        expect(
          operation === 'confirm'
            ? f.state.confirmReceipts.size
            : f.state.removeReceipts.size,
        ).toBe(1);
      });
    });
  }

  it('an unknown committed confirmation stays unknown after a later conflict and keeps the original signed request until a real receipt', async () => {
    await inFixture({}, async (f) => {
      await readGithub(await f.sourceForm());
      const dialog = confirmation(f);
      await dialog.waitFor();
      f.state.loseConfirm = true;
      await dialog
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      const retry = dialog.getByRole('button', { name: '重试', exact: true });
      await retry.waitFor();
      await expect.poll(() => retry.isEnabled()).toBe(true);
      const original = confirmWrites(f)[0]!.input;
      f.state.failConfirm = true;
      await retry.click();
      await expect.poll(() => confirmWrites(f).length).toBe(2);
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(await dialog.getByRole('alert').count()).toBe(0);
      expect(confirmWrites(f)[1]!.input).toEqual(original);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      const form = f.page.getByRole('dialog', {
        name: '新建工作场景',
        exact: true,
      });
      await form.waitFor();
      expect(
        await form
          .getByRole('button', { name: '读取', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(previewWrites(f)).toHaveLength(1);
      await form.getByRole('button', { name: '取消', exact: true }).click();
      await f
        .directory()
        .getByRole('button', { name: '关闭工作场景', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '工作场景', exact: true })
        .click();
      await dialog.waitFor();
      f.state.failConfirm = false;
      await dialog.getByRole('button', { name: '重试', exact: true }).click();
      await f.page
        .getByRole('dialog', { name: '安装完成', exact: true })
        .waitFor();
      expect(confirmWrites(f)[2]!.input).toEqual(original);
      expect(f.state.confirmReceipts.size).toBe(1);
    });
  });

  for (const origin of ['top', 'employee'] as const)
    it(`unknown update ${origin} reopens in the same scope and replays the original request before returning to the exact detail during ${origin === 'top' ? 'pending' : 'failed'} catalog refresh`, async () => {
      await inFixture({}, async (f) => {
        const target = origin === 'employee' ? id(17) : id(7);
        let form: Locator;
        if (origin === 'employee') {
          const employee = await f.openEmployeeDetails('流程哥');
          await employee.getByRole('button', { name: /写周报/ }).click();
          const detail = f.page.getByRole('dialog', {
            name: '写周报',
            exact: true,
          });
          await detail
            .getByRole('heading', { name: '什么时候用', exact: true })
            .waitFor();
          await detail
            .getByRole('button', { name: '更新', exact: true })
            .click();
          form = f.page.getByRole('dialog', {
            name: '更新“写周报”',
            exact: true,
          });
          await form
            .getByRole('heading', { name: '文件要求', exact: true })
            .waitFor();
        } else form = await f.sourceForm(true);
        await readGithub(form);
        const confirm = confirmation(f, true);
        await confirm.waitFor();
        f.state.loseConfirm = true;
        await confirm
          .getByRole('button', { name: '确认更新', exact: true })
          .click();
        await expect
          .poll(() =>
            confirm
              .getByRole('button', { name: '重试', exact: true })
              .isEnabled(),
          )
          .toBe(true);
        const original = PersonalSceneConfirmRequestSchema.parse(
          confirmWrites(f)[0]!.input,
        );
        const frozen = f.state.previews.get(original.previewId)!;
        expect(frozen.operation).toBe('update');
        expect(frozen.instanceId).toBe(target);
        expect(frozen.target.sceneId).toBe(id(50));
        expect(frozen.current?.contentRef).toBe(scene(target).contentRef);
        expect(f.state.confirmReceipts.size).toBe(1);
        expect(
          await f.page
            .getByRole('dialog', { name: '更新完成', exact: true })
            .count(),
        ).toBe(0);
        expect(await confirm.getByRole('alert').count()).toBe(0);

        await confirm
          .getByRole('button', { name: '取消', exact: true })
          .click();
        await form.waitFor();
        await form.getByRole('button', { name: '取消', exact: true }).click();
        const detail = f.page.getByRole('dialog', {
          name: '写周报',
          exact: true,
        });
        await detail.waitFor();
        const parentName =
          origin === 'employee' ? '返回员工详情' : '返回工作场景列表';
        await detail
          .getByRole('button', { name: parentName, exact: true })
          .click();
        const parent =
          origin === 'employee'
            ? f.page.getByRole('dialog', {
                name: '流程哥员工详情',
                exact: true,
              })
            : f.directory();
        await parent.waitFor();
        await parent
          .getByRole('button', {
            name: origin === 'employee' ? '关闭' : '关闭工作场景',
            exact: true,
          })
          .click();
        await parent.waitFor({ state: 'detached' });
        if (origin === 'employee') {
          const employee = await f.openEmployeeDetails('流程哥');
          await employee.getByRole('button', { name: /写周报/ }).click();
        } else
          await f.page
            .getByRole('button', { name: '工作场景', exact: true })
            .click();
        await confirm.waitFor();
        const retry = confirm.getByRole('button', {
          name: '重试',
          exact: true,
        });
        await expect.poll(() => retry.isEnabled()).toBe(true);
        expect(previewWrites(f)).toHaveLength(1);
        expect(confirmWrites(f)).toHaveLength(1);
        const refresh = gate();
        try {
          if (origin === 'top') f.state.directoryGate = refresh.promise;
          else f.state.failDirectory = true;
          await retry.click();
          const success = f.page.getByRole('dialog', {
            name: '更新完成',
            exact: true,
          });
          await success.waitFor();
          expect(confirmWrites(f)).toHaveLength(2);
          expect(confirmWrites(f)[1]!.input).toEqual(original);
          expect(f.state.confirmReceipts.size).toBe(1);
          const receipt = f.state.confirmReceipts.get(original.requestId)!;
          expect(receipt.instanceId).toBe(target);
          expect(receipt.sceneId).toBe(frozen.target.sceneId);
          const detailRead = f.page.waitForRequest((request) => {
            const url = new URL(request.url());
            return (
              request.method() === 'GET' &&
              url.pathname ===
                `/api/v1/employee-instances/${target}/scene-skills` &&
              url.searchParams.get('sceneId') === receipt.sceneId &&
              url.searchParams.get('workspaceId') === original.workspaceId
            );
          });
          if (origin === 'top') await f.page.keyboard.press('Escape');
          else
            await success
              .getByRole('button', { name: '完成', exact: true })
              .click();
          await detailRead;
          await detail
            .getByRole('heading', { name: '什么时候用', exact: true })
            .waitFor();
          await contains(detail, '1.3.0');
          await expect
            .poll(() =>
              detail.evaluate((node) => node.contains(document.activeElement)),
            )
            .toBe(true);
          expect(
            f.state.collections
              .get(target)!
              .skills.find((item) => item.sceneId === receipt.sceneId)
              ?.contentRef,
          ).toBe(receipt.contentRef);
          expect(
            f.state.collections
              .get(target)!
              .skills.find((item) => item.sceneId === id(51)),
          ).toEqual(scene(target, 51));
          const otherTarget = origin === 'employee' ? id(7) : id(17);
          expect(f.state.collections.get(otherTarget)!.revision).toBe(1);
          expect(await confirm.count()).toBe(0);
          await detail
            .getByRole('button', { name: parentName, exact: true })
            .click();
          await parent.waitFor();
          if (origin === 'employee')
            await parent
              .getByRole('region', { name: '基础与人设', exact: true })
              .waitFor();
          else await contains(parent, 'Rice');
          await expect
            .poll(() =>
              parent.evaluate((node) => node.contains(document.activeElement)),
            )
            .toBe(true);
          refresh.release();
          expect(await parent.isVisible()).toBe(true);
          expect(previewWrites(f)).toHaveLength(1);
          expect(confirmWrites(f)).toHaveLength(2);
        } finally {
          refresh.release();
        }
      });
    });

  it('an unknown committed confirmation remains locked when its preview expires instead of clearing uncertainty or creating another request', async () => {
    await inFixture({}, async (f) => {
      await readGithub(await f.sourceForm());
      const dialog = confirmation(f);
      await dialog.waitFor();
      f.state.loseConfirm = true;
      await dialog
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      const retry = dialog.getByRole('button', { name: '重试', exact: true });
      await retry.waitFor();
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(f.state.confirmReceipts.size).toBe(1);
      const original = PersonalSceneConfirmRequestSchema.parse(
        confirmWrites(f)[0]!.input,
      );
      const preview = f.state.previews.get(original.previewId)!;
      await f.page.clock.setSystemTime(
        new Date(Date.parse(preview.expiresAt) + 1000),
      );
      await retry.click();
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(confirmWrites(f)).toHaveLength(1);
      expect(await dialog.getByRole('alert').count()).toBe(0);
      expect(
        await f.page
          .getByRole('dialog', { name: '安装完成', exact: true })
          .count(),
      ).toBe(0);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      const form = f.page.getByRole('dialog', {
        name: '新建工作场景',
        exact: true,
      });
      await form.waitFor();
      expect(
        await form
          .getByRole('button', { name: '读取', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(previewWrites(f)).toHaveLength(1);
      await form.getByRole('button', { name: '取消', exact: true }).click();
      expect(
        await f
          .directory()
          .getByRole('button', { name: '新建场景', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        PersonalSceneConfirmRequestSchema.parse(confirmWrites(f)[0]!.input),
      ).toEqual(original);
    });
  });

  it('authorization loss clears unknown private preview bytes and reauthorization cannot manufacture a new submission or restore the discarded preview', async () => {
    await inFixture({}, async (f) => {
      await readGithub(await f.sourceForm());
      const dialog = confirmation(f);
      await dialog.waitFor();
      f.state.loseConfirm = true;
      await dialog
        .getByRole('button', { name: '确认安装', exact: true })
        .click();
      const retry = dialog.getByRole('button', { name: '重试', exact: true });
      await retry.waitFor();
      await expect.poll(() => retry.isEnabled()).toBe(true);
      const original = confirmWrites(f)[0]!.input;
      f.state.deny = true;
      await retry.click();
      const root = f.directory();
      await root.waitFor();
      await contains(
        root.getByRole('alert'),
        '当前内容不可访问，可能已撤销或权限已变更。',
      );
      expect(await confirmation(f).count()).toBe(0);
      expect(
        await root.getByText('安装工作场景', { exact: true }).count(),
      ).toBe(0);
      expect(confirmWrites(f)).toHaveLength(2);
      await root
        .getByRole('button', { name: '关闭工作场景', exact: true })
        .click();
      f.state.deny = false;
      const restored = await f.openDirectory();
      expect(await confirmation(f).count()).toBe(0);
      expect(
        await restored
          .getByRole('button', { name: '新建场景', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(confirmWrites(f)).toHaveLength(2);
      expect(confirmWrites(f)[0]!.input).toEqual(original);
      expect(confirmWrites(f)[1]!.input).toEqual(original);
      expect(previewWrites(f)).toHaveLength(1);
      expect(f.state.confirmReceipts.size).toBe(1);
    });
  });

  it('ZIP failure can reselect the same real file and confirmation can return to a visible reread action', async () => {
    await inFixture({}, async (f) => {
      const form = await f.sourceForm();
      await form.getByRole('tab', { name: '压缩包', exact: true }).click();
      f.state.previewReason = 'skill_missing';
      await chooseZip(f, form, 'weekly-brief.zip');
      await contains(
        form.getByRole('alert'),
        '没找到 SKILL.md。请确认它在压缩包根目录，不要多包一层文件夹。',
      );
      expect(
        await form
          .getByRole('button', { name: '重新选择', exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await form
          .getByRole('button', { name: '重试', exact: true })
          .isEnabled(),
      ).toBe(true);
      f.state.previewReason = undefined;
      await chooseZip(f, form, 'weekly-brief.zip', '重新选择');
      const confirm = confirmation(f);
      await confirm.waitFor();
      await contains(confirm, 'weekly-brief.zip');
      await confirm
        .getByRole('button', { name: '返回上一层', exact: true })
        .click();
      await form.getByRole('button', { name: '读取', exact: true }).click();
      await confirm.waitFor();
      expect(previewWrites(f)).toHaveLength(3);
      expect(
        previewWrites(f).map(
          (request) =>
            PersonalScenePreviewRequestSchema.parse(request.input).source,
        ),
      ).toEqual(Array(3).fill({ kind: 'zip', fileName: 'weekly-brief.zip' }));
      expect(f.state.writes).toEqual([]);
    });
  });

  for (const origin of ['top', 'employee'] as const)
    for (const operation of ['install', 'update'] as const)
      for (const exit of ['arrow', 'Escape', 'backdrop'] as const)
        it(`success ${origin} ${operation} ${exit} returns to the exact parent during ${exit === 'backdrop' ? 'failed' : 'pending'} catalog refresh`, async () => {
          await inFixture({}, async (f) => {
            let form: Locator;
            if (origin === 'employee') {
              const employee = await f.openEmployeeDetails('流程哥');
              if (operation === 'update') {
                await employee.getByRole('button', { name: /写周报/ }).click();
                const detail = f.page.getByRole('dialog', {
                  name: '写周报',
                  exact: true,
                });
                await detail
                  .getByRole('heading', { name: '什么时候用', exact: true })
                  .waitFor();
                await detail
                  .getByRole('button', { name: '更新', exact: true })
                  .click();
              } else
                await employee
                  .getByRole('button', { name: '新建场景', exact: true })
                  .click();
              form = f.page.getByRole('dialog', {
                name: operation === 'update' ? '更新“写周报”' : '新建工作场景',
                exact: true,
              });
              await form
                .getByRole('heading', { name: '文件要求', exact: true })
                .waitFor();
            } else form = await f.sourceForm(operation === 'update');
            await readGithub(form);
            const confirm = confirmation(f, operation === 'update');
            await confirm.waitFor();
            const refresh = gate();
            try {
              if (exit === 'backdrop') f.state.failDirectory = true;
              else f.state.directoryGate = refresh.promise;
              await confirm
                .getByRole('button', {
                  name: operation === 'update' ? '确认更新' : '确认安装',
                  exact: true,
                })
                .click();
              const success = f.page.getByRole('dialog', {
                name: operation === 'update' ? '更新完成' : '安装完成',
                exact: true,
              });
              await success.waitFor();
              if (exit === 'arrow')
                await success
                  .getByRole('button', { name: '返回上一层', exact: true })
                  .click();
              else if (exit === 'Escape') await f.page.keyboard.press('Escape');
              else {
                expect(
                  await f.page.evaluate(() =>
                    Boolean(
                      document
                        .elementFromPoint(1, 1)
                        ?.closest('[role="dialog"]'),
                    ),
                  ),
                ).toBe(false);
                await f.page.mouse.click(1, 1);
              }
              const parent =
                operation === 'update'
                  ? f.page.getByRole('dialog', { name: '写周报', exact: true })
                  : origin === 'employee'
                    ? f.page.getByRole('dialog', {
                        name: '流程哥员工详情',
                        exact: true,
                      })
                    : f.directory();
              await parent.waitFor();
              if (operation === 'update') {
                await parent
                  .getByRole('heading', { name: '什么时候用', exact: true })
                  .waitFor();
                await contains(parent, '1.3.0');
              } else if (origin === 'employee')
                await parent
                  .getByRole('region', { name: '基础与人设', exact: true })
                  .waitFor();
              await expect
                .poll(() =>
                  parent.evaluate((node) =>
                    node.contains(document.activeElement),
                  ),
                )
                .toBe(true);
              expect(
                await confirmation(f, operation === 'update').count(),
              ).toBe(0);
              expect(confirmWrites(f)).toHaveLength(1);
              expect(confirmWrites(f)[0]!.path).toContain(
                origin === 'employee' ? id(17) : id(7),
              );
              refresh.release();
              expect(await parent.isVisible()).toBe(true);
            } finally {
              refresh.release();
            }
          });
        });

  it.each([1440, 390])(
    'long delivery stays left of its right centered link with approved independent typography at %ipx',
    async (width) => {
      await inFixture({ width }, async (f) => {
        const collection = f.state.collections.get(id(7))!;
        collection.skills[0] = PersonalSceneSkillSchema.parse({
          ...collection.skills[0],
          deliverablesMarkdown:
            '一份周报草稿：已知事实、待确认事项、对应来源和下一步计划。'.repeat(
              12,
            ),
        });
        const detail = await f.openDetail();
        const card = detail.locator('section').filter({
          has: f.page.getByRole('heading', { name: '交付内容', exact: true }),
        });
        const link = card.getByRole('button', { name: /^查看交付结果/ });
        await link.scrollIntoViewIfNeeded();
        const geometry = await link.evaluate((node) => {
          const card = node.parentElement!,
            copy = card.querySelector(':scope > div')!;
          const left = copy.getBoundingClientRect(),
            right = node.getBoundingClientRect(),
            css = getComputedStyle(node);
          return {
            left: {
              x: left.x,
              right: left.right,
              y: left.y,
              height: left.height,
            },
            right: {
              x: right.x,
              y: right.y,
              height: right.height,
              bottom: right.bottom,
            },
            font: css.fontSize,
            line: css.lineHeight,
            weight: css.fontWeight,
            direction: getComputedStyle(card).flexDirection,
          };
        });
        expect(geometry.direction).toBe('row');
        expect(geometry.right.x).toBeGreaterThan(geometry.left.right);
        expect(
          Math.abs(
            geometry.left.y +
              geometry.left.height / 2 -
              geometry.right.y -
              geometry.right.height / 2,
          ),
        ).toBeLessThan(1);
        expect([geometry.font, geometry.line, geometry.weight]).toEqual([
          '12px',
          '18px',
          '500',
        ]);
        expect(geometry.right.y).toBeGreaterThanOrEqual(0);
        expect(geometry.right.bottom).toBeLessThanOrEqual(
          f.page.viewportSize()!.height,
        );
        if (width < 700)
          expect(geometry.right.height).toBeGreaterThanOrEqual(32);
        expect(
          await detail
            .getByRole('button', { name: '删除场景', exact: true })
            .evaluate((node) => {
              const css = getComputedStyle(node);
              return [css.fontSize, css.lineHeight, css.fontWeight];
            }),
        ).toEqual(['14px', '20px', '500']);
      });
    },
  );

  it.each([1440, 390])(
    'coarse source controls have real 40px hit targets and approved input typography at %ipx',
    async (width) => {
      await inFixture({ width, coarse: true }, async (f) => {
        expect(
          await f.page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        ).toBe(true);
        const root = await f.openDirectory();
        const close = await root
          .getByRole('button', { name: '关闭工作场景', exact: true })
          .boundingBox();
        expect(close?.width).toBe(40);
        expect(close?.height).toBe(40);
        await root
          .getByRole('button', { name: '新建场景', exact: true })
          .click();
        const form = f.page.getByRole('dialog', {
          name: '新建工作场景',
          exact: true,
        });
        const back = await form
          .getByRole('button', { name: '返回上一层', exact: true })
          .boundingBox();
        expect(back?.width).toBe(40);
        expect(back?.height).toBe(40);
        expect(
          await form
            .getByRole('textbox', { name: '仓库链接', exact: true })
            .evaluate((node) => {
              const css = getComputedStyle(node);
              return [css.fontSize, css.lineHeight];
            }),
        ).toEqual(width < 700 ? ['16px', '24px'] : ['14px', '22px']);
        expect(
          await form.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
      });
    },
  );

  for (const operation of ['confirm', 'remove'] as const)
    for (const phase of ['lost', 'pending'] as const)
      it(`unresolved ${operation} ${phase} keeps only its scoped technical identity across workspace and viewer changes in one mounted host`, async () => {
        await inFixture({}, async (f) => {
          const scopeRefresh = gate(),
            write = gate();
          try {
            f.state.workspaceGate = scopeRefresh.promise;
            const employee = await f.openEmployeeDetails();
            let dialog: Locator;
            if (operation === 'confirm') {
              await employee
                .getByRole('button', { name: '新建场景', exact: true })
                .click();
              const form = f.page.getByRole('dialog', {
                name: '新建工作场景',
                exact: true,
              });
              await readGithub(form);
              dialog = confirmation(f);
              await dialog.waitFor();
              f.state.loseConfirm = phase === 'lost';
            } else {
              await employee.getByRole('button', { name: /写周报/ }).click();
              const detail = f.page.getByRole('dialog', {
                name: '写周报',
                exact: true,
              });
              await detail
                .getByRole('heading', { name: '什么时候用', exact: true })
                .waitFor();
              dialog = await deleteConfirmation(f, detail);
              f.state.loseRemove = phase === 'lost';
            }
            if (phase === 'pending') f.state.writeGate = write.promise;
            await dialog
              .getByRole('button', {
                name: operation === 'confirm' ? '确认安装' : '删除',
                exact: true,
              })
              .click();
            await expect.poll(() => f.state.writes.length).toBe(1);
            if (phase === 'lost')
              await expect
                .poll(() =>
                  dialog
                    .getByRole('button', { name: '重试', exact: true })
                    .isEnabled(),
                )
                .toBe(true);
            else
              expect(
                await dialog
                  .getByRole('button', { name: '取消', exact: true })
                  .isDisabled(),
              ).toBe(true);
            const original = f.state.writes[0]!.input;
            f.state.scope = {
              workspaceId: id(104),
              viewerId: id(105),
              offset: 100,
            };
            scopeRefresh.release();
            f.state.workspaceGate = null;
            await expect
              .poll(() => f.state.workspaceReplies.at(-1))
              .toBe(`${id(104)}/${id(105)}`);
            await expect.poll(() => dialog.count()).toBe(0);
            const other = await f.openDirectory();
            expect(
              await other
                .getByRole('button', { name: '新建场景', exact: true })
                .isEnabled(),
            ).toBe(true);
            expect(await confirmation(f).count()).toBe(0);
            write.release();
            f.state.writeGate = null;
            await expect
              .poll(() =>
                operation === 'confirm'
                  ? f.state.confirmReceipts.size
                  : f.state.removeReceipts.size,
              )
              .toBe(1);
            await other
              .getByRole('button', { name: '关闭工作场景', exact: true })
              .click();
            f.state.scope = { workspaceId: id(4), viewerId: id(5), offset: 0 };
            await f.page
              .getByRole('button', { name: '查看Rice详情', exact: true })
              .click();
            await expect
              .poll(() => f.state.workspaceReplies.at(-1))
              .toBe(`${id(4)}/${id(5)}`);
            const parent = f.page.getByRole('dialog', { name: /员工详情/ });
            await parent.waitFor();
            await parent
              .getByRole('button', { name: '关闭', exact: true })
              .click();
            const restored = await f.openDirectory();
            expect(await confirmation(f).count()).toBe(0);
            expect(
              await restored
                .getByRole('button', { name: '新建场景', exact: true })
                .isDisabled(),
            ).toBe(true);
            expect(f.state.writes).toHaveLength(1);
            expect(f.state.writes[0]!.input).toEqual(original);
            expect(
              f.state.requests.filter(
                (request) =>
                  request.method !== 'GET' &&
                  !request.path.endsWith('/preview'),
              ),
            ).toHaveLength(1);
          } finally {
            scopeRefresh.release();
            write.release();
          }
        });
      });
});
