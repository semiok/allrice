import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  PlatformEmployeeDefinitionSchema,
  type PlatformEmployeeDefinition,
  type SkillBundle,
} from '@allrice/contracts';
import type * as DatabaseClient from './core/client.ts';
import {
  compilePlatformEmployee,
  listPlatformNativeSkills,
  completePlatformEmployeeTestRun,
  publishPlatformEmployee,
  queuePlatformEmployeeTestRun,
  rollbackPlatformEmployee,
  savePlatformEmployeeDraft,
} from './employees/platform-employees.ts';
import { skillBundleChecksum, skillBytesChecksum } from './skill-bundles.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import { freezeSessionModelSnapshot } from './providers/model-pool.ts';
import { getEmployeeWorkspace } from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const schema = `p18_publish_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;
let port: ReturnType<typeof postgres>;
let beforePublication: (() => Promise<void>) | undefined;
let transactions = 0;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => port,
}));

async function fixture(legacySkillIds?: string[]) {
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  const employeeId = randomUUID(),
    skillId = randomUUID(),
    revisionId = randomUUID();
  const key = `p18-${employeeId}`,
    skillName = `p18-${skillId}`;
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${ownerId},${`${ownerId}@example.test`},'Synthetic publication','not-a-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${organizationId},${key},'Synthetic publication')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'default','Synthetic publication')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${ownerId},'admin')`;
  const definition: PlatformEmployeeDefinition = {
    schemaVersion: 1,
    key,
    name: 'Synthetic publication',
    description: 'Only synthetic package authority checks',
    appearance: { avatarType: 'initials', avatarValue: 'P' },
    identity: {
      role: 'Reviewer',
      mission: 'Test',
      workStyle: 'Controlled',
      behaviorRules: ['No implicit authority'],
      safetyBoundaries: ['Synthetic only'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Synthetic platform policy.',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: legacySkillIds ?? [skillId],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: legacySkillIds
        ? [
            'workspace.file.list',
            'workspace.document.read',
            'workspace.export.create',
          ]
        : ['workspace.skill.read'],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'none',
      connectorIdentityModes: [],
      deniedCapabilities: ['secret:use'],
    },
  };
  const content = '# Synthetic reviewed Skill\n';
  function bundle(version: string, text: string) {
    const bytes = Buffer.from(text);
    const payload: Omit<SkillBundle, 'checksum'> = {
      schemaVersion: 1,
      version,
      contentChecksum: skillBytesChecksum(content),
      sourceRef: `https://example.test/skill?content-sha256=${skillBytesChecksum(content).slice(7)}`,
      license: 'Apache-2.0',
      reviewedBy: 'Synthetic reviewer',
      resources: [
        {
          path: 'references/rules.txt',
          mediaType: 'text/plain',
          byteLength: bytes.length,
          checksum: skillBytesChecksum(bytes),
          contentBase64: bytes.toString('base64'),
        },
      ],
      dependencies: [{ kind: 'tool', name: 'workspace.skill.read' }],
    };
    return { ...payload, checksum: skillBundleChecksum(payload) };
  }
  const a = bundle('1.0.0', 'Reviewed A\n'),
    b = bundle('1.1.0', 'Reviewed B\n');
  async function catalog(value: SkillBundle) {
    await db`insert into allrice_platform_dsh_skills(id,name,description,content,checksum,required_tool_refs,source,source_ref,version,license,review_status,reviewed_by_label,reviewed_at,bundle)
      values(${skillId},${skillName},'Synthetic resource',${content},${skillBytesChecksum(content)},${db.json(['workspace.skill.read'])},'allrice',${value.sourceRef},${value.version},${value.license},'reviewed',${value.reviewedBy},'2026-09-08T00:00:00Z',${db.json(value)})
      on conflict(id) do update set version=excluded.version,bundle=excluded.bundle`;
    await db`insert into allrice_platform_skill_bundle_versions(skill_id,version,checksum,bundle)
      values(${skillId},${value.version},${value.checksum},${db.json(value)}) on conflict do nothing`;
  }
  await catalog(a);
  await db`insert into allrice_platform_employees(id,employee_key,name,description,status) values(${employeeId},${key},'Synthetic publication','Synthetic only','draft')`;
  await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum)
    values(${revisionId},${employeeId},1,'draft',${db.json(definition)},${skillBytesChecksum(JSON.stringify(definition))})`;
  await db`update allrice_platform_employees set current_draft_revision_id=${revisionId} where id=${employeeId}`;
  await db`update allrice_provider_status set status='connected',checked_at=clock_timestamp() where provider='codex'`;
  async function preview() {
    // Queue through the real public API to capture its exact immutable inputs.
    // Only model completion is synthetic; this test never invokes a provider.
    const result = await queuePlatformEmployeeTestRun(employeeId, {
      workspaceId,
      prompt: 'Review the synthetic resource.',
    });
    expect(result.queued).toBe(true);
    const id = result.testRun!.id;
    await db`update allrice_platform_employee_test_runs set status='running',started_at=clock_timestamp(),timeout_at=clock_timestamp()+interval '5 minutes' where id=${id}`;
    const done = await completePlatformEmployeeTestRun(id, {
      answer: 'Synthetic reviewed.',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      threadId: null,
      usage: null,
      events: [],
      error: null,
    });
    expect(done.status).toBe('succeeded');
    const [row] =
      await db`select frozen_package_checksum from allrice_platform_employee_test_runs where id=${id}`;
    return {
      id,
      checksum: row!.frozen_package_checksum as string,
      revisionId: result.testRun!.revisionId,
    };
  }
  const publish = () =>
    publishPlatformEmployee(employeeId, { workspaceIds: [workspaceId] });
  const revision = async (id: string = revisionId) =>
    (
      await db`select * from allrice_platform_employee_revisions where id=${id}`
    )[0]!;
  const assigned = async () =>
    (
      await db`select count(*)::integer as count from allrice_platform_employee_tenant_assignments where employee_id=${employeeId}`
    )[0]!.count;
  return {
    organizationId,
    workspaceId,
    ownerId,
    employeeId,
    revisionId,
    definition,
    a,
    b,
    catalog,
    preview,
    publish,
    revision,
    assigned,
  };
}

suite('P18 exact package publication authority with real PostgreSQL', () => {
  beforeAll(async () => {
    const base = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!base) throw Error('Explicit test database required');
    const url = new URL(base);
    url.search = '';
    admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907,1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema "${schema}"`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), {
      max: 8,
      onnotice: () => {},
      connection: { application_name: schema },
    });
    // Deterministic interleaving between the real compilation transaction and
    // real publication transaction. No query/result/authority is mocked.
    port = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'begin')
          return async (...args: unknown[]) => {
            if (beforePublication && ++transactions === 2) {
              const interleave = beforePublication;
              beforePublication = undefined;
              await interleave();
            }
            return Reflect.apply(target.begin, target, args);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
  }, 120000);
  afterEach(() => {
    beforePublication = undefined;
    transactions = 0;
  });
  afterAll(async () => {
    await db?.end({ timeout: 5 });
    if (admin && /^p18_publish_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
  });
  it('uses the published model in existing chats, repairs stale provider/auth caches, and keeps previously frozen snapshots intact', async () => {
    const f = await fixture();
    await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const [assignment] =
      await db`select * from allrice_employee_assignments where workspace_id=${f.workspaceId} and user_id=${f.ownerId}`;
    const sessionId = randomUUID();
    await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${sessionId},${f.organizationId},${f.workspaceId},${f.ownerId},'Synthetic existing chat',${assignment!.id},${assignment!.employee_version_id})`;
    const scope = {
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      sessionId,
    };
    const original = await freezeSessionModelSnapshot(scope);
    const legacy = {
      ...original,
      provider: 'gemini',
      model: '3.8flash',
      authMode: 'chatgpt_subscription',
    };
    await db`update allrice_session_model_snapshots set snapshot=${db.json(legacy)} where session_id=${sessionId}`;
    const repaired = await freezeSessionModelSnapshot(scope);
    expect(repaired).toMatchObject({
      provider: 'openai-codex',
      model: f.definition.modelPolicy.model,
      authMode: 'chatgpt_subscription',
      reasoningEffort: 'xhigh',
    });
    expect(legacy).toMatchObject({ provider: 'gemini', model: '3.8flash' });

    const changed = {
      ...f.definition,
      modelPolicy: {
        ...f.definition.modelPolicy,
        reasoningEffort: 'high' as const,
      },
    };
    await savePlatformEmployeeDraft(f.employeeId, { definition: changed });
    await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const context = {
      actor: { type: 'user' as const, id: f.ownerId },
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      authenticatedAt: new Date().toISOString(),
      memberships: [
        {
          id: randomUUID(),
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          userId: f.ownerId,
          role: 'admin' as const,
          active: true,
        },
      ],
    };
    const workspace = await getEmployeeWorkspace(context, f.workspaceId);
    expect(
      workspace.sessions.find((item) => item.id === sessionId),
    ).toMatchObject({
      employeeName: f.definition.name,
      running: false,
    });
    expect(
      workspace.sessions.find((item) => item.id === sessionId)
        ?.pendingInteraction,
    ).toBeUndefined();

    expect(
      workspace.sessionModels.find((x) => x.sessionId === sessionId),
    ).toMatchObject({ provider: 'openai-codex', reasoningEffort: 'high' });
    const next = await freezeSessionModelSnapshot(scope);
    expect(next.reasoningEffort).toBe('high');
    expect(original.reasoningEffort).toBe('xhigh');
    // Preparing a Run already bound to the prior employee version cannot rewind
    // the current Session's model cache after a concurrent publication.
    const boundOld = await freezeSessionModelSnapshot({
      ...scope,
      employeeVersionId: assignment!.employee_version_id,
    });
    expect(boundOld.reasoningEffort).toBe('xhigh');
    const [current] =
      await db`select snapshot from allrice_session_model_snapshots where session_id=${sessionId}`;
    expect(current!.snapshot.reasoningEffort).toBe('high');
    await expect(
      freezeSessionModelSnapshot({ ...scope, workspaceId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Non-platform legacy employees keep their explicit frozen route, including
    // unsupported historical auth (which still cannot authorize execution).
    const plain = workspace.employees.find(
      (employee) => employee.id !== assignment!.id,
    )!;
    const legacyId = randomUUID();
    await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${legacyId},${f.organizationId},${f.workspaceId},${f.ownerId},'Synthetic legacy chat',${plain.id},${plain.currentVersion.id})`;
    const legacyScope = { ...scope, sessionId: legacyId };
    const legacySnapshot = {
      ...(await freezeSessionModelSnapshot(legacyScope)),
      provider: 'gemini',
      model: '3.8flash',
      authMode: 'chatgpt_subscription',
    };
    await db`update allrice_session_model_snapshots set snapshot=${db.json(legacySnapshot)} where session_id=${legacyId}`;
    expect(await freezeSessionModelSnapshot(legacyScope)).toEqual(
      legacySnapshot,
    );
  });
  it('does not publish resource B using the successful trial for resource A on the same draft', async () => {
    const f = await fixture(),
      trial = await f.preview();
    await f.catalog(f.b);
    const result = await f.publish();
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('确切运行包');
    expect(await f.assigned()).toBe(0);
    expect(
      (await f.revision()).runtime_profile.runtimePackage.checksum,
    ).not.toBe(trial.checksum);
    expect(
      (
        await db`select frozen_package_checksum from allrice_platform_employee_test_runs where id=${trial.id}`
      )[0]!.frozen_package_checksum,
    ).toBe(trial.checksum);
  });
  it('keeps a legacy success without an exact package hash as history, not release authority', async () => {
    const f = await fixture(),
      trial = await f.preview();
    await db`update allrice_platform_employee_test_runs set frozen_package_checksum=null where id=${trial.id}`;
    expect((await f.publish()).valid).toBe(false);
    expect(await f.assigned()).toBe(0);
    expect(
      (
        await db`select status from allrice_platform_employee_test_runs where id=${trial.id}`
      )[0]!.status,
    ).toBe('succeeded');
  });
  it('rejects a different current draft between preliminary gates and the publication transaction', async () => {
    const f = await fixture();
    await f.preview();
    beforePublication = async () => {
      await savePlatformEmployeeDraft(f.employeeId, {
        definition: { ...f.definition, systemPrompt: 'New untested policy.' },
      });
      await compilePlatformEmployee(f.employeeId);
    };
    await expect(f.publish()).rejects.toThrow(
      'platform_employee_publish_snapshot_changed',
    );
    expect(await f.assigned()).toBe(0);
    expect(
      (
        await db`select current_draft_revision_id from allrice_platform_employees where id=${f.employeeId}`
      )[0]!.current_draft_revision_id,
    ).not.toBe(f.revisionId);
  });
  it('rejects recompilation of the same draft to a different bundle after preliminary gates', async () => {
    const f = await fixture();
    await f.preview();
    beforePublication = async () => {
      await f.catalog(f.b);
      await compilePlatformEmployee(f.employeeId);
    };
    await expect(f.publish()).rejects.toThrow(
      'platform_employee_publish_snapshot_changed',
    );
    expect(await f.assigned()).toBe(0);
  });
  it('preserves rollback A and requires a genuinely new saved draft before the next legal release', async () => {
    const f = await fixture();
    await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const originalA = await f.revision();
    await f.catalog(f.b);
    await savePlatformEmployeeDraft(f.employeeId, { definition: f.definition });
    const trialB = await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const originalB = await f.revision(trialB.revisionId);
    await rollbackPlatformEmployee(f.employeeId, {
      revisionId: f.revisionId,
      reason: 'Synthetic exact rollback.',
    });
    await expect(compilePlatformEmployee(f.employeeId)).rejects.toThrow(
      'platform_employee_published_revision_immutable',
    );
    expect(await f.revision()).toEqual(originalA);
    await savePlatformEmployeeDraft(f.employeeId, { definition: f.definition });
    const nextTrial = await f.preview();
    expect(nextTrial.revisionId).not.toBe(f.revisionId);
    expect(nextTrial.revisionId).not.toBe(trialB.revisionId);
    expect((await f.publish()).valid).toBe(true);
    expect(await f.revision()).toEqual(originalA);
    expect(await f.revision(trialB.revisionId)).toEqual(originalB);
  });
  it.each(['workspace', 'organization', 'provider', 'test'] as const)(
    'rechecks %s authority inside the publication transaction',
    async (kind) => {
      const f = await fixture(),
        trial = await f.preview();
      beforePublication = async () => {
        if (kind === 'workspace')
          await db`update allrice_workspaces set archived_at=clock_timestamp() where id=${f.workspaceId}`;
        if (kind === 'organization')
          await db`update allrice_organizations set archived_at=clock_timestamp() where id=${f.organizationId}`;
        if (kind === 'provider')
          await db`update allrice_provider_status set status='disconnected' where provider='codex'`;
        if (kind === 'test')
          await db`update allrice_platform_employee_test_runs set completed_at=clock_timestamp()-interval '25 hours' where id=${trial.id}`;
      };
      const reason = kind === 'organization' ? 'workspace' : kind;
      await expect(f.publish()).rejects.toThrow(
        `platform_employee_publish_${reason}_unavailable`,
      );
      expect(await f.assigned()).toBe(0);
    },
  );
  it('expires the proof using DB wall time after a real row-lock wait, not transaction start time', async () => {
    const f = await fixture(),
      trial = await f.preview();
    await db`update allrice_platform_employee_test_runs set completed_at=clock_timestamp()-interval '24 hours'+interval '2 seconds' where id=${trial.id}`;
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db.begin(async (tx) => {
      await tx`select id from allrice_platform_employee_test_runs where id=${trial.id} for update`;
      locked();
      await release;
    });
    await ready;
    const publication = f.publish();
    const rejected = expect(publication).rejects.toThrow(
      'platform_employee_publish_test_unavailable',
    );
    try {
      let sawWait = false;
      for (let i = 0; i < 100; i++) {
        const [state] = await admin<
          { waiting: boolean }[]
        >`select exists(select 1 from pg_stat_activity where application_name=${schema} and wait_event_type='Lock' and query like '%allrice_platform_employee_test_runs%' and query like '%for share%') as waiting`;
        if (state?.waiting) {
          sawWait = true;
          break;
        }
        await delay(20);
      }
      expect(sawWait).toBe(true);
      await admin`select pg_sleep(2.1)`;
    } finally {
      unlock();
      await blocker;
    }
    await rejected;
    expect(await f.assigned()).toBe(0);
  }, 15000);
  it('rolls back tenant materialization and publication audit when proof expires before commit', async () => {
    const f = await fixture(),
      trial = await f.preview();
    const functionName = `p18_audit_delay_${randomUUID().replaceAll('-', '')}`;
    await db.unsafe(`create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.employee_id = '${f.employeeId}'::uuid and new.action = 'employee.published' then
          perform pg_sleep(2.1);
        end if;
        return new;
      end; $$`);
    await db.unsafe(`create trigger ${functionName} before insert on allrice_platform_employee_audit_events
      for each row execute function ${functionName}()`);
    try {
      await db`update allrice_platform_employee_test_runs set completed_at=clock_timestamp()-interval '24 hours'+interval '2 seconds' where id=${trial.id}`;
      await expect(f.publish()).rejects.toThrow(
        'platform_employee_publish_test_unavailable',
      );
      expect(await f.assigned()).toBe(0);
      expect(
        (
          await db`select count(*)::integer as count from allrice_employee_versions where organization_id=${f.organizationId}`
        )[0]!.count,
      ).toBe(0);
      expect(
        (
          await db`select count(*)::integer as count from allrice_platform_employee_audit_events where employee_id=${f.employeeId} and action='employee.published'`
        )[0]!.count,
      ).toBe(0);
      expect((await f.revision()).status).toBe('testing');
      expect(
        (
          await db`select current_published_revision_id from allrice_platform_employees where id=${f.employeeId}`
        )[0]!.current_published_revision_id,
      ).toBeNull();
    } finally {
      await db.unsafe(
        `drop trigger ${functionName} on allrice_platform_employee_audit_events`,
      );
      await db.unsafe(`drop function ${functionName}()`);
    }
  }, 15000);

  it('migrates both legacy Office bindings on the next draft, preserving published and queued packages and rollback', async () => {
    const catalog = await loadPlatformContentCatalog();
    const office = catalog.skills.find((skill) => skill.name === 'office')!;
    const f = await fixture(office.replaces);
    const oldTrial = await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const published = await f.revision();
    const [queuedBefore] =
      await db`select * from allrice_platform_employee_test_runs where id=${oldTrial.id}`;

    await synchronizePlatformContent(catalog);
    const choices = await listPlatformNativeSkills();
    expect(choices.find((skill) => skill.id === office.id)?.replaces).toEqual(
      office.replaces,
    );
    expect(choices.some((skill) => office.replaces!.includes(skill.id))).toBe(
      false,
    );
    await savePlatformEmployeeDraft(f.employeeId, { definition: f.definition });
    const nextTrial = await f.preview();
    const next = await f.revision(nextTrial.revisionId);
    expect(next.definition.capabilities.nativeSkillIds).toEqual([office.id]);
    expect(next.definition.capabilities.toolNames).toEqual(
      expect.arrayContaining(office.requiredToolRefs),
    );
    expect(
      next.runtime_profile.runtimePackage.skills.map(
        (skill: { name: string }) => skill.name,
      ),
    ).toEqual(['office']);
    expect((await f.publish()).valid).toBe(true);
    expect(await f.revision()).toEqual(published);
    expect(
      (
        await db`select * from allrice_platform_employee_test_runs where id=${oldTrial.id}`
      )[0],
    ).toEqual(queuedBefore);
    await rollbackPlatformEmployee(f.employeeId, {
      revisionId: f.revisionId,
      reason: 'Office compatibility regression check',
    });
    expect(await f.revision()).toEqual(published);
    await expect(compilePlatformEmployee(f.employeeId)).rejects.toThrow(
      'platform_employee_published_revision_immutable',
    );
  });

  it('upgrades an existing uncompiled legacy draft, while respecting explicit storage denial', async () => {
    const catalog = await loadPlatformContentCatalog();
    const office = catalog.skills.find((skill) => skill.name === 'office')!;
    await synchronizePlatformContent(catalog);
    const f = await fixture(office.replaces);
    expect((await compilePlatformEmployee(f.employeeId)).valid).toBe(true);
    const compiled = await f.revision();
    expect(compiled.definition.capabilities.nativeSkillIds).toEqual([
      office.id,
    ]);
    expect(compiled.checksum).toBe(
      skillBytesChecksum(
        JSON.stringify(
          PlatformEmployeeDefinitionSchema.parse(compiled.definition),
        ),
      ),
    );
    await savePlatformEmployeeDraft(f.employeeId, {
      definition: {
        ...f.definition,
        securityPolicy: {
          ...f.definition.securityPolicy,
          deniedCapabilities: ['storage:write'],
        },
      },
    });
    const blocked = await compilePlatformEmployee(f.employeeId);
    expect(blocked.valid).toBe(false);
    expect(blocked.errors.join(' ')).toContain('storage:write');
  });
});
