import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ReferenceInputSelectionResultSchema,
  ReferenceSelectionErrorSchema,
} from '@allrice/contracts';
import * as database from '../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../packages/database/src/runtime.fixture.ts';
import { referenceToolFixture } from '../../../packages/database/src/reference-tool.fixture.ts';
import { createSession } from '../../../packages/database/src/identity.ts';
import { changeReferencePublication } from '../../../packages/database/src/reference-library.ts';
import {
  executeEmployeeReferenceTool,
  prepareEmployeeContentContext,
} from '../../../packages/database/src/employees/employee-runtime-content.ts';
import { completeJob } from '../../../packages/database/src/execution/queue.ts';
import { GET as selection } from '../app/api/v1/references/revisions/[id]/selection/route';
import { POST as send } from '../app/api/v1/sessions/[id]/messages/route';

const browser = vi.hoisted(() => ({ token: '' }));
// Substitute only Next's cookie transport; actor/tenant/session are authenticated in PG.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) =>
      key === 'allrice_session' && browser.token
        ? { value: browser.token }
        : undefined,
  }),
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'v1.7 current reference chips through actual browser identity and admission',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
    }, 120000);
    afterAll(async () => {
      browser.token = '';
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);
    it('“继续刚才的讨论” keeps history, identifies only unavailable chips and admits the same old conversation after those chips are removed', async () => {
      const x = await referenceToolFixture(f);
      const good = await x.publish('仍可引用的正式资料');
      const removed = await x.publish('已读后移除的正式资料');
      const denied = await x.publish('已读后改权限的正式资料');
      const run = await x.run();
      for (const ref of [removed, denied])
        await executeEmployeeReferenceTool(
          run.scope,
          run.runtime.generationId,
          run.worker,
          'workspace.reference.read',
          ref.pin,
        );
      await completeJob({
        ...run.worker,
        result: { answer: '原先上下文中的资料内容仍然保留。', citations: [] },
      });
      browser.token = (await createSession(x.context.actor.id)).token;
      const request = (path: string, body?: unknown) =>
        new Request('https://example.test/api/v1/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            host: 'example.test',
            origin: 'https://example.test',
            'content-type': 'application/json',
            'x-allrice-organization-id': x.context.organizationId,
            'x-allrice-workspace-id': x.context.workspaceId!,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const route = (id: string) => ({ params: Promise.resolve({ id }) });
      const preflight = (id: string, workspaceId = x.context.workspaceId!) =>
        selection(
          request(
            `references/revisions/${id}/selection?workspaceId=${workspaceId}`,
          ),
          route(id),
        );
      const before = await preflight(removed.revisionId);
      expect(before.status).toBe(200);
      expect(
        ReferenceInputSelectionResultSchema.parse(await before.json()),
      ).toMatchObject({
        viewerId: x.context.actor.id,
        workspaceId: x.context.workspaceId,
        selection: removed.pin,
      });
      await changeReferencePublication(x.publisher, removed.sourceId, {
        workspaceId: x.context.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'delete',
      });
      await changeReferencePublication(x.publisher, denied.sourceId, {
        workspaceId: x.context.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'audience',
        audience: { scope: 'personal', departmentIds: [] },
      });
      for (const id of [removed.revisionId, denied.revisionId, randomUUID()]) {
        const response = await preflight(id);
        expect(response.status).toBe(409);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(
          ReferenceSelectionErrorSchema.parse(await response.json()).error,
        ).toEqual({
          code: 'REFERENCE_SELECTION_UNAVAILABLE',
          message: '引用失败，文件可能被调整权限或移除',
          requestId: expect.any(String),
          retryable: false,
          referenceRevisionIds: [id],
        });
      }
      expect((await preflight(good.revisionId)).status).toBe(200);
      expect((await preflight(good.revisionId, randomUUID())).status).toBe(403);
      const counts = async () =>
        (
          await f.db`select (select count(*)::int from allrice_employee_runs where session_id=${run.scope.sessionId}) runs,(select count(*)::int from allrice_messages where session_id=${run.scope.sessionId}) messages`
        )[0];
      const prior = await counts();
      const path = `sessions/${run.scope.sessionId}/messages?workspaceId=${x.context.workspaceId}`;
      const rejected = await send(
        request(path, {
          text: '继续刚才的讨论',
          clientMessageId: randomUUID(),
          referenceRevisionIds: [
            removed.revisionId,
            good.revisionId,
            denied.revisionId,
          ],
          deliveryMode: 'follow_up',
        }),
        route(run.scope.sessionId),
      );
      expect(rejected.status).toBe(409);
      expect(
        ReferenceSelectionErrorSchema.parse(
          await rejected.json(),
        ).error.referenceRevisionIds.sort(),
      ).toEqual([removed.revisionId, denied.revisionId].sort());
      expect(await counts()).toEqual(prior);
      const accepted = await send(
        request(path, {
          text: '继续刚才的讨论',
          clientMessageId: randomUUID(),
          referenceRevisionIds: [good.revisionId],
          deliveryMode: 'follow_up',
        }),
        route(run.scope.sessionId),
      );
      expect(accepted.status).toBe(202);
      const body = await accepted.json();
      const resumed = await prepareEmployeeContentContext({
        ...run.scope,
        runId: body.run.id,
      });
      expect(resumed).toMatchObject({
        generationId: run.runtime.generationId,
        allowedMessageIds: null,
        historyFromMessageId: null,
      });
      expect(
        (
          await f.db`select content from allrice_messages where id=${run.sent.assistantMessage.id}`
        )[0]!.content.text,
      ).toBe('原先上下文中的资料内容仍然保留。');
      expect(
        (
          await f.db`select jsonb_array_length(reference_reads)::int n from allrice_employee_runs where run_id=${run.scope.runId}`
        )[0]!.n,
      ).toBe(2);
      browser.token = '';
      expect((await preflight(good.revisionId)).status).toBe(401);
    }, 120000);
  },
);
