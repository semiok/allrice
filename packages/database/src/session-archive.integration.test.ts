import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import * as client from './core/client.ts';
import {
  getChatSessionHistory,
  listChatSessions,
  updateChatSession,
  sendChatMessage,
  SessionActiveError,
  ensureDefaultEmployee,
  createChatSession,
} from './workspace/service.ts';
import {
  assertWorkbenchSession,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import { maintainQueue } from './execution/queue.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('session archive: actual isolated PostgreSQL, no model', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    for (const flag of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
    ])
      vi.stubEnv(flag, '1');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  it('repairs publication timestamps from actual messages while preserving user edits and empty sessions', async () => {
    const f = await createExperienceFixture(fixture.db);
    const empty = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: 'Empty conversation',
    });
    const renamed = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: 'Renamed conversation',
    });
    const untouched = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: 'Recent conversation',
    });
    const old = '2026-08-01T00:00:00.000Z';
    const messageAt = '2026-08-10T00:00:00.000Z';
    const editAt = '2026-08-20T00:00:00.000Z';
    const dirtyAt = '2026-09-01T00:00:00.000Z';
    await fixture.db`update allrice_chat_sessions set created_at=${old},updated_at=${dirtyAt} where id in ${fixture.db([f.session.id, empty.id, renamed.id])}`;
    await fixture.db`update allrice_messages set created_at=${messageAt} where session_id=${f.session.id}`;
    await fixture.db`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata,occurred_at)
      values(${f.org},${f.workspace},${f.user},'session.update','chat_session',${renamed.id},'allowed','resource_owner',${randomUUID()},'{}',${editAt})`;
    const migration = await readFile(
      new URL(
        '../migrations/0120_session_activity_recency.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await fixture.db.begin((tx) => tx.unsafe(migration));
    const page = await listChatSessions(f.owner, f.workspace);
    expect(page.sessions.map((s) => s.id)).toEqual([
      untouched.id,
      renamed.id,
      f.session.id,
      empty.id,
    ]);
    expect(page.sessions.map((s) => s.updatedAt)).toEqual([
      untouched.updatedAt,
      editAt,
      messageAt,
      old,
    ]);
    expect(
      (await getChatSessionHistory(f.owner, f.workspace, f.session.id)).session
        .updatedAt,
    ).toBe(messageAt);
    await fixture.db.begin((tx) => tx.unsafe(migration));
    expect((await listChatSessions(f.owner, f.workspace)).sessions).toEqual(
      page.sessions,
    );
  });
  it('archives without deleting history, reads artifacts, rejects sends, restores with owner boundaries', async () => {
    const f = await createExperienceFixture(fixture.db);
    const before = await getChatSessionHistory(
      f.owner,
      f.workspace,
      f.session.id,
    );
    await expect(
      updateChatSession(f.neighbor, f.workspace, f.session.id, {
        archived: true,
      }),
    ).rejects.toBeDefined();
    const archived = await updateChatSession(
      f.owner,
      f.workspace,
      f.session.id,
      { archived: true },
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (await listChatSessions(f.owner, f.workspace)).sessions,
    ).toHaveLength(0);
    expect(
      (
        await listChatSessions(f.owner, f.workspace, { archivedOnly: true })
      ).sessions.map((s) => s.id),
    ).toEqual([f.session.id]);
    expect(
      (await getChatSessionHistory(f.owner, f.workspace, f.session.id))
        .messages,
    ).toEqual(before.messages);
    await expect(
      listWorkbenchArtifacts(f.owner, f.session.id),
    ).resolves.toBeDefined();
    await expect(
      fixture.db.begin((tx) =>
        assertWorkbenchSession(tx, f.owner, f.session.id, true),
      ),
    ).rejects.toBeDefined();
    await expect(
      sendChatMessage(f.owner, f.workspace, f.session.id, {
        text: 'Do not run',
        clientMessageId: randomUUID(),
        attachmentIds: [],
      }),
    ).rejects.toBeDefined();
    await expect(
      updateChatSession(f.neighbor, f.workspace, f.session.id, {
        archived: false,
      }),
    ).rejects.toBeDefined();
    const restored = await updateChatSession(
      f.owner,
      f.workspace,
      f.session.id,
      { archived: false },
    );
    expect(restored.archivedAt).toBeNull();
    expect(restored.employeeAssignmentId).toBe(f.session.employeeAssignmentId);
    expect(
      (await getChatSessionHistory(f.owner, f.workspace, f.session.id))
        .messages,
    ).toEqual(before.messages);
  });
  it('paginates old archives independently from current work', async () => {
    const f = await createExperienceFixture(fixture.db);
    // Keep every row within the same millisecond to catch lost PostgreSQL
    // microseconds in a cursor roundtrip through JavaScript Date.
    for (let i = 0; i < 35; i++)
      await fixture.db`insert into allrice_chat_sessions(organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,title,archived_at,updated_at)
      values(${f.org},${f.workspace},${f.user},${f.session.employeeAssignmentId},${f.session.employeeVersionId},${`archive ${i}`},now(),
        '2026-09-26T00:00:00Z'::timestamptz + ${i} * interval '1 microsecond')`;
    const first = await listChatSessions(f.owner, f.workspace, {
      archivedOnly: true,
    });
    const next = await listChatSessions(f.owner, f.workspace, {
      archivedOnly: true,
      cursor: first.nextCursor!,
    });
    expect(first.sessions).toHaveLength(30);
    expect(next.sessions).toHaveLength(5);
    expect(
      new Set([...first.sessions, ...next.sessions].map((s) => s.id)).size,
    ).toBe(35);
    expect(
      (await listChatSessions(f.owner, f.workspace)).sessions.map((s) => s.id),
    ).toEqual([f.session.id]);
  });
  it('counts readable work beyond page one and paginates each employee without skipping microseconds', async () => {
    const f = await createExperienceFixture(fixture.db);
    const foreign = await createExperienceFixture(fixture.db);
    await ensureDefaultEmployee(f.neighbor, f.workspace);
    const privateOther = await createChatSession(f.neighbor, {
      workspaceId: f.workspace,
      title: 'Private other user',
    });
    const secondId = privateOther.employeeAssignmentId;
    for (let i = 0; i < 65; i++)
      await fixture.db`insert into allrice_chat_sessions(organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,title,updated_at)
        values(${f.org},${f.workspace},${f.user},${f.session.employeeAssignmentId},${f.session.employeeVersionId},${`Rice ${i}`},
          '2026-09-26T00:00:00Z'::timestamptz + ${i} * interval '1 microsecond')`;
    for (let i = 0; i < 3; i++)
      await fixture.db`insert into allrice_chat_sessions(organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,title,visibility,updated_at)
        values(${f.org},${f.workspace},${f.neighbor.actor.id},${secondId},${privateOther.employeeVersionId},${`Shared ${i}`},'workspace','2026-09-25T00:00:00Z')`;
    await fixture.db`insert into allrice_chat_sessions(organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,title,archived_at)
      values(${f.org},${f.workspace},${f.user},${f.session.employeeAssignmentId},${f.session.employeeVersionId},'Archived',now())`;
    const first = await listChatSessions(f.owner, f.workspace, {
      includeEmployeeGroups: true,
    });
    expect(first.sessions).toHaveLength(30);
    expect(first.employeeGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeAssignmentId: f.session.employeeAssignmentId,
          count: 66,
        }),
        expect.objectContaining({ employeeAssignmentId: secondId, count: 3 }),
      ]),
    );
    const next = await listChatSessions(f.owner, f.workspace, {
      employeeAssignmentId: f.session.employeeAssignmentId,
      cursor: first.nextCursor!,
    });
    const last = await listChatSessions(f.owner, f.workspace, {
      employeeAssignmentId: f.session.employeeAssignmentId,
      cursor: next.nextCursor!,
    });
    expect(next.sessions).toHaveLength(30);
    expect(last.sessions).toHaveLength(6);
    expect(last.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.sessions, ...next.sessions, ...last.sessions].map(
          (s) => s.id,
        ),
      ).size,
    ).toBe(66);
    const second = await listChatSessions(f.owner, f.workspace, {
      employeeAssignmentId: secondId,
      cursor: first.nextCursor!,
    });
    expect(second.sessions).toHaveLength(3);
    expect(
      second.sessions.every((s) => s.employeeAssignmentId === secondId),
    ).toBe(true);
    expect(second.sessions.some((s) => s.id === privateOther.id)).toBe(false);
    expect(
      (
        await listChatSessions(f.owner, f.workspace, {
          employeeAssignmentId: foreign.session.employeeAssignmentId,
        })
      ).sessions,
    ).toEqual([]);
    const archived = await listChatSessions(f.owner, f.workspace, {
      archivedOnly: true,
      includeEmployeeGroups: true,
    });
    expect(archived.employeeGroups).toEqual([
      expect.objectContaining({
        employeeAssignmentId: f.session.employeeAssignmentId,
        count: 1,
      }),
    ]);
    await expect(
      listChatSessions(f.owner, f.workspace, {
        employeeAssignmentId: 'not-a-uuid',
      }),
    ).rejects.toBeDefined();
  });
  it('requires confirmation, durably cuts off assistants and pauses schedules; restoration cannot revive tasks', async () => {
    const f = await createAssistantLocalCommandFixture(fixture.db);
    f.requestContext.memberships = f.context.policySnapshot.memberships;
    await fixture.db`insert into allrice_automations(organization_id,workspace_id,owner_id,name,prompt,schedule,session_id)
      values(${f.org},${f.workspace},${f.user},'Test schedule','Synthetic','{}',${f.session})`;
    await expect(
      updateChatSession(f.requestContext, f.workspace, f.session, {
        archived: true,
      }),
    ).rejects.toBeInstanceOf(SessionActiveError);
    expect(
      (
        await fixture.db`select archived_at from allrice_chat_sessions where id=${f.session}`
      )[0]?.archived_at,
    ).toBeNull();
    await updateChatSession(f.requestContext, f.workspace, f.session, {
      archived: true,
      stopActivity: true,
    });
    // A retry is idempotent while the cancellation is still draining.
    await updateChatSession(f.requestContext, f.workspace, f.session, {
      archived: true,
    });
    const [root] =
      await fixture.db`select cancel_requested_at from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    expect(root?.cancel_requested_at).not.toBeNull();
    const [job] =
      await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${f.rootRunId}`;
    expect(job?.cancel_requested_at).not.toBeNull();
    expect(
      (
        await fixture.db`select status from allrice_automations where session_id=${f.session}`
      )[0]?.status,
    ).toBe('paused');
    await updateChatSession(f.requestContext, f.workspace, f.session, {
      archived: false,
    });
    expect(
      (
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${f.rootRunId}`
      )[0]?.cancel_requested_at,
    ).not.toBeNull();
    await maintainQueue();
    expect(
      (
        await fixture.db`select status from allrice_jobs where run_id=${f.rootRunId}`
      )[0]?.status,
    ).toBe('canceled');
    expect(
      (
        await fixture.db`select status from allrice_automations where session_id=${f.session}`
      )[0]?.status,
    ).toBe('paused');
  });
});
