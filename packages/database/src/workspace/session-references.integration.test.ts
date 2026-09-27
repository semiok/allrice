import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  captureSessionReferences,
  assertSessionReferencesReadable,
} from './session-references.ts';
import {
  sendChatMessage,
  getChatSessionHistory,
  updateChatSession,
} from './service.ts';
import { resolveEmployeeExecution } from '../employees/employeehub.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('authorized session reference snapshots', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('freezes source text, preserves retries, excludes tools, denies scope changes and rechecks revocation', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
    try {
      const source = randomUUID(),
        target = randomUUID(),
        empty = randomUUID();
      for (const id of [source, target, empty])
        await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${id},${f.organizationId},${f.workspaceId},${f.ownerId},${id === source ? '财报分析' : '汇报'},${f.assignmentId},${f.employeeVersionId})`;
      for (const [role, text] of [
        ['user', '研究财报'],
        ['assistant', '营收增长 20%'],
        ['tool', 'RAW_TOOL_SECRET'],
      ] as const)
        await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status,completed_at)
          values(${randomUUID()},${f.organizationId},${f.workspaceId},${source},${f.ownerId},${role},${f.db.json({ text, citations: [] })},'completed',now())`;
      const capture = (
        ids: string[],
        visibility: 'private' | 'workspace' = 'private',
      ) =>
        f.db.begin((tx) =>
          captureSessionReferences(
            tx,
            f.context,
            f.workspaceId,
            { id: target, visibility },
            ids,
          ),
        );
      const otherUser = randomUUID();
      await f.db`insert into allrice_users(id,email,display_name,password_hash) values(${otherUser},${`${otherUser}@invalid.test`},'Other','fixture-only')`;
      await f.db`update allrice_chat_sessions set owner_id=${otherUser} where id=${source}`;
      await expect(capture([source])).rejects.toMatchObject({
        code: 'unavailable',
      });
      await f.db`update allrice_chat_sessions set owner_id=${f.ownerId} where id=${source}`;
      const snapshot = await capture([source]);
      expect(snapshot[0]?.messages).toHaveLength(2);
      expect(JSON.stringify(snapshot)).not.toContain('RAW_TOOL_SECRET');
      await expect(capture([target])).rejects.toMatchObject({ code: 'self' });
      await expect(capture([empty])).rejects.toMatchObject({ code: 'empty' });
      await expect(
        f.db.begin((tx) =>
          captureSessionReferences(
            tx,
            { ...f.context, organizationId: randomUUID() },
            f.workspaceId,
            { id: target, visibility: 'private' },
            [source],
          ),
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await f.db`update allrice_chat_sessions set visibility='workspace' where id=${target}`;
      await expect(capture([source])).rejects.toMatchObject({
        code: 'visibility',
      });
      await f.db`update allrice_chat_sessions set visibility='private' where id=${target}`;
      const body = {
        clientMessageId: randomUUID(),
        text: '根据引用整理汇报',
        deliveryMode: 'follow_up',
        sessionReferenceIds: [source],
      };
      const sent = await sendChatMessage(
        f.context,
        f.workspaceId,
        target,
        body,
      );
      expect(sent.userMessage.content.sessionReferences).toEqual([
        { sessionId: source, label: '财报分析' },
      ]);
      await f.db`update allrice_messages set content='{"text":"后续改动","citations":[]}' where session_id=${source} and role='assistant'`;
      const retry = await sendChatMessage(
        f.context,
        f.workspaceId,
        target,
        body,
      );
      expect(retry.run.id).toBe(sent.run.id);
      const resolved = await resolveEmployeeExecution({
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        runId: sent.run.id,
      });
      expect(
        JSON.stringify(resolved.promptSnapshot.sessionReferences),
      ).toContain('营收增长 20%');
      expect(
        JSON.stringify(resolved.promptSnapshot.sessionReferences),
      ).not.toContain('后续改动');
      const history = await getChatSessionHistory(
        f.context,
        f.workspaceId,
        target,
      );
      expect(JSON.stringify(history)).not.toContain('营收增长 20%');
      await expect(
        updateChatSession(f.context, f.workspaceId, target, {
          visibility: 'workspace',
        }),
      ).rejects.toMatchObject({ code: 'visibility' });
      await f.db`update allrice_chat_sessions set archived_at=now() where id=${source}`;
      await expect(
        assertSessionReferencesReadable(
          {
            organizationId: f.organizationId,
            workspaceId: f.workspaceId,
            ownerId: f.ownerId,
          },
          snapshot,
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        resolveEmployeeExecution({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          ownerId: f.ownerId,
          runId: sent.run.id,
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await f.close();
    }
  }, 60000);
});
