import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStorageAdapter } from '@allrice/storage';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
import type * as Client from './core/client.ts';
import { createExperienceStore } from './experience.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { collectPendingExperienceEvidence } from './experience-evidence.ts';
import {
  prepareEmployeeInstanceSnapshot,
  createEmployeeInstance,
} from './employees/employee-instances.ts';
import {
  createChatSession,
  deleteWorkspaceMemory,
  searchWorkspaceMemories,
} from './workspace/service.ts';
import { searchToolBrokerMemories } from './execution/tool-broker.ts';
import { embedWorkspaceText } from './workspace/memory-recall.ts';
import {
  listCompanyRuleSources,
  mutateCompanyAsset,
} from './company-assets.ts';
let storageRoot: string;
let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p20_experience_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const store = createExperienceStore();
type Fixture = Awaited<ReturnType<typeof createExperienceFixture>>;
const feedback = '刚才的对账报告漏了退款，核对时需要单列退款再汇总净回款。';
async function fixture() {
  const f = await createExperienceFixture(db);
  for (const context of [f.owner, f.reviewer, f.neighbor])
    await db`insert into allrice_sessions(id,user_id,token_hash,expires_at)
      values(${context.sessionId},${context.actor.id},${randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')},clock_timestamp()+interval '1 day')`;
  return f;
}
async function pending(f: Fixture, text = feedback) {
  const [r] = await db<
    { employee_assignment_id: string; employee_version_id: string }[]
  >`
    select employee_assignment_id,employee_version_id from allrice_employee_runs where run_id=${f.run}`;
  const instance = await prepareEmployeeInstanceSnapshot(
    f.owner,
    f.session.id,
    r!.employee_assignment_id,
    r!.employee_version_id,
  );
  // Real admission freezes a new Run; never rewrite the prior immutable snapshot.
  const previous = f.run;
  f.run = randomUUID();
  f.message = randomUUID();
  f.assistant = randomUUID();
  f.input = { ...f.input, runId: f.run, messageId: f.message };
  await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status)
    values(${f.message},${f.org},${f.workspace},${f.session.id},${f.user},'user',${db.json({ text, citations: [] })},'completed'),
      (${f.assistant},${f.org},${f.workspace},${f.session.id},${f.user},'assistant','{"text":"Feedback received","citations":[]}','completed')`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
    values(${f.run},${f.org},${f.workspace},${f.user},'succeeded','{}','{}')`;
  await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,
    employee_version_id,session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot,
    execution_snapshot,experience_capture_state)
    select ${f.run},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,
      ${f.message},${f.assistant},'succeeded',clock_timestamp(),provider_snapshot,prompt_snapshot,${db.json({ instance })},'pending'
    from allrice_employee_runs where run_id=${previous}`;
  return instance;
}
async function candidate(f: Fixture) {
  return (await store.list(f.owner)).find((c) => c.source?.runId === f.run);
}
async function replay(f: Fixture) {
  await db`update allrice_employee_runs set experience_capture_state='pending' where run_id=${f.run}`;
  return collectPendingExperienceEvidence({ database: db, limit: 16 });
}
function execution(f: Fixture): ExecutionContext {
  return {
    executionId: randomUUID(),
    runId: f.run,
    jobId: randomUUID(),
    worker: { type: 'worker', id: 'test' },
    delegatedBy: f.owner.actor,
    organizationId: f.org,
    workspaceId: f.workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: randomUUID(),
      organizationId: f.org,
      subjectId: f.user,
      version: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      memberships: f.owner.memberships,
      grants: [
        {
          resourceType: 'memory',
          action: 'resource:read',
          workspaceId: f.workspace,
        },
      ],
    },
  };
}
suite('MET183 incremental evidence — isolated database, no model', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-experience-evidence-'));
    const value = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!value) throw Error('Explicit dedicated test DB required');
    const url = new URL(value);
    if (!(
      (url.hostname === '127.0.0.1' &&
        url.port === '5432' &&
        url.pathname === '/allrice_b2' &&
        url.username === 'a123') ||
      (url.hostname === '127.0.0.1' &&
        url.port === '54329' &&
        url.pathname === '/allrice' &&
        url.username === 'allrice')
    ))
      throw Error('Dedicated B2/CI database only');
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const extensions = await admin<
      { extname: string }[]
    >`select extname from pg_extension where extname in ('vector','pg_trgm')`;
    expect(extensions.map((e) => e.extname).sort()).toEqual([
      'pg_trgm',
      'vector',
    ]);
    await admin.unsafe(`create schema ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 5, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => n.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(name, directory), 'utf8'));
    vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
  }, 120000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.end({ timeout: 5 });
    if (admin && /^p20_experience_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema ${schema} cascade`);
    await admin?.end({ timeout: 5 });
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });
  it('captures the exact user feedback once, without legacy approval or recall, and supports cross-session lookup', async () => {
    const f = await fixture(),
      instance = await pending(f);
    await Promise.all([
      collectPendingExperienceEvidence({ database: db }),
      collectPendingExperienceEvidence({ database: db }),
    ]);
    const c = (await candidate(f))!;
    expect(c).toMatchObject({
      originKind: 'incremental',
      instanceId: instance.id,
      status: 'pending',
      canReview: false,
      content: feedback,
      source: { runId: f.run, messageId: f.message, excerpt: feedback },
      evidence: {
        kind: 'correction',
        skills: [],
        artifacts: [],
        inputs: [],
        availableKnowledge: [],
      },
    });
    await expect(
      store.review(f.owner, c.id, {
        decision: 'approve',
        expectedRevision: c.revision,
        expectedDigest: c.digest,
        reason: 'Attempt to bypass automatic validation',
      }),
    ).rejects.toMatchObject({ code: 'validation_required' });
    const next = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: 'Another session',
    });
    expect(next.id).not.toBe(f.session.id);
    expect(
      (await store.list({ ...f.owner, sessionId: next.id }, instance.id)).map(
        (x) => x.id,
      ),
    ).toEqual([c.id]);
    expect(await store.list(f.neighbor, instance.id)).toEqual([]);
    expect(await store.list(f.reviewer, instance.id)).toEqual([]);
    // Even a mistakenly inserted retrieval row cannot activate a candidate.
    await db`insert into allrice_rag_chunks(organization_id,workspace_id,memory_id,owner_id,content,embedding,visibility)
      values(${f.org},${f.workspace},${c.id},${f.user},${c.content},${`[${embedWorkspaceText(c.content).join(',')}]`}::vector,'private')`;
    expect(
      await searchWorkspaceMemories(f.owner, {
        workspaceId: f.workspace,
        query: '退款',
      }),
    ).toEqual([]);
    expect(await searchToolBrokerMemories(execution(f), '退款', 10)).toEqual(
      [],
    );
    await replay(f);
    expect((await store.list(f.owner)).map((x) => x.id)).toEqual([c.id]);
  });
  it('keeps forgotten-source exclusion across retries and policy revisions', async () => {
    const f = await fixture();
    await pending(f);
    await collectPendingExperienceEvidence({ database: db });
    const c = (await candidate(f))!;
    await deleteWorkspaceMemory(f.owner, f.workspace, c.id);
    await db`update allrice_settings set value=jsonb_set(value,'{revision}','2') where scope_type='system' and key='employee_experience_policy'`;
    await replay(f);
    expect(await candidate(f)).toMatchObject({
      id: c.id,
      archived: true,
      status: 'pending',
    });
    const [count] =
      await db`select count(*)::int n from allrice_experience_reviews where run_id=${f.run}`;
    expect(count?.n).toBe(1);
    expect(
      await db`select id from allrice_rag_chunks where memory_id=${c.id}`,
    ).toEqual([]);
  });
  it('keeps private evidence out of the legacy company rule picker and rejects direct source publication', async () => {
    const f = await fixture();
    await pending(f);
    await collectPendingExperienceEvidence({ database: db });
    const c = (await candidate(f))!;
    const sources = await listCompanyRuleSources(f.reviewer, f.org, db);
    expect(sources.sources.some((s) => s.id === c.id)).toBe(false);
    const [revision] = await db<
      { id: string }[]
    >`select id from allrice_memory_revisions where memory_id=${c.id} and revision=1`;
    await expect(
      mutateCompanyAsset(
        f.reviewer,
        f.org,
        {
          operation: 'save',
          assetId: randomUUID(),
          expectedRevision: 0,
          content: {
            kind: 'rule',
            title: 'Cannot promote private evidence',
            body: feedback,
            category: '运营',
            appliesToEmployeeIds: [],
            taskKeywords: [],
            slots: [],
            sourceMemoryId: c.id,
            sourceMemoryRevisionId: revision!.id,
          },
        },
        new LocalStorageAdapter(storageRoot),
        true,
        db,
      ),
    ).rejects.toMatchObject({ code: 'source_changed' });
    expect(
      await db`select id from allrice_company_assets where organization_id=${f.org}`,
    ).toEqual([]);
    expect((await candidate(f))?.status).toBe('pending');
  });
  it('supports withdrawal while keeping immutable origin and completed legacy history', async () => {
    const f = await fixture();
    await pending(f);
    await collectPendingExperienceEvidence({ database: db });
    const c = (await candidate(f))!;
    const rejected = await store.review(f.owner, c.id, {
      decision: 'reject',
      expectedRevision: c.revision,
      expectedDigest: c.digest,
      reason: 'Forget this synthetic feedback',
    });
    expect(rejected).toMatchObject({
      archived: true,
      status: 'rejected',
      evidence: c.evidence,
    });
    await replay(f);
    expect((await candidate(f))?.id).toBe(c.id);
    await expect(
      db`update allrice_experience_reviews set source_key=${`sha256:${'0'.repeat(64)}`} where memory_id=${c.id}`,
    ).rejects.toThrow('immutable');
    const old = await fixture();
    const manual = await store.create(old.owner, old.input);
    expect(manual.originKind).toBe('manual');
    expect(manual.canReview).toBe(true);
    await store.review(old.owner, manual.id, {
      decision: 'approve',
      expectedRevision: manual.revision,
      expectedDigest: manual.digest,
      reason: 'Original manual history retained',
    });
    expect((await store.list(old.owner))[0]).toMatchObject({
      status: 'approved',
      originKind: 'manual',
      instanceId: null,
    });
  });
  it('does not backfill old messages, old pending manual candidates or unmarked terminal Runs', async () => {
    const old = await fixture();
    const manual = await store.create(old.owner, old.input);
    await collectPendingExperienceEvidence({ database: db });
    expect((await store.list(old.owner))[0]).toMatchObject({
      id: manual.id,
      status: 'pending',
      originKind: 'manual',
    });
    const f = await fixture();
    await pending(f);
    await db`update allrice_messages set created_at='2020-01-01' where id=${f.message}`;
    await collectPendingExperienceEvidence({ database: db });
    expect(await candidate(f)).toBeUndefined();
    const [state] =
      await db`select experience_capture_reason reason from allrice_employee_runs where run_id=${f.run}`;
    expect(state?.reason).toBe('source_ineligible');
  });
  it.each(['method', 'quote', 'temporary', 'long-term', 'model', 'ordinary'])(
    'does not collect ineligible %s text',
    async (kind) => {
      const f = await fixture();
      await pending(
        f,
        kind === 'quote'
          ? `“${feedback}”`
          : kind === 'temporary'
            ? `${feedback}仅本次。`
            : kind === 'long-term'
              ? `${feedback}以后也这样做。`
              : kind === 'ordinary'
                ? '请生成一份报告。'
                : feedback,
      );
      if (kind === 'method')
        await db`update allrice_employee_runs set method_authoring=true where run_id=${f.run}`;
      if (kind === 'model')
        await db`update allrice_messages set role='assistant' where id=${f.message}`;
      await collectPendingExperienceEvidence({ database: db });
      expect(await candidate(f)).toBeUndefined();
      if (kind === 'method') {
        await expect(
          store.create(f.owner, {
            ...f.input,
            sourceExcerpt: feedback,
            content: feedback,
          }),
        ).rejects.toMatchObject({ code: 'invalid_source' });
        expect(
          (await store.sources(f.owner, f.session.id)).some(
            (s) => s.runId === f.run,
          ),
        ).toBe(false);
      }
    },
  );
  it.each(['membership', 'assignment', 'instance', 'session', 'off'])(
    'rechecks current %s before capture',
    async (kind) => {
      const f = await fixture(),
        instance = await pending(f);
      if (kind === 'membership')
        await db`update allrice_memberships set active=false where user_id=${f.user}`;
      if (kind === 'assignment')
        await db`update allrice_employee_assignments set active=false where id=${instance.assignmentId}`;
      if (kind === 'instance')
        await db`update allrice_employee_instances set archived_at=now() where id=${instance.id}`;
      if (kind === 'session')
        await db`update allrice_chat_sessions set archived_at=now() where id=${f.session.id}`;
      if (kind === 'off')
        await db`insert into allrice_settings(scope_type,scope_id,key,value)
      select 'organization',${f.org},key,jsonb_set(value,'{frequency}','"off"') from allrice_settings
      where scope_type='system' and key='employee_experience_policy'`;
      await collectPendingExperienceEvidence({ database: db });
      expect(
        await db`select memory_id from allrice_experience_reviews where run_id=${f.run}`,
      ).toEqual([]);
    },
  );
  it('isolates two instances of one template and preserves source after template version changes', async () => {
    const f = await fixture(),
      instance = await pending(f);
    const other = await createEmployeeInstance(f.owner, {
      workspaceId: f.workspace,
      assignmentId: instance.assignmentId,
      requestId: randomUUID(),
      profile: { name: 'Another private instance' },
    });
    await collectPendingExperienceEvidence({ database: db });
    const c = (await candidate(f))!;
    expect(await store.list(f.owner, other.id)).toEqual([]);
    const nextVersion = randomUUID();
    await db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum)
      select ${nextVersion},organization_id,workspace_id,employee_id,version+1,name,model,system_prompt,capabilities,config_checksum
      from allrice_employee_versions where id=${instance.source.employeeVersionId}`;
    await db`update allrice_employee_assignments set employee_version_id=${nextVersion} where id=${instance.assignmentId}`;
    expect((await store.list(f.owner, instance.id))[0]).toMatchObject({
      id: c.id,
      instanceId: instance.id,
      evidence: c.evidence,
    });
    await replay(f);
    expect((await store.list(f.owner, instance.id)).map((x) => x.id)).toEqual([
      c.id,
    ]);
  });
});
