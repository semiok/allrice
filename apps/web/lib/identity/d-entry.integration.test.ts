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
import type { EmployeeRuntimePackage, StoragePort } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
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
  updateChatSession,
  linkFileToSession,
  linkWorkspaceFileToSession,
} from '../../../../packages/database/src/workspace/service.ts';
import { initializeNativeOncePartition } from '../../../../packages/database/src/native-schedule-once-product.ts';
import { initializeNativeRecurringPartition } from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import { prepareAutomationConversation } from '../../../../packages/database/src/automation-conversation.ts';
import { readScheduleTarget } from '../../../../packages/database/src/native-schedule-authority.ts';
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
import { PATCH } from '../../app/api/v1/sessions/[id]/route';
import {
  POST as uploadAttachment,
  PUT as attachWorkspaceFile,
} from '../../app/api/v1/sessions/[id]/attachments/route';
import { POST as createOnceTask } from '../../app/api/v1/sessions/[id]/once-tasks/route';
import { POST as cancelOnceTask } from '../../app/api/v1/sessions/[id]/once-tasks/[taskId]/cancel/route';
import { POST as createRecurringTask } from '../../app/api/v1/sessions/[id]/schedule-tasks/route';
import { resolveDEntryAdmission } from '../d-entry/admission';
import { resolveDEntryIdentity } from '../d-entry/identity';

