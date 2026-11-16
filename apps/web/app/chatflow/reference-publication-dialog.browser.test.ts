import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReferenceRevision, RequestContext } from '@allrice/contracts';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import { tenantValidationFixture } from '../../../../packages/database/src/tenant-validation.fixture.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../../../../packages/database/src/identity.ts';
import * as publications from '../api/v1/references/publications/route';
import { POST as changePublication } from '../api/v1/references/publications/[id]/route';
import * as workbench from '../api/v1/workbench/files/route';
import { GET as download } from '../api/v1/references/revisions/[id]/download/route';

// DSH comparison: reuse the existing dialog/file UI. Only SaaS cookie identity,
// immutable storage and publication gates are exercised; no new agent lifecycle.
const ports = vi.hoisted(() => ({ context: vi.fn(), storage: vi.fn() }));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('../../lib/storage/runtime', () => ({
  getStorageAdapter: ports.storage,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Login = { token: string; context: RequestContext };
type Selection = {
  kind: 'file' | 'upload' | 'audience' | 'revoke' | 'delete';
  objectId?: string;
  sourceId?: string;
};
type Receipt = { viewerId: string; sourceId: string; revisionId: string };
type Write = {
  path: string;
  body: Record<string, unknown>;
  viewer: string | null;
  status: number;
  result: { sourceId?: string; error?: { code: string } };
};

suite(
  'publication dialog -> real HTTP/cookie identity -> PostgreSQL and fixed storage',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
      browser: Browser,
      server: Server,
      origin: string;
    let a: Login, b: Login, departments: string[], objectId: string;
    const text = '固定原件：本期口径与下载内容。';
    const writes: Write[] = [],
      failures: string[] = [];
    const reads: string[] = [];
    let nextHold: {
      reached: (write: Write) => void;
      wait: Promise<void>;
    } | null = null;
    const releases = new Set<() => void>();
    function holdReply() {
      let reached!: (write: Write) => void, release!: () => void;
      const seen = new Promise<Write>((resolve) => {
        reached = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextHold = { reached, wait };
      releases.add(release);
      return {
        seen,
        release: () => {
          releases.delete(release);
          release();
        },
      };
    }
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      ports.storage.mockReturnValue(runtimeFixtureStorage(f.db));
      const fixture = await tenantValidationFixture(f.db);
      const token = (await createSession(fixture.context.actor.id)).token;
      a = {
        token,
        context: (await authenticateSession(token, {
          workspaceId: fixture.context.workspaceId!,
        }))!,
      };
      departments = [randomUUID(), randomUUID()];
      for (const [i, name] of ['市场部', '运营部'].entries())
        await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name) values(${departments[i]!},${a.context.organizationId},${name},${randomUUID()},${name})`;
      await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,department_id,content_maintenance_level) values(${a.context.organizationId},${a.context.actor.id},'普通发布人',${departments[0]!},'personal')`;
      const [org] =
        await f.db`select slug,name from allrice_organizations where id=${a.context.organizationId}`;
      const colleague = await ensureBootstrapPortalPrincipal({
        organizationSlug: org!.slug,
        organizationName: org!.name,
        workspaceSlug: 'test',
        workspaceName: 'P25 fixture',
        email: randomUUID() + '@example.test',
        displayName: 'B',
        role: 'member',
      });
      const otherToken = (await createSession(colleague.user.id)).token;
      b = {
        token: otherToken,
        context: (await authenticateSession(otherToken, {
          workspaceId: a.context.workspaceId!,
        }))!,
      };
      // Only the cookie transport is replaced; every identity is authenticated in PG.
      ports.context.mockImplementation(async (request: Request) => {
        const cookie = request.headers
          .get('cookie')
          ?.match(/fixture_session=([^;]+)/)?.[1];
        return cookie
          ? authenticateSession(cookie, { workspaceId: a.context.workspaceId! })
          : null;
      });
      const require = createRequire(import.meta.url);
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        absWorkingDir: process.cwd(),
        entryPoints: ['apps/web/test/reference-publication-dialog-page.tsx'],
        bundle: true,
        format: 'esm',
        splitting: true,
        platform: 'browser',
        write: false,
        outdir: '/unused-publication-dialog',
        jsx: 'automatic',
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
        define: {
          'process.env.NODE_ENV': '"development"',
          'process.env': '{}',
        },
      });
      const assets = new Map<string, Uint8Array>(
        built.outputFiles.map(
          (file: { path: string; contents: Uint8Array }) => [
            file.path.slice(file.path.lastIndexOf('/')),
            file.contents,
          ],
        ),
      );
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url!, origin),
            parts = url.pathname.split('/');
          if (req.method === 'GET') reads.push(url.pathname + url.search);
          if (!url.pathname.startsWith('/api/')) {
            res.writeHead(200, {
              'Content-Type': url.pathname.endsWith('.js')
                ? 'application/javascript'
                : url.pathname.endsWith('.css')
                  ? 'text/css'
                  : 'text/html',
            });
            res.end(
              assets.get(url.pathname) ??
                '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/reference-publication-dialog-page.css"></head><body><div id="root"></div><script type="module" src="/reference-publication-dialog-page.js"></script></body></html>',
            );
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers))
            if (typeof value === 'string') headers.set(key, value);
          const body = Buffer.concat(chunks).toString('utf8');
          const request = new Request(url, {
            method: req.method,
            headers,
            ...(body ? { body } : {}),
          });
          const held =
            req.method === 'POST' && parts[4] === 'publications'
              ? nextHold
              : null;
          if (held) nextHold = null;
          const result =
            parts[3] === 'workbench'
              ? req.method === 'POST'
                ? await workbench.POST(request)
                : await workbench.GET(request)
              : parts[4] === 'publications'
                ? !parts[5]
                  ? req.method === 'POST'
                    ? await publications.POST(request)
                    : await publications.GET(request)
                  : await changePublication(request, {
                      params: Promise.resolve({ id: parts[5]! }),
                    })
                : parts[4] === 'revisions' && parts[6] === 'download'
                  ? await download(request, {
                      params: Promise.resolve({ id: parts[5]! }),
                    })
                  : new Response(null, { status: 404 });
          if (req.method === 'POST' && parts[4] === 'publications') {
            const write: Write = {
              path: url.pathname,
              body: JSON.parse(body),
              viewer: headers.get('x-allrice-expected-viewer-id'),
              status: result.status,
              result: await result.clone().json(),
            };
            writes.push(write);
            if (held) {
              held.reached(write);
              await held.wait;
            }
          }
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) {
          failures.push(String(error));
          res.writeHead(500);
          res.end('{}');
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('Missing fixture address');
      origin = 'http://127.0.0.1:' + address.port;
      const { chromium } = createRequire(
        resolve(process.cwd(), 'apps/worker/package.json'),
      )('playwright-core');
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      });
      objectId = (
        await (
          await api('/workbench/files', a, {
            requestId: randomUUID(),
            workspaceId: a.context.workspaceId,
            fileName: '实际上传原件.txt',
            mediaType: 'text/plain',
            contentBase64: Buffer.from(text).toString('base64'),
          })
        ).json()
      ).objectId;
      expect(objectId).toBeTruthy();
    }, 120000);
    afterAll(async () => {
      for (const release of releases) release();
      await browser?.close();
      server?.closeAllConnections();
      if (server) await new Promise<void>((done) => server.close(() => done()));
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
      const evidence = resolve(
        '.local/integration-collection',
        `f3-publication-http-${process.pid}`,
      );
      await mkdir(evidence, { recursive: true });
      // These are disposable fixture IDs and payloads, never session cookies.
      await writeFile(
        resolve(evidence, 'http-receipts.json'),
        JSON.stringify({ writes, reads, failures }, null, 2),
      );
      expect(failures).toEqual([]);
    }, 30000);
    async function api(path: string, login = a, input?: unknown) {
      return fetch(origin + '/api/v1' + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          cookie: 'fixture_session=' + login.token,
          origin,
          'Content-Type': 'application/json',
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    }
    async function directory(login = a, sourceId?: string) {
      const response = await api(
        '/references/publications?workspaceId=' +
          login.context.workspaceId +
          (sourceId ? '&sourceId=' + sourceId : ''),
        login,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        viewerId: string;
        references: ReferenceRevision[];
        options: { writable: boolean; maintenanceLevel: string };
      };
    }
    async function counts() {
      return (
        await f.db`select (select count(*)::int from allrice_knowledge_sources) sources,(select count(*)::int from allrice_knowledge_reference_actions) actions,(select count(*)::int from allrice_storage_objects) objects`
      )[0];
    }
    async function cookie(page: Page, login: Login) {
      await page
        .context()
        .addCookies([
          { name: 'fixture_session', value: login.token, url: origin },
        ]);
    }
    async function pageFor(
      selection: Selection,
      login = a,
      width = 1440,
      ignoreAbort = false,
    ) {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
      });
      const page = await context.newPage();
      await cookie(page, login);
      const query = new URLSearchParams({
        workspaceId: a.context.workspaceId!,
        ...selection,
        ...(selection.kind === 'file' ? { omitOptions: '1' } : {}),
        ...(ignoreAbort ? { ignoreAbort: '1' } : {}),
      });
      await page.goto(origin + '/?' + query);
      await expect.poll(() => page.getByRole('dialog').count()).toBe(1);
      expect(await page.getByLabel('夹具错误').textContent()).toBe('');
      return page;
    }
    async function open(
      page: Page,
      selection: Selection,
      viewerId = a.context.actor.id,
    ) {
      await page.evaluate(
        (detail) =>
          window.dispatchEvent(
            new CustomEvent('publication-fixture-target', { detail }),
          ),
        selection,
      );
      await expect
        .poll(() => page.getByLabel('当前查看者').textContent())
        .toBe(viewerId);
      await expect.poll(() => page.getByRole('dialog').count()).toBe(1);
    }
    function purposeInput(page: Page) {
      // Role naming excludes this control's value from its wrapping label.
      return page
        .getByRole('dialog')
        .getByRole('textbox', { name: '用途', exact: true });
    }
    async function uploadFile(page: Page, name = '本次上传.txt') {
      await page.getByLabel('选择文件', { exact: true }).setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(text),
      });
    }
    async function submit(page: Page, label: string, status = 201) {
      const response = page.waitForResponse(
        (r) =>
          r.url().includes('/api/v1/references/publications') &&
          r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: label, exact: true }).click();
      expect((await response).status()).toBe(status);
      await expect
        .poll(() =>
          status < 300
            ? page.getByRole('dialog').count()
            : page.getByRole('alert').count(),
        )
        .toBe(status < 300 ? 0 : 1);
    }
    async function receipt(page: Page) {
      return (
        JSON.parse(
          (await page.getByLabel('保存回执').textContent())!,
        ) as Receipt[]
      ).at(-1)!;
    }

    it('adds my actual workbench upload as a fixed copy, then revokes only the publication', async () => {
      const reading = reads.length;
      const page = await pageFor({ kind: 'file', objectId });
      try {
        await page.getByRole('radio', { name: '全公司', exact: true }).check();
        expect(
          reads
            .slice(reading)
            .some(
              (path) =>
                path.includes('category=all') && path.includes('limit=1'),
            ),
        ).toBe(true);
        await purposeInput(page).fill('固定口径');
        await submit(page, '确认');
        const saved = await receipt(page);
        const [copy] =
          await f.db`select file_object_id,file_name from allrice_knowledge_revisions where id=${saved.revisionId}`;
        expect(copy!.file_object_id).not.toBe(objectId);
        expect(copy!.file_name).toBe('实际上传原件.txt');
        expect(
          await (
            await api(
              `/references/revisions/${saved.revisionId}/download?workspaceId=${a.context.workspaceId}`,
            )
          ).text(),
        ).toBe(text);
        expect(
          (await directory(a, saved.sourceId)).references[0],
        ).toMatchObject({
          publication: { origin: 'file', publisherId: a.context.actor.id },
        });
        await open(page, { kind: 'revoke', sourceId: saved.sourceId });
        expect(await page.getByRole('dialog').textContent()).toContain(
          '原文件还在',
        );
        await submit(page, '撤销资料', 200);
        expect((await directory(a, saved.sourceId)).references).toEqual([]);
        const original = await api(
          `/workbench/files?view=deliverables&workspaceId=${a.context.workspaceId}&objectId=${objectId}`,
        );
        expect(original.status).toBe(200);
        expect((await original.json()).files[0]).toMatchObject({
          objectId,
          publication: null,
        });
      } finally {
        await page.context().close();
      }
    }, 60000);

    it.each(['personal', 'departments', 'company'] as const)(
      'ordinary member uploads for %s, including a department multi-selection',
      async (scope) => {
        expect((await directory()).options).toMatchObject({
          writable: true,
          maintenanceLevel: 'personal',
        });
        const page = await pageFor(
          { kind: 'upload' },
          a,
          scope === 'departments' ? 390 : 1440,
        );
        try {
          await uploadFile(page, scope + '.txt');
          const labels = {
            personal: '仅自己',
            departments: '指定部门',
            company: '全公司',
          };
          await page
            .getByRole('radio', { name: labels[scope], exact: true })
            .check();
          if (scope === 'departments') {
            expect(
              await page
                .getByRole('button', { name: '发布', exact: true })
                .isDisabled(),
            ).toBe(true);
            await page
              .getByRole('checkbox', { name: '市场部', exact: true })
              .check();
            await page
              .getByRole('checkbox', { name: '运营部', exact: true })
              .check();
          }
          await purposeInput(page).fill('普通成员发布');
          await submit(page, '发布');
          const saved = await receipt(page),
            current = (await directory(a, saved.sourceId)).references[0]!;
          expect(current).toMatchObject({
            fileName: scope + '.txt',
            purpose: '普通成员发布',
            publication: {
              origin: 'upload',
              publisherId: a.context.actor.id,
              audience: {
                scope,
                departmentIds:
                  scope === 'departments' ? [...departments].sort() : [],
              },
            },
          });
          expect(saved.viewerId).toBe(a.context.actor.id);
        } finally {
          await page.context().close();
        }
      },
      60000,
    );

    it('edits purpose and audience atomically using their revision, then downloads the exact upload before delete', async () => {
      const page = await pageFor({ kind: 'upload' }, a, 390);
      try {
        await uploadFile(page, '范围与删除.txt');
        await submit(page, '发布');
        const saved = await receipt(page);
        for (const [index, label] of ['全公司', '仅自己'].entries()) {
          await open(page, { kind: 'audience', sourceId: saved.sourceId });
          await page
            .getByRole('dialog', { name: '编辑资料', exact: true })
            .waitFor();
          expect(await purposeInput(page).inputValue()).toBe(
            index === 0 ? '' : '核对经营指标',
          );
          await purposeInput(page).fill(index === 0 ? '  核对经营指标  ' : '');
          await page.getByRole('radio', { name: label, exact: true }).check();
          await submit(page, '保存', 200);
          expect(writes.at(-1)!.body).toMatchObject({
            action: 'edit',
            purpose: index === 0 ? '核对经营指标' : '',
          });
          expect(writes.at(-1)!.body.expectedRevision).toBe(index + 1);
          expect(
            (await directory(a, saved.sourceId)).references[0],
          ).toMatchObject({
            revision: 1,
            revisionId: saved.revisionId,
            purpose: index === 0 ? '核对经营指标' : '',
            publication: { audienceRevision: index + 2 },
          });

          for (const width of [1440, 390])
            for (const theme of ['light', 'dark'])
              it(`prefills edit purpose and cancels without writes at ${width}px ${theme}`, async () => {
                const page = await pageFor({ kind: 'upload' }, a, width);
                try {
                  await uploadFile(page, `用途-${width}-${theme}.txt`);
                  await purposeInput(page).fill('每月经营报告的格式参考');
                  await submit(page, '发布');
                  const saved = await receipt(page);
                  await open(page, {
                    kind: 'audience',
                    sourceId: saved.sourceId,
                  });
                  await page.evaluate((theme) => {
                    document.documentElement.setAttribute('data-theme', theme);
                    if (theme === 'dark')
                      document.body.setAttribute('data-ds-dark-theme', '');
                    else document.body.removeAttribute('data-ds-dark-theme');
                  }, theme);
                  expect(await purposeInput(page).inputValue()).toBe(
                    '每月经营报告的格式参考',
                  );
                  expect(
                    await purposeInput(page).getAttribute('maxlength'),
                  ).toBe('1000');
                  const dir = process.env.ALLRICE_CONFIRMED_UI_SCREENSHOTS;
                  if (dir) {
                    await mkdir(dir, { recursive: true });
                    await page.screenshot({
                      path: resolve(
                        dir,
                        `enterprise-${width}-${theme}-edit.png`,
                      ),
                      animations: 'disabled',
                    });
                  }
                  const before = writes.length;
                  await purposeInput(page).fill('取消不保存');
                  await page
                    .getByRole('button', { name: '取消', exact: true })
                    .click();
                  expect(writes).toHaveLength(before);
                  await open(page, {
                    kind: 'audience',
                    sourceId: saved.sourceId,
                  });
                  expect(await purposeInput(page).inputValue()).toBe(
                    '每月经营报告的格式参考',
                  );
                  const box = (await page.getByRole('dialog').boundingBox())!;
                  expect(box.x).toBeGreaterThanOrEqual(0);
                  expect(box.x + box.width).toBeLessThanOrEqual(width);
                } finally {
                  await page.context().close();
                }
              });
        }
        await open(page, { kind: 'delete', sourceId: saved.sourceId });
        const href = `/api/v1/references/revisions/${saved.revisionId}/download?workspaceId=${a.context.workspaceId}`;
        expect(
          await page
            .getByRole('link', { name: '先下载', exact: true })
            .getAttribute('href'),
        ).toBe(href);
        const downloading = page.waitForEvent('download');
        await page.getByRole('link', { name: '先下载', exact: true }).click();
        const downloaded = await downloading;
        expect(downloaded.url()).toBe(origin + href);
        expect(await readFile((await downloaded.path())!)).toEqual(
          Buffer.from(text),
        );
        await submit(page, '删除资料', 200);
        expect(writes.at(-1)!.body.expectedRevision).toBe(3);
        expect((await directory(a, saved.sourceId)).references).toEqual([]);
        expect((await api(href.replace('/api/v1', ''))).status).toBe(404);
      } finally {
        await page.context().close();
      }
    }, 60000);

    it('keeps failed form data/request IDs while a different tab changes A cookies to B, with neither account written', async () => {
      const page = await pageFor({ kind: 'upload' });
      try {
        await uploadFile(page, '不能串号.txt');
        await page
          .getByRole('radio', { name: '指定部门', exact: true })
          .check();
        await page
          .getByRole('checkbox', { name: '市场部', exact: true })
          .check();
        await page
          .getByRole('checkbox', { name: '运营部', exact: true })
          .check();
        await purposeInput(page).fill('保留原填写');
        const otherTab = await page.context().newPage();
        await cookie(otherTab, b);
        await otherTab.close();
        const before = await counts(),
          start = writes.length;
        for (let attempt = 0; attempt < 2; attempt++)
          await submit(page, '发布', 409);
        expect(writes[start]!.body).toEqual(writes[start + 1]!.body);
        expect(writes[start]!.viewer).toBe(a.context.actor.id);
        expect(writes[start]!.result.error?.code).toBe('CONFLICT');
        expect(await purposeInput(page).inputValue()).toBe('保留原填写');
        expect(
          await page
            .getByRole('radio', { name: '指定部门', exact: true })
            .isChecked(),
        ).toBe(true);
        for (const name of ['市场部', '运营部'])
          expect(
            await page.getByRole('checkbox', { name, exact: true }).isChecked(),
          ).toBe(true);
        expect(await page.getByRole('dialog').textContent()).toContain(
          '不能串号.txt',
        );
        await purposeInput(page).fill('修改后的填写');
        await submit(page, '发布', 409);
        expect(writes.at(-1)!.body.requestId).not.toBe(
          writes[start]!.body.requestId,
        );
        const changedId = writes.at(-1)!.body.requestId;
        expect(await counts()).toEqual(before);
        expect((await directory(b)).viewerId).toBe(b.context.actor.id);
        expect(
          (await directory(b)).references.filter(
            (r) => r.fileName === '不能串号.txt',
          ),
        ).toEqual([]);
        await cookie(page, a);
        await submit(page, '发布');
        expect(writes.at(-1)!.body.requestId).toBe(changedId);
        expect(
          (await directory(a, (await receipt(page)).sourceId)).references[0]!
            .purpose,
        ).toBe('修改后的填写');
      } finally {
        await page.context().close();
      }
    }, 60000);

    it('retries the same request after a lost HTTP reply without duplicating the committed publication', async () => {
      const page = await pageFor({ kind: 'upload' });
      try {
        await uploadFile(page, '响应丢失后重试.txt');
        await purposeInput(page).fill('同一份副本');
        const start = writes.length;
        await page.route(
          '**/api/v1/references/publications',
          async (route) => {
            // Commit the real request, then fail only its browser delivery.
            await route.fetch({ maxRetries: 0 });
            await route.abort('failed');
          },
          { times: 1 },
        );
        await page.getByRole('button', { name: '发布', exact: true }).click();
        await expect.poll(() => page.getByRole('alert').count()).toBe(1);
        expect(writes[start]!.status).toBe(201);
        const sourceId = writes[start]!.result.sourceId!;
        expect((await directory(a, sourceId)).references).toHaveLength(1);
        const committed = await counts();
        expect(await purposeInput(page).inputValue()).toBe('同一份副本');
        await submit(page, '发布');
        expect(writes[start + 1]!.body).toEqual(writes[start]!.body);
        expect(writes[start + 1]!.result).toEqual(writes[start]!.result);
        expect((await receipt(page)).sourceId).toBe(sourceId);
        expect(await counts()).toEqual(committed);
      } finally {
        await page.context().close();
      }
    }, 60000);

    it.each([
      ['viewer', false],
      ['viewer', true],
      ['target', false],
      ['target', true],
    ] as const)(
      'ignores a late reply after changing %s (real rejection=%s)',
      async (replacement, reject) => {
        const page = await pageFor({ kind: 'upload' }, a, 1440, true),
          held = holdReply();
        try {
          await uploadFile(page, '迟到旧表单.txt');
          if (reject) await cookie(page, b);
          const response = page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              r.url().endsWith('/references/publications'),
          );
          await page.getByRole('button', { name: '发布', exact: true }).click();
          const pending = await held.seen;
          expect(pending.status).toBe(reject ? 409 : 201);
          await cookie(page, replacement === 'viewer' ? b : a);
          await open(
            page,
            replacement === 'viewer'
              ? { kind: 'upload' }
              : { kind: 'file', objectId },
            replacement === 'viewer' ? b.context.actor.id : a.context.actor.id,
          );
          await purposeInput(page).fill('新表单草稿');
          held.release();
          await (await response).finished();
          await page.evaluate(
            () =>
              new Promise<void>((done) => requestAnimationFrame(() => done())),
          );
          expect(await page.getByLabel('保存回执').textContent()).toBe('[]');
          expect(await page.getByRole('alert').count()).toBe(0);
          expect(await purposeInput(page).inputValue()).toBe('新表单草稿');
          expect(
            await page
              .getByRole('button', {
                name: replacement === 'viewer' ? '发布' : '确认',
                exact: true,
              })
              .isEnabled(),
          ).toBe(replacement === 'target');
          if (!reject)
            expect(
              (await directory(a, pending.result.sourceId)).references,
            ).toHaveLength(1);
        } finally {
          held.release();
          await page.context().close();
        }
      },
      60000,
    );

    it('cancel closes a filled mobile upload without writing anything', async () => {
      const page = await pageFor({ kind: 'upload' }, a, 390);
      try {
        await uploadFile(page);
        await purposeInput(page).fill('取消不发布');
        const before = await counts(),
          requests = writes.length;
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
        expect(await page.getByLabel('取消次数').textContent()).toBe('1');
        expect(writes).toHaveLength(requests);
        expect(await counts()).toEqual(before);
      } finally {
        await page.context().close();
      }
    }, 60000);
  },
);
