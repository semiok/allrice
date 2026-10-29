/** Isolated real PostgreSQL lifecycle tests. All identities, approval digests
 * and artifact bytes are synthetic. No provider, native Host or Dev API runs.
 * The dedicated fixture database guard and owned schema cleanup are mandatory. */
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RequestContextSchema,
  type EmployeeRuntimePackage,
  type StorageObject,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  runtimeFixtureStorage,
  createRuntimeFixtureDatabase,
} from '../runtime.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../platform-employees/runtime-package.ts';
import { bindJobNativeSession } from '../execution/queue.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import {
  assertWorkbenchSession,
  getWorkbenchArtifact,
  readArtifactBytes,
} from '../artifact-review.ts';
import {
  getChatSessionHistory,
  sendChatMessage,
  updateChatSession,
} from '../workspace/service.ts';
import { releaseConversationRuntimeTransaction } from './conversation-runtime.ts';
import {
  brandContentBundleDigest,
  brandContentDigest,
} from '../brand-content/rules.ts';
import {
  NativeRootOriginSchema,
  nativeRootDigest,
  newNativeGeneration,
} from './native-root-origin.ts';
import {
  readChatNativeRootOrigin,
  type NativeSessionLeaseInput,
} from './native-session-binding.ts';
import {
  applyNativeTestChatRetirement,
  nativeContextExecutionRetired,
  previewNativeTestChatRetirement,
  readNativeTestChatRetirement,
  readVerifiedNativeChatRetirements,
  type NativeTestChatRetirementScope,
} from './native-context-retirement.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const digest = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');

