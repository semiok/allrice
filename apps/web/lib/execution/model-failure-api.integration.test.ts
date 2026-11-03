import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createExperienceFixture } from '../../../../packages/database/src/experience.fixture.ts';
const auth = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../identity/session', () => ({ getRequestContext: async () => auth.context }));
vi.mock('./platform-technical-health', () => ({ platformTechnicalHealth: async () => undefined }));
import { GET as runGet } from '../../app/api/v1/runs/[id]/route';
import { GET as eventsGet } from '../../app/api/v1/runs/[id]/events/route';
import { GET as adminGet } from '../../app/api/v1/admin/technical-assistant/route';

const suite = process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe.sequential : describe.skip;
suite('real model-failure API boundaries, isolated database and synthetic provider receipt', () => {
  let db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let f: Awaited<ReturnType<typeof createExperienceFixture>>;
  const raw = 'Your authentication token has expired';
  const secret = 'sk-synthetic-private';
  beforeAll(async () => {
    db = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(db.db);
    vi.spyOn(client, 'getDiagnosticsDatabase').mockReturnValue(db.db);
    f = await createExperienceFixture(db.db);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', `${f.reviewer.actor.id}@example.test`);
    await db.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
      values(${randomUUID()},${f.org},${f.workspace},${f.user},${f.run},'failed',${randomUUID()},now()+interval '1 hour','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}')`;
    await db.db`update allrice_runs set state='failed',error_code='DSH_PI_AI_ERROR',error_message=${raw+' '+secret},completed_at=now(),updated_at=now() where id=${f.run}`;
    await db.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${f.run},1,'run.failed',${db.db.json({code:'DSH_PI_AI_ERROR',message:raw+' '+secret,metadata:{modelFailure:{category:'auth',upstreamMessage:raw+' '+secret,nested:{raw:secret}}}})})`;
  }, 120000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db?.close(); });
  const request = (suffix = '') => new Request(`http://localhost/api/v1/runs/${f.run}${suffix}?workspaceId=${f.workspace}`);
  const route = () => ({ params: Promise.resolve({ id: f.run }) });
  it('withholds even redacted raw in the actual public Run GET and events JSON/SSE', async () => {
    auth.context = f.owner;
    const run = await runGet(request(), route());
    expect(run.status).toBe(200);
    const body = await run.text();
    expect(body).not.toContain(raw);
    expect(body).not.toContain(secret);
    expect(body).toContain('管理员');
    for (const accept of ['application/json', 'text/event-stream']) {
      const response = await eventsGet(new Request(request('/events'), { headers: { accept } }), route());
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).not.toContain(raw);
      expect(stream).not.toContain(secret);
      expect(stream).not.toContain('upstreamMessage');
      expect(stream).toContain('管理员');
    }
  });
  it('rejects a member and a tenant admin at the real platform-admin API', async () => {
    for (const role of ['member','admin'] as const) {
      auth.context = { ...f.owner, memberships: f.owner.memberships.map(m => ({...m,role})) };
      const response = await adminGet(new Request('http://localhost/api/v1/admin/technical-assistant'));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(raw);
    }
  });
  it('shows the platform administrator the safe original without returning credentials', async () => {
    auth.context = f.reviewer;
    const response = await adminGet(new Request('http://localhost/api/v1/admin/technical-assistant'));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(raw);
    expect(body).not.toContain(secret);
    expect(body).toContain('auth');
  });
});
