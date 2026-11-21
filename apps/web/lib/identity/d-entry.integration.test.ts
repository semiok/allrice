import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { EmployeeRuntimePackage } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import {
  createSession,
  authenticateSession,
  revokeSession,
} from '../../../../packages/database/src/identity.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  createChatSession,
  getSessionExecutionGeneration,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
import {
  claimNextJob,
  startClaimedJob,
  prepareJobNativeSession,
} from '../../../../packages/database/src/execution/queue.ts';
import { acquireConversationRuntime } from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import { enqueueNativeSubagentControl } from '../../../../packages/database/src/conversation/native-subagent-control.ts';
import { updateQueuedMessage } from '../../../../packages/database/src/conversation/queued-messages.ts';
import { GET } from '../../app/api/v1/d-entry/identity/route';
import { POST } from '../../app/api/v1/d-entry/admission/route';

const cookie = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-271 real cookie/DB owner admission and immutable product writer',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const source = await createEmployeeAdministrationFixture(fixture.db);
      runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            nativeSkillIds: [],
          },
        },
        skills: [],
      });
    }, 120000);
    beforeEach(() => {
      cookie.token = '';
    });
    afterAll(async () => {
      cookie.token = '';
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    async function setup() {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        runtimePackage,
        toolNames: runtimePackage.runtimeManifest.toolNames,
        allowedTools: runtimePackage.runtimeManifest.toolNames,
        runtimePolicy: {
          harness: 'dsh',
          provider: runtimePackage.runtimeManifest.provider,
          model: runtimePackage.runtimeManifest.model,
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic-never-resolved',
          baseUrl: null,
        },
      });
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('synthetic_cookie_login_failed');
      cookie.token = login.token;
      return {
        ...f,
        login,
        context,
        selection: {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          threadId: f.session,
        },
      };
    }
    type Fixture = Awaited<ReturnType<typeof setup>>;
    function request(f: Fixture, post = false, selection = f.selection) {
      return new Request(
        `https://allrice.test/api/v1/d-entry/${post ? 'admission' : 'identity'}${post ? '' : '?' + new URLSearchParams(selection)}`,
        {
          method: post ? 'POST' : 'GET',
          headers: {
            host: 'allrice.test',
            origin: 'https://allrice.test',
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
          ...(post ? { body: JSON.stringify(selection) } : {}),
        },
      );
    }
    async function four(f: Fixture) {
      return createChatSession(
        f.context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          title: 'Only the 4.0 writer may continue this thread',
        },
        { executionGeneration: '4.0' },
      );
    }
    it('maps the real login cookie to current person/employee/root without starting a VM', async () => {
      const f = await setup();
      const req = request(f);
      req.headers.set('x-allrice-person-id', randomUUID());
      const response = await GET(req);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        identity: {
          organizationId: f.org,
          personId: f.user,
          employeeInstanceId: f.assignment,
          threadId: f.session,
        },
      });
      expect(response.headers.get('cache-control')).toContain('no-store');
      const admission = await POST(request(f, true));
      expect(admission.status).toBe(503);
      expect((await admission.json()).error.code).toBe(
        'DEPENDENCY_UNAVAILABLE',
      );
    });
    it('rejects a foreign tenant/person and rechecks cookie and membership revocation', async () => {
      const f = await setup(),
        other = await setup();
      cookie.token = f.login.token;
      const foreignTenant = request(f);
      foreignTenant.headers.set('x-allrice-organization-id', other.org);
      expect((await GET(foreignTenant)).status).toBe(403);
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${other.user},'member')`;
      cookie.token = other.login.token;
      expect([403, 404]).toContain((await GET(request(f))).status);
      cookie.token = f.login.token;
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      expect((await GET(request(f))).status).toBe(403);
      await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
      await revokeSession(f.login.token);
      expect((await GET(request(f))).status).toBe(401);
    });
    it('keeps owner history after assignment withdrawal/archival and refuses continuation', async () => {
      const f = await setup();
      await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      expect((await GET(request(f))).status).toBe(200);
      expect((await POST(request(f, true))).status).toBe(403);
    });
    it('pins old and new threads permanently and never creates a 3.x native origin for 4.0', async () => {
      const f = await setup(),
        thread = await four(f);
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, f.session),
      ).toBe('3.x');
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, thread.id),
      ).toBe('4.0');
      const [row] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${thread.id}`;
      expect(row!.native_root_origin).toBeNull();
      await expect(
        fixture.db`update allrice_chat_sessions set execution_generation='3.x' where id=${thread.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        createChatSession(
          f.context,
          { workspaceId: f.workspace, employeeInstanceId: f.assignment },
          { sessionId: thread.id },
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('serializes competing 3.x/4.0 creations at the same actual thread identity', async () => {
      const f = await setup(),
        id = randomUUID();
      const input = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const results = await Promise.allSettled([
        createChatSession(f.context, input, {
          sessionId: id,
          executionGeneration: '3.x',
        }),
        createChatSession(f.context, input, {
          sessionId: id,
          executionGeneration: '4.0',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'authorization_denied',
      });
      const [row] =
        await fixture.db`select count(*)::int count from allrice_chat_sessions where id=${id}`;
      expect(row!.count).toBe(1);
    });
    it('rejects legacy send, queue edit, child prompt and native acquire on a 4.0 thread before writes', async () => {
      const f = await setup(),
        thread = await four(f);
      await expect(
        sendChatMessage(f.context, f.workspace, thread.id, {
          clientMessageId: randomUUID(),
          text: '请在这条4.0线程继续处理，不能交给3.x执行。',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        updateQueuedMessage(f.context, f.workspace, thread.id, randomUUID(), {
          action: 'edit',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        enqueueNativeSubagentControl(f.context, thread.id, {
          rootRunId: f.rootRunId,
          generation: 0,
          input: {
            requestId: randomUUID(),
            kind: 'prompt',
            mode: 'continuable',
            parentSessionId: 'native-root',
            childSessionId: 'native-child',
            delivery: 'queue',
            content: [{ type: 'text', text: '网页不直接向子会话发言' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        acquireConversationRuntime({
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: thread.id,
          runId: f.rootRunId,
          workerId: f.worker.workerId,
          configChecksum: 'sha256:' + 'a'.repeat(64),
          compactThresholdTokens: 10000,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_messages where session_id=${thread.id}) messages,
      (select count(*)::int from allrice_conversation_runtimes where session_id=${thread.id}) runtimes,
      (select count(*)::int from allrice_conversation_commands where session_id=${thread.id}) commands`;
      expect(counts).toMatchObject({ messages: 0, runtimes: 0, commands: 0 });
    });
    it('filters 4.0 from the real legacy claim and rechecks forged claimed/bind attempts', async () => {
      const f = await setup(),
        thread = await four(f);
      // Synthetic inconsistent queue state tests the real legacy entrypoints;
      // no public writer can create this 4.0 employee Run through enqueue/send.
      await fixture.db`update allrice_employee_runs set session_id=${thread.id} where run_id=${f.rootRunId}`;
      await fixture.db`update allrice_jobs set status='queued',available_at=clock_timestamp()-interval '1 second',attempt=1 where id=${f.worker.jobId}`;
      expect(await claimNextJob(randomUUID(), 60000)).toBeNull();
      await fixture.db`update allrice_jobs set status='claimed',lease_expires_at=clock_timestamp()+interval '5 minutes' where id=${f.worker.jobId}`;
      await expect(
        startClaimedJob(f.worker.workerId, f.worker.jobId, f.worker.leaseToken),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await fixture.db`update allrice_jobs set status='running' where id=${f.worker.jobId}`;
      await expect(
        prepareJobNativeSession({
          workerId: f.worker.workerId,
          jobId: f.worker.jobId,
          leaseToken: f.worker.leaseToken,
          attempt: 1,
          subject: {
            kind: 'chat',
            id: thread.id,
            configChecksum: 'sha256:' + 'a'.repeat(64),
            generation: 0,
            expectedThreadId: null,
          },
          nativeSessionId: 'dsh-' + thread.id,
          storageContextKey: thread.id,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
  },
);
