/** Same persisted facts across production Worker, chat, workbench, company and
 * recommendations. Only the model and explicitly named fault boundaries are
 * synthetic; no paid models, tenant database or Bridge devices are contacted. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { officeMediaTypes, type RequestContext } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import { createP27CodexWorkerFixture } from '../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createChatSession,
  getChatSessionHistory,
  sendChatMessage,
} from '../../packages/database/src/workspace/service.ts';
import { claimNextJob } from '../../packages/database/src/execution/queue.ts';
import { listWorkbenchArtifacts } from '../../packages/database/src/artifact-review.ts';
import { listCompanyDeliverables } from '../../packages/database/src/company-deliverables.ts';
import { readOrganizationDashboard } from '../../packages/database/src/organization-dashboard.ts';
import { readTaskNextSteps } from '../../packages/database/src/task-next-steps.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../../packages/database/src/identity.ts';
import { DshHarnessAdapter } from '../../apps/worker/src/harness/dsh-adapter.ts';
import { DshRuntimePool } from '../../apps/worker/src/harness/dsh/runtime-pool.ts';
import { executeEmployeeRun } from '../../apps/worker/src/jobs/employee-run.ts';
import { runClaimedJob } from '../../apps/worker/src/job-runner.ts';
import { generateDeliverable } from '../../apps/worker/src/deliverable-generator.ts';
import * as nativeOffice from '../../apps/worker/src/office/native.ts';
import * as officeQuality from '../../apps/worker/src/office/quality.ts';
import * as officePreview from '../../packages/office-runtime/src/preview.ts';
import { artifactHttp } from '../../apps/web/lib/runtime/artifact-http.ts';
import { GET as downloadFile } from '../../apps/web/app/api/v1/files/[id]/download/route.ts';
import { verifyDeliveryBrowser } from './delivery-facts-browser.fixture.ts';

const ports = vi.hoisted(() => ({
  context: null as RequestContext | null,
  storage: null as LocalStorageAdapter | null,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getCodexProviderStatus: async () => ({ status: 'connected' }),
}));
vi.mock('../../apps/web/lib/identity/session.ts', () => ({
  getRequestContext: async () => ports.context,
}));
vi.mock('../../apps/web/lib/storage/runtime.ts', () => ({
  getStorageAdapter: () => ports.storage,
}));

const cases = [
  {
    id: 'unpublished',
    title: 'generated output is not a formal delivery after publication fails',
    state: 'failed',
    deliveries: 0,
    failures: 1,
  },
  {
    id: 'partial',
    title: 'one available file does not make two-file work complete',
    state: 'failed',
    deliveries: 1,
    failures: 1,
  },
  {
    id: 'repaired',
    title: 'same-file repair succeeds without hiding the earlier denied audit',
    state: 'succeeded',
    deliveries: 1,
    failures: 1,
  },
  {
    id: 'answer',
    title:
      'a later answer succeeds without counting or recommending the earlier file',
    state: 'succeeded',
    deliveries: 0,
    failures: 0,
  },
  {
    id: 'required-quality',
    title: 'required but unavailable Office quality blocks formal publication',
    state: 'failed',
    deliveries: 0,
    failures: 1,
  },
  {
    id: 'preview',
    title:
      'pending and failed conversion retain the exact downloadable original',
    state: 'succeeded',
    deliveries: 1,
    failures: 0,
  },
] as const;
type Case = (typeof cases)[number];
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET167 joined delivery facts (isolated ordinary employee)', () => {
  beforeEach(() => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    vi.spyOn(DshRuntimePool.prototype, 'acquire').mockRejectedValue(
      Error('PAID_OR_NATIVE_MODEL_FORBIDDEN'),
    );
    vi.spyOn(DshHarnessAdapter.prototype, 'isConfigured').mockReturnValue(true);
  });
  afterEach(() => {
    ports.context = null;
    ports.storage = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  for (const sample of cases)
    it(`delivery.facts.v1: ${sample.title}`, async () => verify(sample), 60000);

  async function verify(sample: Case) {
    const root = await mkdtemp(join(tmpdir(), 'allrice-delivery-facts-'));
    const f = await createP27CodexWorkerFixture({
      allowCiDatabase: true,
      imageGeneration: true,
    });
    try {
      await f.db`update allrice_memberships set role='member' where user_id=${f.ownerId}`;
      const owner: RequestContext = {
        ...f.context,
        memberships: f.context.memberships.map((m) => ({
          ...m,
          role: 'member',
        })),
      };
      const principal = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'allrice-platform',
          organizationName: 'Private platform',
          workspaceSlug: 'default',
          workspaceName: 'Private',
          email: `delivery-admin-${randomUUID()}@example.test`,
          displayName: 'Isolated platform admin',
          role: 'member',
        },
        f.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      const admin = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
      expect(admin.actor.id).not.toBe(owner.actor.id);
      vi.stubEnv('ALLRICE_STORAGE_ROOT', join(root, 'storage'));
      ports.storage = new LocalStorageAdapter(join(root, 'storage'));
      ports.context = owner;
      const session = await createChatSession(owner, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: `Fixed facts: ${sample.id}`,
      });
      let puts = 0,
        caught = 0,
        turn = 0;
      const originalPut = LocalStorageAdapter.prototype.put;
      vi.spyOn(LocalStorageAdapter.prototype, 'put').mockImplementation(
        async function (this: LocalStorageAdapter, object, stream) {
          puts++;
          // A fault before put acknowledges anything; production rollback and
          // formal metadata readers determine the result, not the model's prose.
          if (
            (sample.id === 'unpublished' && puts === 1) ||
            (sample.id === 'partial' && puts === 2) ||
            (sample.id === 'repaired' && puts === 1)
          )
            throw Error('FIXED_STORAGE_BEFORE_WRITE');
          return originalPut.call(this, object, stream);
        },
      );
      if (sample.id === 'required-quality' || sample.id === 'preview') {
        const generated = await generateDeliverable({
          format: 'docx',
          content: 'Fixed protocol document',
        });
        vi.spyOn(nativeOffice, 'generateNativeOfficeExport').mockResolvedValue({
          ...generated,
          bytes: Buffer.from(generated.bytes),
          mediaType: officeMediaTypes.docx,
          sourceFile: undefined,
          warnings: undefined,
          changes: undefined,
          cloudQualityAllowed: true,
          nativeExecution: {
            status: 'checked',
            upstream: '@deepseek-ai/dsh-skill-office@0.1.7-alpha.2',
            output:
              'Synthetic generator boundary; not a physical Office execution.',
            executionLocation: 'cloud',
            executionReason: 'fixed_protocol_boundary',
          },
        });
        vi.spyOn(officeQuality, 'checkOfficeExport').mockResolvedValue({
          bytes: generated.bytes,
          quality: {
            status: 'unavailable',
            reason: 'Fixed unavailable renderer',
          },
          warnings: ['Fixed unavailable renderer'],
        });
      }
      vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
        async (input) => {
          turn++;
          await input.onThreadBound?.({
            threadId: 'fixed-delivery-facts',
            resumed: turn > 1,
            replacedThreadId: null,
          });
          await input.onTurnStarted?.({
            threadId: 'fixed-delivery-facts',
            turnId: `facts-${turn}`,
          });
          const textCall = (id: string, fileName: string) => ({
            id,
            name: 'workspace.export.create',
            arguments: {
              fileName,
              format: 'text',
              content: `Fixed actual original ${fileName}`,
            },
          });
          const calls =
            sample.id === 'answer' && turn > 1
              ? []
              : sample.id === 'partial'
                ? [textCall('a', 'a.txt'), textCall('b', 'b.txt')]
                : sample.id === 'repaired'
                  ? [
                      textCall('bad', 'repaired.txt'),
                      textCall('fixed', 'repaired.txt'),
                    ]
                  : sample.id === 'required-quality' || sample.id === 'preview'
                    ? [
                        {
                          id: 'office',
                          name: 'workspace.export.create',
                          arguments: {
                            fileName: 'protocol.docx',
                            format: 'docx',
                            location: 'cloud',
                            python: {
                              script: '# fixed synthetic generation boundary',
                              inputs: [],
                            },
                          },
                        },
                      ]
                    : [textCall('original', 'original.txt')];
          for (const call of calls) {
            expect(input.tools.map((t) => t.name)).toContain(call.name);
            try {
              await input.onToolCall!(call);
            } catch {
              caught++;
            }
          }
          // An optimistic fixed answer must not override export/quality failures.
          return {
            answer: `Fixed reply ${turn}`,
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
            usageComplete: true,
            cacheUsageKnown: true,
            threadId: 'fixed-delivery-facts',
            turnId: `facts-${turn}`,
          };
        },
      );
      async function execute(text: string) {
        const sent = await sendChatMessage(owner, f.workspaceId, session.id, {
          clientMessageId: randomUUID(),
          text,
          deliveryMode: 'follow_up',
        });
        const workerId = randomUUID(),
          job = await claimNextJob(workerId, 30000);
        const [expected] =
          await f.db`select id from allrice_jobs where run_id=${sent.run.id}`;
        expect(job?.id).toBe(expected!.id);
        await runClaimedJob(
          {
            workerId,
            jobId: job!.id,
            leaseToken: job!.lease!.token,
            leaseMs: 30000,
            heartbeatMs: 1000,
            executionRoot: join(root, 'execution'),
            stopping: () => false,
            onAbortReady: () => {},
          },
          executeEmployeeRun,
        );
        return sent.run.id;
      }
      if (sample.id === 'answer')
        await execute('Create the earlier fixed file');
      const runId = await execute(
        sample.id === 'required-quality'
          ? '必须渲染页面预览后才能交付 Word。'
          : sample.id === 'answer'
            ? 'Answer this question without creating files'
            : 'Deliver the fixed requested files',
      );
      expect(caught).toBe(sample.failures);
      const [formal] =
        await f.db`select r.state,j.status job_status,m.status message_status,m.error_code,m.content from allrice_runs r join allrice_jobs j on j.run_id=r.id join allrice_employee_runs e on e.run_id=r.id join allrice_messages m on m.id=e.assistant_message_id where r.id=${runId}`;
      expect(formal).toMatchObject({
        state: sample.state,
        job_status: sample.state,
        message_status: sample.state === 'succeeded' ? 'completed' : 'failed',
      });
      const history = await getChatSessionHistory(
        owner,
        f.workspaceId,
        session.id,
      );
      expect(
        history.messages.filter((m) => m.role === 'assistant').at(-1)?.status,
      ).toBe(formal!.message_status);
      const { artifacts } = await listWorkbenchArtifacts(owner, session.id);
      const current = artifacts.filter((a) => a.provenance.runId === runId);
      expect(current).toHaveLength(sample.deliveries);
      if (sample.id === 'answer') expect(artifacts).toHaveLength(1);
      const company = await listCompanyDeliverables(admin, f.organizationId);
      expect(
        company.deliverables.filter((a) => a.runId === runId),
      ).toHaveLength(sample.deliveries);
      for (const artifact of current) {
        const delivery = company.deliverables.find(
          (d) => d.id === artifact.version.id,
        )!;
        expect(delivery).toMatchObject({
          runId,
          runStatus: sample.state,
          state: 'ready',
          seriesId: artifact.version.seriesId,
          version: artifact.version.version,
        });
        const http = await artifactHttp(
          new Request('http://localhost/detail'),
          'detail',
          session.id,
          artifact.id,
        );
        expect(http.status).toBe(200);
        const download = await downloadFile(
          new Request('http://localhost/download'),
          { params: Promise.resolve({ id: artifact.object.id }) },
        );
        expect(download.status).toBe(200);
        const bytes = Buffer.from(await download.arrayBuffer());
        expect(
          'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        ).toBe(artifact.object.checksum);
        expect(bytes.length).toBe(artifact.object.sizeBytes);
      }
      const next = await readTaskNextSteps(
        owner,
        {
          workspaceId: f.workspaceId,
          sessionId: session.id,
          employeeAssignmentId: f.assignmentId,
          employeeVersionId: f.employeeVersionId,
        },
        f.db,
      );
      expect(next.scope).toMatchObject({
        organizationId: f.organizationId,
        viewerId: f.ownerId,
        sessionId: session.id,
        sourceRunId: runId,
      });
      expect(next.state).toBe(sample.state);
      const references = next.suggestions.flatMap((s) => s.references);
      for (const ref of references)
        expect(
          current.some(
            (a) =>
              a.version.id === ref.versionId &&
              a.object.id === ref.objectId &&
              a.object.checksum === ref.checksum,
          ),
        ).toBe(true);
      if (!sample.deliveries) expect(references).toHaveLength(0);
      if (sample.id === 'partial') expect(next.notice).toContain('未全部完成');
      if (sample.id === 'repaired') {
        const denied =
          await f.db`select 1 from allrice_audit_events where action='tool.execute' and decision='denied' and metadata->>'runId'=${runId}`;
        expect(denied.length).toBeGreaterThan(0);
        expect(
          next.suggestions.every((s) => !s.task.id.startsWith('prepare-')),
        ).toBe(true);
      }
      const dashboard = await readOrganizationDashboard(
        admin,
        f.organizationId,
      );
      expect(dashboard.work).toMatchObject({
        started: turn,
        completed: sample.state === 'succeeded' ? turn : 0,
        failed: sample.state === 'failed' ? 1 : 0,
        canceled: 0,
        current: { running: 0, waiting: 0, queued: 0 },
      });
      expect(dashboard.deliverables.availableSeries).toBe(artifacts.length);
      async function browser(releasePreview?: () => void) {
        if (process.env.ALLRICE_RUN_BROWSER_INTEGRATION !== '1') return;
        await verifyDeliveryBrowser({
          sessionId: session.id,
          workspaceId: f.workspaceId,
          organizationId: f.organizationId,
          artifact: current[0]!,
          failed: sample.state === 'failed',
          failureText: history.messages.find(
            (m) => m.runId === runId && m.role === 'assistant',
          )?.content.text,
          releasePreview,
          http: async (request) => {
            const url = new URL(request.url);
            if (url.pathname === '/fixture/facts')
              return Response.json({
                messages: (
                  await getChatSessionHistory(owner, f.workspaceId, session.id)
                ).messages,
                next: await readTaskNextSteps(
                  owner,
                  {
                    workspaceId: f.workspaceId,
                    sessionId: session.id,
                    employeeAssignmentId: f.assignmentId,
                    employeeVersionId: f.employeeVersionId,
                  },
                  f.db,
                ),
              });
            const match = url.pathname.match(
              /^\/api\/v1\/sessions\/([^/]+)\/artifacts(?:\/([^/]+)(?:\/(content))?)?$/,
            );
            if (match)
              return artifactHttp(
                request,
                match[3] ? 'content' : match[2] ? 'detail' : 'list',
                match[1]!,
                match[2],
              );
            const file = url.pathname.match(
              /^\/api\/v1\/files\/([^/]+)\/download$/,
            );
            if (file)
              return downloadFile(request, {
                params: Promise.resolve({ id: file[1]! }),
              });
            return new Response(null, { status: 404 });
          },
        });
      }
      if (sample.id === 'partial') await browser();
      if (sample.id === 'preview') {
        const artifact = current[0]!;
        let rejectConversion!: (error: Error) => void;
        const conversion = new Promise<never>((_, reject) => {
          rejectConversion = reject;
        });
        const renderer = vi
          .spyOn(officePreview, 'previewOfficePdf')
          .mockReturnValue(conversion);
        const preview = artifactHttp(
          new Request('http://localhost/preview'),
          'content',
          session.id,
          artifact.id,
        );
        await expect.poll(() => renderer.mock.calls.length).toBe(1);
        expect(
          (
            await downloadFile(
              new Request('http://localhost/download-while-pending'),
              { params: Promise.resolve({ id: artifact.object.id }) },
            )
          ).status,
        ).toBe(200);
        await browser(() =>
          rejectConversion(Error('FIXED_PREVIEW_TEMPORARILY_UNAVAILABLE')),
        );
        rejectConversion(Error('FIXED_PREVIEW_TEMPORARILY_UNAVAILABLE'));
        const response = await preview;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ kind: 'download_only' });
        expect(
          (
            await downloadFile(
              new Request('http://localhost/download-after-failure'),
              { params: Promise.resolve({ id: artifact.object.id }) },
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await readTaskNextSteps(
              owner,
              {
                workspaceId: f.workspaceId,
                sessionId: session.id,
                employeeAssignmentId: f.assignmentId,
                employeeVersionId: f.employeeVersionId,
              },
              f.db,
            )
          ).state,
        ).toBe('succeeded');
      }
      expect(
        (
          await f.db`select role from allrice_memberships where user_id=${f.ownerId}`
        )[0]?.role,
      ).toBe('member');
    } finally {
      const proof = await f.close();
      expect(proof.fixture?.schemaRemoved).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }
});