suite('native test chat retirement: isolated real PostgreSQL, no model', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let runtimePackage: EmployeeRuntimePackage;
  let storageRoot: string;
  beforeAll(async () => {
    // Ambient reader policies must never authorize or alter an owned fixture.
    for (const key of Object.keys(process.env))
      if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
        vi.stubEnv(key, undefined);
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const [schema] = await fixture.db`select current_schema() name`;
    expect(schema!.name).toMatch(/^p25_[a-f0-9]{32}$/);
    storageRoot = await realpath(fixture.storageRoot);
    const employee = await createEmployeeAdministrationFixture(fixture.db);
    runtimePackage = buildEmployeeRuntimePackage({
      revision: 1,
      definition: {
        ...employee.definition,
        capabilities: {
          ...employee.definition.capabilities,
          nativeSkillIds: [],
        },
      },
      skills: [],
    });
    expect(runtimePackage.runtimeManifest.distributionGeneration).toBe(
      newNativeGeneration,
    );
  }, 120_000);

  afterAll(async () => {
    try {
      if (fixture) {
        const cleanup = await fixture.close();
        expect(cleanup.schemaRemoved).toBe(true);
        expect(cleanup.storageRemoved).toBe(true);
        expect(cleanup.databaseClosed).toBe(true);
        expect(cleanup.adminClosed).toBe(true);
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  async function subject(bind = true) {
    const artifactId = digest(randomUUID());
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifactId);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifactId);
    const f = await createRunAuthorityFixture(fixture.db, {
      configure: false,
      runtimePackage,
      businessCreationOrigin: true,
    });
    const [membership] = await fixture.db`select id,role,active
      from allrice_memberships where id=${f.membership}`;
    const owner = RequestContextSchema.parse({
      ...f.context,
      memberships: [
        {
          id: membership!.id,
          role: membership!.role,
          active: membership!.active,
          userId: f.user,
          organizationId: f.org,
          workspaceId: f.workspace,
        },
      ],
    });
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    const [chat] = await fixture.db`select native_root_origin
      from allrice_chat_sessions where id=${f.session}`;
    const origin = NativeRootOriginSchema.parse(chat!.native_root_origin);
    expect(origin).toMatchObject({
      artifactId,
      contextId: f.session,
      frozenIdentity: { sourceId: f.version },
    });
    const [runtime] =
      await fixture.db`select * from allrice_conversation_runtimes
      where session_id=${f.session}`;
    const descriptor = nativeBindingDescriptor({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      contextKey: f.session,
      distributionGeneration: newNativeGeneration,
    });
    descriptor.artifactId = descriptor.artifactManifestDigest = artifactId;
    descriptor.storageNamespace = join(
      storageRoot,
      f.org,
      f.workspace,
      f.user,
      f.session,
      'sessions',
    );
    const input: NativeSessionLeaseInput = {
      workerId: f.worker.workerId,
      jobId: f.worker.jobId,
      leaseToken: f.worker.leaseToken,
      attempt: 1,
      subject: {
        kind: 'chat',
        id: f.session,
        configChecksum: runtime!.config_checksum,
        generation: runtime!.thread_generation,
        expectedThreadId: runtime!.thread_id,
      },
      descriptor,
    };
    if (bind)
      expect((await bindJobNativeSession(input)).binding.artifactId).toBe(
        artifactId,
      );
    return { ...f, origin, owner, input };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;
  const scope = (f: Subject): NativeTestChatRetirementScope => ({
    contextKind: 'chat',
    contextId: f.session,
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
  });
  const request = (scopes: NativeTestChatRetirementScope[]) => ({
    requestId: randomUUID(),
    authorizationEvidenceDigest: digest('synthetic owned-schema authorization'),
    scopes,
  });

  async function finish(f: Subject) {
    await fixture.db.begin(async (tx) => {
      await releaseConversationRuntimeTransaction(tx, {
        organizationId: f.org,
        workspaceId: f.workspace,
        sessionId: f.session,
        runId: f.rootRunId,
        workerId: f.worker.workerId,
        outcome: 'idle',
      });
      await tx`update allrice_runs set state='succeeded',completed_at=clock_timestamp()
        where id=${f.rootRunId}`;
      await tx`update allrice_employee_runs set status='succeeded',completed_at=clock_timestamp()
        where run_id=${f.rootRunId}`;
      // The actual queue schema requires the entire lease tuple to be null.
      await tx`update allrice_jobs set status='succeeded',completed_at=clock_timestamp(),
        worker_id=null,lease_token=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null
        where id=${f.worker.jobId}`;
    });
  }

  // Compare original JSON rows and actual bytes, independently of the
  // retirement helper's internal count/digest implementation.
  async function evidence(f: Subject) {
    const [session] = await fixture.db<
      { value: Record<string, postgres.JSONValue> }[]
    >`select to_jsonb(s) value
      from allrice_chat_sessions s where id=${f.session}`;
    const rows = async (value: PromiseLike<{ value: unknown }[]>) =>
      (await value).map((r) => r.value);
    return {
      session: session!.value,
      pins: await rows(fixture.db`select to_jsonb(b) value
        from allrice_native_session_bindings b where context_kind='chat'
          and context_id=${f.session} order by native_session_id`),
      messages:
        await rows(fixture.db`select to_jsonb(m) value from allrice_messages m
        where session_id=${f.session} order by id`),
      versions:
        await rows(fixture.db`select to_jsonb(v) value from allrice_deliverable_versions v
        where session_id=${f.session} order by id`),
      files:
        await rows(fixture.db`select to_jsonb(r) value from allrice_file_references r
        where session_id=${f.session} order by object_id`),
      artifacts:
        await rows(fixture.db`select to_jsonb(a) value from allrice_workbench_artifacts a
        join allrice_deliverable_versions v on v.id=a.version_id
        where v.session_id=${f.session} order by a.version_id`),
      objects:
        await rows(fixture.db`select to_jsonb(o) value from allrice_storage_objects o
        where o.id in (
          select object_id from allrice_deliverable_versions where session_id=${f.session}
          union select object_id from allrice_file_references where session_id=${f.session}
        ) order by o.id`),
      articles:
        await rows(fixture.db`select to_jsonb(a) value from allrice_brand_content_articles a
        where session_id=${f.session} order by id`),
      bundles:
        await rows(fixture.db`select to_jsonb(b) value from allrice_brand_content_bundles b
        where article_id in (select id from allrice_brand_content_articles where session_id=${f.session})
        order by id`),
    };
  }
  async function retirementRows(f: Subject) {
    const rows = await fixture.db`select to_jsonb(r) value
      from allrice_native_context_retirements r
      where context_kind='chat' and context_id=${f.session}`;
    return rows.map((r) => r.value);
  }
  async function independentArtifact(f: Subject) {
    const versionId = randomUUID();
    const objectId = randomUUID();
    const body = `Independent evidence for ${f.session}\n`;
    const object: StorageObject = {
      id: objectId,
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      key: `organizations/${f.org}/workspaces/${f.workspace}/owners/${f.user}/artifacts/${objectId}`,
      checksum: digest(body),
      sizeBytes: Buffer.byteLength(body),
      mediaType: 'text/plain',
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    };
    await runtimeFixtureStorage(fixture.db).put(
      object,
      new Blob([body]).stream(),
    );
    await fixture.db.begin(async (tx) => {
      await tx`insert into allrice_storage_objects
        (id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
        values (${object.id},${f.org},${f.workspace},${f.user},${object.key},'artifacts',
          ${object.mediaType},${object.sizeBytes},${object.checksum},'ready',true)`;
      await tx`insert into allrice_deliverable_versions
        (id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
        values (${versionId},${f.org},${f.workspace},${f.user},${object.id},${randomUUID()},
          1,${f.session},'independent-evidence.txt','text')`;
      await tx`insert into allrice_workbench_artifacts
        (version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
        values (${versionId},${f.org},${f.workspace},${f.user},${f.rootRunId},'document',
          ${tx.json({ kind: 'tool_result', runId: f.rootRunId, operationId: null, stepId: null })},
          ${randomUUID()},${object.checksum})`;
      await tx`insert into allrice_file_references
        (organization_id,workspace_id,owner_id,session_id,object_id,file_name)
        values (${f.org},${f.workspace},${f.user},${f.session},${object.id},'independent-evidence.txt')`;
    });
    return { versionId, object, body };
  }

  // A valid append to the owned synthetic pin table models a late first bind.
  // Copy real admitted metadata rather than guessing a binding schema.
  async function appendPin(f: Subject) {
    const nativeSessionId = `dsh-late-${randomUUID()}`;
    await fixture.db`insert into allrice_native_session_bindings
      select (jsonb_populate_record(null::allrice_native_session_bindings,
        to_jsonb(b) || jsonb_build_object('native_session_id',${nativeSessionId}::text,
          'bound_at',clock_timestamp()))).*
      from allrice_native_session_bindings b where native_session_id=${f.input.descriptor.nativeSessionId}`;
    return nativeSessionId;
  }

  // Clone only owned synthetic lifecycle rows for scan-size/corruption checks.
  // No trigger is disabled: pins precede the terminal retirement INSERT.
  async function copyRetiredContexts(
    tx: postgres.TransactionSql,
    f: Subject,
    ids: string[],
    change: {
      context?: Record<string, postgres.JSONValue>;
      binding?: Record<string, postgres.JSONValue>;
      retirement?: (
        origin: postgres.JSONValue,
        bindings: Record<string, postgres.JSONValue>[],
      ) => Record<string, postgres.JSONValue>;
    } = {},
  ) {
    for (const id of ids) {
      const origin = NativeRootOriginSchema.parse({
        ...f.origin,
        contextId: id,
        rootSeed: id,
      });
      await tx`insert into allrice_chat_sessions
        select (jsonb_populate_record(null::allrice_chat_sessions,to_jsonb(s) ||
          ${tx.json({ id, native_root_origin: origin, ...change.context })})).*
        from allrice_chat_sessions s where id=${f.session}`;
      await tx`insert into allrice_native_session_bindings
        select (jsonb_populate_record(null::allrice_native_session_bindings,to_jsonb(b) ||
          jsonb_build_object('native_session_id','dsh-copy-' || ${id}::text || '-' || native_session_id,
            'context_id',${id}::uuid,'storage_context_key',${id}::text,
            'storage_namespace',replace(storage_namespace,${f.session},${id}),
            'root_origin_digest',${nativeRootDigest(origin)}::text) ||
          ${tx.json(change.binding ?? {})})).*
        from allrice_native_session_bindings b where context_kind='chat' and context_id=${f.session}`;
      const pins = await tx<
        { value: Record<string, postgres.JSONValue> }[]
      >`select (to_jsonb(b)-'bound_at') || jsonb_build_object('bound_at_micros',
          (extract(epoch from b.bound_at)*1000000)::bigint::text) value
        from allrice_native_session_bindings b where context_kind='chat'
          and context_id=${id} order by native_session_id`;
      const patch = {
        context_id: id,
        request_id: randomUUID(),
        origin_snapshot: origin,
        binding_snapshot: pins.map((r) => r.value),
        ...change.retirement?.(
          origin,
          pins.map((r) => r.value),
        ),
      };
      await tx`insert into allrice_native_context_retirements
        select (jsonb_populate_record(null::allrice_native_context_retirements,to_jsonb(r) ||
          ${tx.json(patch)})).* from allrice_native_context_retirements r
        where context_kind='chat' and context_id=${f.session}`;
    }
  }

  async function observedRetirementScan() {
    return fixture.db.begin(
      'isolation level repeatable read read only',
      async (tx) => {
        await tx`set local statement_timeout='5000'`;
        const [settings] = await tx`select
          current_setting('transaction_read_only') read_only,
          current_setting('transaction_isolation') isolation`;
        const statements: string[] = [];
        const observed = new Proxy(tx, {
          apply(query, thisArg, args: unknown[]) {
            const fragments = args[0];
            if (Array.isArray(fragments) && 'raw' in fragments)
              statements.push(fragments.join('?').replaceAll(/\s+/g, ' '));
            return Reflect.apply(query, thisArg, args);
          },
        });
        const scopes = await readVerifiedNativeChatRetirements(observed);
        return { scopes, statements, settings };
      },
    );
  }

  // Seed the real deferred brand/context and article/bundle foreign-key pairs.
  // The bundle references the already existing artifact; it creates no new file,
  // message or deliverable whose ordinary preservation would catch this race.
  async function linkExistingArtifactToBrand(
    f: Subject,
    output: Awaited<ReturnType<typeof independentArtifact>>,
  ) {
    const brandId = randomUUID();
    const contextId = randomUUID();
    const topicId = randomUUID();
    const articleId = randomUUID();
    const bundleId = randomUUID();
    const context = {
      audience: 'Owned fixture readers',
      tone: 'Concrete',
      requirements: 'Synthetic evidence only; never publish.',
      visualBrief: '',
      facts: [{ id: 'owned_fixture', text: 'All content is synthetic.' }],
      sourceFiles: [],
      strategies: [],
    };
    const candidate = {
      title: 'Owned fixture article',
      angle: 'Preserve existing evidence',
      outline: 'Use the existing independent artifact.',
      audience: context.audience,
      rationale: 'Test a late business reference.',
      factIds: ['owned_fixture'],
      imageBrief: '',
      suggestedWindow: '',
    };
    const content = {
      versionId: output.versionId,
      objectId: output.object.id,
      checksum: output.object.checksum,
    };
    await fixture.db.begin(async (tx) => {
      await tx`insert into allrice_employee_instances
        (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
        values (${f.assignment},${f.org},${f.workspace},${f.user},${f.assignment},'general',${f.version})
        on conflict(id) do nothing`;
      await tx`insert into allrice_brand_content_brands
        (id,organization_id,workspace_id,owner_id,instance_id,name,revision,current_context_id)
        values (${brandId},${f.org},${f.workspace},${f.user},${f.assignment},'Owned fixture brand',1,${contextId})`;
      await tx`insert into allrice_brand_content_contexts
        (id,organization_id,workspace_id,owner_id,instance_id,brand_id,number,brand_name,content,digest)
        values (${contextId},${f.org},${f.workspace},${f.user},${f.assignment},${brandId},1,
          'Owned fixture brand',${tx.json(context)},${brandContentDigest(context)})`;
      await tx`insert into allrice_brand_content_topics
        (id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,title_key,candidate,state)
        values (${topicId},${f.org},${f.workspace},${f.user},${f.assignment},${brandId},${contextId},
          'owned-fixture','owned_fixture_article',${tx.json(candidate)},'accepted')`;
      await tx`insert into allrice_brand_content_articles
        (id,organization_id,workspace_id,owner_id,instance_id,brand_id,topic_id,context_id,session_id,
          topic_revision,platform,state,current_bundle_id)
        values (${articleId},${f.org},${f.workspace},${f.user},${f.assignment},${brandId},${topicId},
          ${contextId},${f.session},1,'owned-fixture','awaiting_review',${bundleId})`;
      await tx`insert into allrice_brand_content_bundles
        (id,organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,number,content,images,digest,change_summary)
        values (${bundleId},${f.org},${f.workspace},${f.user},${f.assignment},${brandId},${articleId},1,
          ${tx.json(content)},'[]'::jsonb,${brandContentBundleDigest('owned-fixture', content, [])},
          'Link the pre-existing owned artifact')`;
    });
    return { articleId, bundleId, content };
  }

  it('batches 22 retirements into three real read-only statements and checks every context beyond the first batch', async () => {
    const empty = await observedRetirementScan();
    expect(empty.scopes).toEqual([]);
    expect(empty.statements).toHaveLength(1);
    const f = await subject();
    await appendPin(f);
    const output = await independentArtifact(f);
    await finish(f);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    await applyNativeTestChatRetirement(plan);
    const before = await evidence(f);
    const retired = await retirementRows(f);
    // Its independent fixture seed stays a legacy dependency even if archived;
    // retiring f.session never implicitly retires another context.
    const seed =
      await fixture.db`select id from allrice_chat_sessions c where c.organization_id=${f.org}
      and c.native_root_origin is null and not exists(select 1 from allrice_native_session_bindings b where b.context_kind='chat' and b.context_id=c.id)`;
    expect(seed).toHaveLength(1);
    await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${seed[0]!.id}`;
    expect(
      (
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${seed[0]!.id}`
      )[0]!.native_root_origin,
    ).toBeNull();

    const first = Array.from({ length: 21 }, () => randomUUID());
    await fixture.db.begin((tx) => copyRetiredContexts(tx, f, first));
    const batch = await observedRetirementScan();
    expect(batch.settings).toEqual({
      read_only: 'on',
      isolation: 'repeatable read',
    });
    expect(batch.scopes.map((s) => s.contextId)).toEqual(
      [f.session, ...first].sort(),
    );
    expect(batch.statements).toHaveLength(3);
    const remaining = Array.from({ length: 29 }, () => randomUUID());
    await fixture.db.begin((tx) => copyRetiredContexts(tx, f, remaining));
    const multiple = await observedRetirementScan();
    expect(multiple.scopes.map((s) => s.contextId)).toEqual(
      [f.session, ...first, ...remaining].sort(),
    );
    expect(multiple.statements).toHaveLength(5);
    expect(await evidence(f)).toEqual(before);
    expect(await retirementRows(f)).toEqual(retired);
    expect(
      await readArtifactBytes(runtimeFixtureStorage(fixture.db), output.object),
    ).toEqual(Buffer.from(output.body));
  }, 30_000);

  it('keeps archived, never-bound chat origins protected until an explicit terminal retirement', async () => {
    const f = await subject(false);
    await finish(f);
    await updateChatSession(f.owner, f.workspace, f.session, {
      archived: true,
    });
    const before = await evidence(f);
    expect(before.pins).toEqual([]);
    expect(before.session.native_root_origin).toEqual(f.origin);
    expect(before.session.archived_at).not.toBeNull();
    expect(
      await nativeContextExecutionRetired(fixture.db, 'chat', f.session),
    ).toBe(false);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    expect(await readNativeTestChatRetirement(plan)).toMatchObject({
      status: 'not-found',
    });
    expect(await retirementRows(f)).toEqual([]);
    expect(await evidence(f)).toEqual(before);
  }, 30_000);

  it('retires only the reviewed execution while preserving origin, pin, independent artifact bytes and another current scope', async () => {
    const f = await subject();
    const current = await subject();
    const output = await independentArtifact(f);
    await finish(f);
    await finish(current);
    const before = await evidence(f);
    const currentBefore = await evidence(current);
    const history = await getChatSessionHistory(
      f.owner,
      f.workspace,
      f.session,
    );
    const artifact = await getWorkbenchArtifact(
      f.owner,
      f.session,
      output.versionId,
    );
    expect(before.pins).toHaveLength(1);
    expect(before.versions).toHaveLength(1);
    expect(before.files).toHaveLength(1);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    expect(await evidence(f)).toEqual(before);
    expect(await applyNativeTestChatRetirement(plan)).toMatchObject({
      contexts: [f.session],
      alreadyApplied: false,
    });
    const after = await evidence(f);
    expect(after.session.archived_at).not.toBeNull();
    expect(after.session.native_root_origin).toEqual(
      before.session.native_root_origin,
    );
    for (const key of [
      'pins',
      'messages',
      'versions',
      'files',
      'artifacts',
      'objects',
      'articles',
      'bundles',
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(await evidence(current)).toEqual(currentBefore);
    expect(
      await getWorkbenchArtifact(f.owner, f.session, output.versionId),
    ).toEqual(artifact);
    expect(
      await readArtifactBytes(
        runtimeFixtureStorage(fixture.db),
        artifact.object,
      ),
    ).toEqual(Buffer.from(output.body));
    expect(
      (await getChatSessionHistory(f.owner, f.workspace, f.session)).messages,
    ).toEqual(history.messages);
    expect(
      await nativeContextExecutionRetired(fixture.db, 'chat', current.session),
    ).toBe(false);
  }, 30_000);

  it('rejects busy, foreign and stale scopes without archiving or recording a partial retirement', async () => {
    const busy = await subject(false);
    const busyBefore = await evidence(busy);
    await expect(
      previewNativeTestChatRetirement(request([scope(busy)])),
    ).rejects.toThrow('NATIVE_RETIREMENT_CONTEXT_BUSY');
    expect(await evidence(busy)).toEqual(busyBefore);
    expect(await retirementRows(busy)).toEqual([]);
    await finish(busy);
    const foreign = await subject(false);
    await finish(foreign);
    await expect(
      previewNativeTestChatRetirement(
        request([scope(busy), { ...scope(foreign), ownerId: busy.user }]),
      ),
    ).rejects.toThrow('NATIVE_RETIREMENT_SCOPE_NOT_FOUND');
    expect(await retirementRows(busy)).toEqual([]);
    expect(await retirementRows(foreign)).toEqual([]);
    const next = await subject(false);
    await finish(next);
    // Make the changed scope last in the plan's canonical order so apply must
    // roll back the earlier scope's archive/terminal insert as well.
    const stale = busy.session.localeCompare(next.session) > 0 ? busy : next;
    const plan = await previewNativeTestChatRetirement(
      request([scope(busy), scope(next)]),
    );
    await expect(
      applyNativeTestChatRetirement({
        ...plan,
        authorizationEvidenceDigest: digest('different unreviewed evidence'),
      }),
    ).rejects.toThrow('NATIVE_RETIREMENT_PLAN_DIGEST_CHANGED');
    await fixture.db`insert into allrice_messages
      (organization_id,workspace_id,session_id,owner_id,role,content)
      values (${stale.org},${stale.workspace},${stale.session},${stale.user},'user',
        '{"text":"late owned-fixture message","citations":[]}')`;
    await expect(applyNativeTestChatRetirement(plan)).rejects.toThrow(
      'NATIVE_RETIREMENT_PLAN_STALE',
    );
    for (const f of [busy, foreign, next]) {
      expect(await retirementRows(f)).toEqual([]);
      expect((await evidence(f)).session.archived_at).toBeNull();
    }
    expect(await readNativeTestChatRetirement(plan)).toMatchObject({
      status: 'not-found',
    });
  }, 30_000);

  it.each(['queued', 'foreign', 'changed'] as const)(
    'exact later-test cloud authorization never exempts %s chat facts from the original SQL API',
    async (mode) => {
      const f = await subject(false);
      await finish(f);
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      const plan = await previewNativeTestChatRetirement({
        ...request([scope(f)]),
        authorizationEvidenceDigest: digest(
          'Synthetic exact later-development-test cloud review; no Dev approval',
        ),
      });
      const before = await evidence(f);
      if (mode === 'queued')
        await fixture.db`update allrice_jobs set status='retry_wait',completed_at=null where id=${f.worker.jobId}`;
      if (mode === 'changed')
        await fixture.db`insert into allrice_messages(organization_id,workspace_id,session_id,owner_id,role,content)
          values(${f.org},${f.workspace},${f.session},${f.user},'user','{"text":"Synthetic post-review writer","citations":[]}')`;
      if (mode === 'foreign') {
        plan.snapshots[0]!.scope.ownerId = randomUUID();
        const body = Object.fromEntries(
          Object.entries(plan).filter(([key]) => key !== 'digest'),
        );
        plan.digest = nativeRootDigest(body);
      }
      await expect(applyNativeTestChatRetirement(plan)).rejects.toThrow(
        /NATIVE_RETIREMENT_CONTEXT_BUSY|NATIVE_RETIREMENT_PLAN_STALE|NATIVE_RETIREMENT_SCOPE_NOT_FOUND/,
      );
      expect(await retirementRows(f)).toEqual([]);
      expect((await evidence(f)).session).toEqual(before.session);
    },
  );
  it('invalidates a reviewed plan after a real new pin and fences further native pins after a fresh retirement', async () => {
    const f = await subject();
    await finish(f);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    const late = await appendPin(f);
    const before = await evidence(f);
    expect(before.pins).toHaveLength(2);
    expect(before.pins).toContainEqual(
      expect.objectContaining({ native_session_id: late }),
    );
    await expect(applyNativeTestChatRetirement(plan)).rejects.toThrow(
      'NATIVE_RETIREMENT_PLAN_STALE',
    );
    expect(await evidence(f)).toEqual(before);
    expect(await retirementRows(f)).toEqual([]);
    const reviewed = await previewNativeTestChatRetirement(request([scope(f)]));
    await applyNativeTestChatRetirement(reviewed);
    await expect(appendPin(f)).rejects.toThrow(
      'native execution context is retired',
    );
    expect((await evidence(f)).pins).toEqual(before.pins);
    await expect(fixture.db`update allrice_native_context_retirements set reason=reason
      where context_kind='chat' and context_id=${f.session}`).rejects.toThrow(
      'native execution retirement is terminal',
    );
    await expect(fixture.db`delete from allrice_native_context_retirements
      where context_kind='chat' and context_id=${f.session}`).rejects.toThrow(
      'native execution retirement is terminal',
    );
    expect(await readNativeTestChatRetirement(reviewed)).toMatchObject({
      status: 'completed',
    });
  }, 30_000);

  it('rejects an old plan when an existing deliverable gains a real brand business reference', async () => {
    const f = await subject();
    const output = await independentArtifact(f);
    await finish(f);
    const original = await evidence(f);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    const reference = await linkExistingArtifactToBrand(f, output);
    const linked = await evidence(f);
    expect(linked.articles).toContainEqual(
      expect.objectContaining({
        id: reference.articleId,
        session_id: f.session,
        current_bundle_id: reference.bundleId,
      }),
    );
    expect(linked.bundles).toContainEqual(
      expect.objectContaining({
        id: reference.bundleId,
        content: reference.content,
      }),
    );
    for (const key of [
      'session',
      'pins',
      'messages',
      'versions',
      'files',
      'artifacts',
      'objects',
    ] as const)
      expect(linked[key]).toEqual(original[key]);
    await expect(applyNativeTestChatRetirement(plan)).rejects.toThrow(
      'NATIVE_RETIREMENT_PLAN_STALE',
    );
    expect(await evidence(f)).toEqual(linked);
    expect(await retirementRows(f)).toEqual([]);
    expect(await readNativeTestChatRetirement(plan)).toMatchObject({
      status: 'not-found',
    });
    expect(
      await readArtifactBytes(runtimeFixtureStorage(fixture.db), output.object),
    ).toEqual(Buffer.from(output.body));
  }, 30_000);

  it('rejects an old plan when a referenced mutable upload changes storage state', async () => {
    const f = await subject();
    const output = await independentArtifact(f);
    const uploadId = randomUUID();
    const upload: StorageObject = {
      ...output.object,
      id: uploadId,
      key: `organizations/${f.org}/workspaces/${f.workspace}/owners/${f.user}/uploads/${uploadId}`,
      immutable: false,
    };
    await runtimeFixtureStorage(fixture.db).put(
      upload,
      new Blob([output.body]).stream(),
    );
    await fixture.db.begin(async (tx) => {
      await tx`insert into allrice_storage_objects
        (id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
        values (${upload.id},${f.org},${f.workspace},${f.user},${upload.key},'uploads',
          ${upload.mediaType},${upload.sizeBytes},${upload.checksum},'ready',false)`;
      await tx`insert into allrice_file_references
        (organization_id,workspace_id,owner_id,session_id,object_id,file_name)
        values (${f.org},${f.workspace},${f.user},${f.session},${upload.id},'mutable-upload.txt')`;
    });
    await finish(f);
    const original = await evidence(f);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    // Ready immutable artifacts forbid this transition themselves. A mutable
    // attachment is an actual allowed state transition, without disabling any
    // constraint or altering the independent deliverable and its object.
    await fixture.db`update allrice_storage_objects set state='deleted',
      deleted_at=clock_timestamp(),updated_at=clock_timestamp() where id=${upload.id}`;
    const changed = await evidence(f);
    expect(changed.objects).toContainEqual(
      expect.objectContaining({ id: upload.id, state: 'deleted' }),
    );
    expect(changed.objects).not.toEqual(original.objects);
    for (const key of [
      'session',
      'pins',
      'messages',
      'versions',
      'files',
      'artifacts',
      'articles',
      'bundles',
    ] as const)
      expect(changed[key]).toEqual(original[key]);
    await expect(applyNativeTestChatRetirement(plan)).rejects.toThrow(
      'NATIVE_RETIREMENT_PLAN_STALE',
    );
    expect(await evidence(f)).toEqual(changed);
    expect(await retirementRows(f)).toEqual([]);
    expect(await readNativeTestChatRetirement(plan)).toMatchObject({
      status: 'not-found',
    });
    expect(
      await readArtifactBytes(runtimeFixtureStorage(fixture.db), output.object),
    ).toEqual(Buffer.from(output.body));
  }, 30_000);

  it('canonicalizes uppercase request and scope UUIDs before digesting, applying and reading the original plan again', async () => {
    const first = await subject();
    const second = await subject();
    await finish(first);
    await finish(second);
    // Guarantee an alphabetic nibble so the request really has two spellings.
    const requestId = 'a' + randomUUID().slice(1);
    const canonicalScopes = [scope(first), scope(second)].sort((a, b) =>
      a.contextId.localeCompare(b.contextId),
    );
    const uppercaseScope = (value: NativeTestChatRetirementScope) => ({
      contextKind: value.contextKind,
      contextId: value.contextId.toUpperCase(),
      organizationId: value.organizationId.toUpperCase(),
      workspaceId: value.workspaceId.toUpperCase(),
      ownerId: value.ownerId.toUpperCase(),
    });
    const input = {
      ...request(canonicalScopes),
      requestId: requestId.toUpperCase(),
      scopes: [...canonicalScopes].reverse().map(uppercaseScope),
    };
    const originalPlan = await previewNativeTestChatRetirement(input);
    expect(originalPlan.requestId).toBe(requestId);
    expect(originalPlan.snapshots.map((snapshot) => snapshot.scope)).toEqual(
      canonicalScopes,
    );
    expect(originalPlan).toEqual(
      await previewNativeTestChatRetirement({
        ...input,
        requestId,
        scopes: canonicalScopes,
      }),
    );
    expect(await applyNativeTestChatRetirement(originalPlan)).toMatchObject({
      requestId,
      contexts: canonicalScopes.map((value) => value.contextId),
      alreadyApplied: false,
    });
    const after = await Promise.all([evidence(first), evidence(second)]);
    const records = await Promise.all([
      retirementRows(first),
      retirementRows(second),
    ]);
    const uppercasePlan = {
      ...originalPlan,
      requestId: requestId.toUpperCase(),
      snapshots: originalPlan.snapshots.map((snapshot) => ({
        ...snapshot,
        scope: uppercaseScope(snapshot.scope),
      })),
    };
    // The original reviewed digest must also survive planSchema normalization;
    // a caller need not invent a second digest to recover a differently cased ID.
    for (const plan of [originalPlan, uppercasePlan]) {
      expect(await readNativeTestChatRetirement(plan)).toMatchObject({
        requestId,
        planDigest: originalPlan.digest,
        status: 'completed',
        contexts: canonicalScopes.map((value) => value.contextId),
      });
      expect(await applyNativeTestChatRetirement(plan)).toMatchObject({
        requestId,
        alreadyApplied: true,
      });
    }
    expect(await Promise.all([evidence(first), evidence(second)])).toEqual(
      after,
    );
    expect(
      await Promise.all([retirementRows(first), retirementRows(second)]),
    ).toEqual(records);
    for (const rows of records)
      expect(rows).toEqual([
        expect.objectContaining({ request_id: requestId }),
      ]);
  }, 30_000);

  it('admits exactly one concurrent scope when uppercase and lowercase request IDs name the same UUID', async () => {
    const first = await subject(false);
    const second = await subject(false);
    await finish(first);
    await finish(second);
    const subjects = [first, second];
    const before = await Promise.all(subjects.map(evidence));
    const requestId = 'b' + randomUUID().slice(1);
    const firstPlan = await previewNativeTestChatRetirement({
      ...request([scope(first)]),
      requestId: requestId.toUpperCase(),
    });
    const secondPlan = await previewNativeTestChatRetirement({
      ...request([scope(second)]),
      requestId,
    });
    expect(firstPlan.requestId).toBe(requestId);
    expect(secondPlan.requestId).toBe(requestId);
    // Supply the casing variants at the apply boundary too. Both transactions
    // must serialize the same PostgreSQL request identity across distinct chats.
    const plans = [
      { ...firstPlan, requestId: requestId.toUpperCase() },
      secondPlan,
    ];
    const outcomes = await Promise.allSettled(
      plans.map((plan) => applyNativeTestChatRetirement(plan)),
    );
    const fulfilled = outcomes.filter((value) => value.status === 'fulfilled');
    const rejected = outcomes.filter((value) => value.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      message: 'NATIVE_RETIREMENT_REQUEST_CONFLICT',
    });
    const winnerIndex = outcomes.findIndex(
      (value) => value.status === 'fulfilled',
    );
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winner = subjects[winnerIndex]!;
    const loser = subjects[loserIndex]!;
    const winningPlan = plans[winnerIndex]!;
    const losingPlan = plans[loserIndex]!;
    expect(fulfilled[0]!.value).toMatchObject({
      requestId,
      contexts: [winner.session],
      alreadyApplied: false,
    });
    const rows = await fixture.db`select request_id,context_id,plan_digest
      from allrice_native_context_retirements where request_id=${requestId}`;
    expect(rows).toEqual([
      {
        request_id: requestId,
        context_id: winner.session,
        plan_digest: winningPlan.digest,
      },
    ]);
    expect((await evidence(winner)).session.archived_at).not.toBeNull();
    expect(await evidence(loser)).toEqual(before[loserIndex]);
    expect(await retirementRows(loser)).toEqual([]);
    expect(await readNativeTestChatRetirement(winningPlan)).toMatchObject({
      requestId,
      status: 'completed',
      contexts: [winner.session],
    });
    await expect(readNativeTestChatRetirement(losingPlan)).rejects.toThrow(
      'NATIVE_RETIREMENT_REQUEST_CONFLICT',
    );
    expect(await applyNativeTestChatRetirement(winningPlan)).toMatchObject({
      alreadyApplied: true,
    });
    await expect(applyNativeTestChatRetirement(losingPlan)).rejects.toThrow(
      'NATIVE_RETIREMENT_REQUEST_CONFLICT',
    );
    expect(await evidence(loser)).toEqual(before[loserIndex]);
    expect(await retirementRows(loser)).toEqual([]);
  }, 30_000);

  it('reads back an uncertain result with the same plan, is idempotent, and permits history but no restore, write or native selection', async () => {
    const f = await subject();
    await finish(f);
    const history = await getChatSessionHistory(
      f.owner,
      f.workspace,
      f.session,
    );
    expect(
      await fixture.db.begin((tx) =>
        readChatNativeRootOrigin(tx, {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: f.session,
        }),
      ),
    ).toEqual(f.origin);
    const plan = await previewNativeTestChatRetirement(request([scope(f)]));
    await applyNativeTestChatRetirement(plan); // Ignore the acknowledgement; recover only by the original readback.
    const retired = await retirementRows(f);
    const after = await evidence(f);
    expect(retired).toHaveLength(1);
    for (let i = 0; i < 2; i++)
      expect(await readNativeTestChatRetirement(plan)).toMatchObject({
        requestId: plan.requestId,
        planDigest: plan.digest,
        status: 'completed',
        contexts: [f.session],
      });
    expect(await retirementRows(f)).toEqual(retired);
    expect(await evidence(f)).toEqual(after);
    expect(await applyNativeTestChatRetirement(plan)).toMatchObject({
      alreadyApplied: true,
    });
    expect(await retirementRows(f)).toEqual(retired);
    expect(await evidence(f)).toEqual(after);
    const conflict = await previewNativeTestChatRetirement({
      ...request([scope(f)]),
      requestId: plan.requestId,
      authorizationEvidenceDigest: digest(
        'different authorization for the same request',
      ),
    });
    await expect(applyNativeTestChatRetirement(conflict)).rejects.toThrow(
      'NATIVE_RETIREMENT_REQUEST_CONFLICT',
    );
    await expect(
      updateChatSession(f.owner, f.workspace, f.session, { archived: false }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      updateChatSession(f.owner, f.workspace, f.session, {
        title: 'must not mutate retired history',
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      sendChatMessage(f.owner, f.workspace, f.session, {
        text: 'must not enqueue',
        clientMessageId: randomUUID(),
        attachmentIds: [],
        deliveryMode: 'follow_up',
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      fixture.db.begin((tx) =>
        assertWorkbenchSession(tx, f.owner, f.session, true),
      ),
    ).rejects.toMatchObject({ code: 'artifact_not_found' });
    await expect(
      fixture.db.begin((tx) =>
        readChatNativeRootOrigin(tx, {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: f.session,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
    expect(
      await nativeContextExecutionRetired(fixture.db, 'chat', f.session),
    ).toBe(true);
    await expect(
      fixture.db.begin((tx) =>
        assertWorkbenchSession(tx, f.owner, f.session, false),
      ),
    ).resolves.toBeUndefined();
    expect(
      (await getChatSessionHistory(f.owner, f.workspace, f.session)).messages,
    ).toEqual(history.messages);
    expect(await evidence(f)).toEqual(after);
    expect(await retirementRows(f)).toEqual(retired);
  }, 30_000);
  it('rejects scope, complete-row, microsecond and late-batch corruption without hiding foreign pins', async () => {
    const f = await subject();
    const foreign = await subject(false);
    await finish(f);
    await finish(foreign);
    await applyNativeTestChatRetirement(
      await previewNativeTestChatRetirement(request([scope(f)])),
    );
    await applyNativeTestChatRetirement(
      await previewNativeTestChatRetirement(request([scope(foreign)])),
    );
    // A valid never-bound retirement retains its empty snapshot semantics.
    expect((await observedRetirementScan()).scopes).toContainEqual(
      scope(foreign),
    );
    const before = await evidence(f);
    const retired = await retirementRows(f);
    const lateId = 'ffffffff-ffff-4fff-bfff-fffffffffff0';
    const missingId = 'ffffffff-ffff-4fff-bfff-fffffffffff1';
    const changed = 'NATIVE_RETIREMENT_REFERENCE_SNAPSHOT_CHANGED';
    const cases: {
      name: string;
      change: NonNullable<Parameters<typeof copyRetiredContexts>[3]>;
      error: string;
    }[] = [
      {
        name: 'unarchived context',
        change: { context: { archived_at: null } },
        error: changed,
      },
      {
        name: 'missing context',
        change: { retirement: () => ({ context_id: missingId }) },
        error: changed,
      },
      ...[
        ['organization_id', foreign.org],
        ['workspace_id', foreign.workspace],
        ['owner_id', foreign.user],
      ].map(([key, value]) => ({
        name: `retirement ${key} mismatch`,
        change: { retirement: () => ({ [key!]: value! }) },
        error: changed,
      })),
      {
        name: 'changed complete origin snapshot',
        change: {
          retirement: (origin) => ({
            origin_snapshot: {
              ...NativeRootOriginSchema.parse(origin),
              rootSeed: 'unreviewed-root-seed',
            },
          }),
        },
        error: changed,
      },
      {
        name: 'foreign owner pin absent from the reviewed snapshot',
        change: {
          binding: { owner_id: foreign.user },
          retirement: () => ({ binding_snapshot: [] }),
        },
        error: 'NATIVE_RETIREMENT_BINDING_SCOPE_CONFLICT',
      },
      {
        name: 'foreign organization/workspace pin absent from the snapshot',
        change: {
          binding: {
            organization_id: foreign.org,
            workspace_id: foreign.workspace,
          },
          retirement: () => ({ binding_snapshot: [] }),
        },
        error: 'NATIVE_RETIREMENT_BINDING_SCOPE_CONFLICT',
      },
      ...[
        ['first_job_id', randomUUID()],
        ['origin_reader_approval_digest', digest('unreviewed reader')],
        ['storage_namespace', '/unreviewed/storage/namespace'],
      ].map(([key, value]) => ({
        name: `complete binding field ${key} changed`,
        change: {
          retirement: (
            _origin: postgres.JSONValue,
            pins: Record<string, postgres.JSONValue>[],
          ) => ({
            binding_snapshot: pins.map((pin) => ({ ...pin, [key!]: value! })),
          }),
        },
        error: changed,
      })),
      {
        name: 'one microsecond binding timestamp difference',
        change: {
          retirement: (_origin, pins) => ({
            binding_snapshot: pins.map((pin) => ({
              ...pin,
              bound_at_micros: (
                BigInt(String(pin.bound_at_micros)) + 1n
              ).toString(),
            })),
          }),
        },
        error: changed,
      },
      {
        name: 'unreviewed pin row',
        change: { retirement: () => ({ binding_snapshot: [] }) },
        error: changed,
      },
    ];
    for (const c of cases) {
      await expect(
        fixture.db.begin(async (tx) => {
          await copyRetiredContexts(tx, f, [lateId], c.change);
          await readVerifiedNativeChatRetirements(tx);
        }),
        c.name,
      ).rejects.toThrow(c.error);
    }
    expect(
      await fixture.db`select context_id from allrice_native_context_retirements
      where context_id in (${lateId},${missingId})`,
    ).toEqual([]);
    expect(await evidence(f)).toEqual(before);
    expect(await retirementRows(f)).toEqual(retired);
    expect((await observedRetirementScan()).scopes).toContainEqual(scope(f));
  }, 30_000);
});
