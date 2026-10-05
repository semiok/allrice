/** Production send -> queue -> Worker -> Broker -> publication -> HTTP.
 * Isolated PG/storage and a deterministic adapter; no native or paid model.
 * Actual DSH/Office execution has separate native/physical scenario evidence. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { RequestContext } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  OfficePackage,
  children,
  elements,
  ns,
} from '../../apps/worker/src/office/package.ts';
import { createP27CodexWorkerFixture } from '../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createChatSession,
  sendChatMessage,
  getChatSessionHistory,
} from '../../packages/database/src/workspace/service.ts';
import { claimNextJob } from '../../packages/database/src/execution/queue.ts';
import { listWorkbenchArtifacts } from '../../packages/database/src/artifact-review.ts';
import { DshHarnessAdapter } from '../../apps/worker/src/harness/dsh-adapter.ts';
import { DshRuntimePool } from '../../apps/worker/src/harness/dsh/runtime-pool.ts';
import { executeEmployeeRun } from '../../apps/worker/src/jobs/employee-run.ts';
import { runClaimedJob } from '../../apps/worker/src/job-runner.ts';
import { artifactHttp } from '../../apps/web/lib/runtime/artifact-http.ts';
import { GET as downloadFile } from '../../apps/web/app/api/v1/files/[id]/download/route.ts';

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
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET167 same-session production control flow and immutable HTTP delivery',
  () => {
    beforeEach(() => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.spyOn(DshRuntimePool.prototype, 'acquire').mockRejectedValue(
        Error('PAID_OR_NATIVE_MODEL_FORBIDDEN'),
      );
      vi.spyOn(DshHarnessAdapter.prototype, 'isConfigured').mockReturnValue(
        true,
      );
    });
    afterEach(() => {
      ports.context = null;
      ports.storage = null;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    async function verifyDelivery(format: 'text' | 'xlsx') {
      const root = await mkdtemp(
        join(tmpdir(), 'allrice-quality-conversation-'),
      );
      const f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        imageGeneration: true,
      });
      try {
        await f.db`update allrice_memberships set role='member' where user_id=${f.ownerId}`;
        const ownerContext: RequestContext = {
          ...f.context,
          memberships: f.context.memberships.map((m) => ({
            ...m,
            role: 'member',
          })),
        };
        const peers: RequestContext[] = [];
        for (const otherCompany of [false, true]) {
          const id = randomUUID();
          const organizationId = otherCompany ? randomUUID() : f.organizationId;
          const workspaceId = otherCompany ? randomUUID() : f.workspaceId;
          const membershipId = randomUUID();
          await f.db`insert into allrice_users(id,email,display_name,password_hash)
          values(${id},${`${id}@example.test`},'Isolated other employee','not-login')`;
          if (otherCompany) {
            await f.db`insert into allrice_organizations(id,slug,name) values(${organizationId},${id},'Isolated other company')`;
            await f.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'other','Other')`;
          }
          await f.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
          values(${membershipId},${organizationId},${workspaceId},${id},'member')`;
          peers.push({
            ...f.context,
            actor: { type: 'user', id },
            organizationId,
            workspaceId,
            memberships: [
              {
                id: membershipId,
                userId: id,
                organizationId,
                workspaceId,
                role: 'member',
                active: true,
              },
            ],
          });
        }
        vi.stubEnv('ALLRICE_STORAGE_ROOT', join(root, 'storage'));
        ports.storage = new LocalStorageAdapter(join(root, 'storage'));
        ports.context = ownerContext;
        const session = await createChatSession(ownerContext, {
          workspaceId: f.workspaceId,
          employeeAssignmentId: f.assignmentId,
          title: 'Fixed two-turn quality case',
        });
        const calls: string[] = [];
        const prompts: string[] = [];
        let parentObjectId: string | undefined;
        let parentChecksum: string | undefined;
        let turn = 0;
        vi.spyOn(DshHarnessAdapter.prototype, 'execute').mockImplementation(
          async (input) => {
            turn++;
            prompts.push(JSON.stringify(input.kernel));
            expect(input.tools.map((t) => t.name)).toContain(
              'workspace.export.create',
            );
            await input.onThreadBound?.({
              threadId: 'fixed-quality-conversation',
              resumed: turn > 1,
              replacedThreadId: null,
            });
            await input.onTurnStarted?.({
              threadId: 'fixed-quality-conversation',
              turnId: `fixed-turn-${turn}`,
            });
            for (const call of [
              {
                id: `list-${turn}`,
                name: 'workspace.file.list',
                arguments: { limit: 10 },
              },
              {
                id: `export-${turn}`,
                name: 'workspace.export.create',
                arguments: {
                  fileName: `fixed-report.${format === 'text' ? 'txt' : format}`,
                  format,
                  ...(format === 'text'
                    ? { content: `fixed revision ${turn}` }
                    : {
                        location: 'cloud',
                        python: {
                          inputs: parentObjectId
                            ? [
                                {
                                  path: 'source.xlsx',
                                  objectId: parentObjectId,
                                  checksum: parentChecksum,
                                },
                              ]
                            : [],
                          sourceObjectId: parentObjectId ?? null,
                          script: `from openpyxl import Workbook,load_workbook\n${parentObjectId ? "w=load_workbook('/tmp/work/input/source.xlsx'); assert w.active['A2'].value=='00123'; assert w.active['B2'].value==10" : "w=Workbook();w.active.append(['编号','金额']);w.active.append(['00123',10])"}\nw.active['B2']=${turn * 10}\nw.save('/tmp/work/output/result.xlsx')\nr=load_workbook('/tmp/work/output/result.xlsx'); assert r.active['A2'].value=='00123'; assert r.active['B2'].value==${turn * 10}`,
                        },
                      }),
                  ...(parentObjectId ? { parentObjectId } : {}),
                },
              },
            ]) {
              calls.push(call.id);
              const result = await input.onToolCall!(call);
              if (call.name === 'workspace.export.create') {
                const receipt = JSON.parse(result.modelContent);
                parentObjectId = receipt.objectId;
                parentChecksum = receipt.digest;
                if (format === 'xlsx') {
                  expect(receipt.nativeExecution).toMatchObject({
                    status: 'checked',
                    executionLocation: 'cloud',
                  });
                  expect(receipt.nativeExecution.output).toContain(
                    '"verdict": "pass"',
                  );
                }
              }
            }
            return {
              answer: `Fixed answer ${turn}`,
              provider: 'openai-codex',
              model: 'gpt-5.6-luna',
              usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
              usageComplete: true,
              cacheUsageKnown: true,
              threadId: 'fixed-quality-conversation',
              turnId: `fixed-turn-${turn}`,
            };
          },
        );
        const runs: string[] = [];
        for (const text of [
          'Create fixed report',
          'Revise the same fixed report',
        ]) {
          const input = {
            clientMessageId: randomUUID(),
            text,
            deliveryMode: 'follow_up',
          };
          const submitted = await sendChatMessage(
            ownerContext,
            f.workspaceId,
            session.id,
            input,
          );
          const duplicate = await sendChatMessage(
            ownerContext,
            f.workspaceId,
            session.id,
            input,
          );
          expect(duplicate.run.id).toBe(submitted.run.id);
          runs.push(submitted.run.id);
          const workerId = randomUUID();
          const job = await claimNextJob(workerId, 30000);
          const [expectedJob] =
            await f.db`select id from allrice_jobs where run_id=${submitted.run.id}`;
          expect(job?.id).toBe(expectedJob!.id);
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
          const [actual] =
            await f.db`select r.state,j.status job_status,m.status message_status,m.content,e.employee_version_id
          from allrice_runs r join allrice_jobs j on j.run_id=r.id join allrice_employee_runs e on e.run_id=r.id
          join allrice_messages m on m.id=e.assistant_message_id where r.id=${submitted.run.id}`;
          expect(actual).toMatchObject({
            state: 'succeeded',
            job_status: 'succeeded',
            message_status: 'completed',
            employee_version_id: f.employeeVersionId,
          });
          expect(actual!.content.text).toBe(`Fixed answer ${turn}`);
        }
        expect(turn).toBe(2);
        expect(calls).toEqual(['list-1', 'export-1', 'list-2', 'export-2']);
        expect(prompts[1]).toContain('Fixed answer 1');
        const history = await getChatSessionHistory(
          ownerContext,
          f.workspaceId,
          session.id,
        );
        expect(
          history.messages
            .filter((m) => m.role === 'assistant')
            .map((m) => m.content.text),
        ).toEqual(['Fixed answer 1', 'Fixed answer 2']);
        const { artifacts } = await listWorkbenchArtifacts(
          ownerContext,
          session.id,
        );
        expect(artifacts).toHaveLength(2);
        expect(new Set(artifacts.map((a) => a.version.seriesId)).size).toBe(1);
        expect(artifacts.map((a) => a.version.version).sort()).toEqual([1, 2]);
        const revision = artifacts.find((a) => a.version.version === 2)!;
        expect(revision.version.parentObjectId).toBe(
          artifacts.find((a) => a.version.version === 1)!.object.id,
        );
        for (const a of artifacts) {
          expect(
            (
              await artifactHttp(
                new Request('http://localhost/detail'),
                'detail',
                session.id,
                a.id,
              )
            ).status,
          ).toBe(200);
          const response = await downloadFile(
            new Request('http://localhost/download'),
            { params: Promise.resolve({ id: a.object.id }) },
          );
          expect(response.status).toBe(200);
          const bytes = Buffer.from(await response.arrayBuffer());
          expect(
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          ).toBe(a.object.checksum);
          if (format === 'text')
            expect(bytes.toString()).toBe(
              `fixed revision ${a.version.version}`,
            );
          else {
            const pkg = await OfficePackage.open(bytes, 'xlsx');
            const cells = elements(
              await pkg.xml('xl/worksheets/sheet1.xml'),
              ns.s,
              'c',
            );
            expect(
              cells.find((c) => c.getAttribute('r') === 'A2')?.textContent,
            ).toContain('00123');
            expect(
              children(
                cells.find((c) => c.getAttribute('r') === 'B2')!,
                ns.s,
                'v',
              )[0]?.textContent,
            ).toBe(String(a.version.version * 10));
          }
          for (const peer of peers) {
            ports.context = peer;
            // The session API hides non-owned identities; same-company file
            // policy denies explicitly, while another company cannot find it.
            expect(
              (
                await artifactHttp(
                  new Request('http://localhost/detail'),
                  'detail',
                  session.id,
                  a.id,
                )
              ).status,
            ).toBe(404);
            expect(
              (
                await downloadFile(new Request('http://localhost/download'), {
                  params: Promise.resolve({ id: a.object.id }),
                })
              ).status,
            ).toBe(peer.organizationId === f.organizationId ? 403 : 404);
          }
          ports.context = ownerContext;
        }
        const persisted =
          await f.db`select metadata from allrice_audit_events where metadata->>'runId'=any(${f.db.array(runs)}::text[]) and action='tool.execute' and decision='allowed' order by occurred_at,id`;
        expect(persisted.map((e) => e.metadata.toolName)).toEqual([
          'workspace.file.list',
          'workspace.export.create',
          'workspace.file.list',
          'workspace.export.create',
        ]);
        expect(
          (
            await f.db`select count(*)::int n from allrice_jobs where run_id=any(${f.db.array(runs)}::uuid[])`
          )[0]!.n,
        ).toBe(2);
      } finally {
        const proof = await f.close();
        expect(proof.fixture?.schemaRemoved).toBe(true);
        await rm(root, { recursive: true, force: true });
      }
    }
    it(
      'chat.production-two-turn.v1: submits once, continues and downloads immutable text revisions with ordinary-owner isolation',
      () => verifyDelivery('text'),
      120000,
    );
    it.skipIf(process.env.ALLRICE_RUN_OFFICE_INTEGRATION !== '1')(
      'office.native-delivery.v1: native XLSX generation, source revision, physical checker and authenticated immutable downloads',
      () => verifyDelivery('xlsx'),
      180000,
    );
  },
);
