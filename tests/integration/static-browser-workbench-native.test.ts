import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../apps/worker/src/harness/browser-qa.fixture.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../packages/database/src/assistant-runtime.fixture.ts';
import { createLocalBrowserFixture } from '../../packages/database/src/local-browser.fixture.ts';
import { installBrowserControlGrant } from '../../packages/database/src/browser-control.ts';
import { publishWorkbenchArtifact } from '../../packages/database/src/artifact-review.ts';
import {
  getWorkAutomation,
  updateWorkAutomation,
} from '../../packages/database/src/work-automation.ts';
import { createSession } from '../../packages/database/src/identity.ts';
import * as client from '../../packages/database/src/core/client.ts';
import { runBrowserWorkspace } from '../../apps/worker/src/tool-broker/handlers/browser-workspace.ts';
import { nativeBrokerRoundtrip } from '../../apps/worker/src/harness/dsh-native-broker.fixture.ts';
import { parseArtifactDetail } from '../../apps/web/lib/chatflow/workbench-model.ts';
import type {
  BrowserVerificationOutcome,
  WorkbenchArtifact,
} from '@allrice/contracts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_STATIC_BROWSER_WORKBENCH === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'saved-page verification: real candidate Web HTTP, workbench and private downloads',
  () => {
    let db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      root: string;
    beforeAll(async () => {
      for (const key of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
      ])
        vi.stubEnv(key, '1');
      db = await createAssistantFixtureDatabase();
      root = await mkdtemp(join(tmpdir(), 'allrice-static-workbench-'));
      vi.spyOn(client, 'getDatabase').mockReturnValue(db.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await db?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });
    it('actual DSH verification -> immutable artifacts -> real authenticated API and UI -> exact browser downloads; old records and cross-account denial', async () => {
      const f = await createLocalBrowserFixture(db.db, root, {
        open: false,
        workbench: true,
        memberRole: 'member',
      });
      await db.db`update allrice_execution_targets set state='offline' where target_key=${'bridge.' + f.device.id}`;
      await installBrowserControlGrant(
        f.context,
        {
          targetId: f.target,
          ownerId: f.user,
          profile: { version: 1, network: 'public_https', origins: [] },
          enabled: true,
        },
        db.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      const automation = await getWorkAutomation(f.context, f.workspace, db.db);
      await updateWorkAutomation(
        f.context,
        f.workspace,
        {
          expectedRevision: automation.revision,
          capability: 'cloud',
          enabled: true,
        },
        db.db,
      );
      const html = `<!doctype html><meta charset="utf-8"><title>Known bug verified</title><button onclick="document.querySelector('output').textContent=20+22">Compute</button><output>0</output>`;
      const source = await publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.session,
          callId: randomUUID(),
          kind: 'document',
          fileName: 'index.html',
          format: 'html',
          mediaType: 'text/html',
          bytes: Buffer.from(html),
        },
        f.storage,
        db.db,
      );
      const [job] = await db.db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
      let delivery:
        | {
            verification: BrowserVerificationOutcome;
            artifacts: WorkbenchArtifact[];
          }
        | undefined;
      const args = {
        command: 'verify',
        artifact: { versionId: source.id, checksum: source.object.checksum },
        location: 'auto',
        plan: {
          version: 1,
          timeoutMs: 30000,
          steps: [
            { type: 'click', selector: { tag: 'button', label: 'Compute' } },
            { type: 'text_contains', expected: '42' },
          ],
        },
      };
      await nativeBrokerRoundtrip({
        canonicalName: 'browser.workspace',
        wireName: 'browser_workspace',
        args,
        invalidArgs: { ...args, url: 'https://example.com' },
        timeoutMs: 120000,
        onToolCall: async (call) => {
          const result = await runBrowserWorkspace({
            input: {
              context: f.execution,
              capabilities: [
                'storage:read',
                'storage:write',
                'network:outbound',
              ],
              storageRoot: root,
              sessionId: f.session,
              call,
              managedBrowserJobAttempt: job!.attempt,
              managedBrowserJobLeaseToken: job!.lease_token,
            },
            arguments: call.arguments,
          });
          delivery = JSON.parse(result.modelContent);
          return result;
        },
      });
      assert.equal(delivery?.verification.report.verdict, 'passed');
      const stranger = await createLocalBrowserFixture(db.db, root, {
        open: false,
        workbench: true,
        memberRole: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      const login = await createSession(f.user),
        foreign = await createSession(stranger.user);
      const [schemaRow] = await db.db<
        { schema: string }[]
      >`select current_schema() as schema`;
      const dbUrl = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      dbUrl.searchParams.set(
        'options',
        '-csearch_path=' + schemaRow!.schema + ',public',
      );
      const portServer = createServer();
      await new Promise<void>((r) => portServer.listen(0, '127.0.0.1', r));
      const address = portServer.address();
      assert.ok(address && typeof address !== 'string');
      const port = address.port;
      await new Promise<void>((r) => portServer.close(() => r()));
      const origin = 'http://127.0.0.1:' + port,
        logPath = join(root, 'web.log'),
        fd = openSync(logPath, 'wx', 0o600);
      const web = spawn(
        process.execPath,
        [
          'server.mjs',
          '--dev',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        {
          cwd: join(process.cwd(), 'apps/web'),
          env: {
            ...process.env,
            DATABASE_URL: dbUrl.toString(),
            ALLRICE_STORAGE_ROOT: root,
            ALLRICE_PLATFORM_ADMIN_EMAILS: '',
            ALLRICE_PORTAL_AUTH_ENABLED: '0',
            ALLRICE_SERVICE_ROLE: 'web',
          },
          stdio: ['ignore', fd, fd],
        },
      );
      closeSync(fd);
      const browser = await chromium.launch({
        headless: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
        serviceWorkers: 'block',
      });
      await context.addCookies([
        { name: 'allrice_session', value: login.token, url: origin },
      ]);
      const foreignContext = await browser.newContext();
      await foreignContext.addCookies([
        { name: 'allrice_session', value: foreign.token, url: origin },
      ]);
      const page = await context.newPage(),
        errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const detail = (id: string, workspace = f.workspace) =>
        `${origin}/api/v1/sessions/${f.session}/artifacts/${id}?workspaceId=${workspace}`;
      const evidence = process.env.ALLRICE_STATIC_BROWSER_EVIDENCE;
      try {
        const deadline = Date.now() + 90000;
        let ready = false;
        while (Date.now() < deadline) {
          if (web.exitCode !== null) throw Error('candidate_web_exited');
          try {
            const r = await fetch(origin + '/api/health/ready', {
              signal: AbortSignal.timeout(1500),
            });
            if (r.status === 200) {
              ready = true;
              break;
            }
          } catch {
            /* Candidate startup has a bounded readiness deadline. */
          }
          await delay(500);
        }
        assert.ok(ready, 'candidate Web readiness');
        const checks = [];
        for (const artifact of delivery!.artifacts) {
          const response = await context.request.get(detail(artifact.id));
          assert.equal(response.status(), 200);
          const parsed = parseArtifactDetail(await response.json());
          assert.equal(
            parsed.browserVerification?.outcome.report.verdict,
            'passed',
          );
          const denied = await foreignContext.request.get(
            detail(artifact.id, stranger.workspace),
          );
          assert.ok([403, 404].includes(denied.status()));
          checks.push({
            artifactId: artifact.id,
            detailStatus: 200,
            crossAccountStatus: denied.status(),
          });
        }
        const legacy = await context.request.get(detail(source.id));
        assert.equal(legacy.status(), 200);
        assert.equal(
          parseArtifactDetail(await legacy.json()).browserVerification,
          null,
        );
        await page.goto(origin + '/chatflow?session=' + f.session, {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        });
        const panel = page.getByRole('complementary', {
          name: '交付成果',
          exact: true,
        });
        if (!(await panel.isVisible()))
          await page
            .getByRole('button', { name: /交付成果/ })
            .first()
            .click();
        const downloads = [];
        for (const artifact of delivery!.artifacts) {
          const menu = panel.getByRole('button', {
            name: '更多文件操作',
            exact: true,
          });
          const fileButton = panel.getByRole('button', {
            name: '侧栏预览 ' + artifact.version.fileName,
            exact: true,
          });
          await menu.or(fileButton).first().waitFor({ timeout: 30000 });
          if (await menu.isVisible()) {
            await menu.click();
            await page
              .getByRole('menuitem', { name: '查看所有成果', exact: true })
              .click();
          }
          await panel
            .getByRole('button', {
              name: '侧栏预览 ' + artifact.version.fileName,
              exact: true,
            })
            .click();
          const verification = panel.getByRole('region', {
            name: '页面验证',
            exact: true,
          });
          await verification.waitFor({ timeout: 30000 });
          assert.ok(
            (await verification.innerText()).includes('页面验证：通过'),
          );
          assert.ok((await verification.innerText()).includes('浏览器已停止'));
          const link = panel.getByRole('link', { name: '下载', exact: true });
          await link.waitFor({ timeout: 30000 });
          const pending = page.waitForEvent('download');
          await link.click();
          const download = await pending;
          assert.equal(await download.failure(), null);
          const file = await download.path();
          assert.ok(file);
          const bytes = await readFile(file);
          assert.equal(
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
            artifact.object.checksum,
          );
          const denied = await foreignContext.request.get(
            `${origin}/api/v1/files/${artifact.object.id}/download?workspaceId=${stranger.workspace}`,
          );
          assert.ok([403, 404].includes(denied.status()));
          downloads.push({
            artifactId: artifact.id,
            sizeBytes: bytes.length,
            checksum: artifact.object.checksum,
            crossAccountStatus: denied.status(),
          });
        }
        expect(errors).toEqual([]);
        if (evidence) {
          await page.screenshot({
            path: join(evidence, 'pr4b-workbench-native.png'),
            fullPage: true,
          });
          await writeFile(
            join(evidence, 'pr4b-workbench-native.json'),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                verification: delivery!.verification,
                checks,
                downloads,
                legacyCompatible: true,
                actualUI: true,
                newModelTasks: 0,
                errors,
              },
              null,
              2,
            ),
          );
        }
      } catch (error) {
        if (evidence) {
          await page
            .screenshot({
              path: join(evidence, 'pr4b-workbench-failure.png'),
              fullPage: true,
            })
            .catch(() => {});
          await writeFile(
            join(evidence, 'pr4b-workbench-failure.txt'),
            await page.locator('body').innerText(),
          );
          await writeFile(
            join(evidence, 'pr4b-workbench-failure-web.log'),
            await readFile(logPath),
          );
        }
        throw error;
      } finally {
        await browser.close();
        web.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((r) => web.once('close', () => r())),
          delay(10000).then(() => {
            web.kill('SIGKILL');
          }),
        ]);
      }
    }, 240000);
  },
);
