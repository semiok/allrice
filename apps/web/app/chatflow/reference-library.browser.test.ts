import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, ReferenceRevision } from '@allrice/contracts';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import * as client from '../../../../packages/database/src/core/client.ts';
import { tenantValidationFixture } from '../../../../packages/database/src/tenant-validation.fixture.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  authenticatePlatformSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from '../../../../packages/database/src/organization-administration.ts';
import { processNextReference } from '../../../worker/src/reference-processing.ts';
import { GET as list, POST as upload } from '../api/v1/references/route';
import {
  GET as saveOptions,
  POST as saveArtifact,
} from '../api/v1/references/artifacts/route';
import { POST as action } from '../api/v1/references/[id]/route';
import { GET as preview } from '../api/v1/references/revisions/[id]/preview/route';
import { GET as download } from '../api/v1/references/revisions/[id]/download/route';

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
suite(
  'reference drawer -> real HTTP -> fixed storage -> Worker -> preview/download',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      browser: Browser,
      server: Server,
      origin: string;
    let admin: RequestContext,
      adminToken: string,
      owner: RequestContext,
      ownerToken: string,
      reader: RequestContext,
      readerToken: string;
    const failures: string[] = [];
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      ports.storage.mockReturnValue(assistantFixtureStorage(f.db));
      const p = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control Plane',
        email: 'reference-browser@example.test',
        displayName: 'Platform',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      adminToken = (await createSession(p.user.id)).token;
      admin = (await authenticatePlatformSession(adminToken))!;
      const company = await createManagedOrganization(admin, {
        name: 'Reference browser fixture',
      });
      const people = await importOrganizationPeople(
        admin,
        company.organizationId,
        {
          people: [
            {
              username: 'owner-' + randomUUID(),
              displayName: 'Owner',
              contentMaintenanceLevel: 'company',
            },
            { username: 'reader-' + randomUUID(), displayName: 'Reader' },
          ],
        },
      );
      ownerToken = (await createSession(people.created[0]!.userId)).token;
      readerToken = (await createSession(people.created[1]!.userId)).token;
      owner = {
        ...(await authenticateSession(ownerToken))!,
        workspaceId: company.defaultWorkspaceId,
      };
      reader = {
        ...(await authenticateSession(readerToken))!,
        workspaceId: company.defaultWorkspaceId,
      };
      ports.context.mockImplementation(async (req: Request) => {
        const token = req.headers
          .get('cookie')
          ?.match(/fixture_session=([^;]+)/)?.[1];
        if (!token) return null;
        return token === adminToken
          ? authenticatePlatformSession(token)
          : authenticateSession(token, {
              workspaceId:
                req.headers.get('x-workspace-id') ??
                new URL(req.url).searchParams.get('workspaceId') ??
                company.defaultWorkspaceId,
            });
      });
      const require = createRequire(import.meta.url),
        { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        absWorkingDir: process.cwd(),
        entryPoints: ['apps/web/test/reference-library-page.tsx'],
        bundle: true,
        format: 'esm',
        splitting: true,
        platform: 'browser',
        write: false,
        outdir: '/unused-reference-library',
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
          if (url.pathname.startsWith('/api/')) {
            const bytes: Buffer[] = [];
            for await (const c of req) bytes.push(Buffer.from(c));
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers))
              if (typeof v === 'string') headers.set(k, v);
            const request = new Request(url, {
              method: req.method,
              headers,
              ...(bytes.length
                ? { body: Buffer.concat(bytes).toString('utf8') }
                : {}),
            });
            const result =
              parts[3] !== 'references'
                ? new Response(null, { status: 404 })
                : !parts[4]
                  ? req.method === 'POST'
                    ? await upload(request)
                    : await list(request)
                  : parts[4] === 'artifacts'
                    ? req.method === 'POST'
                      ? await saveArtifact(request)
                      : await saveOptions(request)
                    : parts[4] === 'revisions'
                      ? parts[6] === 'preview'
                        ? await preview(request, {
                            params: Promise.resolve({ id: parts[5]! }),
                          })
                        : await download(request, {
                            params: Promise.resolve({ id: parts[5]! }),
                          })
                      : await action(request, {
                          params: Promise.resolve({ id: parts[4]! }),
                        });
            res.writeHead(result.status, Object.fromEntries(result.headers));
            res.end(Buffer.from(await result.arrayBuffer()));
            return;
          }
          const asset = assets.get(url.pathname);
          res.writeHead(200, {
            'Content-Type': url.pathname.endsWith('.js')
              ? 'application/javascript'
              : url.pathname.endsWith('.css')
                ? 'text/css'
                : 'text/html',
          });
          res.end(
            asset ??
              '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/reference-library-page.css"></head><body style="margin:0;background:white"><div id="root"></div><script type="module" src="/reference-library-page.js"></script></body></html>',
          );
        } catch (e) {
          failures.push(String(e));
          res.writeHead(500);
          res.end('{}');
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('address');
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
    }, 120000);
    afterAll(async () => {
      await browser?.close();
      server?.closeAllConnections();
      if (server) await new Promise<void>((done) => server.close(() => done()));
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
      expect(failures).toEqual([]);
    }, 30000);
    async function pageFor(token = ownerToken, width = 1440) {
      const c = await browser.newContext({ viewport: { width, height: 960 } });
      await c.addCookies([
        { name: 'fixture_session', value: token, url: origin },
      ]);
      const page = await c.newPage();
      await page.goto(
        origin +
          (token === adminToken
            ? '/?platform=1'
            : '/?workspaceId=' + owner.workspaceId),
      );
      return page;
    }
    async function api(path = '', token = ownerToken, init: RequestInit = {}) {
      return fetch(origin + '/api/v1/references' + path, {
        ...init,
        headers: {
          cookie: 'fixture_session=' + token,
          'content-type': 'application/json',
        },
      });
    }
    async function references(token = ownerToken) {
      return (
        await (
          await api(
            '?workspaceId=' +
              (token === adminToken ? admin.workspaceId : owner.workspaceId),
            token,
          )
        ).json()
      ).references as ReferenceRevision[];
    }
    async function postFile(
      name: string,
      text: Buffer | string,
      mediaType = 'text/plain',
    ) {
      const result = await api('', ownerToken, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          scope: 'personal',
          fileName: name,
          purpose: 'isolated processing check',
          mediaType,
          contentBase64: Buffer.from(text).toString('base64'),
        }),
      });
      expect(result.status).toBe(201);
      return (await result.json()) as { sourceId: string; revisionId: string };
    }
    it.each([1440, 390])(
      'saves an exact business artifact through the dialog and reads its retained file at %ipx',
      async (width) => {
        const a = await tenantValidationFixture(f.db);
        const token = (await createSession(a.context.actor.id)).token;
        await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level) values(${a.context.organizationId},${a.context.actor.id},'Publisher','company')`;
        const c = await browser.newContext({
          viewport: { width, height: 900 },
        });
        await c.addCookies([
          { name: 'fixture_session', value: token, url: origin },
        ]);
        const page = await c.newPage();
        try {
          await page.goto(
            origin +
              '/?workspaceId=' +
              a.context.workspaceId +
              '&artifactId=' +
              a.artifact.artifactId,
          );
          await page
            .getByRole('button', { name: '保存为参考资料', exact: true })
            .click();
          const dialog = page.getByRole('dialog', {
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
          expect(await dialog.getByLabel('保存范围').inputValue()).toBe(
            'personal',
          );
          await dialog.getByLabel('保存范围').selectOption('company');
          await dialog
            .getByLabel('参考资料用途')
            .fill('Synthetic exact-version reference');
          const response = page.waitForResponse(
            (r) =>
              r.url().endsWith('/references/artifacts') &&
              r.request().method() === 'POST',
          );
          await dialog
            .getByRole('button', { name: '保存', exact: true })
            .click();
          const result = await response;
          expect(result.status()).toBe(201);
          const saved = await result.json();
          await dialog.getByRole('status').waitFor();
          await dialog
            .getByRole('button', { name: '完成', exact: true })
            .click();
          await expect.poll(() => dialog.count()).toBe(0);
          await processNextReference(f.storageRoot);
          await page
            .getByRole('button', { name: '查看参考资料', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'evidence.txt', exact: true })
            .click();
          await page
            .getByText('Isolated fixture, not a real model answer.', {
              exact: false,
            })
            .first()
            .waitFor();
          expect(
            await page
              .getByRole('dialog', { name: '参考资料', exact: true })
              .evaluate((dialog) => {
                const bounds = dialog.getBoundingClientRect();
                return [
                  ...dialog.querySelectorAll('fieldset,input,select'),
                ].every((control) => {
                  const box = control.getBoundingClientRect();
                  return box.left >= bounds.left && box.right <= bounds.right;
                });
              }),
          ).toBe(true);
          const download = await api(
            '/revisions/' +
              saved.revisionId +
              '/download?workspaceId=' +
              a.context.workspaceId,
            token,
          );
          expect(download.status).toBe(200);
          expect(
            'sha256:' +
              createHash('sha256')
                .update(Buffer.from(await download.arrayBuffer()))
                .digest('hex'),
          ).toBe(a.artifact.digest);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          await page
            .getByRole('button', { name: '保存为参考资料', exact: true })
            .click();
          await dialog.getByLabel('保存范围').selectOption('company');
          await dialog
            .getByRole('button', { name: '保存', exact: true })
            .click();
          await dialog.getByRole('status').waitFor();
          expect(
            (
              await f.db`select count(*)::int n from allrice_knowledge_revisions where source_artifact_version_id=${a.artifact.artifactId}`
            )[0]!.n,
          ).toBe(1);
        } finally {
          await c.close();
        }
      },
      30000,
    );
    it('uploads from the drawer, indexes without a model, preserves both versions and previews/downloads exact files', async () => {
      const page = await pageFor();
      await page.getByLabel('资料保存范围').selectOption('company');
      await page.getByLabel('上传参考文件').setInputFiles({
        name: '口径.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('已确认回款为 1000 元。'),
      });
      await page.getByRole('button', { name: '保存资料', exact: true }).click();
      await page
        .getByRole('button', { name: '口径.txt', exact: true })
        .waitFor();
      expect(await processNextReference(f.storageRoot)).toBe(true);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText('公司 · v1 · 处理完成', { exact: true }).waitFor();
      await page.getByRole('button', { name: '口径.txt', exact: true }).click();
      await page
        .getByText('已确认回款为 1000 元。', { exact: false })
        .first()
        .waitFor();
      const one = (await references()).find((r) => r.fileName === '口径.txt')!;
      const downloaded = await api(
        '/revisions/' +
          one.revisionId +
          '/download?workspaceId=' +
          reader.workspaceId,
        readerToken,
      );
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe('已确认回款为 1000 元。');
      await page.getByRole('button', { name: '更新文件', exact: true }).click();
      await page.getByLabel('上传参考文件').setInputFiles({
        name: '口径.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('已确认回款为 1200 元。'),
      });
      await page.getByRole('button', { name: '保存资料', exact: true }).click();
      await page
        .getByText('公司 · v2 · 已保存 · 等待处理', { exact: true })
        .waitFor();
      await processNextReference(f.storageRoot);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('button', { name: '口径.txt', exact: true }).click();
      await page.getByLabel('参考资料版本').selectOption(one.revisionId);
      await page
        .getByText('已确认回款为 1000 元。', { exact: false })
        .first()
        .waitFor();
      const history = await (
        await api(
          '?workspaceId=' + owner.workspaceId + '&sourceId=' + one.sourceId,
        )
      ).json();
      expect(
        history.references.map((r: ReferenceRevision) => r.revision),
      ).toEqual([2, 1]);
      expect(
        (
          await f.db`select count(*)::int n from allrice_runs where organization_id=${owner.organizationId}`
        )[0]!.n,
      ).toBe(0);
      await page.context().close();
    });
    it('keeps corrupt/empty/unsupported files out of the index and retries the original bytes and version', async () => {
      const bytes = Buffer.from('固定文件应校验后索引。'),
        saved = await postFile('重试.txt', bytes);
      const [object] =
        await f.db`select o.* from allrice_storage_objects o join allrice_knowledge_revisions r on r.file_object_id=o.id where r.id=${saved.revisionId}`;
      await writeFile(
        join(f.storageRoot, object!.object_key),
        Buffer.from('tampered'),
      );
      await processNextReference(f.storageRoot);
      expect(
        (await references()).find((r) => r.revisionId === saved.revisionId)
          ?.processing,
      ).toBe('failed');
      expect(
        (
          await f.db`select count(*)::int n from allrice_knowledge_documents where knowledge_revision_id=${saved.revisionId}`
        )[0]!.n,
      ).toBe(0);
      await writeFile(join(f.storageRoot, object!.object_key), bytes);
      const page = await pageFor();
      await page.getByRole('button', { name: '重试处理' }).click();
      await processNextReference(f.storageRoot);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      expect(
        (await references()).find((r) => r.revisionId === saved.revisionId)
          ?.processing,
      ).toBe('ready');
      expect(
        (await references()).find((r) => r.revisionId === saved.revisionId)
          ?.checksum,
      ).toBe('sha256:' + createHash('sha256').update(bytes).digest('hex'));
      const empty = await postFile('空白.txt', ' \n ');
      await processNextReference(f.storageRoot);
      expect(
        (await references()).find((r) => r.revisionId === empty.revisionId)
          ?.failure,
      ).toBe('资料没有可检索的文本');
      const binary = await postFile(
        '保存.bin',
        Buffer.from([0, 1, 2]),
        'application/octet-stream',
      );
      await processNextReference(f.storageRoot);
      expect(
        (await references()).find((r) => r.revisionId === binary.revisionId)
          ?.processing,
      ).toBe('unsupported');
      const file = await api(
        '/revisions/' +
          binary.revisionId +
          '/download?workspaceId=' +
          owner.workspaceId,
      );
      expect(Buffer.from(await file.arrayBuffer())).toEqual(
        Buffer.from([0, 1, 2]),
      );
      await page.context().close();
    });
    it('uses the same platform-admin upload and readonly employee view, including mobile layout', async () => {
      const page = await pageFor(adminToken);
      await page.getByRole('button', { name: '管理平台参考资料' }).click();
      expect(await page.getByLabel('资料保存范围').inputValue()).toBe(
        'platform',
      );
      await page.getByLabel('上传参考文件').setInputFiles({
        name: '平台准则.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('文件交付前核对单位与来源。'),
      });
      await page.getByRole('button', { name: '保存资料', exact: true }).click();
      await page.getByRole('button', { name: '平台准则.txt' }).waitFor();
      await processNextReference(f.storageRoot);
      const mobile = await pageFor(readerToken, 390);
      await mobile.getByRole('button', { name: '平台准则.txt' }).waitFor();
      expect(
        await mobile
          .getByRole('button', { name: '更新文件', exact: true })
          .count(),
      ).toBe(0);
      await mobile.getByRole('button', { name: '平台准则.txt' }).click();
      await mobile
        .getByText('文件交付前核对单位与来源。', { exact: false })
        .first()
        .waitFor();
      expect(
        await mobile.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        (await references(readerToken)).some((r) => r.fileName === '重试.txt'),
      ).toBe(false);
      const privateFile = (await references()).find(
        (r) => r.fileName === '重试.txt',
      )!;
      for (const tail of ['preview', 'download'])
        expect(
          (
            await api(
              '/revisions/' +
                privateFile.revisionId +
                '/' +
                tail +
                '?workspaceId=' +
                reader.workspaceId,
              readerToken,
            )
          ).status,
        ).toBe(404);
      await page.context().close();
      await mobile.context().close();
    });
    it('rechecks authorization after preview IO and rejects an already loaded version after login revocation', async () => {
      const file = (await references()).find((r) => r.fileName === '口径.txt')!;
      const storage = assistantFixtureStorage(f.db),
        original = storage.get.bind(storage);
      const read = vi
        .spyOn(storage, 'get')
        .mockImplementationOnce(async (object) => {
          const stream = await original(object);
          await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${reader.sessionId}`;
          return stream;
        });
      const response = await api(
        '/revisions/' +
          file.revisionId +
          '/preview?workspaceId=' +
          reader.workspaceId,
        readerToken,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('1200');
      read.mockRestore();
      expect(
        (
          await api(
            '/revisions/' +
              file.revisionId +
              '/download?workspaceId=' +
              reader.workspaceId,
            readerToken,
          )
        ).status,
      ).toBe(401);
    });
  },
);
