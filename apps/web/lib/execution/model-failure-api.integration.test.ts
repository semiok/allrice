/** Real HTTP handlers and isolated PostgreSQL; provider failures are synthetic. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import {
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createExperienceFixture } from '../../../../packages/database/src/experience.fixture.ts';
import { terminalModelFailureCategorySql } from '../../../../packages/database/src/execution/model-failures.ts';
import { failJob } from '../../../../packages/database/src/execution/queue.ts';
import { nativeEventView } from '../../../../apps/worker/src/harness/dsh/event-projector.ts';
const auth = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../identity/session', () => ({
  getRequestContext: async () => auth.context,
}));
vi.mock('./platform-technical-health', () => ({
  platformTechnicalHealth: async () => undefined,
}));
import { GET as runGet } from '../../app/api/v1/runs/[id]/route';
import { POST as runPost } from '../../app/api/v1/runs/route';
import { POST as cancelPost } from '../../app/api/v1/runs/[id]/cancel/route';
import { GET as eventsGet } from '../../app/api/v1/runs/[id]/events/route';
import { GET as sessionGet } from '../../app/api/v1/sessions/[id]/route';
import { GET as taskGet } from '../../app/api/v1/scheduled-tasks/[taskId]/route';
import { GET as adminGet } from '../../app/api/v1/admin/technical-assistant/route';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('real model-failure API boundaries, isolated database / no model', () => {
  let db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  type Fixture = Awaited<ReturnType<typeof createExperienceFixture>> & {
    idempotencyKey: string;
  };
  let legacy: Fixture;
  let unknown: Fixture;
  let unproven: Fixture;
  let recovered: Fixture;
  let redactionFailed: Fixture;
  const sensitive = [
    'https://private.test/path?q=secret',
    'Authorization: Basic cHJpdmF0ZTpwYXNz',
    'person@example.test',
    '/Users/private/file.txt',
    'C:\\private\\file.txt',
    '12345678-1234-4123-8123-123456789abc',
    'request_id=private',
  ];
  const json = (value: unknown) =>
    db.db.json(JSON.parse(JSON.stringify(value)));
  const raw = 'Your authentication token has expired';
  const unknownRaw = 'Unfamiliar synthetic provider error';
  const secret = 'sk-synthetic-private';
  const overload = 'Our servers are currently overloaded';
  async function seed(code: string | null, message: string, receipt = false) {
    const f = await createExperienceFixture(db.db);
    const idempotencyKey = randomUUID();
    await db.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,last_error_code,last_error_message)
      values(${randomUUID()},${f.org},${f.workspace},${f.user},${f.run},${code ? 'failed' : 'succeeded'},${idempotencyKey},now()+interval '1 hour',
        '{"schemaVersion":1,"type":"synthetic.model.failure","input":{}}',${code},${code ? message + ' ' + secret : null})`;
    await db.db`update allrice_runs set state=${code ? 'failed' : 'succeeded'},error_code=${code},error_message=${code ? message + ' ' + secret : null},completed_at=now(),updated_at=now() where id=${f.run}`;
    if (receipt) {
      const projected = nativeEventView({
        seq: 12,
        type: 'assistant/attempt',
        data: {
          stream: [
            {
              type: 'chunk',
              chunk: {
                type: 'finish',
                reason: {
                  kind: 'error',
                  failure: {
                    code: code?.slice(4) ?? 'SERVER',
                    message: message + ' ' + secret,
                  },
                },
              },
            },
          ],
        },
      })!;
      await db.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${f.org},${f.workspace},${f.run},1,'harness.native',${json({ source: 'dsh', sourceEventId: projected.sourceEventId, sourceEventType: projected.sourceEventType, sourceOccurredAt: projected.sourceOccurredAt, nativePayload: projected.sourcePayload, attempt: 0, summary: 'summary' in projected ? projected.summary : undefined })})`;
    }
    if (code) {
      const receiptPayload = receipt
        ? nativeEventView({
            seq: 12,
            type: 'assistant/attempt',
            data: {
              stream: [
                {
                  type: 'chunk',
                  chunk: {
                    type: 'finish',
                    reason: {
                      kind: 'error',
                      failure: {
                        code: code.slice(4),
                        message: message + ' ' + secret,
                      },
                    },
                  },
                },
              ],
            },
          })!.sourcePayload
        : {};
      await db.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${f.org},${f.workspace},${f.run},2,'run.failed',${json({ code, message: message + ' ' + secret, ...receiptPayload, metadata: { deeper: [{ modelFailure: { category: 'unknown', upstreamMessage: message + ' ' + secret, nested: { raw: secret } } }] } })})`;
      await db.db`update allrice_employee_runs set status='failed',error_code=${code},error_message=${message + ' ' + secret} where run_id=${f.run}`;
      await db.db`update allrice_messages set status='failed',error_code=${code},content=${json({ text: 'Retained complete answer', citations: [], ...(receipt ? { modelFailureCategory: 'unknown' } : {}) })} where id=${f.assistant}`;
    }
    return { ...f, idempotencyKey };
  }
  beforeAll(async () => {
    db = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(db.db);
    vi.spyOn(client, 'getDiagnosticsDatabase').mockReturnValue(db.db);
    legacy = await seed('DSH_PI_AI_ERROR', raw + '\n' + sensitive.join('\n'));
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      `${legacy.reviewer.actor.id}@example.test`,
    );
    unknown = await seed('DSH_SYNTHETIC_NEW_CODE', unknownRaw, true);
    unproven = await seed(
      'DSH_SYNTHETIC_NO_FINISH',
      'Private unproven iterator failure',
    );
    recovered = await seed(null, overload, true);
    redactionFailed = await seed('DSH_PI_AI_ERROR', raw + '\u200b');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db?.close();
  });
  const request = (f: Fixture, suffix = '', init?: RequestInit) =>
    new Request(
      `http://localhost/api/v1/runs/${f.run}${suffix}?workspaceId=${f.workspace}`,
      init,
    );
  const route = (f: Fixture) => ({ params: Promise.resolve({ id: f.run }) });
  async function publicBody(response: Response, status = 200) {
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(body).not.toContain(raw);
    expect(body).not.toContain(unknownRaw);
    expect(body).not.toContain(secret);
    expect(body).not.toContain('upstreamMessage');
    for (const item of sensitive) expect(body).not.toContain(item);
    return body;
  }
  for (const kind of ['legacy', 'unknown', 'unproven'] as const) {
    const fixture = () => ({ legacy, unknown, unproven })[kind];
    it(`${kind}: public Run GET returns safe advice with the unchanged code`, async () => {
      const f = fixture();
      auth.context = f.owner;
      const body = await publicBody(await runGet(request(f), route(f)));
      expect(body).toContain(f.run);
      expect(body).toContain('管理员');
      if (kind === 'unknown')
        expect(body).toContain('模型服务返回了未归类的错误');
      if (kind === 'unproven') {
        expect(body).not.toContain('Private unproven iterator failure');
        expect(body).not.toContain('模型服务返回');
        expect(body).toContain('结果尚待确认');
      }
    });
    for (const accept of ['application/json', 'text/event-stream']) {
      it(`${kind}: public events ${accept} cannot leak raw through envelope or nested metadata`, async () => {
        const f = fixture();
        auth.context = f.owner;
        const body = await publicBody(
          await eventsGet(
            request(f, '/events', { headers: { accept } }),
            route(f),
          ),
        );
        expect(body).toContain('管理员');
        if (kind === 'unproven')
          expect(body).not.toContain('Private unproven iterator failure');
      });
    }
  }
  it('POST replay returns a safe snapshot and terminal cancellation keeps its conflict contract', async () => {
    for (const f of [legacy, unknown, unproven]) {
      auth.context = f.owner;
      const replay = await publicBody(
        await runPost(
          new Request('http://localhost/api/v1/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: f.workspace,
              idempotencyKey: f.idempotencyKey,
              type: 'synthetic.model.failure',
              input: {},
            }),
          }),
        ),
      );
      expect(JSON.parse(replay)).toMatchObject({
        idempotentReplay: true,
        run: { status: 'failed' },
      });
      const cancelled = await publicBody(
        await cancelPost(
          request(f, '/cancel', {
            method: 'POST',
            headers: {
              origin: 'http://localhost',
              'content-type': 'application/json',
            },
            body: '{}',
          }),
          route(f),
        ),
        409,
      );
      expect(JSON.parse(cancelled).error.code).toBe('CONFLICT');
      const unchanged = JSON.parse(
        await publicBody(await runGet(request(f), route(f))),
      );
      expect(unchanged.run.status).toBe('failed');
    }
  });
  it('message reread retains the complete reply and only exposes the server-derived category', async () => {
    for (const f of [legacy, unknown]) {
      auth.context = f.owner;
      const body = await publicBody(
        await sessionGet(
          new Request(
            `http://localhost/api/v1/sessions/${f.session.id}?workspaceId=${f.workspace}`,
          ),
          { params: Promise.resolve({ id: f.session.id }) },
        ),
      );
      const message = JSON.parse(body).history.messages.find(
        (m: { id: string }) => m.id === f.assistant,
      );
      expect(message.content).toMatchObject({
        text: 'Retained complete answer',
        modelFailureCategory: f === legacy ? 'auth' : 'unknown',
      });
    }
  });
  it('the real terminal write stores the safe receipt and retains an already completed reply', async () => {
    const f = await seed(null, 'Synthetic only');
    const workerId = randomUUID(),
      leaseToken = randomUUID();
    const [job] =
      await db.db`update allrice_jobs set status='running',attempt=1,worker_id=${workerId},lease_token=${leaseToken},claimed_at=now(),heartbeat_at=now(),lease_expires_at=now()+interval '10 minutes',completed_at=null where run_id=${f.run} returning id`;
    await db.db`update allrice_runs set state='running',completed_at=null where id=${f.run}`;
    await db.db`update allrice_employee_runs set status='running',completed_at=null where run_id=${f.run}`;
    await db.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${f.run},1,'assistant.text.completed',${json({ messageId: f.assistant, attempt: 1, text: 'Completed answer survives', sourceEventType: 'assistant/message', nativePayload: { contentTypes: ['text'] } })}),
      (${f.org},${f.workspace},${f.run},2,'harness.native',${json({ source: 'dsh', sourceEventId: 'dsh:14', sourceEventType: 'assistant/attempt', attempt: 1, nativePayload: { modelFailure: { category: 'unknown', code: 'FUTURE_TERMINAL', upstreamMessage: unknownRaw + ' ' + secret } } })})`;
    expect(
      await failJob({
        workerId,
        jobId: job!.id,
        leaseToken,
        code: 'DSH_FUTURE_TERMINAL',
        message: unknownRaw + ' ' + secret,
        retryable: false,
      }),
    ).toEqual({ retrying: false });
    const [stored] =
      await db.db`select error_code,error_message,state from allrice_runs where id=${f.run}`;
    expect(stored).toMatchObject({
      state: 'failed',
      error_code: 'DSH_FUTURE_TERMINAL',
    });
    expect(stored!.error_message).toContain(unknownRaw);
    expect(stored!.error_message).not.toContain(secret);
    auth.context = f.owner;
    const result = JSON.parse(
      await publicBody(await runGet(request(f), route(f))),
    );
    expect(result.run.error.message).toContain('模型服务返回了未归类的错误');
    const history = JSON.parse(
      await publicBody(
        await sessionGet(
          new Request(
            `http://localhost/api/v1/sessions/${f.session.id}?workspaceId=${f.workspace}`,
          ),
          { params: Promise.resolve({ id: f.session.id }) },
        ),
      ),
    );
    expect(
      history.history.messages.find((m: { id: string }) => m.id === f.assistant)
        .content,
    ).toMatchObject({
      text: 'Completed answer survives',
      modelFailureCategory: 'unknown',
    });
  });
  it('unproven historical DSH_UNKNOWN and platform TURN_FAILED remain safe without a model claim', async () => {
    auth.context = unproven.owner;
    for (const code of ['DSH_UNKNOWN', 'DSH_TURN_FAILED']) {
      await db.db`update allrice_runs set error_code=${code} where id=${unproven.run}`;
      const result = JSON.parse(
        await publicBody(await runGet(request(unproven), route(unproven))),
      );
      expect(result.run.error.code).toBe(code);
      expect(result.run.error.message).not.toContain(
        'Private unproven iterator failure',
      );
      expect(result.run.error.message).not.toContain('模型服务返回');
    }
    await db.db`update allrice_runs set error_code='DSH_SYNTHETIC_NO_FINISH' where id=${unproven.run}`;
  });
  it('the public scheduled-task history reads the same proven category without selecting the original', async () => {
    const f = unknown,
      taskId = randomUUID();
    const [session] =
      await db.db`select employee_assignment_id from allrice_chat_sessions where id=${f.session.id}`;
    await db.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,next_run_at)
      values(${taskId},${f.org},${f.workspace},${f.user},'Synthetic historical task','Synthetic only','schedule',${json({ frequency: 'daily', time: '09:00', timezone: 'UTC' })},'enabled','reuse',${session!.employee_assignment_id},${f.session.id},'2099-01-01T09:00:00Z')`;
    await db.db`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,status,run_id,session_id,error_code,error_message)
      values(${randomUUID()},${f.org},${f.workspace},${taskId},'2026-11-03T09:00:00Z','failed',${f.run},${f.session.id},'DSH_SYNTHETIC_NEW_CODE',${unknownRaw + ' ' + secret})`;
    const login = await createSession(f.user);
    auth.context = await authenticateSession(login.token, {
      organizationId: f.org,
      workspaceId: f.workspace,
    });
    expect(auth.context).not.toBeNull();
    const body = await publicBody(
      await taskGet(
        new Request(
          `http://localhost/api/v1/scheduled-tasks/${taskId}?workspaceId=${f.workspace}`,
        ),
        { params: Promise.resolve({ taskId }) },
      ),
    );
    expect(JSON.parse(body).occurrences[0].errorMessage).toContain(
      '模型服务返回了未归类的错误',
    );
    const [selected] =
      await db.db`select ${terminalModelFailureCategorySql(db.db)} category from allrice_runs r where r.id=${f.run} and r.organization_id=${f.org} and r.workspace_id=${f.workspace}`;
    expect(selected!.category).toBe('unknown');
  });
  it('rejects a member and tenant admin at the actual platform-admin API', async () => {
    for (const role of ['member', 'admin'] as const) {
      await db.db`update allrice_memberships set role=${role} where user_id=${legacy.owner.actor.id} and workspace_id=${legacy.workspace}`;
      auth.context = {
        ...legacy.owner,
        memberships: legacy.owner.memberships.map((m) => ({ ...m, role })),
      };
      const response = await adminGet(
        new Request('http://localhost/api/v1/admin/technical-assistant'),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(raw);
    }
    await db.db`update allrice_memberships set role='member' where user_id=${legacy.owner.actor.id} and workspace_id=${legacy.workspace}`;
  });
  it('the existing platform admin API safely displays legacy, new-code and recovered root attempt receipts', async () => {
    auth.context = legacy.reviewer;
    const response = await adminGet(
      new Request('http://localhost/api/v1/admin/technical-assistant'),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(raw);
    expect(body).toContain(unknownRaw);
    expect(body).toContain(overload);
    expect(body).not.toContain(secret);
    for (const item of sensitive) expect(body).not.toContain(item);
    expect(body).not.toContain('Private unproven iterator failure');
    const rows = JSON.parse(body).diagnostics.runs.value;
    expect(
      rows.find((row: { runId: string }) => row.runId === redactionFailed.run),
    ).toMatchObject({
      modelFailures: [{ upstreamMessage: '原文无法安全展示' }],
    });
    expect(
      rows.find((row: { runId: string }) => row.runId === recovered.run),
    ).toMatchObject({
      status: 'succeeded',
      modelFailures: [{ category: 'service' }],
    });
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      `${legacy.owner.actor.id}@example.test`,
    );
    auth.context = legacy.owner;
    // Public APIs retain the same restricted surface even for a platform admin.
    expect(
      await publicBody(
        await eventsGet(
          request(legacy, '/events', {
            headers: { accept: 'application/json' },
          }),
          route(legacy),
        ),
      ),
    ).not.toContain(raw);
  });
  it('counts only distinct confirmed root attempts in the existing display JSONB, with no raw selected', async () => {
    const counts = await db.db`
      with attempts as (
        select distinct on (run_id,coalesce(payload->>'attempt',''),payload->>'sourceEventId')
          run_id,occurred_at,payload#>>'{nativePayload,modelFailure,category}' category
        from allrice_run_events
        where event_type='harness.native' and payload->>'source'='dsh'
          and payload->>'sourceEventType'='assistant/attempt'
          and payload->>'sourceEventId' ~ '^dsh:[0-9]+$'
          and payload#>>'{nativePayload,modelFailure,category}' in ('auth','quota','rate_limit','service','transport','context','unknown')
        order by run_id,coalesce(payload->>'attempt',''),payload->>'sourceEventId',sequence
      ) select category,count(*)::int as attempts from attempts group by category order by category`;
    expect([...counts]).toEqual([
      { category: 'service', attempts: 1 },
      { category: 'unknown', attempts: 2 },
    ]);
  });
});