const cookie = vi.hoisted(() => ({
  token: '',
  storage: null as StoragePort | null,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
vi.mock('../storage/runtime', () => ({
  getStorageAdapter: () => cookie.storage!,
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
      cookie.storage = runtimeFixtureStorage(fixture.db);
      for (const kind of ['once', 'recurring'] as const) {
        const reference = {
          artifactId: 'sha256:' + 'a'.repeat(64),
          profileId: `allrice-${kind}-control-v1`,
          storageId: 'synthetic-sql-only',
          stateRoot: fixture.storageRoot,
        };
        vi.stubEnv(`ALLRICE_NATIVE_${kind.toUpperCase()}_ENABLED`, '1');
        vi.stubEnv(
          `ALLRICE_NATIVE_${kind.toUpperCase()}_REFERENCE`,
          JSON.stringify(reference),
        );
        await (
          kind === 'once'
            ? initializeNativeOncePartition
            : initializeNativeRecurringPartition
        )(reference);
      }
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
    function request(
      f: Fixture,
      post = false,
      selection: Record<string, string> = f.selection,
    ) {
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
    function legacyRequest(
      f: Fixture,
      sessionId: string,
      path: string,
      method: string,
      body: unknown,
    ) {
      return new Request(
        `https://allrice.test/api/v1/sessions/${sessionId}${path}?workspaceId=${f.workspace}`,
        {
          method,
          headers: {
            host: 'allrice.test',
            origin: 'https://allrice.test',
            'content-type': 'application/json',
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
          body: JSON.stringify(body),
        },
      );
    }
    const route = (id: string) => ({ params: Promise.resolve({ id }) });
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
    it('rechecks current writable authority for an already logged-in member downgraded to viewer, including new threads', async () => {
      const f = await setup(),
        thread = await four(f);
      const existing = { ...f.selection, threadId: thread.id };
      const newThread = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const policy = {
        revision: 'synthetic-approved-policy',
        defaultGeneration: '3.x' as const,
        selections: [
          {
            organizationId: f.org,
            personId: f.user,
            employeeInstanceId: f.assignment,
            generation: '4.0' as const,
          },
        ],
      };
      for (const selection of [existing, newThread])
        expect(
          (await resolveDEntryAdmission(f.context, selection, policy))
            .executionGeneration,
        ).toBe('4.0');
      await fixture.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
      expect(
        f.context.memberships.find((m) => m.id === f.membership)?.role,
      ).toBe('member');
      const fresh = await authenticateSession(f.login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      expect(fresh?.memberships.find((m) => m.id === f.membership)?.role).toBe(
        'viewer',
      );
      const [assignment] =
        await fixture.db`select active from allrice_employee_assignments where id=${f.assignment}`;
      expect(assignment!.active).toBe(true);
      for (const selection of [existing, newThread]) {
        await expect(
          resolveDEntryAdmission(f.context, selection, policy),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect((await POST(request(f, true, selection))).status).toBe(403);
      }
      expect((await GET(request(f, false, existing))).status).toBe(200);
      await expect(
        resolveDEntryIdentity(f.context, existing, 'history'),
      ).resolves.toMatchObject({ threadId: thread.id });
    });
    it('rejects 4.0 legacy PATCH before metadata and message visibility writes, preserving 3.x updates and history', async () => {
      const f = await setup(),
        thread = await four(f),
        messageId = randomUUID();
      await fixture.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${messageId},${f.org},${f.workspace},${thread.id},${f.user},'user','{"text":"synthetic history","citations":[]}')`;
      const snapshot =
        () => fixture.db`select s.title,s.visibility,s.archived_at,s.pinned_at,s.updated_at,m.visibility message_visibility
        from allrice_chat_sessions s join allrice_messages m on m.session_id=s.id where s.id=${thread.id}`;
      const before = await snapshot();
      for (const patch of [
        { title: 'No legacy rename' },
        { visibility: 'workspace' },
        { archived: true, stopActivity: true },
        { pinned: true },
      ]) {
        expect(
          (
            await PATCH(
              legacyRequest(f, thread.id, '', 'PATCH', patch),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        await expect(
          updateChatSession(f.context, f.workspace, thread.id, patch),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      }
      expect(await snapshot()).toEqual(before);
      expect(
        (await GET(request(f, false, { ...f.selection, threadId: thread.id })))
          .status,
      ).toBe(200);
      const legacy = await createChatSession(f.context, {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      });
      await fixture.db`insert into allrice_messages(organization_id,workspace_id,session_id,owner_id,role,content)
        values(${f.org},${f.workspace},${legacy.id},${f.user},'user','{"text":"legacy history","citations":[]}')`;
      const changed = await PATCH(
        legacyRequest(f, legacy.id, '', 'PATCH', {
          title: 'Legacy rename',
          visibility: 'workspace',
          pinned: true,
        }),
        route(legacy.id),
      );
      expect(changed.status).toBe(200);
      expect((await changed.json()).session).toMatchObject({
        title: 'Legacy rename',
        visibility: 'workspace',
      });
      const [message] =
        await fixture.db`select visibility from allrice_messages where session_id=${legacy.id}`;
      expect(message!.visibility).toBe('workspace');
      expect(
        (
          await PATCH(
            legacyRequest(f, legacy.id, '', 'PATCH', { archived: true }),
            route(legacy.id),
          )
        ).status,
      ).toBe(200);
    });
    it('rejects 4.0 legacy uploads before bytes or metadata, and guards both final file link services while preserving 3.x', async () => {
      const f = await setup(),
        thread = await four(f);
      const content = {
        fileName: 'synthetic.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('isolated fixture bytes').toString('base64'),
      };
      const put = vi.spyOn(cookie.storage!, 'put');
      try {
        const uploaded = await uploadAttachment(
          legacyRequest(f, f.session, '/attachments', 'POST', content),
          route(f.session),
        );
        expect(uploaded.status).toBe(201);
        const objectId = (await uploaded.json()).attachment.id as string;
        expect(put).toHaveBeenCalledTimes(1);
        const legacy = await createChatSession(f.context, {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
        });
        expect(
          (
            await attachWorkspaceFile(
              legacyRequest(f, legacy.id, '/attachments', 'PUT', { objectId }),
              route(legacy.id),
            )
          ).status,
        ).toBe(200);
        put.mockClear();
        const counts = () => fixture.db`select
          (select count(*)::int from allrice_storage_objects where organization_id=${f.org}) objects,
          (select count(*)::int from allrice_file_references where organization_id=${f.org}) links`;
        const before = await counts();
        expect(
          (
            await uploadAttachment(
              legacyRequest(f, thread.id, '/attachments', 'POST', content),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await attachWorkspaceFile(
              legacyRequest(f, thread.id, '/attachments', 'PUT', { objectId }),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        await expect(
          linkFileToSession({
            context: f.context,
            workspaceId: f.workspace,
            sessionId: thread.id,
            objectId,
            fileName: content.fileName,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          linkWorkspaceFileToSession({
            context: f.context,
            workspaceId: f.workspace,
            sessionId: thread.id,
            objectId,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(put).not.toHaveBeenCalled();
        expect(await counts()).toEqual(before);
        const [linked] =
          await fixture.db`select count(*)::int count from allrice_file_references where session_id=${thread.id}`;
        expect(linked!.count).toBe(0);
      } finally {
        put.mockRestore();
      }
    });
    it('rejects 4.0 once/recurring new_each_run at real routes and before creating a fresh 3.x target', async () => {
      const f = await setup(),
        thread = await four(f);
      const task = {
        name: 'Synthetic only',
        prompt: 'No native execution',
        conversationMode: 'new_each_run' as const,
      };
      const once = {
        ...task,
        clientRequestId: randomUUID(),
        runAt: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'UTC',
      };
      const recurring = {
        ...task,
        clientRequestId: randomUUID(),
        rule: { kind: 'every', seconds: 3600 },
      };
      const counts = () => fixture.db`select
        (select count(*)::int from allrice_automations where organization_id=${f.org}) clocks,
        (select count(*)::int from allrice_native_once_controls where immutable_control->>'organizationId'=${f.org}) once_controls,
        (select count(*)::int from allrice_native_recurring_controls where immutable_identity->>'organizationId'=${f.org}) recurring_controls,
        (select count(*)::int from allrice_chat_sessions where organization_id=${f.org} and execution_generation='3.x') legacy_threads,
        (select count(*)::int from allrice_automation_runs where organization_id=${f.org}) automation_runs,
        (select count(*)::int from allrice_jobs where organization_id=${f.org}) jobs`;
      const before = await counts();
      expect(
        (
          await createOnceTask(
            legacyRequest(f, thread.id, '/once-tasks', 'POST', once),
            route(thread.id),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await createRecurringTask(
            legacyRequest(f, thread.id, '/schedule-tasks', 'POST', recurring),
            route(thread.id),
          )
        ).status,
      ).toBe(403);
      const scope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
      };
      await expect(
        fixture.db.begin(async (tx) =>
          prepareAutomationConversation(
            tx,
            f.context,
            scope,
            {
              id: randomUUID(),
              name: task.name,
              revision: 1,
              session_id: thread.id,
              employee_assignment_id: f.assignment,
              conversation_mode: 'new_each_run',
            },
            await readScheduleTarget(tx, scope, thread.id),
            { kind: 'manual', requestId: randomUUID() },
          ),
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await counts()).toEqual(before);
      const legacyOnce = await createOnceTask(
        legacyRequest(f, f.session, '/once-tasks', 'POST', once),
        route(f.session),
      );
      expect(legacyOnce.status).toBe(201);
      const taskId = (await legacyOnce.json()).task.id as string;
      expect(
        (
          await createRecurringTask(
            legacyRequest(f, f.session, '/schedule-tasks', 'POST', recurring),
            route(f.session),
          )
        ).status,
      ).toBe(201);
      const [after] = await counts();
      expect(after).toMatchObject({
        clocks: 2,
        once_controls: 1,
        recurring_controls: 1,
        legacy_threads: 1,
        automation_runs: 0,
        jobs: before[0]!.jobs,
      });
      const [controlBefore] =
        await fixture.db`select snapshot,snapshot_version from allrice_native_once_controls where automation_id=${taskId}`;
      expect(
        (
          await cancelOnceTask(
            legacyRequest(
              f,
              thread.id,
              `/once-tasks/${taskId}/cancel`,
              'POST',
              {},
            ),
            { params: Promise.resolve({ id: thread.id, taskId }) },
          )
        ).status,
      ).toBe(403);
      const [controlAfter] =
        await fixture.db`select snapshot,snapshot_version from allrice_native_once_controls where automation_id=${taskId}`;
      expect(controlAfter).toEqual(controlBefore);
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
