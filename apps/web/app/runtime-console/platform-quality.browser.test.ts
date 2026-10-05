import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QualityCheckReportSchema,
  type QualityCheck,
  type QualityScheduleView,
} from '@allrice/database/technical-contracts';
import type {
  Route,
  Response,
} from '../../../worker/node_modules/playwright-core/index.js';
import type { ProjectServiceView } from '@allrice/contracts';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite(
  'fixed quality UI: lost write acknowledgement and no fabricated pass',
  () => {
    it('reconciles the original request after a lost acknowledgement; missing evidence remains unknown', async () => {
      const require = createRequire(import.meta.url),
        { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        entryPoints: ['apps/web/test/platform-quality-page.tsx'],
        bundle: true,
        write: false,
        outdir: '/unused-quality',
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      const server = createServer((req, res) => {
        const file = req.url === '/app.css' ? '.css' : '.js';
        if (req.url === '/app.css' || req.url === '/app.js') {
          res.setHeader(
            'content-type',
            file === '.css' ? 'text/css' : 'text/javascript',
          );
          res.end(
            built.outputFiles?.find((f: { path: string; text: string }) =>
              f.path.endsWith(file),
            )?.text ?? '',
          );
        } else {
          res.setHeader('content-type', 'text/html');
          res.end(
            '<div id="root"></div><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>',
          );
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { chromium } = createRequire(resolve('apps/worker/package.json'))(
        'playwright-core',
      );
      const browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      });
      const rows: QualityCheck[] = [],
        posts: string[] = [];
      const services = new Map<string, ProjectServiceView>();
      const history = new Map<string, QualityCheck>();
      let scheduleView: QualityScheduleView = {
        schedule: null,
        occurrences: [],
      };
      const scheduleWrites: Record<string, unknown>[] = [];
      let slowId = '',
        holdId = '',
        releaseOldService: (() => void) | undefined;
      try {
        const page = await browser.newPage(),
          errors: string[] = [];
        page.on('pageerror', (e: Error) => errors.push(e.message));
        await page.route(
          '**/api/v1/admin/technical-assistant/quality**',
          async (route: Route) => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith('/quality/schedule')) {
              if (route.request().method() === 'GET')
                return route.fulfill({ json: scheduleView });
              const input = route.request().postDataJSON();
              scheduleWrites.push(input);
              if (
                input.expectedRevision !==
                (scheduleView.schedule?.revision ?? 0)
              )
                return route.fulfill({ status: 409 });
              if (route.request().method() === 'DELETE')
                scheduleView = { ...scheduleView, schedule: null };
              else
                scheduleView = {
                  ...scheduleView,
                  schedule: {
                    id: scheduleView.schedule?.id ?? randomUUID(),
                    revision: (scheduleView.schedule?.revision ?? 0) + 1,
                    enabled: input.enabled,
                    time: input.time,
                    timezone: 'Asia/Shanghai',
                    nextRunAt: input.enabled
                      ? new Date(Date.now() + 60000).toISOString()
                      : null,
                  },
                };
              // The first successful enable loses its HTTP acknowledgement.
              return scheduleWrites.length === 1
                ? route.abort('failed')
                : route.fulfill({ json: scheduleView });
            }
            const serviceId = new URL(route.request().url()).pathname.match(
              /\/quality\/([^/]+)\/service$/,
            )?.[1];
            if (serviceId) {
              const service = services.get(serviceId);
              if (slowId === serviceId)
                await new Promise((done) => setTimeout(done, 3500));
              if (!service) return route.fulfill({ status: 404, json: {} });
              if (holdId === serviceId)
                await new Promise<void>((done) => {
                  releaseOldService = done;
                });
              return route.fulfill({ json: { service } });
            }
            if (route.request().method() === 'POST') {
              const request = route.request().postDataJSON();
              posts.push(request.requestId);
              rows.push({
                id: randomUUID(),
                requestId: request.requestId,
                runId: randomUUID(),
                jobId: randomUUID(),
                sessionId: randomUUID(),
                caseId: request.caseId,
                variant: request.variant,
                status: 'running',
                environment: 'test',
                releaseSha: 'a'.repeat(40),
                fixtureDigest: 'sha256:' + 'a'.repeat(64),
                assertionDigest: 'sha256:' + 'b'.repeat(64),
                runnerDigest: 'sha256:' + 'c'.repeat(64),
                fingerprint: 'sha256:' + 'd'.repeat(64),
                employeeVersionId: randomUUID(),
                employeeRevisionId: randomUUID(),
                modelUsed: false,
                accepted: false,
                createdAt: new Date().toISOString(),
                report: null,
              });
              return route.abort('failed');
            }
            const detailId = path.match(/\/quality\/([^/]+)$/)?.[1];
            if (detailId) {
              const q =
                history.get(detailId) ?? rows.find((q) => q.id === detailId);
              return route.fulfill({ status: q ? 200 : 404, json: q ?? {} });
            }
            return route.fulfill({ json: rows });
          },
        );
        await page.goto(
          `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        );
        const daily = page.getByRole('region', { name: '每日固定场景质检' });
        await expect
          .poll(() =>
            daily.getByRole('button', { name: '开启每日质检' }).isEnabled(),
          )
          .toBe(true);
        await daily.getByLabel('每日检查时间').fill('09:10');
        await daily.getByRole('button', { name: '开启每日质检' }).click();
        await daily.getByText('已开启', { exact: true }).waitFor();
        expect(scheduleWrites).toEqual([
          { expectedRevision: 0, enabled: true, time: '09:10' },
        ]);
        await daily.getByRole('button', { name: '暂停每日质检' }).click();
        await expect
          .poll(() =>
            daily.getByRole('button', { name: '暂停每日质检' }).isDisabled(),
          )
          .toBe(true);
        expect(scheduleView.schedule!.nextRunAt).toBeNull();
        await daily.getByRole('button', { name: '移除每日规则' }).click();
        await daily.getByRole('button', { name: '开启每日质检' }).waitFor();
        expect(scheduleWrites).toHaveLength(3);
        await page
          .getByRole('button', { name: '检查错误样例', exact: true })
          .click();
        const detail = page.getByRole('article', { name: '质检详情' });
        await detail.getByText('等待实际构建与断言证据。').waitFor();
        expect(posts).toHaveLength(1);
        expect(
          await page
            .getByRole('button', { name: '检查修正样例', exact: true })
            .isDisabled(),
        ).toBe(true);
        rows[0]!.status = 'failed';
        await page.getByRole('button', { name: '刷新质检记录' }).click();
        await detail
          .getByText('检查已结束，但证据不完整，不能判定通过。')
          .waitFor();
        expect(await page.getByText('质检通过', { exact: true }).count()).toBe(
          0,
        );
        expect(posts).toHaveLength(1);
        expect(errors).toEqual([]);
        // Synthetic complete observations test rendering only; they are not
        // physical proof. Canonical cancellation/failure must remain authoritative.
        const checksum = 'sha256:' + 'a'.repeat(64),
          now = new Date().toISOString(),
          operationId = randomUUID(),
          observationId = randomUUID();
        const artifacts = (['source', 'page', 'screenshot'] as const).map(
          (kind) => {
            const versionId = randomUUID();
            return {
              artifactId: versionId,
              versionId,
              objectId: randomUUID(),
              checksum,
              fileName: kind + '.bin',
              sizeBytes: 1,
              kind,
              storedBytesVerified: true as const,
            };
          },
        );
        const target = {
          versionId: artifacts[1]!.versionId,
          objectId: artifacts[1]!.objectId,
          checksum,
          version: 1,
          mediaType: 'text/html',
          sizeBytes: 1,
          fileName: 'page.html',
          sourceOperationId: operationId,
          sourceSessionId: rows[0]!.sessionId,
        };
        rows[0]!.report = QualityCheckReportSchema.parse({
          version: 1,
          verdict: 'passed',
          completedAt: now,
          project: {
            projectId: randomUUID(),
            snapshot: { kind: 'artifact', id: randomUUID(), checksum },
          },
          build: {
            operationId,
            location: 'cloud',
            targetId: randomUUID(),
            exitCode: 0,
            command: 'node build.mjs',
          },
          artifacts,
          browser: {
            version: 1,
            verificationId: randomUUID(),
            report: {
              version: 1,
              target,
              planDigest: checksum,
              startedAt: now,
              completedAt: now,
              verdict: 'passed',
              steps: [
                {
                  index: 0,
                  type: 'text_contains',
                  status: 'passed',
                  observationId,
                  pageDigest: checksum,
                  expected: '结果：2',
                  actual: '结果：2',
                  errorCode: null,
                },
              ],
              errorCode: null,
            },
            plan: {
              version: 1,
              timeoutMs: 15000,
              steps: [{ type: 'text_contains', expected: '结果：2' }],
            },
            location: 'cloud',
            executionReason: 'synthetic_ui',
            targetId: randomUUID(),
            deviceId: null,
            attemptId: randomUUID(),
            containerId: 'a'.repeat(64),
            imageDigest: checksum,
            browserVersion: 'synthetic',
            physicalStopConfirmed: true,
            screenshotChecksum: checksum,
            screenshotObjectId: null,
            screenshotObservationId: observationId,
          },
          errorCode: null,
          cleanup: 'confirmed',
        });
        for (const status of ['running', 'canceled', 'failed'] as const) {
          rows[0]!.status = status;
          rows[0]!.accepted = false;
          await page.getByRole('button', { name: '刷新质检记录' }).click();
          await detail
            .getByRole('heading', {
              name:
                status === 'running'
                  ? '检查中'
                  : status === 'canceled'
                    ? '已停止'
                    : '未完成',
              exact: true,
            })
            .waitFor();
          expect(
            await page.getByText('质检通过', { exact: true }).count(),
          ).toBe(0);
          expect(await detail.getByRole('link').count()).toBe(3);
        }
        rows[0]!.status = 'succeeded';
        rows[0]!.accepted = true;
        await page.getByRole('button', { name: '刷新质检记录' }).click();
        await detail
          .getByRole('heading', { name: '质检通过', exact: true })
          .waitFor();
        // A delayed service response for a previous check must never appear
        // beneath the new check's controls. These are UI fixtures, not QA proof.
        const liveRows = ['A', 'B'].map(() => ({
          ...rows[0]!,
          id: randomUUID(),
          requestId: randomUUID(),
          runId: randomUUID(),
          caseId: 'project.live.v1' as const,
          variant: 'correct' as const,
          status: 'succeeded' as const,
          accepted: false,
          report: null,
        }));
        for (const [index, row] of liveRows.entries()) {
          services.set(row.id, {
            version: 1,
            id: randomUUID(),
            runId: row.runId,
            sessionId: row.sessionId,
            backend: 'cloud',
            state: index === 0 ? 'ready' : 'stopped',
            project: {
              projectId: randomUUID(),
              snapshot: { kind: 'artifact', id: randomUUID(), checksum },
            },
            sourceDigest: checksum,
            expiresAt: now,
            hardDeadlineAt: now,
            lastSeenAt: now,
            stopRequested: index === 1,
            stopped: index === 1,
            updatePending: false,
            canRenew: index === 0,
          });
        }
        rows.push(...liveRows);
        holdId = liveRows[0]!.id;
        slowId = liveRows[1]!.id;
        await page.getByRole('button', { name: '刷新质检记录' }).click();
        await page.getByRole('button', { name: '查看质检详情' }).nth(1).click();
        for (let i = 0; !releaseOldService && i < 50; i++)
          await new Promise((done) => setTimeout(done, 20));
        expect(releaseOldService).toBeTypeOf('function');
        await page.getByRole('button', { name: '查看质检详情' }).nth(2).click();
        const liveCard = detail.getByRole('region', { name: '项目实时预览' });
        await liveCard
          .getByRole('status')
          .getByText(/已停止/)
          .waitFor();
        const oldResponse = page.waitForResponse((r: Response) =>
          r.url().endsWith(`/${holdId}/service`),
        );
        releaseOldService!();
        await oldResponse;
        expect(
          await liveCard.getByRole('button', { name: '停止预览' }).isDisabled(),
        ).toBe(true);
        expect(await liveCard.getByRole('status').textContent()).toContain(
          '已停止',
        );
        const historic = rows.shift()!;
        history.set(historic.id, historic);
        scheduleView = {
          schedule: null,
          occurrences: [
            {
              id: randomUUID(),
              scheduledFor: now,
              status: historic.status,
              checkId: historic.id,
              accepted: historic.accepted,
              verdict: historic.report?.verdict ?? null,
              notExecutedReason: null,
            },
          ],
        };
        await daily.getByRole('button', { name: '刷新每日质检' }).click();
        await daily.getByRole('button', { name: '查看本轮质检' }).click();
        await detail
          .getByText(new RegExp(`版本 ${historic.releaseSha.slice(0, 10)}`))
          .waitFor();
        expect(
          await detail.getByRole('region', { name: '项目实时预览' }).count(),
        ).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }, 60000);
  },
);
